import { describe, expect, test } from 'bun:test';
import { GitHubClient } from '../../src/github/client';
import { docsNotice, partMarker, publishToGitHub, splitCommentBody } from '../../src/publish';
import { SUMMARY_MARKER, TESTING_MARKER } from '../../src/render/markdown';
import { changeSet, fakeFetch, file, finding } from '../helpers';
import { consolidated, report } from './fixtures';

const ref = { owner: 'santhosh', repo: 'demo', number: 7 };

function setup(existing: { id: number; body: string }[] = []) {
  const fake = fakeFetch([
    { method: 'GET', match: /\/pulls\/7\/comments$/, respond: () => ({ json: [] }) },
    { method: 'POST', match: /\/reviews$/, respond: () => ({ json: {} }) },
    { method: 'GET', match: /\/issues\/7\/comments$/, respond: () => ({ json: existing }) },
    { method: 'POST', match: /\/issues\/7\/comments$/, respond: () => ({ status: 201, json: {} }) },
    { method: 'PATCH', match: /\/issues\/comments\/\d+$/, respond: () => ({ json: {} }) },
    { method: 'DELETE', match: /\/issues\/comments\/\d+$/, respond: () => ({ status: 204 }) },
  ]);
  return { gh: new GitHubClient({ token: 't', fetch: fake.fetch }), requests: fake.requests };
}
const posted = (requests: ReturnType<typeof setup>['requests']) =>
  requests.filter(r => r.method === 'POST' && r.url.includes('/issues/7/comments')).map(r => (r.body as { body: string }).body);

describe('splitCommentBody', () => {
  test('a body that fits stays one part with the base marker', () => {
    expect(splitCommentBody(SUMMARY_MARKER, `${SUMMARY_MARKER}\nhello`)).toEqual([`${SUMMARY_MARKER}\nhello`]);
  });

  test('long bodies split into numbered parts within the limit, each with its own marker', () => {
    const body = [SUMMARY_MARKER, ...Array.from({ length: 200 }, (_, i) => `line ${i} ${'x'.repeat(40)}`)].join('\n');
    const parts = splitCommentBody(SUMMARY_MARKER, body, 3_000);
    expect(parts.length).toBeGreaterThan(2);
    parts.forEach((p, i) => {
      expect(p.length).toBeLessThanOrEqual(3_000);
      expect(p.startsWith(partMarker(SUMMARY_MARKER, i + 1))).toBe(true);
      expect(p).toContain(`Part ${i + 1} of ${parts.length}`);
    });
    expect(partMarker(SUMMARY_MARKER, 2)).toBe('<!-- gh-code-reviewer:summary:part-2 -->');
    expect(parts[1]!.includes(SUMMARY_MARKER)).toBe(false);
    expect(parts.join('\n')).toContain('line 199');
  });

  test('a cut inside a code fence closes and reopens it', () => {
    const body = ['intro', '```ts', ...Array.from({ length: 100 }, (_, i) => `const v${i} = ${i};`), '```', 'end'].join('\n');
    const parts = splitCommentBody(SUMMARY_MARKER, body, 800);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect((p.match(/^```/gm) ?? []).length % 2).toBe(0);
    expect(parts[1]).toContain('```ts\nconst');
  });
});

describe('docsNotice', () => {
  test('only when code changed and no docs did', () => {
    expect(docsNotice(changeSet([file({ path: 'src/a.ts' })]))).toContain('no documentation');
    expect(docsNotice(changeSet([file({ path: 'src/a.ts' }), file({ path: 'README.md' })]))).toBeNull();
    expect(docsNotice(changeSet([file({ path: 'config.yml' })]))).toBeNull();
  });
});

describe('publishToGitHub', () => {
  const cs = changeSet([file({ path: 'src/users.ts' })]);

  test('upserts a separate testing comment when there are test requirements', async () => {
    const { gh, requests } = setup();
    const result = await publishToGitHub(gh, ref, report({ findings: [], consolidated: consolidated() }), cs);
    expect(result).toMatchObject({ summary: 'created', summaryParts: 1, testing: 'created' });
    const bodies = posted(requests);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]!.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(bodies[1]!.startsWith(TESTING_MARKER)).toBe(true);
    expect(bodies[1]).toContain('findUser escapes quotes');
  });

  test('updates existing comments in place on re-runs', async () => {
    const { gh, requests } = setup([
      { id: 1, body: `${SUMMARY_MARKER}\nold` },
      { id: 2, body: `${TESTING_MARKER}\nold` },
    ]);
    const result = await publishToGitHub(gh, ref, report({ findings: [], consolidated: consolidated() }), cs);
    expect(result).toMatchObject({ summary: 'updated', testing: 'updated' });
    expect(requests.filter(r => r.method === 'PATCH').map(r => new URL(r.url).pathname)).toEqual([
      '/repos/santhosh/demo/issues/comments/1',
      '/repos/santhosh/demo/issues/comments/2',
    ]);
  });

  test('deletes an earlier testing comment (and its parts) when the new report has no testing content', async () => {
    const { gh, requests } = setup([
      { id: 1, body: `${SUMMARY_MARKER}\nold` },
      { id: 2, body: `${TESTING_MARKER}\nold` },
      { id: 3, body: `${partMarker(TESTING_MARKER, 2)}\nold part` },
      { id: 4, body: 'a human comment' },
    ]);
    const result = await publishToGitHub(gh, ref, report({ findings: [] }), cs);
    expect(result.testing).toBeUndefined();
    expect(result.testingRemoved).toBe(2);
    expect(requests.filter(r => r.method === 'DELETE').map(r => new URL(r.url).pathname)).toEqual([
      '/repos/santhosh/demo/issues/comments/2',
      '/repos/santhosh/demo/issues/comments/3',
    ]);
  });

  test('uses the presentation for the summary and appends the opt-in docs notice', async () => {
    const { gh, requests } = setup();
    const presentation = {
      persona: 'captain',
      intro: 'Crew, listen.',
      aspects: [],
      issues: [],
      filesTable: [],
      cleanFiles: [],
      verdict: 'Sail.',
    };
    await publishToGitHub(gh, ref, report({ findings: [], presentation }), cs, { docsNotice: true });
    const body = posted(requests)[0]!;
    expect(body.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(body).toContain('## ⚓ Bridge briefing\n\nCrew, listen.');
    expect(body).toContain("## 🛟 Captain's orders\n\nSail.");
    expect(body).toContain('📝 **Docs:**');
  });

  test('a presentation summary still carries the consolidated review and audit trail, but not the testing section', async () => {
    const { gh, requests } = setup();
    const presentation = { persona: 'neutral', intro: 'Hi.', aspects: [], issues: [], filesTable: [], cleanFiles: [], verdict: 'OK.' };
    await publishToGitHub(
      gh,
      ref,
      report({
        findings: [],
        presentation,
        consolidated: consolidated(),
        validated: false,
        rejected: [{ finding: finding({ title: 'Rename sql' }), reason: 'style only' }],
        skipped: [{ path: 'package-lock.json', reason: 'lockfile' }],
      }),
      cs,
    );
    const [summary, testing] = posted(requests);
    expect(summary).toContain('**Merge risk:** HIGH');
    expect(summary).toContain('### Architecture changes');
    expect(summary).toContain('### Security concerns');
    expect(summary).toContain('#### Untrusted input and data flow');
    expect(summary).toContain('### Functionality: ✅ complete');
    expect(summary).toContain('| Affects security | Yes |');
    expect(summary).toContain('Code quality, dependencies and performance');
    expect(summary).toContain('not double-checked');
    expect(summary).toContain('1 draft finding(s) dropped by the critic');
    expect(summary).toContain('1 file(s) not reviewed');
    expect(summary).toContain('🧪 2 test requirement(s)');
    expect(summary).toContain('estimated model cost');
    expect(summary).not.toContain('### Unit tests');
    expect(testing!.startsWith(TESTING_MARKER)).toBe(true);
    expect(testing).toContain('### Unit tests');
  });

  test('deletes leftover parts from a longer earlier run, listing comments once per comment kind', async () => {
    const { gh, requests } = setup([
      { id: 1, body: `${SUMMARY_MARKER}\nold` },
      { id: 2, body: `${partMarker(SUMMARY_MARKER, 2)}\nold` },
      { id: 3, body: `${partMarker(SUMMARY_MARKER, 3)}\nold` },
      { id: 4, body: `${partMarker(TESTING_MARKER, 2)}\nold` },
      { id: 5, body: 'someone else mentions part-2' },
    ]);
    await publishToGitHub(gh, ref, report({ findings: [], consolidated: consolidated() }), cs);
    const calls = requests.map(r => `${r.method} ${new URL(r.url).pathname}`);
    expect(calls.filter(c => c.startsWith('DELETE'))).toEqual([
      'DELETE /repos/santhosh/demo/issues/comments/2',
      'DELETE /repos/santhosh/demo/issues/comments/3',
      'DELETE /repos/santhosh/demo/issues/comments/4',
    ]);
    expect(calls.filter(c => c === 'GET /repos/santhosh/demo/issues/7/comments')).toHaveLength(2);
    expect(calls.filter(c => c.startsWith('PATCH')).map(c => c.split('/').at(-1))).toEqual(['1']);
  });

  test('keeps parts that are still in use', async () => {
    const big = report({ findings: [], overview: Array.from({ length: 400 }, (_, i) => `sentence ${i}.`).join('\n') });
    const { gh, requests } = setup([
      { id: 1, body: `${SUMMARY_MARKER}\nold` },
      { id: 2, body: `${partMarker(SUMMARY_MARKER, 2)}\nold` },
      { id: 30, body: `${partMarker(SUMMARY_MARKER, 30)}\nold` },
    ]);
    const result = await publishToGitHub(gh, ref, big, cs, { maxCommentChars: 2_000 });
    expect(result.summaryParts).toBeGreaterThan(2);
    expect(result.summaryParts).toBeLessThan(30);
    const deleted = requests.filter(r => r.method === 'DELETE').map(r => new URL(r.url).pathname.split('/').at(-1));
    expect(deleted).toEqual(['30']);
  });

  test('splits a huge summary into several comments', async () => {
    const { gh, requests } = setup();
    const big = report({ findings: [], overview: Array.from({ length: 400 }, (_, i) => `sentence ${i}.`).join('\n') });
    const result = await publishToGitHub(gh, ref, big, cs, { maxCommentChars: 2_000 });
    const bodies = posted(requests);
    expect(result.summaryParts).toBe(bodies.length);
    expect(bodies.length).toBeGreaterThan(1);
    expect(bodies[1]!.startsWith('<!-- gh-code-reviewer:summary:part-2 -->')).toBe(true);
    expect(result.testing).toBeUndefined();
  });
});
