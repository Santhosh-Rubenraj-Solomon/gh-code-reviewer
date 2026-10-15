import { describe, expect, test } from 'bun:test';
import { formatPullRef, parsePullRef, pullRefFromActions } from '../src/github/pull-ref';

describe('parsePullRef', () => {
  test.each([
    ['https://github.com/santhosh/demo/pull/42', 'santhosh', 'demo', 42],
    ['https://github.com/santhosh/demo/pull/42/files', 'santhosh', 'demo', 42],
    ['https://github.com/santhosh/demo/pull/42#discussion_r1', 'santhosh', 'demo', 42],
    ['https://ghe.example.com/team/svc.api/pull/7', 'team', 'svc.api', 7],
    ['santhosh/demo#3', 'santhosh', 'demo', 3],
    ['  santhosh/demo#3  ', 'santhosh', 'demo', 3],
  ])('%s', (input, owner, repo, number) => {
    expect(parsePullRef(input)).toEqual({ owner, repo, number });
  });

  test.each(['', 'demo#3', 'https://github.com/santhosh/demo/issues/3', 'santhosh/demo/3'])(
    'rejects %p',
    input => {
      expect(() => parsePullRef(input)).toThrow(/pull request/);
    },
  );
});

test('formatPullRef round-trips the short form', () => {
  expect(formatPullRef(parsePullRef('a/b#9'))).toBe('a/b#9');
});

describe('pullRefFromActions', () => {
  const env = { GITHUB_REPOSITORY: 'santhosh/demo', GITHUB_EVENT_PATH: '/event.json' };

  test('reads the PR number from the event payload', () => {
    const read = () => JSON.stringify({ pull_request: { number: 15 } });
    expect(pullRefFromActions(env, read)).toEqual({ owner: 'santhosh', repo: 'demo', number: 15 });
  });

  test('returns null for non-PR events', () => {
    expect(pullRefFromActions(env, () => JSON.stringify({ ref: 'refs/heads/main' }))).toBeNull();
  });

  test('returns null outside Actions', () => {
    expect(pullRefFromActions({}, () => '{}')).toBeNull();
  });
});
