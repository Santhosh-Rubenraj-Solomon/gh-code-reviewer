import { describe, expect, test } from 'bun:test';
import { GitHubClient, GitHubError } from '../src/github/client';
import { loadPullRequest, toChangedFile } from '../src/sources/github-pr';
import { fakeFetch, SQL_CONTENT, SQL_PATCH } from './helpers';

const ref = { owner: 'santhosh', repo: 'demo', number: 7 };

function client(routes: Parameters<typeof fakeFetch>[0], apiUrl?: string) {
  const fake = fakeFetch(routes);
  return { gh: new GitHubClient({ token: 't0ken', apiUrl, fetch: fake.fetch }), requests: fake.requests };
}

describe('GitHubClient', () => {
  test('sends auth and API version headers', async () => {
    const { gh, requests } = client([
      {
        method: 'GET',
        match: /\/pulls\/7$/,
        respond: () => ({ json: { title: 'T', body: null, base: { ref: 'main' }, head: { sha: 'abc' } } }),
      },
    ]);
    expect(await gh.getPull(ref)).toEqual({ title: 'T', body: '', baseRef: 'main', headSha: 'abc' });
    expect(requests[0]!.headers.Authorization).toBe('Bearer t0ken');
    expect(requests[0]!.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
  });

  test('uses a GitHub Enterprise base URL without doubling slashes', async () => {
    const { gh, requests } = client(
      [{ method: 'GET', match: /\/pulls\/7$/, respond: () => ({ json: { title: '', body: '', base: { ref: 'm' }, head: { sha: 's' } } }) }],
      'https://ghe.example.com/api/v3/',
    );
    await gh.getPull(ref);
    expect(requests[0]!.url).toBe('https://ghe.example.com/api/v3/repos/santhosh/demo/pulls/7');
  });

  test('follows pagination until a short page', async () => {
    const page = (n: number, size: number) =>
      Array.from({ length: size }, (_, i) => ({ filename: `f${n}-${i}.ts`, status: 'modified', additions: 1, deletions: 0 }));
    const { gh, requests } = client([
      {
        method: 'GET',
        match: /\/pulls\/7\/files$/,
        respond: url => ({ json: url.searchParams.get('page') === '1' ? page(1, 100) : page(2, 3) }),
      },
    ]);
    const files = await gh.listPullFiles(ref);
    expect(files).toHaveLength(103);
    expect(requests.map(r => new URL(r.url).searchParams.get('page'))).toEqual(['1', '2']);
  });

  test('decodes base64 file content and encodes path segments', async () => {
    const { gh, requests } = client([
      {
        method: 'GET',
        match: /\/contents\//,
        respond: () => ({
          json: { type: 'file', size: 10, encoding: 'base64', content: Buffer.from('hello').toString('base64') },
        }),
      },
    ]);
    expect(await gh.getFileContent(ref, 'src/my file.ts', 'abc')).toBe('hello');
    expect(requests[0]!.url).toContain('/contents/src/my%20file.ts?ref=abc');
  });

  test('returns null for missing, oversized or non-file content', async () => {
    const cases = [
      { status: 404, json: { message: 'Not Found' } },
      { json: { type: 'file', size: 2_000_000, encoding: 'base64', content: 'aGk=' } },
      { json: { type: 'dir', size: 0 } },
    ];
    for (const response of cases) {
      const { gh } = client([{ method: 'GET', match: /\/contents\//, respond: () => response }]);
      expect(await gh.getFileContent(ref, 'x', 'sha')).toBeNull();
    }
  });

  test('raises GitHubError with the status for other failures', async () => {
    const { gh } = client([{ method: 'GET', match: /\/pulls\/7$/, respond: () => ({ status: 403, text: 'forbidden' }) }]);
    const error = await gh.getPull(ref).catch(e => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.status).toBe(403);
    expect(error.message).toContain('forbidden');
  });

  test('createReview posts RIGHT-side inline comments', async () => {
    const { gh, requests } = client([{ method: 'POST', match: /\/reviews$/, respond: () => ({ json: { id: 1 } }) }]);
    await gh.createReview(ref, 'sha1', 'body', [{ path: 'a.ts', line: 3, body: 'bad' }]);
    expect(requests[0]!.body).toEqual({
      commit_id: 'sha1',
      body: 'body',
      event: 'COMMENT',
      comments: [{ path: 'a.ts', line: 3, side: 'RIGHT', body: 'bad' }],
    });
  });

  test('upsertIssueComment edits our existing comment', async () => {
    const { gh, requests } = client([
      {
        method: 'GET',
        match: /\/issues\/7\/comments$/,
        respond: () => ({ json: [{ id: 1, body: 'someone else' }, { id: 2, body: '<!-- m --> old' }] }),
      },
      { method: 'PATCH', match: /\/issues\/comments\/2$/, respond: () => ({ json: {} }) },
    ]);
    expect(await gh.upsertIssueComment(ref, '<!-- m -->', 'new')).toBe('updated');
    expect(requests.at(-1)).toMatchObject({ method: 'PATCH', body: { body: 'new' } });
  });

  test('upsertIssueComment creates a comment when ours is missing', async () => {
    const { gh, requests } = client([
      { method: 'GET', match: /\/issues\/7\/comments$/, respond: () => ({ json: [] }) },
      { method: 'POST', match: /\/issues\/7\/comments$/, respond: () => ({ status: 201, json: {} }) },
    ]);
    expect(await gh.upsertIssueComment(ref, '<!-- m -->', 'new')).toBe('created');
    expect(requests.at(-1)!.method).toBe('POST');
  });
});

describe('loadPullRequest', () => {
  test.each([
    ['added', 'added'],
    ['removed', 'removed'],
    ['renamed', 'renamed'],
    ['modified', 'modified'],
    ['copied', 'modified'],
    ['changed', 'modified'],
  ])('maps GitHub status %s to %s', (status, expected) => {
    expect(toChangedFile({ filename: 'a', status, additions: 0, deletions: 0 }).status).toBe(expected as never);
  });

  test('builds a change set and fetches head content for files with a diff', async () => {
    const { gh, requests } = client([
      {
        method: 'GET',
        match: /\/pulls\/7$/,
        respond: () => ({ json: { title: 'Lookup', body: 'Adds lookup', base: { ref: 'main' }, head: { sha: 'headsha' } } }),
      },
      {
        method: 'GET',
        match: /\/pulls\/7\/files$/,
        respond: () => ({
          json: [
            { filename: 'src/users.ts', status: 'modified', patch: SQL_PATCH, additions: 2, deletions: 1 },
            { filename: 'src/gone.ts', status: 'removed', patch: '@@ -1 +0,0 @@\n-x', additions: 0, deletions: 1 },
            { filename: 'logo.png', status: 'added', additions: 0, deletions: 0 },
          ],
        }),
      },
      {
        method: 'GET',
        match: /\/contents\/src\/users\.ts$/,
        respond: () => ({ json: { type: 'file', size: 100, encoding: 'base64', content: Buffer.from(SQL_CONTENT).toString('base64') } }),
      },
    ]);

    const cs = await loadPullRequest(gh, ref);
    expect(cs).toMatchObject({ source: 'github', title: 'Lookup', baseRef: 'main', headSha: 'headsha', pull: ref });
    expect(cs.files.map(f => [f.path, f.status, f.content !== undefined])).toEqual([
      ['src/users.ts', 'modified', true],
      ['src/gone.ts', 'removed', false],
      ['logo.png', 'added', false],
    ]);
    expect(cs.files[2]!.patch).toBe('');
    const contentCalls = requests.filter(r => r.url.includes('/contents/'));
    expect(contentCalls).toHaveLength(1);
    expect(contentCalls[0]!.url).toContain('ref=headsha');
  });
});

describe('GitHubClient retries', () => {
  type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | Error;

  /** Replies in order (the last one repeats), recording every call. */
  function scripted(replies: Reply[], options: { retries?: number; now?: () => number } = {}) {
    const calls: string[] = [];
    const delays: number[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${new URL(String(input)).pathname}`);
      const reply = replies[Math.min(calls.length - 1, replies.length - 1)]!;
      if (reply instanceof Error) throw reply;
      if (reply.status === 204) return new Response(null, { status: 204 });
      return new Response(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}), {
        status: reply.status,
        headers: { 'Content-Type': 'application/json', ...reply.headers },
      });
    }) as unknown as typeof fetch;
    const gh = new GitHubClient({
      token: 't',
      fetch: fetchImpl,
      sleep: async ms => {
        delays.push(ms);
      },
      ...options,
    });
    return { gh, calls, delays };
  }
  const pull = { title: 'T', body: '', base: { ref: 'main' }, head: { sha: 's' } };

  test('retries 5xx and network errors with exponential backoff', async () => {
    const { gh, calls, delays } = scripted([{ status: 502, body: 'bad gateway' }, new TypeError('fetch failed'), { status: 200, body: pull }]);
    expect((await gh.getPull(ref)).title).toBe('T');
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([1000, 2000]);
  });

  test('gives up after the configured retries and keeps the status', async () => {
    const { gh, calls, delays } = scripted([{ status: 503, body: 'down' }], { retries: 2 });
    const error = await gh.getPull(ref).catch(e => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.status).toBe(503);
    expect(calls).toHaveLength(3);
    expect(delays).toEqual([1000, 2000]);
  });

  test('honours retry-after on 429, capped at 60 s', async () => {
    const { gh, delays } = scripted([
      { status: 429, headers: { 'retry-after': '5' } },
      { status: 429, headers: { 'retry-after': '600' } },
      { status: 200, body: pull },
    ]);
    await gh.getPull(ref);
    expect(delays).toEqual([5000, 60_000]);
  });

  test('retries a 403 only when it is a rate limit, waiting for x-ratelimit-reset', async () => {
    const now = () => 1_000_000_000_000;
    const primary = scripted(
      [
        { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(1_000_000_000 + 12) } },
        { status: 200, body: pull },
      ],
      { now },
    );
    await primary.gh.getPull(ref);
    expect(primary.delays).toEqual([12_000]);

    const secondary = scripted([
      { status: 403, body: { message: 'You have exceeded a secondary rate limit.' } },
      { status: 200, body: pull },
    ]);
    await secondary.gh.getPull(ref);
    expect(secondary.calls).toHaveLength(2);
    expect(secondary.delays).toEqual([1000]);

    const forbidden = scripted([{ status: 403, body: 'Resource not accessible by integration' }]);
    const error = await forbidden.gh.getPull(ref).catch(e => e);
    expect(error.status).toBe(403);
    expect(error.rateLimited).toBe(false);
    expect(forbidden.calls).toHaveLength(1);
  });

  test.each([401, 404, 422])('does not retry %d', async status => {
    const { gh, calls, delays } = scripted([{ status, body: 'nope' }]);
    const error = await gh.createReview(ref, 'sha', 'b', []).catch(e => e);
    expect(error).toBeInstanceOf(GitHubError);
    expect(error.status).toBe(status);
    expect(calls).toHaveLength(1);
    expect(delays).toEqual([]);
  });

  test('deleteIssueComment sends DELETE and accepts 204', async () => {
    const { gh, calls } = scripted([{ status: 204 }]);
    await gh.deleteIssueComment(ref, 42);
    expect(calls).toEqual(['DELETE /repos/santhosh/demo/issues/comments/42']);
  });

  test('upsertIssueCommentIn uses a pre-fetched listing', async () => {
    const { gh, calls } = scripted([{ status: 200, body: {} }]);
    expect(await gh.upsertIssueCommentIn(ref, [{ id: 9, body: '<!-- m -->' }], '<!-- m -->', 'new')).toBe('updated');
    expect(await gh.upsertIssueCommentIn(ref, [], '<!-- m -->', 'new')).toBe('created');
    expect(calls).toEqual(['PATCH /repos/santhosh/demo/issues/comments/9', 'POST /repos/santhosh/demo/issues/7/comments']);
  });
});

describe('GitHubClient POST retries', () => {
  test('a POST is not repeated after a 5xx, but is after a rate limit', async () => {
    let posts = 0;
    const fake = fakeFetch([
      {
        method: 'POST',
        match: /\/reviews$/,
        respond: () => (++posts === 1 ? { status: 502, text: 'bad gateway' } : { json: {} }),
      },
    ]);
    const gh = new GitHubClient({ token: 't', fetch: fake.fetch, sleep: async () => {} });
    await expect(gh.createReview(ref, 'sha', 'b', [])).rejects.toThrow(/502/);
    expect(posts).toBe(1);

    let limited = 0;
    const fake2 = fakeFetch([
      {
        method: 'POST',
        match: /\/reviews$/,
        respond: () => (++limited === 1 ? { status: 429, text: 'slow down' } : { json: {} }),
      },
    ]);
    const gh2 = new GitHubClient({ token: 't', fetch: fake2.fetch, sleep: async () => {} });
    await gh2.createReview(ref, 'sha', 'b', []);
    expect(limited).toBe(2);
  });
});
