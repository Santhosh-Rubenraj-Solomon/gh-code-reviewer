import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import {
  CriticalFailureError,
  MastraLLM,
  type AgentCallOptions,
  type AgentFactory,
  type AgentGenerateResult,
  type AgentLike,
  type AgentStreamResult,
  type ChatMessage,
  type MastraLLMOptions,
} from '../../src/llm';
import { TimingCollector } from '../../src/timing';
import { testConfig } from '../helpers';

type StreamScript = (opts?: AgentCallOptions) => Promise<AgentStreamResult>;
type GenerateScript = (opts?: AgentCallOptions) => Promise<AgentGenerateResult>;

interface Script {
  stream?: StreamScript;
  generate?: GenerateScript;
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const never = <T>() => new Promise<T>(() => {});

/** A text stream that yields chunks with optional delays; `hangAfter` stops yielding without closing. */
async function* chunks(parts: string[], opts: { delayMs?: number; hangAfter?: number } = {}): AsyncGenerator<string> {
  for (let i = 0; i < parts.length; i++) {
    if (opts.hangAfter !== undefined && i >= opts.hangAfter) await never();
    if (opts.delayMs) await wait(opts.delayMs);
    yield parts[i]!;
  }
  if (opts.hangAfter !== undefined && opts.hangAfter >= parts.length) await never();
}

function streamOf(parts: string[], extra: Partial<AgentStreamResult> = {}, opts = {}): AgentStreamResult {
  return { textStream: chunks(parts, opts), usage: Promise.resolve({ inputTokens: 11, outputTokens: 7 }), ...extra };
}

const failing = (message: string, status?: number) => () =>
  Promise.reject(Object.assign(new Error(message), status === undefined ? {} : { status }));

function harness(scripts: Record<string, Script>, options: MastraLLMOptions = {}, configOverrides = {}) {
  const calls: { model: string; mode: 'stream' | 'generate'; messages: ChatMessage[]; opts?: AgentCallOptions }[] = [];
  const factory: AgentFactory = ({ model }) => {
    const agent: AgentLike = {
      stream: (messages, opts) => {
        calls.push({ model, mode: 'stream', messages, opts });
        const s = scripts[model]?.stream;
        return s ? s(opts) : Promise.reject(Object.assign(new Error(`no stream script for ${model}`), { status: 400 }));
      },
      generate: (messages, opts) => {
        calls.push({ model, mode: 'generate', messages, opts });
        const g = scripts[model]?.generate;
        return g ? g(opts) : Promise.reject(Object.assign(new Error(`no generate script for ${model}`), { status: 400 }));
      },
    };
    return agent;
  };
  const timings = new TimingCollector();
  const sleeps: number[] = [];
  const llm = new MastraLLM(testConfig({ anthropicApiKey: 'sk-ant', maxRetries: 0, ...configOverrides }), {
    agentFactory: factory,
    timings,
    sleep: async ms => void sleeps.push(ms),
    timeouts: { initMs: 30, firstChunkMs: 30, betweenChunksMs: 30, generateMs: 30, settleMs: 30 },
    ...options,
  });
  return { llm, calls, timings, sleeps };
}

const OPUS = 'anthropic:claude-opus-5-5';
const SONNET = 'anthropic:claude-sonnet-5-5';
const HAIKU = 'anthropic:claude-haiku-5-5';
const GEMINI_PRO = 'google:gemini-3.1-pro-preview';

describe('streaming', () => {
  test('joins chunks, forwards them, and reports provider usage', async () => {
    const { llm, calls } = harness({ [OPUS]: { stream: async () => streamOf(['Hel', 'lo']) } });
    const seen: string[] = [];
    const result = await llm.streamText('review', [{ role: 'user', content: 'hi' }], c => seen.push(c));
    expect(result).toEqual({ text: 'Hello', usage: { inputTokens: 11, outputTokens: 7 }, model: OPUS });
    expect(seen).toEqual(['Hel', 'lo']);
    expect(calls).toHaveLength(1);
  });

  test('accepts a web ReadableStream as the text stream', async () => {
    const stream = new ReadableStream<string>({
      start(c) {
        c.enqueue('a');
        c.enqueue('b');
        c.close();
      },
    });
    const { llm } = harness({ [OPUS]: { stream: async () => ({ textStream: stream }) } });
    const result = await llm.generateText('review', 'x');
    expect(result.text).toBe('ab');
    // No usage promise: tokens are estimated from the text.
    expect(result.usage.inputTokens).toBeGreaterThan(0);
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  test('estimates usage when the usage promise never settles', async () => {
    const { llm } = harness({ [OPUS]: { stream: async () => streamOf(['done'], { usage: never() }) } });
    const result = await llm.generateText('review', 'prompt');
    expect(result.usage.outputTokens).toBeGreaterThan(0);
  });

  test('a per-call model override picks the model for chat tier routing', async () => {
    const { llm, calls } = harness({ [HAIKU]: { stream: async () => streamOf(['cheap']) } });
    const result = await llm.streamText('chat', [{ role: 'system', content: 's' }, { role: 'user', content: 'q' }], undefined, {
      model: HAIKU,
    });
    expect(result.model).toBe(HAIKU);
    expect(calls[0]!.messages.map(m => m.role)).toEqual(['system', 'user']);
  });
});

describe('timeouts', () => {
  test('init timeout moves on to the next model', async () => {
    const { llm, timings } = harness({
      [OPUS]: { stream: () => never() },
      [SONNET]: { stream: async () => streamOf(['ok']) },
    });
    const result = await llm.generateText('review', 'x');
    expect(result.model).toBe(SONNET);
    const [first] = timings.list();
    expect(first).toMatchObject({ model: OPUS, status: 'timeout', ttfcMs: null });
    expect(first!.error).toContain('waiting for the stream to open');
  });

  test('first-chunk timeout with no data is a failure', async () => {
    const { llm, timings } = harness({
      [OPUS]: { stream: async () => streamOf(['late'], {}, { hangAfter: 0 }) },
      [SONNET]: { stream: async () => streamOf(['ok']) },
    });
    expect((await llm.generateText('review', 'x')).model).toBe(SONNET);
    expect(timings.list()[0]!.error).toContain('waiting for the first chunk');
  });

  test('between-chunk timeout keeps the partial text', async () => {
    const { llm, timings } = harness({
      [OPUS]: { stream: async () => streamOf(['part one, ', 'never'], {}, { hangAfter: 1 }) },
    });
    const result = await llm.generateText('review', 'x');
    expect(result).toMatchObject({ text: 'part one, ', partial: true, model: OPUS });
    expect(result.usage.outputTokens).toBeGreaterThan(0);
    expect(timings.list()).toHaveLength(1);
    expect(timings.list()[0]).toMatchObject({ status: 'partial' });
    expect(timings.list()[0]!.ttfcMs).not.toBeNull();
  });

  test('each attempt gets its own abort signal, aborted when the attempt times out', async () => {
    const { llm, calls } = harness({
      [OPUS]: { stream: async () => streamOf(['late'], {}, { hangAfter: 0 }) },
      [SONNET]: { stream: () => never() },
      [HAIKU]: { stream: async () => streamOf(['ok']), generate: () => never() },
    });
    expect((await llm.generateText('review', 'x')).model).toBe(HAIKU);
    const [first, second, third] = calls.map(c => c.opts?.abortSignal);
    expect(first).toBeInstanceOf(AbortSignal);
    expect(first).not.toBe(second);
    expect(first!.aborted).toBe(true);
    expect(second!.aborted).toBe(true);
    expect(third!.aborted).toBe(false);
  });

  test('the generate fallback is aborted on timeout, and a stalled partial stream is aborted', async () => {
    const timedOut = harness({ [OPUS]: { stream: failing('bad', 400), generate: () => never() } }, { maxModels: 1 });
    await expect(timedOut.llm.generateText('review', 'x')).rejects.toBeInstanceOf(CriticalFailureError);
    const generate = timedOut.calls.find(c => c.mode === 'generate')!;
    expect(generate.opts?.abortSignal?.aborted).toBe(true);

    const stalled = harness({ [OPUS]: { stream: async () => streamOf(['part', 'never'], {}, { hangAfter: 1 }) } });
    expect((await stalled.llm.generateText('review', 'x')).partial).toBe(true);
    expect(stalled.calls[0]!.opts?.abortSignal?.aborted).toBe(true);
  });

  test('a slow but steady stream is not cut off', async () => {
    const { llm } = harness({ [OPUS]: { stream: async () => streamOf(['a', 'b', 'c', 'd'], {}, { delayMs: 15 }) } });
    expect((await llm.generateText('review', 'x')).text).toBe('abcd');
  });
});

describe('fallback chain', () => {
  test('anthropic primary falls back opus -> sonnet -> haiku, then generate on the last', async () => {
    const { llm, calls } = harness({
      [OPUS]: { stream: failing('boom', 400) },
      [SONNET]: { stream: failing('boom', 400) },
      [HAIKU]: { stream: failing('boom', 400), generate: async () => ({ text: 'from generate', usage: {} }) },
    });
    const result = await llm.generateText('review', 'x');
    expect(result.text).toBe('from generate');
    expect(calls.map(c => `${c.model}:${c.mode}`)).toEqual([
      `${OPUS}:stream`,
      `${SONNET}:stream`,
      `${HAIKU}:stream`,
      `${HAIKU}:generate`,
    ]);
  });

  test('chain order from a cheaper primary tries weaker then stronger models', () => {
    const { llm } = harness({});
    expect(llm.modelChain(SONNET)).toEqual([SONNET, HAIKU, OPUS]);
    expect(llm.modelChain(HAIKU)).toEqual([HAIKU, SONNET, OPUS]);
  });

  test('other providers join only when their key is present, capped at 4 models', () => {
    const withoutGoogle = harness({}).llm;
    expect(withoutGoogle.modelChain(OPUS)).toEqual([OPUS, SONNET, HAIKU]);
    const both = harness({}, {}, { googleApiKey: 'g' }).llm;
    expect(both.modelChain(OPUS)).toEqual([OPUS, SONNET, HAIKU, GEMINI_PRO]);
    const googleOnly = harness({}, {}, { anthropicApiKey: undefined, googleApiKey: 'g' }).llm;
    // The primary stays even without its key, so the missing key shows up as the error.
    expect(googleOnly.modelChain(OPUS)).toEqual([
      OPUS,
      GEMINI_PRO,
      'google:gemini-3-flash-preview',
      'google:gemini-3.1-flash-lite-preview',
    ]);
  });

  test('fallbacks and the model cap are configurable', () => {
    const { llm } = harness({}, { fallbacks: { anthropic: [OPUS, HAIKU] }, maxModels: 2 });
    expect(llm.modelChain(OPUS)).toEqual([OPUS, HAIKU]);
    expect(llm.modelChain('anthropic:custom')).toEqual(['anthropic:custom', OPUS]);
  });

  test('retries each model on retryable errors before falling back', async () => {
    let opusTries = 0;
    const { llm, sleeps } = harness(
      {
        [OPUS]: {
          stream: () => (++opusTries < 3 ? failing('overloaded', 529)() : Promise.resolve(streamOf(['third time']))),
        },
      },
      {},
      { maxRetries: 2, retryBaseDelayMs: 10 },
    );
    expect((await llm.generateText('review', 'x')).text).toBe('third time');
    expect(sleeps).toEqual([10, 20]);
  });

  test('throws CriticalFailureError listing every model tried', async () => {
    const { llm, timings } = harness({
      [OPUS]: { stream: failing('a down', 503) },
      [SONNET]: { stream: failing('b down', 503) },
      [HAIKU]: { stream: failing('c down', 503), generate: failing('d down', 503) },
    });
    const error = await llm.generateText('review', 'x').catch(e => e);
    expect(error).toBeInstanceOf(CriticalFailureError);
    expect(error.name).toBe('CriticalFailureError');
    expect(error.modelsTried).toEqual([OPUS, SONNET, HAIKU, `${HAIKU} (generate)`]);
    expect(error.message).toContain(`${OPUS} -> ${SONNET} -> ${HAIKU}`);
    expect(error.message).toContain('d down');
    expect(timings.list().map(t => t.status)).toEqual(['error', 'error', 'error', 'error']);
    expect(timings.list().map(t => t.streamed)).toEqual([true, true, true, false]);
  });

  test('an empty stream counts as a failure', async () => {
    const { llm } = harness({
      [OPUS]: { stream: async () => streamOf([]) },
      [SONNET]: { stream: async () => streamOf(['fine']) },
    });
    expect((await llm.generateText('review', 'x')).model).toBe(SONNET);
  });
});

describe('generateObject', () => {
  const schema = z.object({ verdict: z.string(), score: z.number() });

  test('uses the structured object when it validates', async () => {
    const { llm, calls } = harness({
      [OPUS]: {
        stream: async () => streamOf(['{"verdict":"ok","score":1}'], { object: Promise.resolve({ verdict: 'ok', score: 1 }) }),
      },
    });
    const result = await llm.generateObject('review', 'judge', schema);
    expect(result.object).toEqual({ verdict: 'ok', score: 1 });
    expect(calls[0]!.opts?.structuredOutput?.schema).toBe(schema);
  });

  test('falls back to JSON extracted from the same response text', async () => {
    const { llm, calls } = harness({
      [OPUS]: {
        stream: async () =>
          streamOf(['Sure! ```json\n{"verdict":"meh","score":2}\n```'], { object: Promise.reject(new Error('invalid')) }),
      },
    });
    const result = await llm.generateObject('review', 'judge', schema);
    expect(result.object).toEqual({ verdict: 'meh', score: 2 });
    expect(calls).toHaveLength(1);
  });

  test('makes a plain-text JSON call when the structured response is unusable', async () => {
    let n = 0;
    const { llm, calls } = harness({
      [OPUS]: {
        stream: async () =>
          ++n === 1
            ? streamOf(['not json'], { object: Promise.resolve({ verdict: 1 }) })
            : streamOf(['{"verdict":"retry","score":3}']),
      },
    });
    const result = await llm.generateObject('review', 'judge', schema);
    expect(result.object).toEqual({ verdict: 'retry', score: 3 });
    expect(calls).toHaveLength(2);
    expect(calls[1]!.opts?.structuredOutput).toBeUndefined();
    expect(calls[1]!.messages[0]!.content).toContain('single JSON value');
    expect(result.usage).toEqual({ inputTokens: 22, outputTokens: 14 });
  });

  test('uses the injected parser', async () => {
    const { llm } = harness(
      { [OPUS]: { stream: async () => streamOf(['verdict=x score=4']) } },
      { parseJson: () => ({ verdict: 'x', score: 4 }) },
    );
    expect((await llm.generateObject('review', 'judge', schema)).object).toEqual({ verdict: 'x', score: 4 });
  });

  test('tries the text path when structured mode fails on every model with non-transient errors', async () => {
    const { llm } = harness({
      [OPUS]: {
        stream: async opts =>
          opts?.structuredOutput ? Promise.reject(new Error('schema unsupported')) : streamOf(['{"verdict":"t","score":5}']),
      },
      [SONNET]: { stream: failing('schema unsupported') },
      [HAIKU]: { stream: failing('schema unsupported'), generate: failing('schema unsupported') },
    });
    expect((await llm.generateObject('review', 'judge', schema)).object).toEqual({ verdict: 't', score: 5 });
  });

  test('reports a clear error when nothing matches the schema', async () => {
    const { llm } = harness({ [OPUS]: { stream: async () => streamOf(['{"verdict":"x"}']) } });
    await expect(llm.generateObject('review', 'judge', schema)).rejects.toThrow(/does not match the expected structure/);
  });
});

test('timing entries carry call id, stage, model, ttfc, duration, tokens and status', async () => {
  let clock = 1_000;
  const { llm, timings } = harness(
    { [HAIKU]: { stream: async () => ((clock += 50), streamOf(['x'])) } },
    { now: () => (clock += 10) },
  );
  await llm.generateText('triage', 'x');
  const [entry] = timings.list();
  expect(entry).toMatchObject({
    callId: 'triage-1',
    stage: 'triage',
    model: HAIKU,
    inputTokens: 11,
    outputTokens: 7,
    status: 'success',
    streamed: true,
  });
  expect(entry!.ttfcMs).toBeGreaterThan(0);
  expect(entry!.durationMs).toBeGreaterThanOrEqual(entry!.ttfcMs!);
  expect(timings.summary().triage).toMatchObject({ calls: 1, failures: 0 });
});
