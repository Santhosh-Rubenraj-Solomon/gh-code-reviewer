import { Agent } from '@mastra/core/agent';
import { z } from 'zod';
import { modelForStage, type Config } from './config';
import type { Usage } from './cost';
import { createLanguageModel, parseModelId, type Provider } from './models';
import { STAGE_INSTRUCTIONS } from './prompts';
import { TimingCollector, type CallStatus } from './timing';
import type { Stage } from './types';
import { extractJson } from './utils/json';
import { isRetryableError, withRetry } from './utils/retry';
import { estimateTokens } from './utils/tokens';

export interface TextResult {
  text: string;
  usage: Usage;
  model: string;
  /** True when a stream stalled after some text arrived and the partial text was kept. */
  partial?: boolean;
}

export interface ObjectResult<T> {
  object: T;
  usage: Usage;
  model: string;
}

/** The only surface the pipeline uses to talk to a model. Tests substitute a fake. */
export interface LLMClient {
  generateText(stage: Stage, prompt: string): Promise<TextResult>;
  generateObject<T>(stage: Stage, prompt: string, schema: z.ZodType<T>): Promise<ObjectResult<T>>;
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Chat needs incremental output and a per-call model (tier routing); the review pipeline does not. */
export interface StreamingLLMClient extends LLMClient {
  streamText(
    stage: Stage,
    messages: ChatMessage[],
    onChunk?: (text: string) => void,
    options?: { model?: string },
  ): Promise<TextResult>;
}

export function toUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as { inputTokens?: number; outputTokens?: number };
  return { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 };
}

// ---- agent seam -----------------------------------------------------------

export interface AgentCallOptions {
  structuredOutput?: { schema: unknown };
  /** Aborted when the attempt times out or is abandoned, so the provider request is cancelled too. */
  abortSignal?: AbortSignal;
}

/** The subset of Mastra's stream output this client reads. */
export interface AgentStreamResult {
  textStream: ReadableStream<string> | AsyncIterable<string>;
  usage?: PromiseLike<unknown>;
  object?: PromiseLike<unknown>;
}

export interface AgentGenerateResult {
  text?: string;
  usage?: unknown;
  object?: unknown;
}

export interface AgentLike {
  stream(messages: ChatMessage[], options?: AgentCallOptions): Promise<AgentStreamResult>;
  generate(messages: ChatMessage[], options?: AgentCallOptions): Promise<AgentGenerateResult>;
}

export interface AgentSpec {
  stage: Stage;
  model: string;
  instructions: string;
}

export type AgentFactory = (spec: AgentSpec) => AgentLike;

function mastraAgentFactory(config: Config): AgentFactory {
  return ({ stage, model, instructions }) => {
    const agent = new Agent({
      id: `ghr-${stage}-${model.replace(/[^a-z0-9-]/gi, '-')}`,
      name: `gh-code-reviewer ${stage}`,
      instructions,
      model: createLanguageModel(model, config),
    });
    // Mastra's message union does not accept a role union, and its option overloads are keyed on the
    // schema type; this seam passes both through untyped.
    const input = (messages: ChatMessage[]) => messages as Parameters<Agent['generate']>[0];
    return {
      stream: (messages, options) =>
        agent.stream(input(messages), (options ?? {}) as never) as Promise<AgentStreamResult>,
      generate: (messages, options) =>
        agent.generate(input(messages), (options ?? {}) as never) as Promise<AgentGenerateResult>,
    };
  };
}

// ---- errors ---------------------------------------------------------------

export type TimeoutKind = 'init' | 'first-chunk' | 'between-chunks' | 'generate';

const TIMEOUT_WAITING_FOR: Record<TimeoutKind, string> = {
  init: 'the stream to open',
  'first-chunk': 'the first chunk',
  'between-chunks': 'the next chunk',
  generate: 'a response',
};

export class LLMTimeoutError extends Error {
  constructor(
    readonly kind: TimeoutKind,
    readonly model: string,
    readonly ms: number,
  ) {
    super(`${model} timed out after ${ms}ms waiting for ${TIMEOUT_WAITING_FOR[kind]}`);
    this.name = 'LLMTimeoutError';
  }
}

/** Every model in the fallback chain, and the final non-streaming attempt, failed. */
export class CriticalFailureError extends Error {
  constructor(
    readonly stage: Stage,
    readonly modelsTried: string[],
    readonly failures: string[],
    readonly causes: unknown[] = [],
  ) {
    super(
      `All model attempts for stage "${stage}" failed. Tried: ${modelsTried.join(' -> ')}. ` +
        `Last error: ${failures[failures.length - 1] ?? 'unknown'}`,
    );
    this.name = 'CriticalFailureError';
  }
}

// ---- options --------------------------------------------------------------

export interface StreamTimeouts {
  /** Waiting for the provider to accept the request and open a stream. */
  initMs: number;
  firstChunkMs: number;
  betweenChunksMs: number;
  /** The final non-streaming attempt. */
  generateMs: number;
  /** Waiting for usage/object promises after the text stream ended. */
  settleMs: number;
}

export const DEFAULT_TIMEOUTS: StreamTimeouts = {
  initMs: 120_000,
  firstChunkMs: 180_000,
  betweenChunksMs: 60_000,
  generateMs: 180_000,
  settleMs: 5_000,
};

export const DEFAULT_FALLBACKS: Record<Provider, string[]> = {
  anthropic: ['anthropic:claude-opus-5-5', 'anthropic:claude-sonnet-5-5', 'anthropic:claude-haiku-5-5'],
  google: ['google:gemini-3.1-pro-preview', 'google:gemini-3-flash-preview', 'google:gemini-3.1-flash-lite-preview'],
};

export interface MastraLLMOptions {
  agentFactory?: AgentFactory;
  fallbacks?: Partial<Record<Provider, string[]>>;
  /** Distinct models tried per call, primary included. */
  maxModels?: number;
  timeouts?: Partial<StreamTimeouts>;
  timings?: TimingCollector;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  parseJson?: (text: string) => unknown;
  instructions?: (stage: Stage) => string;
  log?: (message: string) => void;
}

interface CallPlan {
  structured?: z.ZodType<unknown>;
  onChunk?: (text: string) => void;
  model?: string;
}

interface AttemptOutcome {
  text: string;
  usage: Usage;
  model: string;
  partial: boolean;
  object?: unknown;
}

/** Mutable so the caller still sees how far an attempt got when it throws. */
interface AttemptProbe {
  ttfcMs: number | null;
  usage: Usage;
}

const TIMED_OUT = Symbol('timed-out');

function raceTimeout<T>(promise: PromiseLike<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function chunkIterator(source: ReadableStream<string> | AsyncIterable<string>): AsyncIterator<string> {
  if ('getReader' in source) {
    const reader = source.getReader();
    return {
      next: async () => {
        const r = await reader.read();
        return r.done ? { done: true, value: undefined } : { done: false, value: r.value };
      },
      return: async () => {
        await reader.cancel().catch(() => {});
        return { done: true, value: undefined };
      },
    };
  }
  return source[Symbol.asyncIterator]();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function addUsage(a: Usage, b: Usage): Usage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

const JSON_ONLY_REMINDER =
  'Reply with a single JSON value that matches the schema below. Do not add prose before or after it.';

/**
 * One Mastra agent per (stage, model). Each call streams from the stage's model, falls back along a
 * chain of other models whose provider key is configured, and finally tries one non-streaming
 * generate before giving up with a CriticalFailureError.
 */
export class MastraLLM implements StreamingLLMClient {
  private readonly agents = new Map<string, AgentLike>();
  private readonly agentFactory: AgentFactory;
  private readonly fallbacks: Partial<Record<Provider, string[]>>;
  private readonly maxModels: number;
  private readonly timeouts: StreamTimeouts;
  private readonly now: () => number;
  private readonly parseJson: (text: string) => unknown;
  private readonly log: (message: string) => void;
  readonly timings: TimingCollector;
  private callCounter = 0;

  constructor(
    private readonly config: Config,
    private readonly options: MastraLLMOptions = {},
  ) {
    this.agentFactory = options.agentFactory ?? mastraAgentFactory(config);
    this.fallbacks = options.fallbacks ?? DEFAULT_FALLBACKS;
    this.maxModels = options.maxModels ?? 4;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...options.timeouts };
    this.timings = options.timings ?? new TimingCollector();
    this.now = options.now ?? Date.now;
    this.parseJson = options.parseJson ?? extractJson;
    this.log = options.log ?? (() => {});
  }

  // ---- public API ---------------------------------------------------------

  async generateText(stage: Stage, prompt: string): Promise<TextResult> {
    const out = await this.call(stage, [{ role: 'user', content: prompt }], {});
    return { text: out.text, usage: out.usage, model: out.model, ...(out.partial ? { partial: true } : {}) };
  }

  async streamText(
    stage: Stage,
    messages: ChatMessage[],
    onChunk?: (text: string) => void,
    options: { model?: string } = {},
  ): Promise<TextResult> {
    const out = await this.call(stage, messages, { onChunk, model: options.model });
    return { text: out.text, usage: out.usage, model: out.model, ...(out.partial ? { partial: true } : {}) };
  }

  async generateObject<T>(stage: Stage, prompt: string, schema: z.ZodType<T>): Promise<ObjectResult<T>> {
    let first: AttemptOutcome;
    try {
      first = await this.call(stage, [{ role: 'user', content: prompt }], { structured: schema });
    } catch (error) {
      // A provider outage would fail the text path too; anything else may be the structured mode itself.
      if (!(error instanceof CriticalFailureError) || error.causes.some(isRetryableError)) throw error;
      this.log(`${stage}: structured output failed on every model, retrying as plain text`);
      first = { text: '', usage: { inputTokens: 0, outputTokens: 0 }, model: '', partial: false };
    }

    if (first.object !== undefined) {
      const parsed = schema.safeParse(first.object);
      if (parsed.success) return { object: parsed.data, usage: first.usage, model: first.model };
    }
    // Structured output can fail validation while the raw text still holds usable JSON.
    const fromText = this.tryParse(first.text, schema);
    if (fromText.ok) return { object: fromText.value, usage: first.usage, model: first.model };

    this.log(`${stage}: structured output did not validate, retrying as plain text with JSON extraction`);
    const second = await this.call(stage, [{ role: 'user', content: this.jsonOnlyPrompt(prompt, schema) }], {});
    const usage = addUsage(first.usage, second.usage);
    const retried = this.tryParse(second.text, schema);
    if (retried.ok) return { object: retried.value, usage, model: second.model };
    throw new Error(`Stage "${stage}" returned output that does not match the expected structure: ${retried.error}`);
  }

  // ---- fallback chain -----------------------------------------------------

  private hasKey(provider: Provider): boolean {
    return provider === 'anthropic' ? Boolean(this.config.anthropicApiKey) : Boolean(this.config.googleApiKey);
  }

  private providerOf(model: string): Provider | null {
    try {
      return parseModelId(model).provider;
    } catch {
      return null;
    }
  }

  /**
   * The primary model first, then weaker models of the same provider, then stronger ones, then other
   * providers' chains. Models whose provider has no key are dropped; the primary always stays so a
   * missing key surfaces as a clear error.
   */
  modelChain(primary: string): string[] {
    const provider = this.providerOf(primary);
    const candidates = [primary];
    if (provider) {
      const own = this.fallbacks[provider] ?? [];
      const at = own.indexOf(primary);
      candidates.push(...(at === -1 ? own : [...own.slice(at + 1), ...own.slice(0, at).reverse()]));
    }
    for (const [other, models] of Object.entries(this.fallbacks)) {
      if (other !== provider) candidates.push(...(models ?? []));
    }

    const chain: string[] = [];
    for (const model of candidates) {
      if (chain.includes(model)) continue;
      const p = this.providerOf(model);
      if (model !== primary && (!p || !this.hasKey(p))) continue;
      chain.push(model);
      if (chain.length >= this.maxModels) break;
    }
    return chain;
  }

  private async call(stage: Stage, messages: ChatMessage[], plan: CallPlan): Promise<AttemptOutcome> {
    const callId = `${stage}-${++this.callCounter}`;
    const chain = this.modelChain(plan.model ?? modelForStage(this.config, stage));
    const failures: string[] = [];
    const causes: unknown[] = [];

    for (const model of chain) {
      try {
        return await withRetry(() => this.attempt(callId, stage, model, messages, plan, 'stream'), {
          retries: this.config.maxRetries,
          baseDelayMs: this.config.retryBaseDelayMs,
          sleep: this.options.sleep,
          onRetry: (error, n, delay) =>
            this.log(`${stage}: ${model} failed (${errorMessage(error)}); retry ${n} in ${delay}ms`),
        });
      } catch (error) {
        failures.push(`${model}: ${errorMessage(error)}`);
        causes.push(error);
        this.log(`${stage}: giving up on ${model}: ${errorMessage(error)}`);
      }
    }

    const last = chain[chain.length - 1]!;
    try {
      return await this.attempt(callId, stage, last, messages, plan, 'generate');
    } catch (error) {
      failures.push(`${last} (generate): ${errorMessage(error)}`);
      causes.push(error);
    }
    throw new CriticalFailureError(stage, [...chain, `${last} (generate)`], failures, causes);
  }

  // ---- single attempt -----------------------------------------------------

  private agentFor(stage: Stage, model: string): AgentLike {
    const key = `${stage}|${model}`;
    let agent = this.agents.get(key);
    if (!agent) {
      const instructions =
        this.options.instructions?.(stage) ?? (STAGE_INSTRUCTIONS as Partial<Record<Stage, string>>)[stage] ?? '';
      agent = this.agentFactory({ stage, model, instructions });
      this.agents.set(key, agent);
    }
    return agent;
  }

  private estimate(messages: ChatMessage[], text: string): Usage {
    return {
      inputTokens: estimateTokens(messages.map(m => m.content).join('\n')),
      outputTokens: estimateTokens(text),
    };
  }

  private async attempt(
    callId: string,
    stage: Stage,
    model: string,
    messages: ChatMessage[],
    plan: CallPlan,
    mode: 'stream' | 'generate',
  ): Promise<AttemptOutcome> {
    const startedAt = this.now();
    const probe: AttemptProbe = { ttfcMs: null, usage: { inputTokens: 0, outputTokens: 0 } };
    const record = (status: CallStatus, error?: string) =>
      this.timings.record({
        callId,
        stage,
        model,
        startedAt,
        ttfcMs: probe.ttfcMs,
        durationMs: this.now() - startedAt,
        inputTokens: probe.usage.inputTokens,
        outputTokens: probe.usage.outputTokens,
        status,
        streamed: mode === 'stream',
        ...(error ? { error } : {}),
      });

    // One controller per attempt: a timed-out or abandoned request must not keep running (and billing) behind us.
    const controller = new AbortController();
    try {
      const agent = this.agentFor(stage, model);
      const callOptions: AgentCallOptions = { abortSignal: controller.signal };
      if (plan.structured) callOptions.structuredOutput = { schema: plan.structured };
      const out =
        mode === 'stream'
          ? await this.streamOnce(agent, model, messages, callOptions, plan.onChunk, startedAt, probe)
          : await this.generateOnce(agent, model, messages, callOptions, probe);
      // A stalled stream kept as partial text is still running on the provider side.
      if (out.partial) controller.abort(new Error(`${model} stalled; partial response kept`));
      record(out.partial ? 'partial' : 'success');
      return out;
    } catch (error) {
      controller.abort(error);
      record(error instanceof LLMTimeoutError ? 'timeout' : 'error', errorMessage(error));
      throw error;
    }
  }

  private async streamOnce(
    agent: AgentLike,
    model: string,
    messages: ChatMessage[],
    callOptions: AgentCallOptions | undefined,
    onChunk: ((text: string) => void) | undefined,
    startedAt: number,
    probe: AttemptProbe,
  ): Promise<AttemptOutcome> {
    const t = this.timeouts;
    const opened = await raceTimeout(agent.stream(messages, callOptions), t.initMs);
    if (opened === TIMED_OUT) throw new LLMTimeoutError('init', model, t.initMs);

    const chunks = chunkIterator(opened.textStream);
    let text = '';
    let partial = false;
    for (;;) {
      const limit = probe.ttfcMs === null ? t.firstChunkMs : t.betweenChunksMs;
      const next = await raceTimeout(chunks.next(), limit);
      if (next === TIMED_OUT) {
        void chunks.return?.()?.catch?.(() => {});
        if (!text) throw new LLMTimeoutError(probe.ttfcMs === null ? 'first-chunk' : 'between-chunks', model, limit);
        this.log(`${model} stalled after ${text.length} chars; keeping the partial response`);
        partial = true;
        break;
      }
      if (next.done) break;
      if (probe.ttfcMs === null) probe.ttfcMs = this.now() - startedAt;
      text += next.value;
      onChunk?.(next.value);
    }

    let object: unknown;
    if (!partial && callOptions?.structuredOutput && opened.object) {
      // A rejected or slow object is not fatal: generateObject falls back to the text.
      const settled = await raceTimeout(
        Promise.resolve(opened.object).then(
          v => v,
          () => undefined,
        ),
        t.settleMs,
      );
      object = settled === TIMED_OUT ? undefined : settled;
    }
    if (!text && object === undefined) throw new Error(`no data received from ${model}`);

    probe.usage = await this.settleUsage(opened.usage, partial, messages, text);
    return { text, usage: probe.usage, model, partial, object };
  }

  private async settleUsage(
    usage: PromiseLike<unknown> | undefined,
    partial: boolean,
    messages: ChatMessage[],
    text: string,
  ): Promise<Usage> {
    if (!partial && usage) {
      const settled = await raceTimeout(
        Promise.resolve(usage).then(
          v => v,
          () => undefined,
        ),
        this.timeouts.settleMs,
      );
      if (settled !== TIMED_OUT && settled) {
        const u = toUsage(settled);
        if (u.inputTokens > 0 || u.outputTokens > 0) return u;
      }
    }
    return this.estimate(messages, text);
  }

  private async generateOnce(
    agent: AgentLike,
    model: string,
    messages: ChatMessage[],
    callOptions: AgentCallOptions | undefined,
    probe: AttemptProbe,
  ): Promise<AttemptOutcome> {
    const result = await raceTimeout(agent.generate(messages, callOptions), this.timeouts.generateMs);
    if (result === TIMED_OUT) throw new LLMTimeoutError('generate', model, this.timeouts.generateMs);
    const text = result.text ?? '';
    if (!text && result.object === undefined) throw new Error(`no data received from ${model}`);
    const reported = toUsage(result.usage);
    probe.usage =
      reported.inputTokens > 0 || reported.outputTokens > 0 ? reported : this.estimate(messages, text);
    return { text, usage: probe.usage, model, partial: false, object: result.object };
  }

  // ---- JSON fallback ------------------------------------------------------

  private tryParse<T>(text: string, schema: z.ZodType<T>): { ok: true; value: T } | { ok: false; error: string } {
    if (!text.trim()) return { ok: false, error: 'empty response' };
    let raw: unknown;
    try {
      raw = this.parseJson(text);
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
    const parsed = schema.safeParse(raw);
    return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: parsed.error.message };
  }

  private jsonOnlyPrompt(prompt: string, schema: z.ZodType<unknown>): string {
    let shape = '';
    try {
      shape = JSON.stringify(z.toJSONSchema(schema));
    } catch {
      // Some schemas (transforms, custom refinements) have no JSON Schema form; the reminder still helps.
    }
    return [prompt, '', JSON_ONLY_REMINDER, shape].join('\n').trimEnd();
  }
}
