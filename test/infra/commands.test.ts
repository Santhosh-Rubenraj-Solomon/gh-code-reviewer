import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  changelogCommand,
  checkGithubCommand,
  cleanupCommand,
  CommandError,
  compareVersions,
  configShowCommand,
  maskSecret,
  sessionsCommand,
  updateCheck,
  type CheckClient,
  type ReleaseClient,
} from '../../src/commands';
import { GitHubError, type ReleaseInfo, type RepositoryInfo } from '../../src/github/client';
import { ReviewStore } from '../../src/store';

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

async function seededStore() {
  const dir = mkdtempSync(join(tmpdir(), 'ghr-cmd-'));
  dirs.push(dir);
  let clock = Date.UTC(2026, 9, 1);
  let n = 0;
  const store = new ReviewStore({ path: dir, now: () => clock, newId: () => `s${++n}` });
  const a = await store.getOrCreateSession({ key: 'a', source: { type: 'github', id: 'o/r#1', title: 'Add login flow' }, target: 'github' });
  clock += 60_000;
  const b = await store.getOrCreateSession({ key: 'b', source: { type: 'local', id: 'feature', title: 'Fix the cache' } });
  await store.saveStageData(b.id, 'fetch', { files: Array.from({ length: 12 }, (_, i) => ({ path: `f${i}.ts` })) });
  await store.setStageStatus(b.id, 'review', 'failed', 'model down');
  return { store, a, b, advance: (ms: number) => (clock += ms) };
}

describe('sessionsCommand', () => {
  test('list, filter, show and delete', async () => {
    const { store, a, b } = await seededStore();
    const list = await sessionsCommand([], { store });
    expect(list.split('\n')).toEqual([
      `${b.id}  local    2026-10-01 00:01  Fix the cache  stages 1/11 completed`,
      `${a.id}  github   2026-10-01 00:00  Add login flow  stages 0/11 completed`,
    ]);
    expect(await sessionsCommand(['ls', 'login'], { store })).toStartWith(a.id);
    expect(await sessionsCommand(['list', 'zzz'], { store })).toBe('No sessions match "zzz".');

    const show = await sessionsCommand(['show', b.id], { store });
    expect(show).toContain('source:  local feature');
    expect(show).toContain('[x] fetch        completed');
    expect(show).toContain('[!] review       failed - model down');
    expect(show).toContain('[ ] publish      pending');
    expect(show).toContain('Files (12):');
    expect(show).toContain('  f9.ts');
    expect(show).not.toContain('f10.ts');
    expect(show).toContain('... and 2 more');
    expect(await sessionsCommand(['show', 'nope'], { store })).toBe('No session with id "nope".');
    expect(await sessionsCommand(['show'], { store })).toContain('Usage:');

    expect(await sessionsCommand(['rm', a.id], { store })).toBe(`Deleted session ${a.id}.`);
    expect(await sessionsCommand(['delete', a.id], { store })).toBe(`No session with id "${a.id}".`);
    expect(await sessionsCommand(['bogus'], { store })).toContain('Usage:');
    await store.close();
  });

  test('empty store', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ghr-cmd-'));
    dirs.push(dir);
    const store = new ReviewStore({ path: dir });
    expect(await sessionsCommand(['list'], { store })).toBe('No review sessions stored yet.');
    await store.close();
  });
});

describe('cleanupCommand', () => {
  test('validates --days', async () => {
    const none = { reports: 0, batches: 0, impacts: 0 };
    const store = { cleanupOlderThan: async () => ({ sessions: [], caches: none }) };
    for (const bad of ['--days=0', '--days=abc', '--days=-3']) {
      await expect(cleanupCommand([bad], { store })).rejects.toBeInstanceOf(CommandError);
    }
    const seen: number[] = [];
    const spy = { cleanupOlderThan: async (d: number) => (seen.push(d), { sessions: [], caches: none }) };
    expect(await cleanupCommand([], { store: spy })).toBe(
      'Nothing to clean up: no sessions or cache entries older than 30 day(s).',
    );
    await cleanupCommand(['--days', '7'], { store: spy });
    expect(seen).toEqual([30, 7]);
  });

  test('dry run lists and a real run deletes', async () => {
    const { store, advance, a, b } = await seededStore();
    advance(10 * 86_400_000);
    const dry = await cleanupCommand(['--days=5', '--dry-run'], { store });
    expect(dry).toStartWith('Would delete 2 session(s) older than 5 day(s) (dry run, nothing removed):');
    expect(store.getSession(a.id)).not.toBeNull();
    const real = await cleanupCommand(['--days=5'], { store });
    expect(real.split('\n')).toEqual(['Deleted 2 session(s) older than 5 day(s):', `  ${a.id}`, `  ${b.id}`]);
    expect(store.getSession(a.id)).toBeNull();
    await store.close();
  });

  test('reports pruned cache entries and repository snapshots even with no stale sessions', async () => {
    let pruned = 0;
    const store = {
      cleanupOlderThan: async () => ({ sessions: [], caches: { reports: 2, batches: 3, impacts: 1 } }),
    };
    const pruneRepos = async () => (pruned++, 4);
    const out = await cleanupCommand(['--days=5'], { store, pruneRepos });
    expect(out).not.toContain('Nothing to clean up');
    expect(out.split('\n')).toEqual([
      'No sessions older than 5 day(s).',
      'Pruned 2 cached review(s), 3 cached batch(es), 1 impact entr(ies).',
      'Removed 4 cached repository snapshot(s).',
    ]);
    const dry = await cleanupCommand(['--days=5', '--dry-run'], { store, pruneRepos });
    expect(dry).toContain('Would prune 2 cached review(s)');
    expect(pruned).toBe(1);
  });
});

describe('configShowCommand', () => {
  test('masks secrets at any depth', () => {
    expect(maskSecret('sk-ant-1234567890')).toBe('sk-a…7890');
    expect(maskSecret('short')).toBe('****');
    expect(maskSecret('12345678')).toBe('****');
    const rc = JSON.stringify({ anthropicApiKey: 'sk-ant-1234567890', githubToken: 'ghp_x', persona: 'mentor', nested: { clientSecret: 'abcdefghijkl' } });
    const out = configShowCommand({ rcPath: '/h/.ghreviewrc.json', readText: () => rc });
    expect(out).toContain('Config file: /h/.ghreviewrc.json');
    expect(out).toContain('"anthropicApiKey": "sk-a…7890"');
    expect(out).toContain('"githubToken": "****"');
    expect(out).toContain('"clientSecret": "abcd…ijkl"');
    expect(out).toContain('"persona": "mentor"');
    expect(out).not.toContain('1234567890');
  });

  test('missing and invalid files', () => {
    expect(configShowCommand({ rcPath: '/x', readText: () => null })).toContain('No config file at /x');
    expect(configShowCommand({ rcPath: '/x', readText: () => '{oops' })).toContain('/x is not valid JSON');
  });
});

describe('checkGithubCommand', () => {
  const ref = { owner: 'o', repo: 'r', number: 3 };
  function client(over: Partial<CheckClient> = {}): CheckClient {
    return {
      getAuthenticatedUser: async () => ({ login: 'octo', scopes: ['repo'], expiresAt: null }),
      getRepository: async () => ({
        fullName: 'o/r',
        defaultBranch: 'main',
        private: true,
        permissions: { admin: false, push: true, pull: true },
      }),
      getPull: async () => ({ title: 'Add thing', body: '', baseRef: 'main', headSha: 'h1' }),
      listPullFiles: async () => [
        { filename: 'gone.ts', status: 'removed', additions: 0, deletions: 3 },
        { filename: 'a.ts', status: 'modified', additions: 1, deletions: 1 },
      ],
      getFileContent: async (_r, path, sha) => (path === 'a.ts' && sha === 'h1' ? 'x' : null),
      ...over,
    };
  }

  test('classic token without a PR', async () => {
    expect(await checkGithubCommand({ client: client() })).toBe(
      'Authenticated as: octo\nToken scopes: repo\nCan post PR comments: yes, "repo" covers public and private repositories\n' +
        'Token expiry: none reported (the token does not expire, or GitHub does not say)',
    );
    const pub = await checkGithubCommand({ client: client({ getAuthenticatedUser: async () => ({ login: 'o', scopes: ['public_repo'], expiresAt: null }) }) });
    expect(pub).toContain('public repositories only');
    const none = await checkGithubCommand({ client: client({ getAuthenticatedUser: async () => ({ login: 'o', scopes: [], expiresAt: null }) }) });
    expect(none).toContain('Token scopes: (none)');
    expect(none).toContain('Can post PR comments: no');
  });

  test('fine-grained token with all PR checks passing', async () => {
    const out = await checkGithubCommand({
      client: client({ getAuthenticatedUser: async () => ({ login: 'bot', scopes: null, expiresAt: null }) }),
      ref,
    });
    expect(out).toContain('fine-grained or GitHub Actions token');
    expect(out).toContain('[ok] repository permissions (o/r): admin=no, push=yes, pull=yes');
    expect(out).toContain('[ok] post PR comments: likely - also needs "Pull requests: Read and write"');
    expect(out).toContain('[ok] read pull request: Add thing');
    expect(out).toContain('[ok] list changed files: 2 file(s)');
    expect(out).toContain('[ok] read file content: a.ts');
  });

  test('reports failures and stops at the first blocking one', async () => {
    const out = await checkGithubCommand({
      client: client({
        getAuthenticatedUser: async () => {
          throw new GitHubError('GET /user failed with 403', 403);
        },
        getPull: async () => {
          throw new GitHubError('GET pull failed with 404', 404);
        },
      }),
      ref,
    });
    expect(out).toContain('Authenticated user: unavailable (GET /user failed with 403)');
    expect(out).toContain('[FAIL] read pull request: GET pull failed with 404');
    expect(out).not.toContain('list changed files');

    const unreadable = await checkGithubCommand({ client: client({ getFileContent: async () => null }), ref });
    expect(unreadable).toContain('[FAIL] read file content: a.ts not readable');
    const onlyRemoved = await checkGithubCommand({ client: client({ listPullFiles: async () => [] }), ref });
    expect(onlyRemoved).toContain('[skip] read file content');
  });

  test('reports token expiry: expired, soon, later, and unparseable', async () => {
    const now = () => Date.parse('2026-10-15T00:00:00Z');
    const run = (expiresAt: string | null) =>
      checkGithubCommand({ client: client({ getAuthenticatedUser: async () => ({ login: 'o', scopes: ['repo'], expiresAt }) }), now });
    expect(await run('2026-10-01 00:00:00 UTC')).toContain('Token expiry: EXPIRED on 2026-10-01 00:00:00 UTC');
    expect(await run('2026-10-18 12:00:00 +0200')).toContain('Token expiry: WARNING - expires in 4 day(s), on 2026-10-18 12:00:00 +0200');
    expect(await run('2027-01-01 00:00:00 UTC')).toContain('Token expiry: 2027-01-01 00:00:00 UTC (in 78 days)');
    expect(await run('someday')).toContain('Token expiry: someday');
  });

  test('reports repository permissions and whether PR comments can be posted', async () => {
    const repo = (over: Partial<RepositoryInfo>) => async () => ({
      fullName: 'o/r',
      defaultBranch: 'main',
      private: true,
      permissions: { admin: false, push: false, pull: true },
      ...over,
    });
    const readOnly = await checkGithubCommand({ client: client({ getRepository: repo({}) }), ref });
    expect(readOnly).toContain('[ok] repository permissions (o/r): admin=no, push=no, pull=yes');
    expect(readOnly).toContain('[ok] post PR comments: yes');

    const publicScope = await checkGithubCommand({
      client: client({
        getAuthenticatedUser: async () => ({ login: 'o', scopes: ['public_repo'], expiresAt: null }),
        getRepository: repo({}),
      }),
      ref,
    });
    expect(publicScope).toContain("[FAIL] post PR comments: no - the token's scopes do not cover this private repository");

    const noAccess = await checkGithubCommand({
      client: client({ getRepository: repo({ permissions: { admin: false, push: false, pull: false } }) }),
      ref,
    });
    expect(noAccess).toContain('[FAIL] post PR comments: no - the token has no read access');

    const unknown = await checkGithubCommand({ client: client({ getRepository: repo({ permissions: null }) }), ref });
    expect(unknown).toContain('[skip] repository permissions: not reported for this token');

    const failing = await checkGithubCommand({
      client: client({
        getRepository: async () => {
          throw new GitHubError('GET repo failed with 404', 404);
        },
      }),
      ref,
    });
    expect(failing).toContain('[FAIL] read repository: GET repo failed with 404');
    expect(failing).toContain('[ok] read pull request: Add thing');
  });
});

describe('updates', () => {
  const release: ReleaseInfo = { tag: 'v0.3.0', name: 'Spring', body: 'Faster reviews\n\nNew persona\n' + 'x'.repeat(100), url: 'https://r' };
  const releases = (r: ReleaseInfo | null, calls: string[] = []): ReleaseClient => ({
    getLatestRelease: async (o, n) => (calls.push(`${o}/${n}`), r),
  });
  const repo = { owner: 'me', repo: 'ghr' };

  test('compareVersions', () => {
    expect(compareVersions('v1.2.0', '1.10.0')).toBe(-1);
    expect(compareVersions('2.0', '1.9.9')).toBe(1);
    expect(compareVersions('v1.0.0-beta', '1.0.0')).toBe(0);
  });

  test('updateCheck returns a notice only for a newer release', async () => {
    const notice = await updateCheck({ client: releases(release), repo, current: '0.1.0', ci: false });
    expect(notice).toStartWith('A newer version is available: v0.3.0 (you have 0.1.0).');
    expect(notice).toContain('  Faster reviews\n  New persona\n');
    expect(notice).toContain(`  ${'x'.repeat(71)}…`);
    expect(notice).toEndWith('Release notes: https://r');
    expect(await updateCheck({ client: releases(release), repo, current: '0.3.0', ci: false })).toBeNull();
    expect(await updateCheck({ client: releases(null), repo, current: '0.1.0', ci: false })).toBeNull();
  });

  test('updateCheck is silent in CI, without a repo, on errors and when slow', async () => {
    const calls: string[] = [];
    expect(await updateCheck({ client: releases(release, calls), repo, current: '0.1.0', ci: true })).toBeNull();
    expect(await updateCheck({ client: releases(release, calls), current: '0.1.0', ci: false })).toBeNull();
    expect(calls).toEqual([]);
    const failing: ReleaseClient = { getLatestRelease: () => Promise.reject(new Error('offline')) };
    expect(await updateCheck({ client: failing, repo, current: '0.1.0', ci: false })).toBeNull();
    const slow: ReleaseClient = { getLatestRelease: () => new Promise(() => {}) };
    expect(await updateCheck({ client: slow, repo, current: '0.1.0', ci: false, timeoutMs: 10 })).toBeNull();
  });

  test('changelogCommand', async () => {
    const out = await changelogCommand({ client: releases(release), repo, current: '0.1.0' });
    expect(out).toStartWith('Spring (v0.3.0)\nhttps://r\n\nFaster reviews');
    expect(out).toEndWith('You have 0.1.0; v0.3.0 is newer.');
    expect(await changelogCommand({ client: releases(release), repo, current: '0.3.0' })).toEndWith(
      'You are on the latest release (0.3.0).',
    );
    expect(await changelogCommand({ client: releases(null), repo, current: '0.1.0' })).toBe('me/ghr has no published releases yet.');
    expect(await changelogCommand({ client: releases(release), current: '0.1.0' })).toContain('No release repository');
  });
});
