import type { CachePruneResult, ReviewStore } from '../store';

export const DEFAULT_RETENTION_DAYS = 30;

export class CommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CommandError';
  }
}

/** Accepts `--days=N` or `--days N`. */
export function parseDays(args: string[]): number {
  let raw: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg.startsWith('--days=')) raw = arg.slice('--days='.length);
    else if (arg === '--days') raw = args[++i];
  }
  if (raw === undefined) return DEFAULT_RETENTION_DAYS;
  const days = Number(raw);
  if (!Number.isFinite(days) || days < 1) {
    throw new CommandError(`--days must be a number of at least 1 (got "${raw}")`);
  }
  return days;
}

export interface CleanupDeps {
  store: Pick<ReviewStore, 'cleanupOlderThan'>;
  /** Removes stale downloaded repository snapshots; resolves to the number removed. Not run on a dry run. */
  pruneRepos?: () => Promise<number>;
}

function cacheLine(caches: CachePruneResult, dryRun: boolean): string | null {
  const total = caches.reports + caches.batches + caches.impacts;
  if (total === 0) return null;
  const parts = `${caches.reports} cached review(s), ${caches.batches} cached batch(es), ${caches.impacts} impact entr(ies)`;
  return dryRun ? `Would prune ${parts}.` : `Pruned ${parts}.`;
}

/**
 * `ghr cleanup [--days=N] [--dry-run]`: removes sessions not touched in N days, cache entries older than that,
 * and (when wired) stale repository snapshots.
 */
export async function cleanupCommand(args: string[], deps: CleanupDeps): Promise<string> {
  const days = parseDays(args);
  const dryRun = args.includes('--dry-run');
  const { sessions: ids, caches } = await deps.store.cleanupOlderThan(days, { dryRun });
  const repos = !dryRun && deps.pruneRepos ? await deps.pruneRepos() : 0;

  const lines: string[] = [];
  if (ids.length > 0) {
    lines.push(
      dryRun
        ? `Would delete ${ids.length} session(s) older than ${days} day(s) (dry run, nothing removed):`
        : `Deleted ${ids.length} session(s) older than ${days} day(s):`,
      ...ids.slice(0, 20).map(id => `  ${id}`),
    );
    if (ids.length > 20) lines.push(`  ... and ${ids.length - 20} more`);
  }
  const cacheText = cacheLine(caches, dryRun);
  if (cacheText) lines.push(cacheText);
  if (repos > 0) lines.push(`Removed ${repos} cached repository snapshot(s).`);
  if (lines.length === 0) return `Nothing to clean up: no sessions or cache entries older than ${days} day(s).`;
  if (ids.length === 0) lines.unshift(`No sessions older than ${days} day(s).`);
  return lines.join('\n');
}
