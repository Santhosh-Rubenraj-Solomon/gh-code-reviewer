import { describe, expect, test } from 'bun:test';
import { buildIdentifyPrompt, headTail, heuristicIdentity, identifyChange } from '../../src/pipeline/identify';
import { FakeLLM, file, makeDeps } from '../helpers';

describe('identifyChange', () => {
  test('uses the model and hard-cuts very long titles', async () => {
    const llm = new FakeLLM({ identify: () => ({ title: 'T'.repeat(150), problem: 'P', solution: 'S' }) });
    const deps = makeDeps(llm);
    const id = await identifyChange(deps, [file({ path: 'src/a.ts' })]);
    expect(id.title.length).toBe(100);
    expect(id.problem).toBe('P');
    expect(deps.cost.summary().byStage.identify!.calls).toBe(1);
  });

  test('keeps head and tail of each diff and caps the whole prompt', () => {
    const big = 'H'.repeat(3_000) + 'T'.repeat(3_000);
    const cut = headTail(big, 2_000);
    expect(cut.startsWith('H'.repeat(1_000))).toBe(true);
    expect(cut.endsWith('T'.repeat(1_000))).toBe(true);
    expect(cut).toContain('[4000 characters omitted]');

    const files = Array.from({ length: 20 }, (_, i) => file({ path: `src/f${i}.ts`, patch: big }));
    const prompt = buildIdentifyPrompt(files);
    expect(prompt).toMatch(/…and \d+ more files/);
    expect(prompt.length).toBeLessThan(18_000);
    expect(prompt).toContain('- src/f19.ts');
  });

  test('falls back to path heuristics when the model fails', async () => {
    const llm = new FakeLLM({ identify: () => { throw new Error('down'); } });
    const id = await identifyChange(makeDeps(llm), [file({ path: 'src/a.test.ts' })]);
    expect(id.title).toBe('Add or update tests');
    expect(id.problem).toBeTruthy();
    expect(id.solution).toContain('src/a.test.ts');
  });

  test('heuristic titles', () => {
    const t = (paths: string[]) => heuristicIdentity(paths.map(path => ({ path }))).title;
    expect(t(['README.md', 'docs/a.md'])).toBe('Update documentation');
    expect(t(['package.json', '.eslintrc.json'])).toBe('Update configuration');
    expect(t(['tests/a.py', 'src/b_test.go'])).toBe('Add or update tests');
    expect(t(['src/a.ts', 'src/b.ts', 'lib/c.ts', 'x.test.ts'])).toBe('Changes in src');
    expect(t(['main.go'])).toBe('Code changes');
    expect(t([])).toBe('Code changes');
  });
});
