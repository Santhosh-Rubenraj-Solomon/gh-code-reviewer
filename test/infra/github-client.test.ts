import { expect, test } from 'bun:test';
import { GitHubClient, GitHubError } from '../../src/github/client';
import { fakeFetch } from '../helpers';

/** fakeFetch cannot set response headers, which the scope check needs. */
function headerFetch(status: number, json: unknown, headers: Record<string, string> = {}) {
  return (async () =>
    new Response(JSON.stringify(json), { status, headers: { 'Content-Type': 'application/json', ...headers } })) as unknown as typeof fetch;
}

test('getAuthenticatedUser reads classic token scopes from x-oauth-scopes', async () => {
  const client = new GitHubClient({ token: 't', fetch: headerFetch(200, { login: 'octo' }, { 'x-oauth-scopes': 'repo, read:org' }) });
  expect(await client.getAuthenticatedUser()).toEqual({ login: 'octo', scopes: ['repo', 'read:org'], expiresAt: null });
  const empty = new GitHubClient({ token: 't', fetch: headerFetch(200, { login: 'octo' }, { 'x-oauth-scopes': '' }) });
  expect((await empty.getAuthenticatedUser()).scopes).toEqual([]);
});

test('getAuthenticatedUser reports null scopes for fine-grained tokens', async () => {
  const { fetch, requests } = fakeFetch([{ method: 'GET', match: /^\/user$/, respond: () => ({ json: { login: 'bot' } }) }]);
  const client = new GitHubClient({ token: 't', fetch });
  expect(await client.getAuthenticatedUser()).toEqual({ login: 'bot', scopes: null, expiresAt: null });
  expect(requests[0]!.url).toBe('https://api.github.com/user');
});

test('getAuthenticatedUser reads the token expiry header', async () => {
  const headers = { 'github-authentication-token-expiration': '2026-11-01 12:00:00 UTC' };
  const client = new GitHubClient({ token: 't', fetch: headerFetch(200, { login: 'octo' }, headers) });
  expect((await client.getAuthenticatedUser()).expiresAt).toBe('2026-11-01 12:00:00 UTC');
});

test('getRepository maps the repository and permissions', async () => {
  const { fetch } = fakeFetch([
    {
      method: 'GET',
      match: /^\/repos\/o\/r$/,
      respond: () => ({
        json: { full_name: 'o/r', default_branch: 'main', private: true, permissions: { admin: false, push: true, pull: true } },
      }),
    },
  ]);
  const client = new GitHubClient({ token: 't', fetch });
  expect(await client.getRepository({ owner: 'o', repo: 'r' })).toEqual({
    fullName: 'o/r',
    defaultBranch: 'main',
    private: true,
    permissions: { admin: false, push: true, pull: true },
  });
  await expect(client.getRepository({ owner: 'x', repo: 'y' })).rejects.toBeInstanceOf(GitHubError);
});

test('getLatestRelease maps the release and returns null on 404', async () => {
  const { fetch } = fakeFetch([
    {
      method: 'GET',
      match: /^\/repos\/o\/r\/releases\/latest$/,
      respond: () => ({ json: { tag_name: 'v1.2.0', name: null, body: 'Notes', html_url: 'https://x/rel' } }),
    },
    { method: 'GET', match: /^\/repos\/o\/broken\/releases\/latest$/, respond: () => ({ status: 500, text: 'down' }) },
  ]);
  const client = new GitHubClient({ token: 't', fetch, sleep: async () => {} });
  expect(await client.getLatestRelease('o', 'r')).toEqual({ tag: 'v1.2.0', name: 'v1.2.0', body: 'Notes', url: 'https://x/rel' });
  expect(await client.getLatestRelease('o', 'none')).toBeNull();
  await expect(client.getLatestRelease('o', 'broken')).rejects.toThrow(/500/);
});
