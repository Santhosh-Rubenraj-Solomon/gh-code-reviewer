import { createHash, randomBytes } from 'node:crypto';
import { open, type Database, type RootDatabase } from 'lmdb';
import type { ChatTurn } from '../memory/types';
import { summarizeTimings, type StageTimingSummary, type TimingEntry } from '../timing';
import type { FileReview, ImpactResult, ReviewReport } from '../types';
import { isReviewReport, unstamp, type ReportCache, type Stamped } from './report-cache';

export const STORE_SCHEMA_VERSION = 2;

export const SESSION_STAGES = [
  'fetch',
  'impact',
  'triage',
  'docs',
  'batching',
  'review',
  'critic',
  'consolidate',
  'validate',
  'persona',
  'publish',
] as const;
export type SessionStage = (typeof SESSION_STAGES)[number];

export type StageState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
const STAGE_STATES: readonly StageState[] = ['pending', 'running', 'completed', 'failed', 'skipped'];

export interface StageStatus {
  state: StageState;
  startedAt?: number;
  finishedAt?: number;
  error?: string;
}

export interface SessionSource {
  /** e.g. 'github', 'local', 'commits'. */
  type: string;
  /** e.g. 'owner/repo#12' or a branch name. */
  id: string;
  title: string;
}

export interface Session {
  schemaVersion: number;
  id: string;
  /** Stable key for "the same review target", used to resume a session. */
  identity: string;
  createdAt: number;
  updatedAt: number;
  source: SessionSource;
  target: string;
  config: Record<string, unknown>;
  stages: Record<SessionStage, StageStatus>;
}

export interface SessionIdentity {
  key: string;
  source: SessionSource;
  target?: string;
  config?: Record<string, unknown>;
}

export interface ReviewStoreOptions {
  path: string;
  now?: () => number;
  newId?: () => string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** Impact analysis depends on the whole repo, not just the diff, so a cached graph goes stale within a day. */
export const IMPACT_TTL_MS = DAY_MS;

export interface CachePruneResult {
  reports: number;
  batches: number;
  impacts: number;
}

/** Key for the impact cache: the repo snapshot plus the set of changed paths (order-insensitive). */
export function impactKey(repoHash: string, changedPaths: readonly string[]): string {
  const paths = createHash('sha256')
    .update(JSON.stringify([...new Set(changedPaths)].sort()))
    .digest('hex')
    .slice(0, 16);
  return `${repoHash}${SEP}${paths}`;
}

function isImpactResult(value: unknown): value is ImpactResult {
  return isRecord(value) && isRecord(value.files);
}

function isChatTurns(value: unknown): value is ChatTurn[] {
  return (
    Array.isArray(value) &&
    value.every(
      m => isRecord(m) && typeof m.content === 'string' && ['system', 'user', 'assistant'].includes(m.role as string),
    )
  );
}
/** Session ids are hex and stage names are fixed, so a colon cleanly delimits the key prefix. */
const SEP = ':';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function pendingStages(): Record<SessionStage, StageStatus> {
  return Object.fromEntries(SESSION_STAGES.map(s => [s, { state: 'pending' }])) as Record<SessionStage, StageStatus>;
}

/**
 * Reads a stored session, upgrading older shapes. Returns null for anything that cannot be a session,
 * so callers treat it as corrupt instead of crashing on it.
 */
export function normalizeSession(value: unknown): Session | null {
  if (!isRecord(value)) return null;
  const { id, createdAt } = value;
  if (typeof id !== 'string' || !id || typeof createdAt !== 'number') return null;
  const updatedAt = typeof value.updatedAt === 'number' ? value.updatedAt : createdAt;
  const rawSource = isRecord(value.source) ? value.source : {};
  const stages = pendingStages();
  if (isRecord(value.stages)) {
    for (const stage of SESSION_STAGES) {
      const s = value.stages[stage];
      if (isRecord(s) && STAGE_STATES.includes(s.state as StageState)) stages[stage] = s as unknown as StageStatus;
    }
  }
  return {
    schemaVersion: typeof value.schemaVersion === 'number' ? value.schemaVersion : 1,
    id,
    identity: typeof value.identity === 'string' ? value.identity : id,
    createdAt,
    updatedAt,
    source: {
      type: typeof rawSource.type === 'string' ? rawSource.type : 'unknown',
      id: typeof rawSource.id === 'string' ? rawSource.id : '',
      title: typeof rawSource.title === 'string' ? rawSource.title : '',
    },
    target: typeof value.target === 'string' ? value.target : '',
    config: isRecord(value.config) ? value.config : {},
    stages,
  };
}

function isFileReviewList(value: unknown): value is FileReview[] {
  return Array.isArray(value) && value.every(r => isRecord(r) && typeof r.path === 'string' && Array.isArray(r.findings));
}

/**
 * Durable review state in one LMDB environment: sessions with per-stage status and data, a batch-level
 * review cache, model call timings, and full-report cache entries.
 */
export class ReviewStore implements ReportCache {
  private readonly root: RootDatabase;
  private readonly sessions: Database<unknown, string>;
  private readonly identities: Database<string, string>;
  private readonly stageData: Database<unknown, string>;
  private readonly batches: Database<unknown, string>;
  private readonly timings: Database<unknown, string>;
  private readonly reports: Database<unknown, string>;
  private readonly impacts: Database<unknown, string>;
  private readonly chats: Database<unknown, string>;
  private readonly now: () => number;
  private readonly newId: () => string;
  private timingSeq = 0;
  /** Tail of the write chain per session: read-modify-write of a session record must not interleave. */
  private readonly sessionQueues = new Map<string, Promise<void>>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;

  constructor(options: ReviewStoreOptions) {
    this.root = open({ path: options.path, maxDbs: 16, compression: true });
    this.sessions = this.root.openDB<unknown, string>({ name: 'sessions' });
    this.identities = this.root.openDB<string, string>({ name: 'session-identities' });
    this.stageData = this.root.openDB<unknown, string>({ name: 'stage-data' });
    this.batches = this.root.openDB<unknown, string>({ name: 'batch-reviews' });
    this.timings = this.root.openDB<unknown, string>({ name: 'timings' });
    this.reports = this.root.openDB<unknown, string>({ name: 'reports' });
    this.impacts = this.root.openDB<unknown, string>({ name: 'impact' });
    this.chats = this.root.openDB<unknown, string>({ name: 'chats' });
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => randomBytes(4).toString('hex'));
  }

  // ---- sessions -----------------------------------------------------------

  getSession(id: string): Session | null {
    return normalizeSession(this.sessions.get(id));
  }

  /** Resumes the session for this identity, or starts one. `fresh` always starts a new session. */
  async getOrCreateSession(identity: SessionIdentity, options: { fresh?: boolean } = {}): Promise<Session> {
    const existingId = options.fresh ? undefined : this.identities.get(identity.key);
    const existing = existingId ? this.getSession(existingId) : null;
    const now = this.now();
    if (existing) {
      const updated: Session = {
        ...existing,
        schemaVersion: STORE_SCHEMA_VERSION,
        updatedAt: now,
        source: identity.source,
        target: identity.target ?? existing.target,
        config: identity.config ?? existing.config,
      };
      await this.sessions.put(updated.id, updated);
      return updated;
    }

    let id = this.newId();
    while (this.sessions.doesExist(id)) id = this.newId();
    const session: Session = {
      schemaVersion: STORE_SCHEMA_VERSION,
      id,
      identity: identity.key,
      createdAt: now,
      updatedAt: now,
      source: identity.source,
      target: identity.target ?? '',
      config: identity.config ?? {},
      stages: pendingStages(),
    };
    await this.sessions.put(id, session);
    await this.identities.put(identity.key, id);
    return session;
  }

  /** Safe to call concurrently for the same session: updates are applied one after another. */
  setStageStatus(sessionId: string, stage: SessionStage, state: StageState, error?: string): Promise<void> {
    return this.serialised(sessionId, () => this.applyStageStatus(sessionId, stage, state, error));
  }

  private async applyStageStatus(sessionId: string, stage: SessionStage, state: StageState, error?: string) {
    const session = this.requireSession(sessionId);
    const now = this.now();
    const previous = session.stages[stage];
    const next: StageStatus = { state };
    if (state === 'running') next.startedAt = now;
    else if (previous.startedAt !== undefined) next.startedAt = previous.startedAt;
    if (state === 'completed' || state === 'failed' || state === 'skipped') next.finishedAt = now;
    if (error) next.error = error;
    session.stages[stage] = next;
    session.updatedAt = now;
    await this.sessions.put(sessionId, session);
  }

  /** Stores a stage's output and marks the stage completed. */
  saveStageData(sessionId: string, stage: SessionStage, data: unknown): Promise<void> {
    return this.serialised(sessionId, async () => {
      this.requireSession(sessionId);
      await this.stageData.put(`${sessionId}${SEP}${stage}`, data);
      await this.applyStageStatus(sessionId, stage, 'completed');
    });
  }

  getStageData<T = unknown>(sessionId: string, stage: SessionStage): T | undefined {
    return this.stageData.get(`${sessionId}${SEP}${stage}`) as T | undefined;
  }

  /** Newest first. `filter` matches id, title, source id, source type or target, case-insensitively. */
  findSessions(filter?: string, limit = 20): Session[] {
    const needle = filter?.toLowerCase();
    const found: Session[] = [];
    for (const { value } of this.sessions.getRange()) {
      const session = normalizeSession(value);
      if (!session) continue;
      if (needle) {
        const hay = [session.id, session.source.title, session.source.id, session.source.type, session.target];
        if (!hay.some(h => h.toLowerCase().includes(needle))) continue;
      }
      found.push(session);
    }
    return found.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, limit);
  }

  async deleteSession(id: string): Promise<boolean> {
    const raw = this.sessions.get(id);
    if (raw === undefined) return false;
    const session = normalizeSession(raw);
    if (session && this.identities.get(session.identity) === id) await this.identities.remove(session.identity);
    for (const db of [this.stageData, this.timings, this.chats]) {
      for (const key of db.getKeys(this.prefixRange(id))) await db.remove(key);
    }
    await this.sessions.remove(id);
    return true;
  }

  /**
   * Removes sessions not updated in `days` days, plus records that cannot be read as sessions, and prunes report,
   * batch and impact cache entries written before the cutoff (entries from before timestamps existed count as old).
   * Returns the session ids removed (or that would be, with dryRun) and the cache entry counts.
   */
  async cleanupOlderThan(
    days: number,
    options: { dryRun?: boolean } = {},
  ): Promise<{ sessions: string[]; caches: CachePruneResult }> {
    const cutoff = this.now() - days * DAY_MS;
    const doomed: string[] = [];
    for (const { key, value } of this.sessions.getRange()) {
      const session = normalizeSession(value);
      if (!session || session.updatedAt < cutoff) doomed.push(key);
    }
    if (!options.dryRun) {
      for (const id of doomed) await this.deleteSession(id);
    }
    const caches = await this.pruneCachesOlderThan(days, options);
    return { sessions: doomed, caches };
  }

  /** Counts (and unless dryRun, removes) cache entries written more than `days` days ago. */
  async pruneCachesOlderThan(days: number, options: { dryRun?: boolean } = {}): Promise<CachePruneResult> {
    const cutoff = this.now() - days * DAY_MS;
    const prune = async (db: Database<unknown, string>): Promise<number> => {
      const keys: string[] = [];
      for (const { key, value } of db.getRange()) {
        const entry = unstamp(value);
        if (!entry || entry.createdAt < cutoff) keys.push(key);
      }
      if (!options.dryRun) for (const key of keys) await db.remove(key);
      return keys.length;
    };
    return { reports: await prune(this.reports), batches: await prune(this.batches), impacts: await prune(this.impacts) };
  }

  /** Empties the report and batch caches (sessions, impact cache and chats are kept). */
  async clearCaches(): Promise<{ reports: number; batches: number }> {
    const clear = async (db: Database<unknown, string>): Promise<number> => {
      let count = 0;
      for (const key of db.getKeys()) {
        await db.remove(key);
        count++;
      }
      return count;
    };
    return { reports: await clear(this.reports), batches: await clear(this.batches) };
  }

  // ---- batch review cache -------------------------------------------------

  getBatch(key: string): FileReview[] | undefined {
    const value = unstamp(this.batches.get(key))?.value;
    return isFileReviewList(value) ? value : undefined;
  }

  putBatch(key: string, reviews: FileReview[]): Promise<void> {
    return this.track(() => this.batches.put(key, this.stamp(reviews)));
  }

  // ---- impact cache -------------------------------------------------------

  /** Cached impact analysis, or undefined when missing, malformed or older than IMPACT_TTL_MS. */
  getImpact<T extends ImpactResult = ImpactResult>(key: string): T | undefined {
    const entry = unstamp(this.impacts.get(key));
    if (!entry || this.now() - entry.createdAt > IMPACT_TTL_MS) return undefined;
    return isImpactResult(entry.value) ? (entry.value as T) : undefined;
  }

  putImpact(key: string, value: ImpactResult): Promise<void> {
    return this.track(() => this.impacts.put(key, this.stamp(value)));
  }

  // ---- issue chats --------------------------------------------------------

  saveChat(sessionId: string, issueId: string, messages: ChatTurn[]): Promise<void> {
    const value = messages.map(m => ({ role: m.role, content: m.content }));
    return this.track(() => this.chats.put(`${sessionId}${SEP}${issueId}`, this.stamp(value)));
  }

  getChat(sessionId: string, issueId: string): ChatTurn[] | undefined {
    const value = unstamp(this.chats.get(`${sessionId}${SEP}${issueId}`))?.value;
    return isChatTurns(value) ? value : undefined;
  }

  // ---- timings ------------------------------------------------------------

  recordTiming(sessionId: string, entry: TimingEntry): Promise<void> {
    // The sequence keeps two attempts of the same call (same callId) from overwriting each other.
    const seq = String(++this.timingSeq).padStart(6, '0');
    return this.track(() => this.timings.put(`${sessionId}${SEP}${entry.startedAt}${SEP}${seq}${SEP}${entry.callId}`, entry));
  }

  getTimings(sessionId: string): TimingEntry[] {
    const entries: TimingEntry[] = [];
    for (const { value } of this.timings.getRange(this.prefixRange(sessionId))) {
      if (isRecord(value) && typeof value.stage === 'string' && typeof value.durationMs === 'number') {
        entries.push(value as unknown as TimingEntry);
      }
    }
    return entries;
  }

  timingSummary(sessionId: string): Record<string, StageTimingSummary> {
    return summarizeTimings(this.getTimings(sessionId));
  }

  // ---- report cache -------------------------------------------------------

  get(key: string): ReviewReport | undefined {
    const value = unstamp(this.reports.get(key))?.value;
    return isReviewReport(value) ? value : undefined;
  }

  put(key: string, report: ReviewReport): Promise<void> {
    return this.track(() => this.reports.put(key, this.stamp(report)));
  }

  /** Resolves once every write started so far has finished (failures are left to their own callers). */
  async flush(): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
  }

  /** Waits for pending writes, then closes. Writes requested after this point are silently dropped. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.flush();
    await this.root.close();
  }

  // ---- helpers ------------------------------------------------------------

  private stamp<T>(value: T): Stamped<T> {
    return { createdAt: this.now(), value };
  }

  /**
   * Starts a write and remembers it so flush()/close() wait for it. After close() the write is skipped: late
   * cache or timing writes (e.g. from a model call finishing during shutdown) must not surface as LMDB errors.
   */
  private track(write: () => Promise<unknown>): Promise<void> {
    if (this.closed) return Promise.resolve();
    let started: Promise<unknown>;
    try {
      started = write();
    } catch (error) {
      started = Promise.reject(error);
    }
    const promise = started.then(() => undefined);
    this.pending.add(promise);
    const done = () => this.pending.delete(promise);
    promise.then(done, done);
    return promise;
  }

  /** Runs `task` after every earlier serialised task for this session, whether those succeeded or not. */
  private serialised(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.sessionQueues.get(sessionId) ?? Promise.resolve();
    if (this.closed) return Promise.resolve();
    const run = previous.then(task, task);
    const tail = run.catch(() => undefined);
    this.sessionQueues.set(sessionId, tail);
    void tail.then(() => {
      if (this.sessionQueues.get(sessionId) === tail) this.sessionQueues.delete(sessionId);
    });
    return this.track(() => run);
  }

  private prefixRange(sessionId: string) {
    return { start: `${sessionId}${SEP}`, end: `${sessionId}${SEP}￿` };
  }

  private requireSession(id: string): Session {
    const session = this.getSession(id);
    if (!session) throw new Error(`No review session with id "${id}"`);
    return session;
  }
}
