import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

/** `uncommitted` is a review of the working tree's staged + unstaged changes. */
export type HistoryKind = 'pr' | 'local' | 'commits' | 'uncommitted';

export interface HistoryEntry {
  kind: HistoryKind;
  /** PR reference (owner/repo#12), base branch, comma-separated SHAs, or the base ref for uncommitted changes. */
  target: string;
  title?: string;
  persona?: string;
  cwd: string;
  /** ISO timestamp of the run. */
  at: string;
}

export interface HistoryIO {
  readText(path: string): string | null;
  writeText(path: string, text: string): void;
  remove(path: string): void;
}

export interface HistoryOptions {
  path?: string;
  limit?: number;
  io?: HistoryIO;
}

export const DEFAULT_HISTORY_PATH = join(homedir(), '.gh-code-reviewer', 'history.json');

const fileIO: HistoryIO = {
  readText: path => (existsSync(path) ? readFileSync(path, 'utf8') : null),
  writeText: (path, text) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  remove: path => rmSync(path, { force: true }),
};

const KINDS: readonly HistoryKind[] = ['pr', 'local', 'commits', 'uncommitted'];

function isEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== 'object' || value === null) return false;
  const e = value as Record<string, unknown>;
  const optionalString = (v: unknown) => v === undefined || typeof v === 'string';
  return (
    KINDS.includes(e.kind as HistoryKind) &&
    typeof e.target === 'string' &&
    typeof e.cwd === 'string' &&
    typeof e.at === 'string' &&
    !Number.isNaN(Date.parse(e.at)) &&
    optionalString(e.title) &&
    optionalString(e.persona)
  );
}

/** Two runs are "the same review" when re-running one would review the same thing. */
function sameReview(a: HistoryEntry, b: HistoryEntry): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'pr') return a.target === b.target;
  // The working tree of a checkout is one review target, whatever it contains right now.
  if (a.kind === 'uncommitted') return a.cwd === b.cwd;
  if (a.kind === 'local') return a.cwd === b.cwd && (a.title ?? '') === (b.title ?? '');
  return a.cwd === b.cwd && a.target === b.target;
}

/** The last few review runs, newest first, so `--rerun` can offer them. */
export class ReviewHistory {
  private readonly path: string;
  private readonly limit: number;
  private readonly io: HistoryIO;

  constructor(options: HistoryOptions = {}) {
    this.path = options.path ?? DEFAULT_HISTORY_PATH;
    this.limit = options.limit ?? 5;
    this.io = options.io ?? fileIO;
  }

  /** A file that is not valid history is discarded rather than allowed to break every run. */
  load(): HistoryEntry[] {
    const text = this.io.readText(this.path);
    if (text === null) return [];
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.every(isEntry)) return parsed.slice(0, this.limit);
    } catch {
      // fall through to the reset below
    }
    this.io.remove(this.path);
    return [];
  }

  add(entry: HistoryEntry): HistoryEntry[] {
    const entries = [entry, ...this.load().filter(e => !sameReview(e, entry))].slice(0, this.limit);
    this.io.writeText(this.path, `${JSON.stringify(entries, null, 2)}\n`);
    return entries;
  }

  latest(): HistoryEntry | undefined {
    return this.load()[0];
  }

  clear(): void {
    this.io.remove(this.path);
  }
}

export function timeAgo(then: Date, now: Date): string {
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** e.g. "[pr] owner/repo#12 (mentor) – 3h ago". */
export function labelFor(entry: HistoryEntry, now: Date = new Date()): string {
  const what =
    entry.kind === 'pr'
      ? entry.target
      : entry.kind === 'local' || entry.kind === 'uncommitted'
        ? (entry.title ?? basename(entry.cwd))
        : `${entry.title ?? basename(entry.cwd)} @ ${entry.target}`;
  const persona = entry.persona ? ` (${entry.persona})` : '';
  return `[${entry.kind}] ${what}${persona} – ${timeAgo(new Date(entry.at), now)}`;
}
