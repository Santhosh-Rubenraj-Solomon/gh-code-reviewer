import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  analyzeImpact,
  blastRadiusFor,
  impactLevel,
  isTestFile,
  touchedLines,
  type AnalyzedImpact,
} from '../../src/impact/analyzer';
import { LocalRepoProvider } from '../../src/repo/local-provider';
import type { RepoFileProvider } from '../../src/repo/provider';
import type { ChangedFile } from '../../src/types';
import { FIXTURE_FILES, mathChange, writeFixture } from './fixture';

const noGit = async () => {
  throw new Error('no git');
};

let fixture: ReturnType<typeof writeFixture>;
let provider: LocalRepoProvider;
let impact: AnalyzedImpact;

beforeAll(async () => {
  fixture = writeFixture();
  provider = new LocalRepoProvider(fixture.root, { git: noGit });
  impact = await analyzeImpact(provider, [mathChange()]);
});
afterAll(() => fixture.cleanup());

describe('analyzeImpact on the fixture', () => {
  test('modified exports come from hunk overlap', () => {
    expect(impact.notes).toEqual([]);
    expect(impact.files['src/util/math.ts']?.modifiedExports.map(s => s.name)).toEqual(['add']);
  });

  test('lists direct and transitive dependents with depth, via and used symbols', () => {
    const impacted = impact.files['src/util/math.ts']?.impacted ?? [];
    expect(impacted.map(i => [i.path, i.kind, i.depth])).toEqual([
      ['src/calc.ts', 'direct', 1],
      ['src/util/index.ts', 'direct', 1],
      ['src/report.ts', 'transitive', 2],
      ['test/calc.test.ts', 'transitive', 2],
      ['src/app.ts', 'transitive', 3],
    ]);
    expect(impacted.every(i => i.via === 'src/util/math.ts')).toBe(true);
    const calc = impacted.find(i => i.path === 'src/calc.ts');
    expect(calc?.usedSymbols).toEqual(['pretty', 'product', 'total']);
    expect(impacted.find(i => i.path === 'src/report.ts')?.usedSymbols).toEqual(['buildReport']);
    expect(impacted.find(i => i.path === 'src/app.ts')?.usedSymbols).toEqual(['boot']);
    expect(impacted.map(i => i.path)).not.toContain('src/unrelated.ts');
  });

  test('level, blast radius and edges', () => {
    expect(impact.files['src/util/math.ts']?.level).toBe('medium');
    expect(impact.blastRadius.level).toBe('medium');
    expect(impact.blastRadius.criticalPaths).toEqual(['src/util/math.ts']);
    expect(impact.blastRadius.description).toContain('5 dependent files');
    expect(impact.edges).toContainEqual({ from: 'src/calc.ts', to: 'src/util/math.ts' });
    expect(impact.edges).toContainEqual({ from: 'src/app.ts', to: 'src/report.ts' });
    expect(impact.edges.some(e => e.from === 'src/unrelated.ts' || e.to === 'src/legacy.js')).toBe(false);
  });

  test('keeps short previews of symbols in direct dependents', () => {
    expect(impact.snippets['src/calc.ts::total']).toContain('add(s, x)');
    expect(Object.values(impact.snippets).every(s => s.length <= 301)).toBe(true);
  });

  test('coverage finds the existing test through the graph', () => {
    expect(impact.coverage).toEqual({
      untested: [],
      testsToUpdate: ['test/calc.test.ts'],
      coveredBy: { 'src/util/math.ts': ['test/calc.test.ts'] },
    });
  });

  test('semantic changes per symbol', () => {
    expect(impact.semantic.filter(s => s.path === 'src/util/math.ts')).toEqual([
      { path: 'src/util/math.ts', symbol: 'add', change: 'modified' },
      { path: 'src/util/math.ts', symbol: 'mul', change: 'unchanged' },
      { path: 'src/util/math.ts', symbol: 'PI', change: 'unchanged' },
    ]);
  });
});

describe('analyzeImpact edge cases', () => {
  test('new files count every export as modified and every symbol as added', async () => {
    const content = 'export function fresh() { return 1; }\nfunction inner() {}\n';
    const added: ChangedFile = {
      path: 'src/fresh.ts',
      status: 'added',
      patch: '@@ -0,0 +1,2 @@\n+export function fresh() { return 1; }\n+function inner() {}',
      additions: 2,
      deletions: 0,
      content,
    };
    const result = await analyzeImpact(provider, [added]);
    expect(result.files['src/fresh.ts']?.modifiedExports.map(s => s.name)).toEqual(['fresh']);
    expect(result.semantic.map(s => s.change)).toEqual(['added', 'added']);
    expect(result.coverage.untested).toEqual(['src/fresh.ts']);
    expect(result.files['src/fresh.ts']?.level).toBe('none');
  });

  test('a function appended to an existing file is added, not modified', async () => {
    const content = `${FIXTURE_FILES['src/util/format.ts']}\nexport function pad(s: string) {\n  return s;\n}\n`;
    const change: ChangedFile = {
      path: 'src/util/format.ts',
      status: 'modified',
      patch: '@@ -3,0 +5,3 @@\n+export function pad(s: string) {\n+  return s;\n+}',
      additions: 3,
      deletions: 0,
      content,
    };
    const result = await analyzeImpact(provider, [change]);
    expect(result.semantic).toEqual([
      { path: 'src/util/format.ts', symbol: 'fmt', change: 'unchanged' },
      { path: 'src/util/format.ts', symbol: 'pad', change: 'added' },
    ]);
    expect(result.files['src/util/format.ts']?.modifiedExports.map(s => s.name)).toEqual(['pad']);
  });

  test('a changed test alongside its source counts as coverage', async () => {
    const files = { 'lib/solo.ts': 'export const solo = 1;\n', 'lib/solo.test.ts': 'test("x", () => {});\n' };
    const fx = writeFixture(files);
    try {
      const p = new LocalRepoProvider(fx.root, { git: noGit });
      const changes = Object.keys(files).map(path => ({ ...mathChange(), path, patch: '' }));
      const result = await analyzeImpact(p, changes);
      expect(result.coverage.untested).toEqual([]);
      const alone = await analyzeImpact(p, [changes[0] as ChangedFile]);
      expect(alone.coverage.untested).toEqual(['lib/solo.ts']);
    } finally {
      fx.cleanup();
    }
  });

  test('importers of a removed file are still impacted', async () => {
    const removed: ChangedFile = { path: 'src/legacy.js', status: 'removed', patch: '', additions: 0, deletions: 6 };
    const result = await analyzeImpact(provider, [removed]);
    expect(result.files['src/legacy.js']?.impacted.map(i => i.path)).toEqual(['src/app.ts']);
    expect(result.coverage.untested).toEqual([]);
  });

  test('skips analysis with a note when the repository is too large', async () => {
    const result = await analyzeImpact(provider, [mathChange()], { maxRepoFiles: 3 });
    expect(result.files).toEqual({});
    expect(result.notes[0]).toContain('limit 3');
  });

  test('returns partial results with a note when the time budget runs out', async () => {
    let t = 0;
    const result = await analyzeImpact(provider, [mathChange()], { timeoutMs: 100, batchSize: 2, now: () => (t += 60) });
    expect(result.notes.some(n => n.includes('partial'))).toBe(true);
    expect(result.files['src/util/math.ts']).toBeDefined();
  });

  test('provider failures become notes instead of exceptions', async () => {
    const broken: RepoFileProvider = {
      listFiles: async () => {
        throw new Error('disk on fire');
      },
      readFile: async () => null,
      repoHash: async () => 'x',
      listRuleFiles: async () => [],
    };
    const result = await analyzeImpact(broken, [mathChange()]);
    expect(result.notes).toEqual(['Impact analysis failed: disk on fire']);
    expect(result.blastRadius.level).toBe('low');
  });
});

describe('pure helpers', () => {
  test('impactLevel thresholds', () => {
    expect([0, 1, 3, 4, 9, 10, 50].map(impactLevel)).toEqual(['none', 'low', 'low', 'medium', 'medium', 'high', 'high']);
  });

  test('blastRadiusFor thresholds', () => {
    expect(blastRadiusFor(0, []).level).toBe('low');
    expect(blastRadiusFor(4, []).level).toBe('low');
    expect(blastRadiusFor(5, []).level).toBe('medium');
    expect(blastRadiusFor(9, ['a']).level).toBe('medium');
    expect(blastRadiusFor(10, []).level).toBe('high');
    expect(blastRadiusFor(1, ['a', 'b']).level).toBe('high');
    expect(blastRadiusFor(20, []).level).toBe('critical');
    expect(blastRadiusFor(0, ['a', 'b', 'c']).level).toBe('critical');
    expect(blastRadiusFor(1, []).description).toContain('1 dependent file affected');
  });

  test('isTestFile patterns', () => {
    const tests = [
      'a.test.ts',
      'a.spec.jsx',
      'pkg/x_test.go',
      'tests/test_x.py',
      'x_test.py',
      'w.test.dart',
      'FooTest.kt',
      'FooTests.swift',
      'src/__tests__/x.ts',
    ];
    for (const t of tests) expect(isTestFile(t)).toBe(true);
    for (const t of ['a.ts', 'testing.py', 'contest.go', 'latest.ts']) expect(isTestFile(t)).toBe(false);
  });

  test('touchedLines maps deletions onto the new side', () => {
    const patch = '@@ -10,4 +10,3 @@\n a\n-b\n c\n+d\n-e';
    expect([...touchedLines(patch)].sort((x, y) => x - y)).toEqual([11, 12, 13]);
  });
});
