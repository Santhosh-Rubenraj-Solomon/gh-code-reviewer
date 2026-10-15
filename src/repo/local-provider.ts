import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { SOURCE_EXTENSIONS } from '../impact/parser';
import type { RepoFileProvider } from './provider';

export type AsyncGitRunner = (args: string[], cwd: string) => Promise<string>;

const execFileAsync = promisify(execFile);
export const runGitAsync: AsyncGitRunner = async (args, cwd) =>
  (await execFileAsync('git', args, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })).stdout;

export const MAX_FILE_BYTES = 512 * 1024;

export const IGNORED_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'vendor',
  'Pods',
  '__pycache__',
  'coverage',
]);

export interface LocalProviderOptions {
  git?: AsyncGitRunner;
  maxFileBytes?: number;
  extensions?: readonly string[];
}

const toPosix = (p: string) => p.split(sep).join('/');

export class LocalRepoProvider implements RepoFileProvider {
  private readonly root: string;
  private readonly git: AsyncGitRunner;
  private readonly maxFileBytes: number;
  private readonly extensions: Set<string>;
  private readonly cache = new Map<string, string | null>();
  private listing: Promise<string[]> | null = null;
  private allListing: Promise<string[]> | null = null;
  private realRoot: Promise<string> | null = null;

  constructor(root: string, options: LocalProviderOptions = {}) {
    this.root = resolve(root);
    this.git = options.git ?? runGitAsync;
    this.maxFileBytes = options.maxFileBytes ?? MAX_FILE_BYTES;
    this.extensions = new Set(options.extensions ?? SOURCE_EXTENSIONS);
  }

  listFiles(): Promise<string[]> {
    this.listing ??= this.walk('').then(files => files.sort());
    return this.listing;
  }

  /**
   * Every file in the repository regardless of extension (verify-rules needs configs, docs, workflows...).
   * In a git checkout this is tracked plus untracked-but-not-gitignored files; otherwise a walk that skips `.git`.
   * Either way the IGNORED_DIRS (node_modules, dist, ...) are left out.
   */
  listAllFiles(): Promise<string[]> {
    this.allListing ??= this.listAllUncached().then(files => [...new Set(files)].sort());
    return this.allListing;
  }

  private async listAllUncached(): Promise<string[]> {
    let out: string | null = null;
    try {
      out = await this.git(['ls-files', '-z', '--cached', '--others', '--exclude-standard'], this.root);
    } catch {
      // Not a git checkout (or git missing): walk the tree instead.
    }
    if (out === null) return this.walkAll('');
    const listed = out.split('\0').filter(p => p && !p.split('/').some(seg => IGNORED_DIRS.has(seg)));
    // The index can still list files deleted from the working tree; only report what exists.
    const exists = await Promise.all(listed.map(p => stat(join(this.root, p)).then(i => i.isFile(), () => false)));
    return listed.filter((_, i) => exists[i]);
  }

  private async walkAll(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(join(this.root, dir), { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (entry.name === '.git' || IGNORED_DIRS.has(entry.name)) continue;
        out.push(...(await this.walkAll(rel)));
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
    return out;
  }

  private async walk(dir: string): Promise<string[]> {
    let entries;
    try {
      entries = await readdir(join(this.root, dir), { withFileTypes: true });
    } catch {
      return [];
    }
    const out: string[] = [];
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      // Symlinks are skipped so the walk cannot loop or wander outside the repository.
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
        out.push(...(await this.walk(rel)));
      } else if (entry.isFile() && this.hasSourceExtension(entry.name)) {
        out.push(rel);
      }
    }
    return out;
  }

  private hasSourceExtension(name: string): boolean {
    const dot = name.lastIndexOf('.');
    return dot > 0 && this.extensions.has(name.slice(dot).toLowerCase());
  }

  /** Absolute path for a repo-relative path, or null when it escapes the root. */
  private inside(path: string): string | null {
    if (!path || isAbsolute(path) || path.includes('\0')) return null;
    const abs = resolve(this.root, path);
    const rel = relative(this.root, abs);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
    return abs;
  }

  async readFile(path: string): Promise<string | null> {
    const key = toPosix(path);
    if (this.cache.has(key)) return this.cache.get(key) ?? null;
    const content = await this.load(key);
    this.cache.set(key, content);
    return content;
  }

  private async load(path: string): Promise<string | null> {
    const abs = this.inside(path);
    if (!abs) return null;
    try {
      // Resolve symlinks too: a link inside the repo must not expose files outside it.
      this.realRoot ??= realpath(this.root);
      const real = await realpath(abs);
      const rel = relative(await this.realRoot, real);
      if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
      const info = await stat(real);
      if (!info.isFile() || info.size > this.maxFileBytes) return null;
      return await readFile(real, 'utf8');
    } catch {
      return null;
    }
  }

  async repoHash(): Promise<string> {
    try {
      const sha = (await this.git(['rev-parse', 'HEAD'], this.root)).trim();
      if (sha) return sha;
    } catch {
      // Not a git checkout; fall through to a content-derived fingerprint.
    }
    const hash = createHash('sha256');
    for (const file of await this.listFiles()) {
      const info = await stat(join(this.root, file)).catch(() => null);
      hash.update(`${file}:${info?.size ?? 0}:${info?.mtimeMs ?? 0}\n`);
    }
    return `worktree-${hash.digest('hex').slice(0, 16)}`;
  }

  async listRuleFiles(): Promise<{ path: string; content: string }[]> {
    const paths: string[] = [];
    try {
      const entries = await readdir(join(this.root, '.review'), { withFileTypes: true });
      for (const e of entries) if (e.isFile() && e.name.toLowerCase().endsWith('.md')) paths.push(`.review/${e.name}`);
    } catch {
      // No .review directory.
    }
    paths.sort();
    paths.push('.github/code-review.md');

    const out: { path: string; content: string }[] = [];
    for (const path of paths) {
      const content = await this.readFile(path);
      if (content !== null) out.push({ path, content });
    }
    return out;
  }
}
