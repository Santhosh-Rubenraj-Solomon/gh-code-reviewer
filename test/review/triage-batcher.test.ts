import { describe, expect, test } from 'bun:test';
import { buildBatches, planBatches } from '../../src/pipeline/batcher';
import { staticTriage, triage } from '../../src/pipeline/triage';
import { changeSet, FakeLLM, file, makeDeps } from '../helpers';

describe('staticTriage additions', () => {
  test('skips root tooling config by exact path and project docs', () => {
    const { candidates, skipped } = staticTriage([
      file({ path: '.gitignore' }),
      file({ path: 'web/.gitignore' }),
      file({ path: 'README.md' }),
      file({ path: 'src/templates/email.md' }),
      file({ path: 'src/a.ts' }),
    ]);
    expect(candidates.map(f => f.path)).toEqual(['web/.gitignore', 'src/templates/email.md', 'src/a.ts']);
    expect(skipped).toEqual([
      { path: '.gitignore', reason: 'tooling config' },
      { path: 'README.md', reason: 'project documentation' },
    ]);
  });

  test('root config list is configurable', () => {
    const { skipped } = staticTriage([file({ path: '.gitignore' }), file({ path: 'tsconfig.json' })], {
      rootConfigFiles: ['tsconfig.json'],
    });
    expect(skipped.map(s => s.path)).toEqual(['tsconfig.json']);
  });
});

describe('triage', () => {
  const files = [file({ path: 'src/a.ts', patch: 'x'.repeat(5_000) }), file({ path: 'src/b.ts' })];

  test('returns dependencies limited to known files, truncates diffs and includes the docs summary', async () => {
    const llm = new FakeLLM({
      triage: () => ({
        files: [
          { path: 'src/a.ts', review: true, reason: 'logic', summary: 'A', relatedFiles: ['src/b.ts', 'src/a.ts', 'ghost.ts'] },
          { path: 'src/b.ts', review: true, reason: 'logic', summary: 'B' },
        ],
      }),
    });
    const result = await triage(makeDeps(llm), changeSet(files), files, { docsSummary: 'Service docs here' });
    expect(result.dependencies).toEqual({ 'src/a.ts': ['src/b.ts'] });
    const prompt = llm.calls[0]!.prompt;
    expect(prompt).toContain('Service docs here');
    expect(prompt).not.toContain('x'.repeat(2_000));
    expect(prompt).toContain('[truncated');
  });

  test('fails open with empty dependencies', async () => {
    const llm = new FakeLLM({ triage: () => { throw new Error('x'); } });
    const result = await triage(makeDeps(llm), changeSet(files), files);
    expect(result.reviewable).toHaveLength(2);
    expect(result.dependencies).toEqual({});
  });
});

const count = (text: string) => text.length;
const sized = (path: string, n: number) => file({ path, patch: 'x'.repeat(n) });

describe('buildBatches impact-aware ordering', () => {
  test('files with more related files come first and pull their partners along', () => {
    const files = [sized('a/x.ts', 10), sized('b/y.ts', 10), sized('c/z.ts', 10), sized('d/w.ts', 10)];
    const batches = buildBatches(files, {
      maxTokens: 20,
      maxFiles: 10,
      count,
      related: { 'd/w.ts': ['b/y.ts', 'c/z.ts'], 'b/y.ts': ['d/w.ts'] },
    });
    expect(batches.map(b => b.map(i => i.file.path))).toEqual([['d/w.ts', 'b/y.ts'], ['c/z.ts', 'a/x.ts']]);
  });

  test('dependency count breaks ties, then directory, then size descending', () => {
    const files = [sized('a/small.ts', 1), sized('a/big.ts', 9), sized('z/dep.ts', 1)];
    const order = buildBatches(files, { maxTokens: 1_000, maxFiles: 10, count, dependencies: { 'z/dep.ts': ['q'] } })
      .flat()
      .map(i => i.file.path);
    expect(order).toEqual(['z/dep.ts', 'a/big.ts', 'a/small.ts']);
  });

  test('extra tokens count against the budget', () => {
    const files = [sized('a.ts', 10), sized('b.ts', 10)];
    expect(buildBatches(files, { maxTokens: 25, maxFiles: 10, count })).toHaveLength(1);
    expect(buildBatches(files, { maxTokens: 25, maxFiles: 10, count, extraTokens: () => 5 })).toHaveLength(2);
  });
});

describe('planBatches', () => {
  const files = [sized('a.ts', 10), sized('b.ts', 10), sized('c.ts', 10), sized('d.ts', 10)];

  test('no model call when everything fits', async () => {
    const llm = new FakeLLM({});
    const batches = await planBatches(makeDeps(llm), files, { maxTokens: 100, maxFiles: 10, count });
    expect(batches).toHaveLength(1);
    expect(llm.calls).toHaveLength(0);
  });

  test('uses the model plan and validates it', async () => {
    const llm = new FakeLLM({
      batching: () => ({
        batches: [
          ['a.ts', 'c.ts', 'ghost.ts'],
          ['c.ts', 'b.ts'],
        ],
      }),
    });
    const deps = makeDeps(llm);
    const batches = await planBatches(deps, files, {
      maxTokens: 25,
      maxFiles: 10,
      count,
      summaries: { 'a.ts': 'Alpha summary' },
      related: { 'a.ts': ['c.ts'] },
    });
    // ghost dropped, duplicate c.ts kept in its first batch, missing d.ts appended.
    expect(batches.map(b => b.map(i => i.file.path))).toEqual([['a.ts', 'c.ts'], ['b.ts'], ['d.ts']]);
    expect(llm.calls[0]!.prompt).toContain('Alpha summary');
    expect(llm.calls[0]!.prompt).toContain('connected to: c.ts');
    expect(deps.cost.summary().byStage.batching!.calls).toBe(1);
  });

  test('over-budget and over-count batches are split', async () => {
    const llm = new FakeLLM({ batching: () => ({ batches: [['a.ts', 'b.ts', 'c.ts', 'd.ts']] }) });
    const byTokens = await planBatches(makeDeps(llm), files, { maxTokens: 25, maxFiles: 10, count });
    expect(byTokens.map(b => b.length)).toEqual([2, 2]);
    const byCount = await planBatches(makeDeps(llm), files, { maxTokens: 15, maxFiles: 3, count });
    expect(byCount.every(b => b.length === 1)).toBe(true);
  });

  test('falls back to buildBatches on model error or an empty plan', async () => {
    const options = { maxTokens: 25, maxFiles: 10, count };
    const expected = buildBatches(files, options);
    const failing = new FakeLLM({ batching: () => { throw new Error('boom'); } });
    const deps = makeDeps(failing);
    expect(await planBatches(deps, files, options)).toEqual(expected);
    expect(deps.logs[0]).toContain('batch planning failed');
    const empty = new FakeLLM({ batching: () => ({ batches: [] }) });
    expect((await planBatches(makeDeps(empty), files, options)).flat()).toHaveLength(4);
  });
});
