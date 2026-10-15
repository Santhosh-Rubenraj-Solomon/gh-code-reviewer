import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { splitUnifiedDiff } from '../diff';
import type { ChangedFile, ChangeSet } from '../types';

export type GitRunner = (args: string[], cwd: string) => string;

export const runGit: GitRunner = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

export interface LocalOptions {
  base?: string;
  cwd?: string;
  git?: GitRunner;
}

/** Larger files are listed but their content is not loaded or reviewed. */
export const MAX_FILE_BYTES = 1024 * 1024;
/** git's well-known id for the empty tree, used as the base when there is no parent commit. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

const BINARY_EXTENSIONS = new Set([
  ...['png', 'jpg', 'jpeg', 'gif', 'bmp', 'ico', 'webp', 'tiff', 'psd', 'heic'],
  ...['woff', 'woff2', 'ttf', 'otf', 'eot'],
  ...['zip', 'gz', 'tgz', 'tar', 'bz2', 'xz', '7z', 'rar', 'jar', 'war'],
  ...['exe', 'dll', 'so', 'dylib', 'a', 'o', 'class', 'bin', 'wasm', 'node'],
  ...['mp3', 'mp4', 'wav', 'ogg', 'flac', 'mov', 'avi', 'mkv', 'webm'],
  ...['pdf', 'sqlite', 'db', 'mdb'],
]);

export function isBinaryPath(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot !== -1 && BINARY_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function sizeIfExists(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

function tryGit(git: GitRunner, args: string[], cwd: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

/**
 * Flags for every `git diff` we parse: user config such as an external diff tool, color, `diff.noprefix` or
 * `diff.mnemonicPrefix` would otherwise change the output format the parser expects.
 */
export const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '--find-renames'];

/**
 * The repository's top-level directory for `cwd`. Diff paths are relative to it, so file reads and untracked
 * listings must be too; otherwise running from a subdirectory finds nothing. Falls back to `cwd` when git cannot
 * answer, so the real git error surfaces from the command that needs a repository.
 */
export function repoRoot(cwd: string, git: GitRunner = runGit): string {
  return tryGit(git, ['rev-parse', '--show-toplevel'], cwd)?.trim() || cwd;
}

/** Content of `path` at `rev`, or undefined when git cannot show it or it is over MAX_FILE_BYTES. */
function contentAt(git: GitRunner, cwd: string, rev: string, path: string): string | undefined {
  const text = tryGit(git, ['show', `${rev}:${path}`], cwd);
  return text !== null && Buffer.byteLength(text) <= MAX_FILE_BYTES ? text : undefined;
}

/**
 * Reviews committed work on the current branch against the merge base with `base`.
 * Content comes from HEAD, not the working tree, so uncommitted edits cannot leak into a review of commits.
 * Binary files are left out; files over 1 MB are listed without content.
 */
export function loadLocalChanges(options: LocalOptions = {}): ChangeSet {
  const git = options.git ?? runGit;
  const cwd = repoRoot(options.cwd ?? process.cwd(), git);
  const base = options.base ?? 'origin/main';

  const mergeBase = git(['merge-base', base, 'HEAD'], cwd).trim();
  const headSha = git(['rev-parse', 'HEAD'], cwd).trim();
  const diff = git(['diff', ...DIFF_FLAGS, mergeBase, 'HEAD'], cwd);
  const subject = git(['log', '-1', '--format=%s'], cwd).trim();
  const body = git(['log', `${mergeBase}..HEAD`, '--format=- %s'], cwd).trim();

  const files = splitUnifiedDiff(diff).filter(f => !isBinaryPath(f.path));
  for (const file of files) {
    if (file.status !== 'removed') file.content = contentAt(git, cwd, 'HEAD', file.path);
  }

  return {
    source: 'local',
    title: subject || `Changes since ${base}`,
    description: body,
    baseRef: base,
    headSha,
    files,
  };
}

// ---- uncommitted changes ----------------------------------------------------

export interface WorkingTreeOptions {
  cwd?: string;
  git?: GitRunner;
  readText?: (path: string) => string | null;
  fileSize?: (path: string) => number | null;
  title?: string;
  description?: string;
}

/** An untracked file shown as a diff that adds every line. */
export function addedFileDiff(path: string, text: string): ChangedFile {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  const lines = text === '' ? [] : body.split('\n');
  const patch = lines.length === 0 ? '' : [`@@ -0,0 +1,${lines.length} @@`, ...lines.map(l => `+${l}`)].join('\n');
  return { path, status: 'added', patch, additions: lines.length, deletions: 0, content: text };
}

/**
 * Staged and unstaged edits relative to HEAD, plus untracked files (respecting .gitignore).
 * Binary files are left out; files over 1 MB are listed without content.
 */
export function loadWorkingTreeChanges(options: WorkingTreeOptions = {}): ChangeSet {
  const git = options.git ?? runGit;
  const cwd = repoRoot(options.cwd ?? process.cwd(), git);
  const read = options.readText ?? readIfExists;
  const size = options.fileSize ?? sizeIfExists;

  const head = tryGit(git, ['rev-parse', '--verify', '-q', 'HEAD'], cwd)?.trim() || null;
  const branch = tryGit(git, ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)?.trim() || 'HEAD';
  // `git diff <commit>` compares the working tree (staged and unstaged together) with that commit.
  const diff = git(['diff', ...DIFF_FLAGS, head ?? EMPTY_TREE], cwd);

  const files: ChangedFile[] = [];
  for (const file of splitUnifiedDiff(diff)) {
    if (isBinaryPath(file.path)) continue;
    if (file.status !== 'removed') {
      const bytes = size(join(cwd, file.path));
      if (bytes !== null && bytes <= MAX_FILE_BYTES) file.content = read(join(cwd, file.path)) ?? undefined;
    }
    files.push(file);
  }

  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z'], cwd).split('\0').filter(Boolean);
  for (const path of untracked) {
    if (isBinaryPath(path)) continue;
    const bytes = size(join(cwd, path));
    if (bytes !== null && bytes > MAX_FILE_BYTES) {
      files.push({ path, status: 'added', patch: '', additions: 0, deletions: 0 });
      continue;
    }
    const text = read(join(cwd, path));
    if (text !== null) files.push(addedFileDiff(path, text));
  }

  return {
    source: 'local',
    title: options.title ?? `Uncommitted changes on ${branch}`,
    description: options.description ?? '',
    baseRef: 'HEAD',
    headSha: head ?? 'initial',
    files,
  };
}

// ---- explicit commits -------------------------------------------------------

export interface CommitOptions {
  cwd?: string;
  git?: GitRunner;
  shas: string[];
}

function resolveCommit(git: GitRunner, cwd: string, sha: string): string {
  const resolved = tryGit(git, ['rev-parse', '--verify', '-q', `${sha}^{commit}`], cwd)?.trim();
  if (!resolved) throw new Error(`"${sha}" is not a commit in this repository`);
  return resolved;
}

function isAncestor(git: GitRunner, cwd: string, a: string, b: string): boolean {
  return tryGit(git, ['merge-base', '--is-ancestor', a, b], cwd) !== null;
}

/** Oldest first. Commit time decides; ancestry breaks ties between commits made in the same second. */
export function orderCommits(git: GitRunner, cwd: string, shas: string[]): string[] {
  const time = new Map(shas.map(s => [s, Number(git(['show', '-s', '--format=%ct', s], cwd).trim())]));
  return [...shas].sort((a, b) => {
    const dt = time.get(a)! - time.get(b)!;
    if (dt !== 0) return dt;
    if (isAncestor(git, cwd, a, b)) return -1;
    if (isAncestor(git, cwd, b, a)) return 1;
    return 0;
  });
}

/**
 * Reviews the range covered by the selected commits: from the parent of the oldest to the newest.
 * Selection order does not matter; commits between the selected ones are part of the range.
 */
export function loadCommitChanges(options: CommitOptions): ChangeSet {
  const git = options.git ?? runGit;
  const cwd = repoRoot(options.cwd ?? process.cwd(), git);
  if (options.shas.length === 0) throw new Error('Select at least one commit to review');

  const resolved = [...new Set(options.shas.map(s => resolveCommit(git, cwd, s.trim())))];
  const ordered = orderCommits(git, cwd, resolved);
  const oldest = ordered[0]!;
  const newest = ordered[ordered.length - 1]!;
  const base = tryGit(git, ['rev-parse', '--verify', '-q', `${oldest}^`], cwd)?.trim() || EMPTY_TREE;

  const diff = git(['diff', ...DIFF_FLAGS, base, newest], cwd);
  const files = splitUnifiedDiff(diff).filter(f => !isBinaryPath(f.path));
  for (const file of files) {
    if (file.status !== 'removed') file.content = contentAt(git, cwd, newest, file.path);
  }

  const subjects = ordered.map(s => git(['log', '-1', '--format=%s', s], cwd).trim());
  const rangeArg = base === EMPTY_TREE ? newest : `${base}..${newest}`;
  const inRange = Number(git(['rev-list', '--count', rangeArg], cwd).trim());
  const lines = subjects.map((s, i) => `- ${ordered[i]!.slice(0, 7)} ${s}`);
  if (inRange > ordered.length) {
    lines.push(`(the range also includes ${inRange - ordered.length} commit(s) between the selected ones)`);
  }

  return {
    source: 'local',
    title: ordered.length === 1 ? subjects[0]! : `${ordered.length} commits: ${subjects[subjects.length - 1]}`,
    description: lines.join('\n'),
    baseRef: base,
    headSha: newest,
    files,
  };
}

// ---- commit picker ----------------------------------------------------------

export interface CommitInfo {
  sha: string;
  shortSha: string;
  /** At most 60 characters. */
  subject: string;
  relativeDate: string;
  timestamp: number;
}

export const BASE_CANDIDATES = ['origin/main', 'origin/master', 'main', 'master'];

export function truncateSubject(subject: string, max = 60): string {
  return subject.length <= max ? subject : `${subject.slice(0, max - 1)}…`;
}

/** Commits on HEAD that are not on the base branch, newest first, for interactive selection. */
export function listUnmergedCommits(options: { cwd?: string; git?: GitRunner } = {}): {
  base: string;
  commits: CommitInfo[];
} {
  const git = options.git ?? runGit;
  const cwd = repoRoot(options.cwd ?? process.cwd(), git);
  const base = BASE_CANDIDATES.find(b => tryGit(git, ['rev-parse', '--verify', '-q', `${b}^{commit}`], cwd)?.trim());
  if (!base) throw new Error(`No base branch found (looked for ${BASE_CANDIDATES.join(', ')})`);

  const out = git(['log', `${base}..HEAD`, '--format=%H%x1f%h%x1f%s%x1f%cr%x1f%ct%x1e'], cwd);
  const commits = out
    .split('\x1e')
    .map(r => r.trim())
    .filter(Boolean)
    .map(record => {
      const [sha = '', shortSha = '', subject = '', relativeDate = '', ct = '0'] = record.split('\x1f');
      return { sha, shortSha, subject: truncateSubject(subject), relativeDate, timestamp: Number(ct) * 1000 };
    });
  return { base, commits };
}
