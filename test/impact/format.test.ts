import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { analyzeImpact, emptyImpact, type AnalyzedImpact } from '../../src/impact/analyzer';
import { formatFileImpactForPrompt, formatImpactSummaryForPrompt, toMermaid, toText } from '../../src/impact/format';
import { buildTestPlan } from '../../src/impact/test-plan';
import { LocalRepoProvider } from '../../src/repo/local-provider';
import type { ChangedFile, ReviewReport, TestRequirement } from '../../src/types';
import { finding } from '../helpers';
import { mathChange, writeFixture } from './fixture';

let fixture: ReturnType<typeof writeFixture>;
let impact: AnalyzedImpact;
const changes: ChangedFile[] = [mathChange()];

beforeAll(async () => {
  fixture = writeFixture();
  impact = await analyzeImpact(new LocalRepoProvider(fixture.root, { git: async () => 'abc' }), changes);
});
afterAll(() => fixture.cleanup());

describe('prompt formatting', () => {
  test('per-file section lists exports, direct dependents with previews, and transitive files', () => {
    const text = formatFileImpactForPrompt(impact, 'src/util/math.ts');
    expect(text).toContain('Ripple effects of src/util/math.ts (impact: medium)');
    expect(text).toContain('function `add` (lines 1-3)');
    expect(text).toContain('- src/calc.ts');
    expect(text).toContain('add(s, x)');
    expect(text).toContain('src/app.ts (3 imports away, from src/util/math.ts)');
    expect(formatFileImpactForPrompt(impact, 'src/nope.ts')).toBe('');
    expect(formatFileImpactForPrompt(emptyImpact(), 'src/util/math.ts')).toBe('');
  });

  test('limits previews and lists the remaining used names', () => {
    const many = structuredClone(impact);
    const file = many.files['src/util/math.ts'];
    if (!file) throw new Error('fixture missing');
    const names = Array.from({ length: 12 }, (_, i) => `sym${i}`);
    file.impacted = [{ path: 'src/big.ts', depth: 1, kind: 'direct', via: 'src/util/math.ts', usedSymbols: names }];
    for (const n of names) many.snippets[`src/big.ts::${n}`] = `function ${n}() {}`;
    const text = formatFileImpactForPrompt(many, 'src/util/math.ts');
    expect(text.match(/```/g)?.length).toBe(6);
    expect(text).toContain('Other code using the change: sym3, sym4, sym5, sym6, sym7, sym8, sym9, sym10 (+1 more)');
  });

  test('summary covers cross-file impact, blast radius, coverage and symbol counts', () => {
    const text = formatImpactSummaryForPrompt(impact);
    expect(text).toContain('## Cross-file impact');
    expect(text).toContain('src/calc.ts [direct] uses pretty, product, total');
    expect(text).toContain('Blast radius: medium');
    expect(text).toContain('may need updates: test/calc.test.ts');
    expect(text).toContain('0 added, 1 modified');
    expect(formatImpactSummaryForPrompt(emptyImpact())).toBe('');
  });
});

describe('graph output', () => {
  test('mermaid has classes for changed, direct and transitive files and dependency arrows', () => {
    const mmd = toMermaid(impact, ['src/util/math.ts']);
    expect(mmd.startsWith('graph LR')).toBe(true);
    expect(mmd).toContain('n0["…/util/math.ts"]:::changed');
    expect(mmd).toMatch(/\["src\/calc.ts"\]:::direct/);
    expect(mmd).toMatch(/\["src\/app.ts"\]:::transitive/);
    expect(mmd).toContain('classDef changed');
    expect(mmd).toMatch(/n0 --> n\d/);
  });

  test('text tree shows each changed file with its dependents', () => {
    const text = toText(impact, ['src/util/math.ts', 'README.md']);
    expect(text).toContain('* src/util/math.ts — impact medium');
    expect(text).toContain('├─ src/calc.ts (direct, used by pretty, product, total)');
    expect(text).toContain('└─ src/app.ts (depth 3)');
    expect(text).toContain('* README.md\n    (no dependents found)');
    expect(text).toContain('Blast radius: medium');
  });
});

describe('buildTestPlan', () => {
  const now = () => new Date('2026-10-15T12:00:00Z');
  const req = (kind: 'unit' | 'e2e'): TestRequirement => ({
    kind,
    description: `${kind} test`,
    rationale: 'because',
    evidence: { file: 'src/util/math.ts', snippet: 'add' },
  });

  test('impact-only plan has nulls for review data', () => {
    const plan = buildTestPlan({ sourceId: 'o/r#1', changedFiles: changes, impact, now });
    expect(plan.version).toBe('1');
    expect(plan.generatedAt).toBe('2026-10-15T12:00:00.000Z');
    expect(plan.summary.semanticChanges).toEqual({ added: 0, modified: 1, unchanged: 2 });
    expect(plan.summary.coverageGaps).toEqual([]);
    const entry = plan.changedFiles[0];
    expect(entry?.semanticChanges).toEqual([{ symbol: 'add', change: 'modified' }]);
    expect(entry?.modifiedExports?.map(e => e.name)).toEqual(['add']);
    expect(entry?.modifiedExports?.[0]?.code).toContain('return a + b');
    expect(entry?.coverage).toEqual({ tested: true, coveredBy: ['test/calc.test.ts'] });
    expect(entry?.impact?.direct).toEqual(['src/calc.ts', 'src/util/index.ts']);
    expect(entry?.impact?.transitive).toContainEqual({ path: 'src/app.ts', depth: 3 });
    expect(entry?.review).toBeNull();
    expect(plan.impactedFiles?.map(i => i.path)).toHaveLength(5);
    expect(plan.testRequirements).toBeNull();
  });

  test('without impact or report everything is null', () => {
    const plan = buildTestPlan({ sourceId: 'x', changedFiles: changes, now });
    expect(plan.summary).toEqual({ blastRadius: null, semanticChanges: null, coverageGaps: null });
    expect(plan.changedFiles[0]).toMatchObject({ semanticChanges: null, modifiedExports: null, coverage: null, impact: null });
    expect(plan.impactedFiles).toBeNull();
  });

  test('includes review data, deduplicated findings and split test requirements', () => {
    const f = finding({ file: 'src/util/math.ts', title: 'Coerces silently', line: 2 });
    const report = {
      findings: [f, finding({ file: 'src/other.ts' })],
      fileReviews: [
        {
          path: 'src/util/math.ts',
          status: 'ok',
          whatChanged: 'add now coerces inputs',
          findings: [f],
          positives: [],
          testingRecommendations: ['Test string inputs'],
        },
      ],
      consolidated: { testRequirements: [req('unit'), req('e2e'), req('unit')] },
    } as unknown as ReviewReport;
    const plan = buildTestPlan({ sourceId: 'x', changedFiles: changes, impact, report, now });
    expect(plan.changedFiles[0]?.review).toEqual({
      whatChanged: 'add now coerces inputs',
      testingRecommendations: ['Test string inputs'],
      findings: [f],
    });
    expect(plan.testRequirements?.unit).toHaveLength(2);
    expect(plan.testRequirements?.e2e).toHaveLength(1);
  });
});
