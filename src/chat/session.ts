import { truncate } from '../pipeline/deps';
import type { LLMClient } from '../llm';
import { CHAT_TIERS, type ChatTier, type InteractiveIssue } from '../issues';
import type { ChatTurn, MemoryItem, MemoryQuery } from '../memory/types';
import { parseRoute, ROUTING_INSTRUCTION, RouteTagFilter, stripRoutes, type RouteHint } from './routing';

export type ChatMessage = ChatTurn;

/** Streams one model reply. The integrator adapts the real LLM layer to this; tests script it. */
export interface ChatModel {
  stream(
    messages: ChatMessage[],
    model: string,
    onChunk?: (text: string) => void,
  ): Promise<{ text: string; inputTokens: number; outputTokens: number }>;
}

/** The slice of DeveloperMemory a chat needs. */
export interface ChatMemory {
  relevantFor(context: { project?: string | null; issueTitle?: string }): Promise<MemoryItem[]>;
  recordFromChat(
    messages: ChatTurn[],
    options: { issueTitle: string; project?: string | null; resolved?: boolean; keyPoints?: string[] },
  ): Promise<MemoryItem[]>;
  query(filters: MemoryQuery): MemoryItem[];
}

export const DEFAULT_CHAT_MODELS: Record<ChatTier, string> = {
  basic: 'anthropic:claude-haiku-5-5',
  standard: 'anthropic:claude-sonnet-5-5',
  advanced: 'anthropic:claude-opus-5-5',
};

export const TOKEN_THRESHOLDS = { warning: 25_000, compact: 30_000, limit: 50_000 } as const;

export type ContextLevel = 'ok' | 'warning' | 'compact' | 'limit';

export interface ContextStatus {
  tokens: number;
  level: ContextLevel;
  message?: string;
}

export interface ChatResult {
  kind: 'reply' | 'command' | 'exit' | 'error';
  /** The assistant reply (routing tags removed), the command's output, or the error message. */
  output: string;
  tier: ChatTier;
  autoRouting: boolean;
  status: ContextStatus;
  model?: string;
  route?: RouteHint;
  /** True when the history was compacted while handling this input. */
  compacted?: boolean;
}

export interface ChatSessionOptions {
  issue: InteractiveIssue;
  model: ChatModel;
  /** Used for history summaries (the `chat` stage). */
  llm: LLMClient;
  memory?: ChatMemory;
  /** Persona-specific voice for the reviewer; a neutral default is used when omitted. */
  personaInstruction?: string;
  project?: string | null;
  tierModels?: Partial<Record<ChatTier, string>>;
  readFile?: (path: string) => Promise<string>;
  contextMaxChars?: number;
  /** Compact automatically once the history reaches the compact threshold (default true). */
  autoCompact?: boolean;
  /** Annotated diff of the issue's file, shown to the model so it can quote changed lines. */
  contextDiff?: string;
  /** Cap for contextDiff (default 6000 characters). */
  contextDiffMaxChars?: number;
  /** A transcript from `transcript()` of an earlier session about this issue, to carry on where it stopped. */
  initialTranscript?: ChatMessage[];
}

const KEEP_RECENT = 4;
/** Marks the system turn that carries a compaction summary inside a saved transcript. */
const SUMMARY_MARKER = '[conversation summary]\n';
const DEFAULT_PERSONA = 'You are an experienced code reviewer talking with the developer about a finding from your review.';

export const CHAT_HELP = [
  'Commands:',
  '  /model basic|standard|advanced   Use one model tier for every reply',
  '  /model auto                      Let the reviewer pick the tier per reply (default)',
  '  /compact                         Summarise older messages to free up context',
  '  /clear                           Forget the conversation so far',
  '  /context <path>                  Add a file to the conversation',
  '  /memory                          Show memories relevant to this issue',
  '  /memory list                     Show your top memories',
  '  /memory save                     Remember this discussion',
  '  /help                            Show this help',
  '  /exit, /quit, /q                 Back to the issue list',
].join('\n');

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function contextStatus(tokens: number): ContextStatus {
  if (tokens >= TOKEN_THRESHOLDS.limit) {
    return { tokens, level: 'limit', message: 'Context limit reached. Run /compact or /clear before continuing.' };
  }
  if (tokens >= TOKEN_THRESHOLDS.compact) {
    return { tokens, level: 'compact', message: 'Context is large; older messages will be summarised.' };
  }
  if (tokens >= TOKEN_THRESHOLDS.warning) {
    return { tokens, level: 'warning', message: 'Context is getting large. Consider /compact.' };
  }
  return { tokens, level: 'ok' };
}

function describeIssue(issue: InteractiveIssue): string {
  const lines = [
    `Title: ${issue.title}`,
    `Severity: ${issue.severity}`,
    `Type: ${issue.type}`,
    `Files: ${issue.files.join(', ') || 'unknown'}`,
  ];
  if (issue.lines.length) lines.push(`Lines: ${issue.lines.join(', ')}`);
  lines.push('', 'Description:', issue.description);
  if (issue.evidence) lines.push('', 'Code:', '```', issue.evidence, '```');
  if (issue.suggestedFix) lines.push('', 'Suggested fix:', issue.suggestedFix);
  return lines.join('\n');
}

/** A conversation with the reviewer about one issue: tier routing, slash commands, memory and context compaction. */
export class ChatSession {
  readonly issue: InteractiveIssue;
  private readonly options: ChatSessionOptions;
  private readonly tierModels: Record<ChatTier, string>;
  private baseSystem = '';
  private summary = '';
  private contextFiles: { path: string; content: string }[] = [];
  private history: ChatMessage[] = [];
  private forcedTier: ChatTier | null = null;
  private autoRoutingEnabled = true;
  private lastRoute: RouteHint | undefined;
  private memories: MemoryItem[] = [];
  readonly usage = { inputTokens: 0, outputTokens: 0 };

  private constructor(options: ChatSessionOptions) {
    this.options = options;
    this.issue = options.issue;
    this.tierModels = { ...DEFAULT_CHAT_MODELS, ...options.tierModels };
    for (const m of options.initialTranscript ?? []) {
      if (m.role === 'system') {
        if (m.content.startsWith(SUMMARY_MARKER)) this.summary = m.content.slice(SUMMARY_MARKER.length);
      } else {
        this.history.push({ role: m.role, content: m.content });
      }
    }
  }

  static async create(options: ChatSessionOptions): Promise<ChatSession> {
    const session = new ChatSession(options);
    if (options.memory) {
      try {
        session.memories = await options.memory.relevantFor({
          project: options.project ?? null,
          issueTitle: options.issue.title,
        });
      } catch {
        session.memories = [];
      }
    }
    session.baseSystem = session.buildBaseSystem();
    return session;
  }

  private buildBaseSystem(): string {
    const parts = [
      this.options.personaInstruction?.trim() || DEFAULT_PERSONA,
      '',
      'The issue under discussion:',
      describeIssue(this.issue),
      ...this.diffSection(),
      '',
      'Answer the developer\'s questions about this issue. Be concrete: reference the code, explain the risk, and when',
      'asked for a fix, show the changed code. If the developer shows the issue is not real, say so plainly.',
    ];
    if (this.memories.length) {
      parts.push('', 'What you remember about this developer (respect these preferences and past decisions):');
      for (const m of this.memories) parts.push(`- [${m.type}] ${m.content}`);
    }
    parts.push('', ROUTING_INSTRUCTION);
    return parts.join('\n');
  }

  private diffSection(): string[] {
    const diff = this.options.contextDiff?.trim();
    if (!diff) return [];
    const clipped = truncate(diff, this.options.contextDiffMaxChars ?? 6_000);
    return ['', 'The change to this file (diff):', '```diff', clipped, '```'];
  }

  // ---- state -------------------------------------------------------------

  /** The system message the model sees: base instructions plus any summary and added files. */
  systemMessage(): string {
    const parts = [this.baseSystem];
    if (this.summary) parts.push('', 'Summary of the earlier conversation:', this.summary);
    for (const file of this.contextFiles) parts.push('', `File ${file.path}:`, '```', file.content, '```');
    return parts.join('\n');
  }

  messages(): ChatMessage[] {
    return [{ role: 'system', content: this.systemMessage() }, ...this.history];
  }

  /** User and assistant turns only (no system message). */
  conversation(): ChatMessage[] {
    return [...this.history];
  }

  /**
   * Everything needed to resume this conversation later: the turns, preceded by the compaction summary (as a
   * marked system turn) when there is one. Pass it back as `initialTranscript`.
   */
  transcript(): ChatMessage[] {
    const summary: ChatMessage[] = this.summary ? [{ role: 'system', content: `${SUMMARY_MARKER}${this.summary}` }] : [];
    return [...summary, ...this.history.map(m => ({ ...m }))];
  }

  tokens(): number {
    return this.messages().reduce((sum, m) => sum + estimateTokens(m.content), 0);
  }

  status(): ContextStatus {
    return contextStatus(this.tokens());
  }

  get autoRouting(): boolean {
    return this.autoRoutingEnabled;
  }

  /** 'fixed' after /model <tier>, 'auto' when the model picks the tier, 'manual' when routing is switched off. */
  routingMode(): 'auto' | 'fixed' | 'manual' {
    return this.forcedTier ? 'fixed' : this.autoRoutingEnabled ? 'auto' : 'manual';
  }

  /** The tier the next reply will use. */
  currentTier(): ChatTier {
    if (this.forcedTier) return this.forcedTier;
    if (!this.autoRoutingEnabled) return 'standard';
    return this.lastRoute?.tier ?? this.issue.chatTier;
  }

  modelFor(tier: ChatTier): string {
    return this.tierModels[tier];
  }

  setForcedTier(tier: ChatTier | null): void {
    this.forcedTier = tier;
  }

  setAutoRouting(enabled: boolean): void {
    this.autoRoutingEnabled = enabled;
    if (enabled) this.forcedTier = null;
  }

  clearHistory(): void {
    this.history = [];
    this.summary = '';
    this.contextFiles = [];
    this.lastRoute = undefined;
  }

  private result(kind: ChatResult['kind'], output: string, extra: Partial<ChatResult> = {}): ChatResult {
    return {
      kind,
      output,
      tier: this.currentTier(),
      autoRouting: this.autoRoutingEnabled,
      status: this.status(),
      ...extra,
    };
  }

  // ---- input -------------------------------------------------------------

  async handleInput(text: string, onChunk?: (text: string) => void): Promise<ChatResult> {
    const input = text.trim();
    if (!input) return this.result('command', '');
    if (input.startsWith('/')) return this.command(input);
    return this.send(input, onChunk);
  }

  private async send(input: string, onChunk?: (text: string) => void): Promise<ChatResult> {
    if (this.status().level === 'limit' && !(await this.tryCompact())) {
      return this.result('error', contextStatus(this.tokens()).message ?? 'Context limit reached.');
    }
    const tier = this.currentTier();
    const model = this.modelFor(tier);
    this.history.push({ role: 'user', content: input });
    const filter = new RouteTagFilter();
    let reply: { text: string; inputTokens: number; outputTokens: number };
    try {
      reply = await this.options.model.stream(this.messages(), model, chunk => {
        const visible = filter.push(chunk);
        if (visible) onChunk?.(visible);
      });
    } catch (error) {
      // Drop the unanswered question so a retry does not send it twice.
      this.history.pop();
      return this.result('error', `The model call failed: ${(error as Error).message}`, { model });
    }
    const tail = filter.flush();
    if (tail) onChunk?.(tail);

    this.usage.inputTokens += reply.inputTokens;
    this.usage.outputTokens += reply.outputTokens;
    const route = parseRoute(reply.text);
    if (route) this.lastRoute = route;
    const clean = stripRoutes(reply.text).trim();
    this.history.push({ role: 'assistant', content: clean });

    let compacted = false;
    if ((this.options.autoCompact ?? true) && this.tokens() >= TOKEN_THRESHOLDS.compact) {
      compacted = await this.tryCompact();
    }
    return { ...this.result('reply', clean, { model, route, compacted }), tier };
  }

  private async tryCompact(): Promise<boolean> {
    try {
      return await this.compact();
    } catch {
      return false;
    }
  }

  /**
   * Replaces everything but the last few turns with a model-written summary. The live history is rewritten, so
   * the next request really is smaller. Returns false when there was nothing old enough to summarise.
   */
  async compact(): Promise<boolean> {
    if (this.history.length <= KEEP_RECENT) return false;
    const older = this.history.slice(0, -KEEP_RECENT);
    const transcript = older.map(m => `${m.role === 'user' ? 'Developer' : 'Reviewer'}: ${m.content}`).join('\n\n');
    const prompt = [
      `Summarise this part of a conversation about the code review issue "${this.issue.title}".`,
      'Keep every decision, agreed fix, open question, code identifier and preference the developer stated.',
      'Write at most 250 words of plain prose.',
      ...(this.summary ? ['', 'Summary of what came before it:', this.summary] : []),
      '',
      transcript,
    ].join('\n');
    const { text } = await this.options.llm.generateText('chat', prompt);
    const summary = text.trim();
    if (!summary) throw new Error('The summary came back empty');
    this.summary = summary;
    this.history = this.history.slice(-KEEP_RECENT);
    return true;
  }

  // ---- slash commands ----------------------------------------------------

  private async command(input: string): Promise<ChatResult> {
    const [rawName = '', ...args] = input.slice(1).split(/\s+/);
    const name = rawName.toLowerCase();
    const arg = args.join(' ').trim();
    switch (name) {
      case 'exit':
      case 'quit':
      case 'q':
        return this.result('exit', '');
      case 'help':
        return this.result('command', CHAT_HELP);
      case 'model':
        return this.modelCommand(arg.toLowerCase());
      case 'compact':
        return this.compactCommand();
      case 'clear':
        this.clearHistory();
        return this.result('command', 'Conversation cleared.');
      case 'context':
        return this.contextCommand(arg);
      case 'memory':
        return this.memoryCommand(arg.toLowerCase());
      default:
        return this.result('command', `Unknown command /${name}.\n\n${CHAT_HELP}`);
    }
  }

  private modelCommand(arg: string): ChatResult {
    if (arg === 'auto') {
      this.setAutoRouting(true);
      return this.result('command', 'Automatic model routing is on.');
    }
    if ((CHAT_TIERS as readonly string[]).includes(arg)) {
      const tier = arg as ChatTier;
      this.setForcedTier(tier);
      return this.result('command', `Using the ${tier} tier (${this.modelFor(tier)}) until you run /model auto.`);
    }
    const current = `Current tier: ${this.currentTier()} (${this.modelFor(this.currentTier())})`;
    return this.result('command', `${current}, routing ${this.routingMode()}.\nUsage: /model basic|standard|advanced|auto`);
  }

  private async compactCommand(): Promise<ChatResult> {
    const before = this.tokens();
    try {
      if (!(await this.compact())) return this.result('command', 'Nothing to compact yet.');
    } catch (error) {
      return this.result('error', `Compaction failed: ${(error as Error).message}`);
    }
    return this.result('command', `Compacted the conversation: ~${before} → ~${this.tokens()} tokens.`, {
      compacted: true,
    });
  }

  private async contextCommand(path: string): Promise<ChatResult> {
    if (!path) return this.result('command', 'Usage: /context <path>');
    if (!this.options.readFile) return this.result('error', 'Adding files is not available in this session.');
    let content: string;
    try {
      content = await this.options.readFile(path);
    } catch (error) {
      return this.result('error', `Could not read ${path}: ${(error as Error).message}`);
    }
    const max = this.options.contextMaxChars ?? 8_000;
    const clipped = truncate(content, max);
    this.contextFiles = [...this.contextFiles.filter(f => f.path !== path), { path, content: clipped }];
    const note = content.length > max ? ` (truncated to ${max} characters)` : '';
    return this.result('command', `Added ${path} to the conversation${note}.`);
  }

  private async memoryCommand(arg: string): Promise<ChatResult> {
    const memory = this.options.memory;
    if (!memory) return this.result('command', 'Developer memory is not enabled for this session.');
    const format = (items: MemoryItem[]) => items.map(m => `- [${m.type}] ${m.content}`).join('\n');
    try {
      if (arg === 'save') {
        const recent = this.history.slice(-6);
        if (!recent.length) return this.result('command', 'Nothing to save yet.');
        const saved = await memory.recordFromChat(recent, {
          issueTitle: this.issue.title,
          project: this.options.project ?? null,
          resolved: false,
        });
        return this.result('command', `Saved ${saved.length} memor${saved.length === 1 ? 'y' : 'ies'} from this discussion.`);
      }
      if (arg === 'list') {
        const top = memory.query({ project: this.options.project ?? null, limit: 5 });
        return this.result('command', top.length ? `Your top memories:\n${format(top)}` : 'No memories yet.');
      }
      if (arg) return this.result('command', 'Usage: /memory [list|save]');
      const relevant = (
        await memory.relevantFor({ project: this.options.project ?? null, issueTitle: this.issue.title })
      ).slice(0, 3);
      return this.result(
        'command',
        relevant.length ? `Memories relevant to this issue:\n${format(relevant)}` : 'No memories relevant to this issue.',
      );
    } catch (error) {
      return this.result('error', `Memory error: ${(error as Error).message}`);
    }
  }
}
