import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runReview, sortFindings } from '../src/pipeline/run';
import { cacheKey, LmdbReportCache, type ReportCache } from '../src/store';
import type { ReviewReport } from '../src/types';
import { changeSet, FakeLLM, file, finding, SQL_CONTENT, testConfig } from './helpers';

function happyLLM() {
  return new FakeLLM({
    triage: () => ({
      files: [{ path: 'src/users.ts', review: true, reason: 'logic', summary: 'Builds SQL by hand' }],
    }),
    review: () => ({
      findings: [
        finding({ severity: 'low', title: 'Minor: missing return type', evidence: 'export async function findUser(name: string) {' }),
        finding(),
        finding({ title: 'Made up', evidence: 'exec(cmd)' }),
      ],
    }),
    critic: () => ({
      verdicts: [
        { index: 0, keep: true, reason: 'ok' },
        { index: 1, keep: true, reason: 'ok' },
      ],
    }),
    consolidate: () => ({ overview: 'Adds a lookup with an injection bug.', risk: 'high', highlights: ['findUser'] }),
    persona: () => 'Hello.',
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
  test('runs every stage and assembles a sorted, verified report', async () => {
    const llm = happyLLM();
    const { report, cached } = await runReview(cs(), { config: testConfig({ persona: 'mentor' }), llm });

    expect(cached).toBe(false);
    expect(llm.calls.map(c => c.stage)).toEqual(['triage', 'review', 'critic', 'consolidate', 'persona']);
    expect(report.findings.map(f => f.severity)).toEqual(['critical', 'low']);
    expect(report.rejected.map(r => r.finding.title)).toEqual(['Made up']);
    expect(report.skipped).toEqual([{ path: 'yarn.lock', reason: 'lockfile' }]);
    expect(report.reviewedFiles).toEqual(['src/users.ts']);
    expect(report.risk).toBe('high');
    expect(report.intro).toBe('Hello.');
    expect(report.validated).toBe(true);
    expect(report.cost.totalUsd).toBeGreaterThan(0);
    expect(Object.keys(report.cost.byStage).sort()).toEqual(['consolidate', 'critic', 'persona', 'review', 'triage']);
  });

  test('passes team rules through to the review prompt', async () => {
    const llm = happyLLM();
    await runReview(cs(), { config: testConfig(), llm, rules: 'No string-built SQL.' });
    expect(llm.callsFor('review')[0]!.prompt).toContain('No string-built SQL.');
  });

  test('a failing batch is logged and the rest of the review continues', async () => {
    const llm = new FakeLLM({
      triage: () => ({ files: [] }),
      review: () => {
        throw new Error('context too long');
      },
      consolidate: () => ({ overview: 'ok', risk: 'low', highlights: [] }),
    });
    const logs: string[] = [];
    const { report } = await runReview(cs(), { config: testConfig(), llm, log: m => logs.push(m) });
    expect(report.findings).toEqual([]);
    expect(logs.some(l => l.includes('batch 1 failed'))).toBe(true);
  });

  test('a PR with only skippable files makes almost no model calls', async () => {
    const llm = new FakeLLM({ consolidate: () => ({ overview: 'Lockfile bump.', risk: 'low', highlights: [] }) });
    const { report } = await runReview(changeSet([file({ path: 'package-lock.json' })]), { config: testConfig(), llm });
    expect(llm.calls.map(c => c.stage)).toEqual(['consolidate']);
    expect(report.reviewedFiles).toEqual([]);
  });

  test('reuses a cached report for the same commit unless asked to refresh', async () => {
    const cache = new MemoryCache();
    const config = testConfig();
    const first = happyLLM();
    await runReview(cs(), { config, llm: first, cache });
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
    const { report } = await runReview(cs(), { config: testConfig(), llm: happyLLM() });

    const writer = new LmdbReportCache(dir);
    await writer.put('k', report);
    await writer.close();

    const reader = new LmdbReportCache(dir);
    expect(reader.get('k')).toEqual(report);
    expect(reader.get('missing')).toBeUndefined();
    await reader.close();
  });
});
