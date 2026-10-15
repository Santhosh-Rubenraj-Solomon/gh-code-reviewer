import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchItem } from '../../src/pipeline/batcher';
import { batchCacheKey, buildReviewPrompt, dumpRawResponse, reviewBatch, type ReviewContext } from '../../src/pipeline/reviewer';
import type { FileReview } from '../../src/types';
import { FakeLLM, file, finding, makeDeps, SQL_CONTENT } from '../helpers';

const users = file({ path: 'src/users.ts', content: SQL_CONTENT });
const other = file({ path: 'src/other.ts' });
const batch: BatchItem[] = [
  { file: users, includeContent: true },
  { file: other, includeContent: false },
];
const base: ReviewContext = { title: 'Lookup', description: 'desc', summaries: { 'src/other.ts': 'Other summary' } };

function answer(reviews: unknown[], extra: Record<string, unknown> = {}, suffix = ''): string {
  return JSON.stringify({ fileReviews: reviews, ...extra }) + suffix;
}

describe('buildReviewPrompt', () => {
  test('includes docs, per-file rules, security context, impact and content', () => {
    const prompt = buildReviewPrompt(batch, {
      ...base,
      docsSummary: 'Docs say hi',
      rulesFor: p => (p === 'src/users.ts' ? 'Bind params.' : ''),
      securityContextFor: () => ({ name: 'entry-point', instructions: 'Untrusted input.' }),
      impactFor: p => (p === 'src/users.ts' ? 'Used by admin page' : ''),
    });
    expect(prompt).toContain('Docs say hi');
    expect(prompt).toContain('Rules for this file:\nBind params.');
    expect(prompt).toContain('Security focus (entry-point): Untrusted input.');
    expect(prompt).toContain('Used by admin page');
    expect(prompt).toContain('    3 +  const sql');
    expect(prompt).toContain('Whole file after the change');
    expect(prompt).toContain('never in `findings`');
    expect(prompt).not.toContain('<file_requests>');
  });

  test('identical rules are shown once; file requests explained only with a reader', () => {
    const prompt = buildReviewPrompt(batch, {
      ...base,
      rulesFor: () => 'Same rule.',
      reader: { readFile: async () => null },
    });
    expect(prompt.split('Same rule.').length - 1).toBe(1);
    expect(prompt).toContain('<file_requests>');
  });
});

describe('reviewBatch', () => {
  test('normalises output, moves positives, fills missing files with placeholders', async () => {
    const llm = new FakeLLM({
      review: () =>
        'Here it is:\n```json\n' +
        answer([
          {
            path: 'src/users.ts',
            whatChanged: 'Builds SQL by hand',
            findings: [
              { ...finding(), file: undefined, category: 'Edge Case', severity: 'HIGH', line: 'L3', occurrences: [{ line: 'L4', snippet: 'db.query(sql)' }] },
              { category: 'positive', severity: 'note', title: 'Nice', explanation: 'Good naming', evidence: 'x' },
              { title: 'no evidence', explanation: 'x', severity: 'low' },
            ],
            positives: [{ text: 'Small diff' }],
            testingRecommendations: ['Test quotes in names'],
          },
          { path: 'src/ghost.ts', findings: [finding({ file: 'src/ghost.ts' })] },
        ]) +
        '\n```',
    });
    const deps = makeDeps(llm);
    const reviews = await reviewBatch(deps, batch, base);
    expect(reviews.map(r => r.path)).toEqual(['src/users.ts', 'src/other.ts']);
    const [u, o] = reviews as [FileReview, FileReview];
    expect(u.findings).toHaveLength(1);
    expect(u.findings[0]).toMatchObject({ file: 'src/users.ts', category: 'edge-case', severity: 'high', line: 3 });
    expect(u.findings[0]!.occurrences).toEqual([{ line: 4, snippet: 'db.query(sql)' }]);
    expect(u.positives).toEqual(['Small diff', 'Good naming']);
    expect(u.testingRecommendations).toEqual(['Test quotes in names']);
    expect(o).toMatchObject({ status: 'ok', findings: [] });
    expect(o.whatChanged).toContain('Other summary');
    expect(o.whatChanged).toContain('no detailed review');
    expect(deps.logs).toContain('dropping review for unknown file "src/ghost.ts"');
  });

  test('follow-up loop honours additionalFilesNeeded and <file_requests>, at most two rounds', async () => {
    let call = 0;
    const llm = new FakeLLM({
      review: () => {
        call++;
        if (call === 1) {
          return answer([{ path: 'src/users.ts', whatChanged: 'first', findings: [] }], {
            additionalFilesNeeded: { files: ['src/db.ts'], reason: 'need db' },
          });
        }
        if (call === 2) {
          return answer([{ path: 'src/users.ts', whatChanged: 'second', findings: [finding()] }], {}, '\n<file_requests>\nsrc/auth.ts:check\n</file_requests>');
        }
        return answer([{ path: 'src/other.ts', whatChanged: 'third', findings: [] }], {
          additionalFilesNeeded: { files: ['src/more.ts'], reason: 'more' },
        });
      },
    });
    const reads: string[] = [];
    const reader = { readFile: async (p: string) => { reads.push(p); return `// ${p}\nexport function check() {}`; } };
    const reviews = await reviewBatch(makeDeps(llm), batch, { ...base, reader });
    expect(llm.callsFor('review')).toHaveLength(3);
    expect(reads).toEqual(['src/db.ts', 'src/auth.ts']);
    expect(llm.calls[1]!.prompt).toContain('// src/db.ts');
    expect(llm.calls[2]!.prompt).toContain('### src/auth.ts (symbol check)');
    expect(reviews[0]!.whatChanged).toBe('second');
    expect(reviews[0]!.findings).toHaveLength(1);
    expect(reviews[1]!.whatChanged).toBe('third');
  });

  test('no follow-up without a reader', async () => {
    const llm = new FakeLLM({
      review: () => answer([{ path: 'src/users.ts', findings: [] }], { additionalFilesNeeded: { files: ['a.ts'] } }),
    });
    await reviewBatch(makeDeps(llm), batch, base);
    expect(llm.calls).toHaveLength(1);
  });

  test('a failed follow-up keeps the earlier answer', async () => {
    let call = 0;
    const llm = new FakeLLM({
      review: () => {
        if (++call === 2) throw new Error('flaky');
        return answer([{ path: 'src/users.ts', whatChanged: 'first' }], { additionalFilesNeeded: { files: ['a.ts'] } });
      },
    });
    const reviews = await reviewBatch(makeDeps(llm), batch, { ...base, reader: { readFile: async () => 'x' } });
    expect(reviews[0]).toMatchObject({ status: 'ok', whatChanged: 'first' });
  });

  test('cache hit skips the model; complete results are stored', async () => {
    const store = new Map<string, FileReview[]>();
    const cache = { get: (k: string) => store.get(k), put: (k: string, v: FileReview[]) => void store.set(k, v) };
    const llm = new FakeLLM({
      review: () => answer([{ path: 'src/users.ts', findings: [] }, { path: 'src/other.ts', findings: [] }]),
    });
    const first = await reviewBatch(makeDeps(llm), batch, { ...base, cache });
    expect(store.size).toBe(1);
    const second = await reviewBatch(makeDeps(llm), batch, { ...base, cache });
    expect(second).toEqual(first);
    expect(llm.calls).toHaveLength(1);

    const changed = [{ file: { ...users, patch: users.patch + '\n+x' }, includeContent: true }, batch[1]!];
    await reviewBatch(makeDeps(llm), changed, { ...base, cache });
    expect(llm.calls).toHaveLength(2);
  });

  test('batch cache key covers PR text, docs, security, impact and the salt', () => {
    const ctx = {
      ...base,
      securityContextFor: () => ({ name: 'web', instructions: 'check xss' }),
      impactFor: () => 'used by api.ts',
      cacheSalt: 'model-a',
    };
    const key = batchCacheKey(batch, ctx);
    expect(batchCacheKey(batch, ctx)).toBe(key);
    for (const change of [
      { title: 'other' },
      { description: 'other' },
      { docsSummary: 'docs' },
      { securityContextFor: () => ({ name: 'web', instructions: 'check csrf' }) },
      { impactFor: () => 'used by cli.ts' },
      { cacheSalt: 'model-b' },
    ]) {
      expect(batchCacheKey(batch, { ...ctx, ...change })).not.toBe(key);
    }
  });

  test('results with placeholders are not cached', async () => {
    const store = new Map<string, FileReview[]>();
    const cache = { get: (k: string) => store.get(k), put: (k: string, v: FileReview[]) => void store.set(k, v) };
    const llm = new FakeLLM({ review: () => answer([{ path: 'src/users.ts' }]) });
    await reviewBatch(makeDeps(llm), batch, { ...base, cache });
    expect(store.size).toBe(0);
  });

  test('critical failures are rethrown', async () => {
    const llm = new FakeLLM({
      review: () => {
        const error = new Error('retries exhausted');
        error.name = 'CriticalFailureError';
        throw error;
      },
    });
    await expect(reviewBatch(makeDeps(llm), batch, base)).rejects.toThrow('retries exhausted');
  });

  test('other errors become per-file error or timeout status', async () => {
    const boom = new FakeLLM({ review: () => { throw new Error('500 server error'); } });
    const errored = await reviewBatch(makeDeps(boom), batch, base);
    expect(errored.map(r => r.status)).toEqual(['error', 'error']);
    expect(errored[0]!.error).toContain('500 server error');

    const slow = new FakeLLM({ review: () => { throw new Error('request timed out after 60s'); } });
    const timedOut = await reviewBatch(makeDeps(slow), batch, base);
    expect(timedOut.map(r => r.status)).toEqual(['timeout', 'timeout']);

    const garbage = new FakeLLM({ review: () => JSON.stringify({ wrong: true }) });
    expect((await reviewBatch(makeDeps(garbage), batch, base))[0]!.status).toBe('error');
  });

  test('cross-file findings go to the right file; unknown files are dropped', async () => {
    const llm = new FakeLLM({
      review: () =>
        answer([
          { path: 'src/users.ts', findings: [finding({ file: 'src/other.ts' }), finding({ file: 'nowhere.ts' })] },
          { path: 'src/other.ts', whatChanged: 'other' },
        ]),
    });
    const deps = makeDeps(llm);
    const [u, o] = await reviewBatch(deps, batch, base);
    expect(u!.findings).toHaveLength(0);
    expect(o!.findings.map(f => f.file)).toEqual(['src/other.ts']);
    expect(o!.whatChanged).toBe('other');
    expect(deps.logs).toContain('dropping finding for unknown file "nowhere.ts"');
  });
});

describe('raw response debug dump', () => {
  const tempDirs: string[] = [];
  afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
  });
  const temp = () => {
    const d = mkdtempSync(join(tmpdir(), 'ghr-debug-'));
    tempDirs.push(d);
    return d;
  };

  test('an unparseable answer is saved to debugDir and the path is logged', async () => {
    const dir = join(temp(), 'debug');
    const saved = process.env.GHR_NO_DEBUG;
    delete process.env.GHR_NO_DEBUG;
    const garbage = new FakeLLM({ review: () => 'not json at all {{' });
    const deps = makeDeps(garbage);
    let reviews: FileReview[];
    try {
      reviews = await reviewBatch(deps, batch, { ...base, debugDir: dir });
    } finally {
      if (saved !== undefined) process.env.GHR_NO_DEBUG = saved;
    }
    expect(reviews[0]!.status).toBe('error');
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^review-response-.+\.txt$/);
    expect(readFileSync(join(dir, files[0]!), 'utf8')).toBe('not json at all {{');
    expect(deps.logs.some(l => l.includes(join(dir, files[0]!)))).toBe(true);
  });

  test('nothing is written without debugDir, for parseable answers, or with GHR_NO_DEBUG', async () => {
    const dir = temp();
    const ok = new FakeLLM({ review: () => answer([{ path: 'src/users.ts' }, { path: 'src/other.ts' }]) });
    await reviewBatch(makeDeps(ok), batch, { ...base, debugDir: dir });
    expect(readdirSync(dir)).toEqual([]);

    const garbage = new FakeLLM({ review: () => 'nope' });
    await reviewBatch(makeDeps(garbage), batch, base);
    expect(await dumpRawResponse(dir, 'x', { GHR_NO_DEBUG: '1' })).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });

  test('two dumps in the same instant get distinct names', async () => {
    const dir = temp();
    const [a, b] = await Promise.all([dumpRawResponse(dir, 'a', {}), dumpRawResponse(dir, 'b', {})]);
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a).not.toBe(b);
    expect(readdirSync(dir)).toHaveLength(2);
  });
});
