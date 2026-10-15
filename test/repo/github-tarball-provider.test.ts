import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { c as createTar } from 'tar';
import { cacheKey, GitHubTarballProvider, pruneTarballCache } from '../../src/repo/github-tarball-provider';
import { writeFixture } from '../impact/fixture';

let work: string;
let archive: Buffer;

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), 'ghr-tarball-'));
  // GitHub tarballs wrap everything in one top-level `owner-repo-sha/` directory.
  const src = writeFixture({ 'src/a.ts': 'export const a = 1;\n', 'src/b.ts': "import { a } from './a';\n", '.review/r.md': '# rule\n' });
  const wrapped = join(work, 'wrap');
  const { renameSync, mkdirSync } = await import('node:fs');
  mkdirSync(wrapped);
  renameSync(src.root, join(wrapped, 'acme-demo-abc123'));
  const file = join(work, 'repo.tar.gz');
  await createTar({ gzip: true, file, cwd: wrapped }, ['acme-demo-abc123']);
  archive = readFileSync(file);
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

interface Req {
  url: string;
  headers: Record<string, string>;
}

function server(opts: { contentLength?: string } = {}) {
  const requests: Req[] = [];
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.startsWith('https://api.example.com/')) {
      return new Response(null, { status: 302, headers: { location: 'https://codeload.example.com/acme/demo/tar.gz/abc123' } });
    }
    const headers: Record<string, string> = { 'content-type': 'application/x-gzip' };
    if (opts.contentLength) headers['content-length'] = opts.contentLength;
    return new Response(new Uint8Array(archive), { status: 200, headers });
  };
  return { fetch: fetchImpl as unknown as typeof fetch, requests };
}

const base = { owner: 'acme', repo: 'demo', sha: 'abc123', token: 'tkn', apiUrl: 'https://api.example.com' };

describe('GitHubTarballProvider', () => {
  test('downloads, follows the redirect without leaking the token, extracts and serves files', async () => {
    const cacheRoot = join(work, 'cache1');
    const s = server();
    const p = await GitHubTarballProvider.create({ ...base, cacheRoot, fetch: s.fetch, now: () => 1_000 });
    expect(p.downloaded).toBe(true);
    expect(s.requests[0]?.url).toBe('https://api.example.com/repos/acme/demo/tarball/abc123');
    expect(s.requests[0]?.headers.Authorization).toBe('Bearer tkn');
    expect(s.requests[1]?.url).toBe('https://codeload.example.com/acme/demo/tar.gz/abc123');
    expect(s.requests[1]?.headers.Authorization).toBeUndefined();
    expect(p.dir).toBe(join(cacheRoot, cacheKey('acme', 'demo', 'abc123')));
    expect(await p.listFiles()).toEqual(['src/a.ts', 'src/b.ts']);
    expect(await p.readFile('src/a.ts')).toBe('export const a = 1;\n');
    expect(await p.repoHash()).toBe('abc123');
    expect((await p.listRuleFiles()).map(r => r.path)).toEqual(['.review/r.md']);
    expect(existsSync(join(cacheRoot, `${cacheKey('acme', 'demo', 'abc123')}.meta.json`))).toBe(true);
  });

  test('reuses the cache within the TTL and re-downloads after it', async () => {
    const cacheRoot = join(work, 'cache2');
    const s = server();
    let clock = 0;
    const opts = { ...base, cacheRoot, fetch: s.fetch, now: () => clock };
    await GitHubTarballProvider.create(opts);
    expect(s.requests).toHaveLength(2);

    clock = 5 * 60 * 60 * 1000;
    const hit = await GitHubTarballProvider.create(opts);
    expect(hit.downloaded).toBe(false);
    expect(s.requests).toHaveLength(2);
    expect(await hit.readFile('src/b.ts')).toContain('./a');

    clock = 7 * 60 * 60 * 1000;
    const miss = await GitHubTarballProvider.create(opts);
    expect(miss.downloaded).toBe(true);
    expect(s.requests).toHaveLength(4);
  });

  test('refuses archives over the size limit', async () => {
    const cacheRoot = join(work, 'cache3');
    const big = server({ contentLength: String(300 * 1024 * 1024) });
    await expect(GitHubTarballProvider.create({ ...base, cacheRoot, fetch: big.fetch })).rejects.toThrow(/over the 200 MB limit/);
    expect(existsSync(join(cacheRoot, cacheKey('acme', 'demo', 'abc123')))).toBe(false);
    // Also enforced while streaming when content-length is missing or understated.
    await expect(GitHubTarballProvider.create({ ...base, cacheRoot, fetch: server().fetch, maxBytes: 10 })).rejects.toThrow(/exceeded/);
  });

  test('surfaces HTTP errors and cleans up ephemeral checkouts', async () => {
    const cacheRoot = join(work, 'cache4');
    const failing = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(GitHubTarballProvider.create({ ...base, cacheRoot, fetch: failing })).rejects.toThrow(/HTTP 404/);

    const p = await GitHubTarballProvider.create({ ...base, cacheRoot, fetch: server().fetch, ephemeral: true });
    expect(existsSync(p.dir)).toBe(true);
    await p.cleanup();
    expect(existsSync(p.dir)).toBe(false);
  });
});

describe('pruneTarballCache', () => {
  test('removes stale, unmarked and leftover staging dirs; keeps fresh ones and foreign entries', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ghr-prune-'));
    try {
      const now = 1_000_000_000;
      const fresh = cacheKey('o', 'r', 'fresh');
      const stale = cacheKey('o', 'r', 'stale');
      const noMeta = cacheKey('o', 'r', 'nometa');
      const orphan = cacheKey('o', 'r', 'orphan');
      for (const key of [fresh, stale, noMeta]) mkdirSync(join(root, key));
      writeFileSync(join(root, `${fresh}.meta.json`), JSON.stringify({ createdAt: now - 1000 }));
      writeFileSync(join(root, `${stale}.meta.json`), JSON.stringify({ createdAt: now - 10_000 }));
      writeFileSync(join(root, `${orphan}.meta.json`), JSON.stringify({ createdAt: now }));
      mkdirSync(join(root, `${fresh}.1-2.partial`));
      mkdirSync(join(root, 'someone-elses-dir'));

      // The staging dir's mtime is wall-clock time, far after the fake clock, so it is not stale yet.
      expect(await pruneTarballCache(root, 5000, now)).toBe(2);
      expect(existsSync(join(root, fresh))).toBe(true);
      expect(existsSync(join(root, stale))).toBe(false);
      expect(existsSync(join(root, `${stale}.meta.json`))).toBe(false);
      expect(existsSync(join(root, noMeta))).toBe(false);
      expect(existsSync(join(root, `${orphan}.meta.json`))).toBe(false);
      expect(existsSync(join(root, `${fresh}.1-2.partial`))).toBe(true);
      expect(existsSync(join(root, 'someone-elses-dir'))).toBe(true);

      expect(await pruneTarballCache(root, 5000, Date.now() + 10_000)).toBe(2); // fresh + staging now stale
      expect(await pruneTarballCache(join(root, 'missing'))).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
