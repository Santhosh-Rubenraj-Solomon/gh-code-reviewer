import { describe, expect, test } from 'bun:test';
import { GitHubClient } from '../src/github/client';
import { MAX_INLINE_COMMENTS, planComments, publishToGitHub } from '../src/publish';
import { renderFinding, renderSummary, SUMMARY_MARKER } from '../src/render/markdown';
import type { ReviewReport } from '../src/types';
import { changeSet, fakeFetch, file, finding } from './helpers';

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    title: 'Look up users by name',
    headSha: 'abc1234def',
    overview: 'Adds a user lookup that builds SQL by hand.',
    risk: 'high',
    highlights: ['SQL built from user input'],
    findings: [finding()],
    rejected: [{ finding: finding({ title: 'Rename sql' }), reason: 'critic: style only' }],
    skipped: [{ path: 'package-lock.json', reason: 'lockfile' }],
    reviewedFiles: ['src/users.ts'],
    validated: true,
    cost: { totalUsd: 0.01234, byStage: {} },
    ...overrides,
  };
}

describe('renderSummary', () => {
  test('includes marker, risk, table, details, dropped findings, skipped files and cost', () => {
    const md = renderSummary(report());
    expect(md.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(md).toContain('**Merge risk:** HIGH');
    expect(md).toContain('| 🛑 Critical | `src/users.ts:3` | SQL injection in findUser |');
    expect(md).toContain('### Details');
    expect(md).toContain('1 draft finding(s) dropped by the critic');
    expect(md).toContain('`package-lock.json`: lockfile');
    expect(md).toContain('at abc1234 · estimated model cost $0.0123');
  });

  test('says so when nothing was found, and omits empty sections', () => {
    const md = renderSummary(report({ findings: [], rejected: [], skipped: [], highlights: [] }));
    expect(md).toContain('No verified issues found.');
    expect(md).not.toContain('<details>');
    expect(md).not.toContain('Look at first');
  });

  test('shows only the requested findings in detail', () => {
    const md = renderSummary(report(), { detailed: [] });
    expect(md).toContain('SQL injection in findUser');
    expect(md).not.toContain('### Details');
  });

  test('escapes table-breaking characters and quotes the persona intro', () => {
    const md = renderSummary(report({ intro: 'Line one\nLine two', findings: [finding({ title: 'a | b' })] }));
    expect(md).toContain('a \\| b');
    expect(md).toContain('> Line one\n> Line two');
  });

  test('warns when findings were not verified', () => {
    expect(renderSummary(report({ validated: false }))).toContain('not double-checked');
  });
});

test('renderFinding includes severity, category, explanation and suggestion', () => {
  const body = renderFinding(finding());
  expect(body).toContain('**🛑 Critical · security: SQL injection in findUser**');
  expect(body).toContain('**Suggestion:** Use a parameterised query');
  expect(renderFinding(finding({ suggestion: undefined }))).not.toContain('Suggestion');
});

describe('planComments', () => {
  const cs = changeSet([file({ path: 'src/users.ts' })]);

  test('inlines findings on diff lines and keeps the rest for the summary', () => {
    const onDiff = finding({ line: 3 });
    const offDiff = finding({ line: 40, title: 'Far away' });
    const noLine = finding({ line: undefined, title: 'File-level' });
    const otherFile = finding({ file: 'src/other.ts', title: 'Elsewhere' });
    const plan = planComments(report({ findings: [onDiff, offDiff, noLine, otherFile] }), cs);
    expect(plan.inline.map(i => i.comment)).toEqual([{ path: 'src/users.ts', line: 3, body: renderFinding(onDiff) }]);
    expect(plan.general.map(f => f.title)).toEqual(['Far away', 'File-level', 'Elsewhere']);
  });

  test('caps the number of inline comments', () => {
    const many = Array.from({ length: MAX_INLINE_COMMENTS + 5 }, (_, i) => finding({ title: `n${i}` }));
    const plan = planComments(report({ findings: many }), cs);
    expect(plan.inline).toHaveLength(MAX_INLINE_COMMENTS);
    expect(plan.general).toHaveLength(5);
  });
});

describe('publishToGitHub', () => {
  const ref = { owner: 'santhosh', repo: 'demo', number: 7 };
  const cs = changeSet([file({ path: 'src/users.ts' })]);

  function setup(existingComments: unknown[]) {
    const fake = fakeFetch([
      { method: 'GET', match: /\/pulls\/7\/comments$/, respond: () => ({ json: existingComments }) },
      { method: 'POST', match: /\/reviews$/, respond: () => ({ json: {} }) },
      { method: 'GET', match: /\/issues\/7\/comments$/, respond: () => ({ json: [] }) },
      { method: 'POST', match: /\/issues\/7\/comments$/, respond: () => ({ status: 201, json: {} }) },
    ]);
    return { gh: new GitHubClient({ token: 't', fetch: fake.fetch }), requests: fake.requests };
  }

  test('posts a review with inline comments and a summary comment', async () => {
    const { gh, requests } = setup([]);
    const result = await publishToGitHub(gh, ref, report(), cs);
    expect(result).toEqual({ inlinePosted: 1, duplicatesSkipped: 0, summary: 'created', summaryParts: 1 });
    const review = requests.find(r => r.url.endsWith('/reviews'))!;
    expect((review.body as { commit_id: string }).commit_id).toBe('abc1234def');
    const summary = requests.find(r => r.method === 'POST' && r.url.includes('/issues/7/comments'))!;
    expect((summary.body as { body: string }).body).toContain(SUMMARY_MARKER);
  });

  test('does not repeat an inline comment that is already on the PR', async () => {
    const { gh, requests } = setup([{ path: 'src/users.ts', line: 3, body: '**🛑 Critical · security: SQL injection in findUser**' }]);
    const result = await publishToGitHub(gh, ref, report(), cs);
    expect(result).toMatchObject({ inlinePosted: 0, duplicatesSkipped: 1 });
    expect(requests.some(r => r.url.endsWith('/reviews'))).toBe(false);
  });

  test('skips the review entirely when there is nothing to inline', async () => {
    const { gh, requests } = setup([]);
    await publishToGitHub(gh, ref, report({ findings: [] }), cs);
    expect(requests.map(r => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      'GET /repos/santhosh/demo/issues/7/comments',
      'POST /repos/santhosh/demo/issues/7/comments',
    ]);
  });
});
