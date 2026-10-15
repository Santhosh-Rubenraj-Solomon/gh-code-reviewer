import { createHash } from 'node:crypto';
import { createWriteStream, type Dirent } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { x as extractTar } from 'tar';
import { LocalRepoProvider, type LocalProviderOptions } from './local-provider';
import type { RepoFileProvider } from './provider';

export const DEFAULT_CACHE_ROOT = join(tmpdir(), 'gh-code-reviewer', 'repos');
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
export const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024;
const MAX_REDIRECTS = 5;

export interface TarballProviderOptions extends LocalProviderOptions {
  owner: string;
  repo: string;
  /** Commit sha (or ref) to fetch. A sha is strongly preferred: the cache assumes the content never changes. */
  sha: string;
  token?: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  cacheRoot?: string;
  ttlMs?: number;
  maxBytes?: number;
  now?: () => number;
  /** Delete the extracted tree on cleanup() instead of keeping it for later runs. */
  ephemeral?: boolean;
}

interface CacheMeta {
  createdAt: number;
  owner: string;
  repo: string;
  sha: string;
}

export function cacheKey(owner: string, repo: string, sha: string): string {
  return createHash('sha256').update(`${owner}/${repo}@${sha}`).digest('hex').slice(0, 32);
}

/** Repository access for runs outside a checkout: downloads the GitHub tarball once and serves files from disk. */
export class GitHubTarballProvider implements RepoFileProvider {
  private constructor(
    private readonly local: LocalRepoProvider,
    private readonly sha: string,
    readonly dir: string,
    private readonly ephemeral: boolean,
    /** True when the archive was downloaded during create(); false on a cache hit. */
    readonly downloaded: boolean,
  ) {}

  static async create(options: TarballProviderOptions): Promise<GitHubTarballProvider> {
    const cacheRoot = options.cacheRoot ?? DEFAULT_CACHE_ROOT;
    const now = options.now ?? Date.now;
    const key = cacheKey(options.owner, options.repo, options.sha);
    const dir = join(cacheRoot, key);
    const metaPath = join(cacheRoot, `${key}.meta.json`);

    let downloaded = false;
    if (!(await isFresh(metaPath, now(), options.ttlMs ?? CACHE_TTL_MS))) {
      await mkdir(cacheRoot, { recursive: true });
      await download(options, cacheRoot, key, dir);
      const meta: CacheMeta = { createdAt: now(), owner: options.owner, repo: options.repo, sha: options.sha };
      await writeFile(metaPath, JSON.stringify(meta));
      downloaded = true;
    }
    const local = new LocalRepoProvider(dir, { ...options, git: async () => options.sha });
    return new GitHubTarballProvider(local, options.sha, dir, options.ephemeral ?? false, downloaded);
  }

  listFiles(): Promise<string[]> {
    return this.local.listFiles();
  }

  readFile(path: string): Promise<string | null> {
    return this.local.readFile(path);
  }

  async repoHash(): Promise<string> {
    return this.sha;
  }

  listRuleFiles(): Promise<{ path: string; content: string }[]> {
    return this.local.listRuleFiles();
  }

  async cleanup(): Promise<void> {
    if (!this.ephemeral) return;
    await rm(this.dir, { recursive: true, force: true });
    await rm(`${this.dir}.meta.json`, { force: true });
  }
}

const KEY_DIR = /^[0-9a-f]{32}$/;
const STAGING_DIR = /^[0-9a-f]{32}\..+\.partial$/;

/**
 * Removes extracted snapshots older than `maxAgeMs` (or with missing/broken metadata) and staging dirs left by
 * interrupted downloads. Returns how many directories were removed. A missing cache root is not an error.
 */
export async function pruneTarballCache(
  root: string = DEFAULT_CACHE_ROOT,
  maxAgeMs: number = CACHE_TTL_MS,
  now: number = Date.now(),
): Promise<number> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  const dirs = new Set(entries.filter(e => e.isDirectory()).map(e => e.name));
  let removed = 0;
  for (const name of dirs) {
    const dir = join(root, name);
    let stale: boolean;
    if (KEY_DIR.test(name)) stale = !(await isFresh(`${dir}.meta.json`, now, maxAgeMs));
    else if (STAGING_DIR.test(name)) stale = now - (await stat(dir)).mtimeMs >= maxAgeMs;
    else continue; // not ours
    if (!stale) continue;
    await rm(dir, { recursive: true, force: true });
    if (KEY_DIR.test(name)) await rm(`${dir}.meta.json`, { force: true });
    removed++;
  }
  // Metadata whose tree is already gone would only make a later run think the cache is warm.
  for (const entry of entries) {
    const key = entry.name.endsWith('.meta.json') ? entry.name.slice(0, -'.meta.json'.length) : null;
    if (entry.isFile() && key && KEY_DIR.test(key) && !dirs.has(key)) await rm(join(root, entry.name), { force: true });
  }
  return removed;
}

async function isFresh(metaPath: string, now: number, ttlMs: number): Promise<boolean> {
  try {
    const meta = JSON.parse(await readFile(metaPath, 'utf8')) as Partial<CacheMeta>;
    return typeof meta.createdAt === 'number' && now - meta.createdAt < ttlMs;
  } catch {
    return false;
  }
}

async function fetchArchive(options: TarballProviderOptions): Promise<Response> {
  const doFetch = options.fetch ?? fetch;
  const api = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '');
  let url = `${api}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}/tarball/${encodeURIComponent(options.sha)}`;
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'gh-code-reviewer',
  };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;

  // Redirects are followed by hand: GitHub answers with a signed codeload URL, which must not receive the token.
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const res = await doFetch(url, { headers: hop === 0 ? headers : { 'User-Agent': headers['User-Agent'] ?? '' }, redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url).toString();
      continue;
    }
    if (!res.ok) throw new Error(`Tarball download failed for ${options.owner}/${options.repo}@${options.sha}: HTTP ${res.status}`);
    return res;
  }
  throw new Error(`Tarball download for ${options.owner}/${options.repo} redirected too many times`);
}

async function download(options: TarballProviderOptions, cacheRoot: string, key: string, dir: string): Promise<void> {
  const maxBytes = options.maxBytes ?? MAX_ARCHIVE_BYTES;
  const res = await fetchArchive(options);
  const declared = Number(res.headers.get('content-length') ?? '0');
  if (declared > maxBytes) {
    throw new Error(`Repository archive is ${Math.round(declared / 1048576)} MB, over the ${Math.round(maxBytes / 1048576)} MB limit`);
  }
  if (!res.body) throw new Error('Tarball response had no body');

  const suffix = `${process.pid}-${Date.now()}`;
  const archive = join(cacheRoot, `${key}.${suffix}.tar.gz`);
  const staging = join(cacheRoot, `${key}.${suffix}.partial`);
  try {
    await writeCapped(res.body, archive, maxBytes);
    await mkdir(staging, { recursive: true });
    await extractTar({
      file: archive,
      cwd: staging,
      strip: 1,
      // Links could point outside the tree; source analysis never needs them.
      filter: (_path, entry) => !('type' in entry) || (entry.type !== 'SymbolicLink' && entry.type !== 'Link'),
    });
    // Extract to a staging dir and rename so an interrupted run never leaves a half-filled cache entry.
    await rm(dir, { recursive: true, force: true });
    await rename(staging, dir);
  } finally {
    await rm(archive, { force: true });
    await rm(staging, { recursive: true, force: true });
  }
}

/** Streams the body to disk, aborting once it exceeds `maxBytes` (content-length may be absent or wrong). */
async function writeCapped(body: ReadableStream<Uint8Array>, path: string, maxBytes: number): Promise<void> {
  const out = createWriteStream(path);
  const reader = body.getReader();
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`Repository archive exceeded the ${Math.round(maxBytes / 1048576)} MB limit`);
      if (!out.write(value)) await new Promise<void>(r => out.once('drain', () => r()));
    }
  } catch (err) {
    await reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    await new Promise<void>((r, j) => out.end((e?: Error | null) => (e ? j(e) : r())));
  }
}
