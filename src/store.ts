import { createHash } from 'node:crypto';
import { open, type RootDatabase } from 'lmdb';
import type { Config } from './config';
import type { ChangeSet, ReviewReport } from './types';

export interface ReportCache {
  get(key: string): ReviewReport | undefined;
  put(key: string, report: ReviewReport): Promise<void>;
  close(): Promise<void>;
}

/**
 * Same PR + same head commit + same models + same persona = same review.
 * Re-running a workflow on an unchanged commit then costs nothing.
 */
export function cacheKey(changeSet: ChangeSet, config: Pick<Config, 'tiers' | 'stageTiers' | 'persona'>): string {
  const id = changeSet.pull
    ? `gh:${changeSet.pull.owner}/${changeSet.pull.repo}#${changeSet.pull.number}`
    : `local:${changeSet.baseRef}`;
  const settings = createHash('sha256')
    .update(JSON.stringify([config.tiers, config.stageTiers, config.persona]))
    .digest('hex')
    .slice(0, 12);
  return `${id}@${changeSet.headSha}:${settings}`;
}

export class LmdbReportCache implements ReportCache {
  private readonly db: RootDatabase<ReviewReport, string>;

  constructor(path: string) {
    this.db = open<ReviewReport, string>({ path, compression: true });
  }

  get(key: string): ReviewReport | undefined {
    return this.db.get(key);
  }

  async put(key: string, report: ReviewReport): Promise<void> {
    await this.db.put(key, report);
  }

  close(): Promise<void> {
    return this.db.close();
  }
}
