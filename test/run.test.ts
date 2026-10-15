import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReview, sortFindings, type RunStep, type StepState } from '../src/pipeline/run';
import type { RepoFileProvider } from '../src/repo/provider';
import { cacheKey, LmdbReportCache, type ReportCache } from '../src/store';
import type { ReviewReport } from '../src/types';
import { changeSet, FakeLLM, file, finding, SQL_CONTENT, testConfig } from './helpers';

const ADMIN = "import { findUser } from './users';\nexport async function showUser(n: string) {\n  return findUser(n);\n}\n";
const SNIPPET = 'const sql = "SELECT * FROM users WHERE name = \'" + name + "\'";';

/** A two-file repository where admin.ts depends on the changed users.ts. */
function repo(): RepoFileProvider {
  const files: Record<string, string> = { 'src/users.ts': SQL_CONTENT, 'src/admin.ts': ADMIN };
  return {
    listFiles: async () => Object.keys(files),
    readFile: async path => files[path] ?? null,
    repoHash: async () => 'abc',
    listRuleFiles: async () => [{ path: '.github/code-review.md', content: 'No string-built SQL.' }],
  };
}

const evidence = { file: 'src/users.ts', snippet: SNIPPET, line: 3 };

const consolidatedAnswer = () => ({
  overview: 'Adds a lookup with an injection bug.',
  risk: 'low',
  highlights: ['findUser'],
  architectureChanges: [],
  securityConcerns: [
    {
      description: 'User input is concatenated into SQL.',
      severity: 'critical',
      category: 'taint',
      affectedFiles: ['src/users.ts'],
      remediation: 'Use a bound parameter.',
      evidence,
    },
  ],
  securityChecklist: {
    impactsSecurity: true,
    cryptographicChange: false,
    secureChannelModified: false,
    dataManagementChange: true,
    otherSecurityImpact: false,
  },
  recommendations: [{ text: 'Parameterise the query in findUser.', priority: 'high', evidence }],
  functionality: { isComplete: true, missing: [], explanation: 'Lookup works for normal names.' },
  unitTests: [{ description: 'findUser with a quote in the name', rationale: 'Covers the injection path.', evidence }],
  e2eTests: [],
  codeQuality: { patterns: '', complexity: '', maintainability: '' },
  dependencies: { added: '', impact: '', security: '' },
  performance: { bottlenecks: '', resources: '', scalability: '' },
  limitations: [],
  completeness: 'complete',
});

const reviewAnswer = () =>
  JSON.stringify({
    fileReviews: [
      {
        path: 'src/users.ts',
        whatChanged: 'findUser now builds SQL by concatenation.',
        findings: [
          finding({ severity: 'low', title: 'Minor: missing return type', evidence: 'export async function findUser(name: string) {' }),
          finding(),
          finding({ title: 'Made up', evidence: 'exec(cmd)' }),
        ],
        positives: ['Small, focused function.'],
        testingRecommendations: ['Test a name containing a quote.'],
      },
    ],
    additionalFilesNeeded: { files: [], reason: '' },
  });

function happyLLM(overrides: ConstructorParameters<typeof FakeLLM>[0] = {}) {
  return new FakeLLM({
    triage: () => ({
      files: [{ path: 'src/users.ts', review: true, reason: 'logic', summary: 'Builds SQL by hand' }],
    }),
    review: reviewAnswer,
    critic: () => ({
      verdicts: [
        { index: 0, keep: true, reason: 'ok' },
        { index: 1, keep: true, reason: 'ok' },
      ],
    }),
    consolidate: consolidatedAnswer,
    validate: prompt => {
      const fixes = prompt.match(/\[FIX-\d+\]/g)?.length ?? 0;
      if (fixes) return { verdicts: Array(fixes).fill(true) };
      const keep = [{ index: 0, keep: true, reason: 'grounded' }];
      return { securityConcerns: keep, recommendations: keep, testRequirements: keep };
    },
    persona: () => ({
      intro: 'One finding needs attention before merge.',
      aspects: [{ name: 'Security', status: 'critical', note: 'SQL built from input.' }],
      issues: [{ sourceId: 'ISSUE-1', title: 'Injection in findUser', description: 'The name reaches SQL unescaped.' }],
      files: [{ path: 'src/users.ts', description: 'User lookup.' }],
      verdict: 'Fix the query, then merge.',
    }),
    ...overrides,
  });
}

const cs = () =>
  changeSet([
    file({ path: 'src/users.ts', content: SQL_CONTENT }),
    file({ path: 'yarn.lock' }),
  ]);

class MemoryCache implements ReportCache {
  store = new Map<string, ReviewReport>();
  get(key: string) {
    return this.store.get(key);
  }
  async put(key: string, report: ReviewReport) {
    this.store.set(key, report);
  }
  async close() {}
}

describe('runReview', () => {
  test('runs every stage with impact, rules, validation and a persona presentation', async () => {
    const llm = happyLLM();
    const steps: string[] = [];
    const { report, cached } = await runReview(cs(), {
      config: testConfig({ persona: 'mentor' }),
      llm,
      provider: repo(),
      onStep: (step: RunStep, state: StepState) => steps.push(`${step}:${state}`),
    });

    expect(cached).toBe(false);
    const stages = [...new Set(llm.calls.map(c => c.stage))];
    expect(stages).toEqual(['triage', 'review', 'critic', 'consolidate', 'validate', 'persona']);
    expect(steps).toContain('impact:completed');
    expect(steps).toContain('validate:completed');
    expect(steps).toContain('persona:completed');

    const reviewPrompt = llm.callsFor('review')[0]!.prompt;
    expect(reviewPrompt).toContain('No string-built SQL.');
    expect(reviewPrompt).toContain('src/admin.ts');

    expect(report.findings.map(f => f.severity)).toEqual(['critical', 'low']);
    expect(report.rejected.map(r => r.finding.title)).toEqual(['Made up']);
    expect(report.skipped).toEqual([{ path: 'yarn.lock', reason: 'lockfile' }]);
    expect(report.fileReviews?.[0]?.positives).toEqual(['Small, focused function.']);
    expect(report.impact?.files['src/users.ts']?.impacted.map(i => i.path)).toEqual(['src/admin.ts']);
    expect(report.risk).toBe('high');
    expect(report.consolidated?.securityConcerns).toHaveLength(1);
    expect(report.consolidated?.testRequirements).toHaveLength(1);
    expect(report.presentation?.persona).toBe('mentor');
    expect(report.intro).toBe('One finding needs attention before merge.');
    expect(report.validated).toBe(true);
    expect(Object.keys(report.cost.byStage).sort()).toEqual(['consolidate', 'critic', 'persona', 'review', 'triage', 'validate']);
  });

  test('skips impact without a repository, validation when configured, and the presentation for "none"', async () => {
    const llm = happyLLM();
    const steps: string[] = [];
    const { report } = await runReview(cs(), {
      config: testConfig({ persona: 'none', skipValidation: true }),
      llm,
      onStep: (step: RunStep, state: StepState) => steps.push(`${step}:${state}`),
    });
    expect(steps).toEqual(expect.arrayContaining(['impact:skipped', 'validate:skipped', 'persona:skipped']));
    expect(llm.callsFor('validate')).toHaveLength(0);
    expect(llm.callsFor('persona')).toHaveLength(0);
    expect(report.presentation).toBeUndefined();
    expect(report.impact).toBeUndefined();
  });

  test('a non-critical review error marks the files failed and the report is not cached', async () => {
    const cache = new MemoryCache();
    const llm = happyLLM({
      review: () => {
        throw new Error('context too long');
      },
    });
    const { report } = await runReview(cs(), { config: testConfig({ persona: 'none' }), llm, cache });
    expect(report.fileReviews?.[0]?.status).toBe('error');
    expect(report.findings).toEqual([]);
    expect(cache.store.size).toBe(0);
  });

  test('a critical failure aborts the run', async () => {
    const llm = happyLLM({
      review: () => {
        throw Object.assign(new Error('all models failed'), { name: 'CriticalFailureError' });
      },
    });
    await expect(runReview(cs(), { config: testConfig(), llm })).rejects.toThrow('all models failed');
  });

  test('a PR with only skippable files makes no triage or review calls', async () => {
    const llm = happyLLM();
    const { report } = await runReview(changeSet([file({ path: 'package-lock.json' })]), {
      config: testConfig({ persona: 'none' }),
      llm,
    });
    expect(llm.callsFor('triage')).toHaveLength(0);
    expect(llm.callsFor('review')).toHaveLength(0);
    expect(report.reviewedFiles).toEqual([]);
  });

  test('reuses a cached report for the same commit unless asked to refresh', async () => {
    const cache = new MemoryCache();
    const config = testConfig({ persona: 'none' });
    await runReview(cs(), { config, llm: happyLLM(), cache });
    expect(cache.store.size).toBe(1);

    const second = happyLLM();
    const again = await runReview(cs(), { config, llm: second, cache });
    expect(again.cached).toBe(true);
    expect(second.calls).toHaveLength(0);

    const third = happyLLM();
    const fresh = await runReview(cs(), { config, llm: third, cache, fresh: true });
    expect(fresh.cached).toBe(false);
    expect(third.calls.length).toBeGreaterThan(0);
  });
});

describe('runReview caching and shortcuts', () => {
  test('when triage leaves nothing to review, no further model calls are made', async () => {
    const llm = happyLLM({
      triage: () => ({ files: [{ path: 'src/users.ts', review: false, reason: 'formatting only', summary: 'Whitespace' }] }),
    });
    const steps: string[] = [];
    const { report } = await runReview(cs(), {
      config: testConfig({ persona: 'mentor' }),
      llm,
      onStep: (step: RunStep, state: StepState) => steps.push(`${step}:${state}`),
    });
    expect([...new Set(llm.calls.map(c => c.stage))]).toEqual(['triage']);
    expect(steps).toEqual(expect.arrayContaining(['review:skipped', 'consolidate:skipped', 'persona:skipped']));
    expect(report.overview).toContain('No code in this change needed a review');
    expect(report.skipped.map(s => s.reason)).toEqual(['lockfile', 'triage: formatting only']);
    expect(report.risk).toBe('low');
  });

  test('a review cached without validation or with other rules is not reused for a normal run', async () => {
    const cache = new MemoryCache();
    await runReview(cs(), { config: testConfig({ persona: 'none', skipValidation: true }), llm: happyLLM(), cache });
    const normal = await runReview(cs(), { config: testConfig({ persona: 'none' }), llm: happyLLM(), cache });
    expect(normal.cached).toBe(false);

    const withRules = (content: string): RepoFileProvider => ({
      ...repo(),
      listRuleFiles: async () => [{ path: '.github/code-review.md', content }],
    });
    const config = testConfig({ persona: 'none', impact: { ...testConfig().impact, enabled: false } });
    await runReview(cs(), { config, llm: happyLLM(), cache, provider: withRules('Rule A') });
    expect((await runReview(cs(), { config, llm: happyLLM(), cache, provider: withRules('Rule A') })).cached).toBe(true);
    expect((await runReview(cs(), { config, llm: happyLLM(), cache, provider: withRules('Rule B') })).cached).toBe(false);
  });

  test('impact analysis is reused for the same repository state and changes', async () => {
    const impacts = new Map<string, unknown>();
    const impactCache = {
      get: (key: string) => impacts.get(key) as never,
      put: (key: string, value: unknown) => void impacts.set(key, value),
    };
    let listed = 0;
    const provider: RepoFileProvider = { ...repo(), listFiles: async () => (listed++, ['src/users.ts', 'src/admin.ts']) };
    const config = testConfig({ persona: 'none' });
    const first = await runReview(cs(), { config, llm: happyLLM(), provider, impactCache, fresh: true });
    const second = await runReview(cs(), { config, llm: happyLLM(), provider, impactCache, fresh: true });
    expect(impacts.size).toBe(1);
    expect(listed).toBe(1);
    expect(second.report.impact?.files).toEqual(first.report.impact?.files);
  });
});

test('sortFindings orders by severity, then file, then line', () => {
  const sorted = sortFindings([
    finding({ severity: 'low', file: 'a.ts', line: 1 }),
    finding({ severity: 'high', file: 'b.ts', line: 9 }),
    finding({ severity: 'high', file: 'b.ts', line: 2 }),
    finding({ severity: 'high', file: 'a.ts', line: 5 }),
  ]);
  expect(sorted.map(f => `${f.severity}:${f.file}:${f.line}`)).toEqual([
    'high:a.ts:5',
    'high:b.ts:2',
    'high:b.ts:9',
    'low:a.ts:1',
  ]);
});

describe('store', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test('cacheKey changes with the commit and with model settings', () => {
    const config = testConfig();
    const base = cacheKey(cs(), config);
    expect(base).toStartWith('gh:santhosh/demo#7@abc1234def5678:');
    expect(cacheKey(changeSet([], { headSha: 'other' }), config)).not.toBe(base);
    expect(cacheKey(cs(), { ...config, persona: 'terse' })).not.toBe(base);
    expect(cacheKey(changeSet([], { pull: undefined, baseRef: 'origin/dev' }), config)).toStartWith('local:origin/dev@');
  });

  test('LmdbReportCache persists reports across instances', async () => {
    dir = mkdtempSync(join(tmpdir(), 'ghr-store-'));
    const { report } = await runReview(cs(), { config: testConfig({ persona: 'none' }), llm: happyLLM() });

    const writer = new LmdbReportCache(dir);
    await writer.put('k', report);
    await writer.close();

    const reader = new LmdbReportCache(dir);
    expect(reader.get('k')).toEqual(report);
    expect(reader.get('missing')).toBeUndefined();
    await reader.close();
  });
});
