import { createHash } from 'node:crypto';
import { open, type RootDatabase } from 'lmdb';
import type { Config } from '../config';
import type { ChangeSet, ReviewReport } from '../types';

export interface ReportCache {
  get(key: string): ReviewReport | undefined;
  put(key: string, report: ReviewReport): Promise<void>;
  close(): Promise<void>;
}

export type CacheKeyConfig = Pick<Config, 'tiers' | 'stageTiers' | 'persona'> &
  Partial<Pick<Config, 'skipValidation' | 'impact'>>;

/** Cached values are stored with their write time so cleanup can age them out. */
export interface Stamped<T> {
  createdAt: number;
  value: T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Reads a stamped entry, or an entry written before stamps existed (createdAt unknown, reported as 0). */
export function unstamp(raw: unknown): Stamped<unknown> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (isRecord(raw) && typeof raw.createdAt === 'number' && 'value' in raw && Object.keys(raw).length === 2) {
    return { createdAt: raw.createdAt, value: raw.value };
  }
  return { createdAt: 0, value: raw };
}

/** Loose shape check: a cached report is whatever the pipeline wrote, but never a scalar or list. */
export function isReviewReport(value: unknown): value is ReviewReport {
  return isRecord(value);
}

/**
 * Same PR + same head commit + same models + same persona + same review settings and rules = same review.
 * Re-running a workflow on an unchanged commit then costs nothing.
 * Local reviews also hash the diff itself: uncommitted edits keep the same HEAD but are a different review.
 * `rulesFingerprint` is a caller-supplied digest of the repo's review rule files, so editing a rule invalidates.
 * `extra` is any further JSON-serialisable input that shapes the review (PR text, security contexts, limits,
 * prompt versions); leaving it out yields the same key as before it existed.
 */
export function cacheKey(
  changeSet: ChangeSet,
  config: CacheKeyConfig,
  rulesFingerprint?: string,
  extra?: unknown,
): string {
  const id = changeSet.pull
    ? `gh:${changeSet.pull.owner}/${changeSet.pull.repo}#${changeSet.pull.number}`
    : `local:${changeSet.baseRef}`;
  const content = changeSet.pull ? null : changeSet.files.map(f => [f.path, f.status, f.patch]);
  const parts: unknown[] = [
    config.tiers,
    config.stageTiers,
    config.persona,
    content,
    config.skipValidation ?? false,
    config.impact?.enabled ?? null,
    rulesFingerprint ?? null,
  ];
  if (extra !== undefined) parts.push(extra);
  const settings = createHash('sha256')
    .update(JSON.stringify(parts))
    .digest('hex')
    .slice(0, 12);
  return `${id}@${changeSet.headSha}:${settings}`;
}

/** Standalone report cache in its own LMDB environment. ReviewStore offers the same API alongside sessions. */
export class LmdbReportCache implements ReportCache {
  private readonly db: RootDatabase<unknown, string>;
  private readonly now: () => number;

  constructor(path: string, now: () => number = Date.now) {
    this.db = open<unknown, string>({ path, compression: true });
    this.now = now;
  }

  get(key: string): ReviewReport | undefined {
    const entry = unstamp(this.db.get(key));
    return entry && isReviewReport(entry.value) ? entry.value : undefined;
  }

  async put(key: string, report: ReviewReport): Promise<void> {
    const entry: Stamped<ReviewReport> = { createdAt: this.now(), value: report };
    await this.db.put(key, entry);
  }

  close(): Promise<void> {
    return this.db.close();
  }
}
