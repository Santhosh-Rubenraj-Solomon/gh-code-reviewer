import { describe, expect, test } from 'bun:test';
import { consolidate, fallbackConsolidated, riskFromFindings, type ConsolidatedOutput } from '../../src/pipeline/consolidator';
import { changeSet, FakeLLM, file, finding, makeDeps } from '../helpers';
import { fileReview, SQL_EVIDENCE } from './fixtures';

const cs = changeSet([file({ path: 'src/users.ts' })]);
const ev = { file: 'src/users.ts', snippet: SQL_EVIDENCE };

function output(overrides: Partial<ConsolidatedOutput> = {}): ConsolidatedOutput {
  return {
    overview: 'Adds a lookup.',
    risk: 'low',
    highlights: ['a', 'b', 'c', 'd', 'e'],
    architectureChanges: [' New helper ', ''],
    securityConcerns: [
      { description: 'Injection', severity: 'critical', category: 'taint', affectedFiles: ['src/users.ts'], remediation: 'Bind', evidence: ev },
    ],
    securityChecklist: {
      impactsSecurity: true,
      cryptographicChange: false,
      secureChannelModified: false,
      dataManagementChange: false,
      otherSecurityImpact: false,
    },
    recommendations: Array.from({ length: 7 }, (_, i) => ({ text: `rec ${i}`, priority: 'high' as const, evidence: ev })),
    functionality: { isComplete: true, missing: [], explanation: 'Done.' },
    unitTests: [{ description: 'unit one', rationale: 'r', evidence: ev }],
    e2eTests: [{ description: 'e2e one', rationale: 'r', evidence: ev }, { description: ' ', rationale: '', evidence: ev }],
    codeQuality: { patterns: '', complexity: '', maintainability: '' },
    dependencies: { added: '', impact: '', security: '' },
    performance: { bottlenecks: '', resources: '', scalability: '' },
    limitations: [],
    completeness: 'complete',
    ...overrides,
  };
}

const input = (overrides = {}) => ({
  fileReviews: [fileReview()],
  findings: [finding({ severity: 'critical' })],
  summaries: { 'src/users.ts': 'user lookup' },
  ...overrides,
});

describe('consolidate', () => {
  test('maps the model output into Consolidated, capping lists and dropping blanks', async () => {
    const llm = new FakeLLM({ consolidate: () => output() });
    const c = await consolidate(makeDeps(llm), cs, input());
    expect(c.highlights).toHaveLength(4);
    expect(c.recommendations).toHaveLength(5);
    expect(c.architectureChanges).toEqual(['New helper']);
    expect(c.testRequirements.map(t => [t.kind, t.description])).toEqual([
      ['unit', 'unit one'],
      ['e2e', 'e2e one'],
    ]);
    expect(llm.callsFor('consolidate')).toHaveLength(1);
  });

  test('never reports less risk than the verified findings imply', async () => {
    const llm = new FakeLLM({ consolidate: () => output({ risk: 'low' }) });
    expect((await consolidate(makeDeps(llm), cs, input())).risk).toBe('high');
    const medium = await consolidate(makeDeps(llm), cs, input({ findings: [finding({ severity: 'medium' })] }));
    expect(medium.risk).toBe('medium');
    expect(riskFromFindings([finding({ severity: 'low' })])).toBe('low');
  });

  test('retries once after an invalid answer', async () => {
    let n = 0;
    const llm = new FakeLLM({ consolidate: () => (++n === 1 ? { overview: 'missing everything' } : output()) });
    const deps = makeDeps(llm);
    const c = await consolidate(deps, cs, input());
    expect(n).toBe(2);
    expect(c.overview).toBe('Adds a lookup.');
    expect(deps.logs.some(l => l.includes('attempt 1 failed'))).toBe(true);
  });

  test('falls back to a deterministic review after two empty answers, without throwing', async () => {
    const llm = new FakeLLM({ consolidate: () => output({ overview: '   ' }) });
    const c = await consolidate(makeDeps(llm), cs, input({ findings: [finding()] }));
    expect(llm.callsFor('consolidate')).toHaveLength(2);
    expect(c.overview).toContain('1 file(s) changed; 1 verified finding(s).');
    expect(c.overview).toContain('src/users.ts: Builds the user lookup query by hand.');
    expect(c.risk).toBe('high');
    expect(c.securityConcerns[0]).toMatchObject({ category: 'taint', evidence: { file: 'src/users.ts', line: 3 } });
    expect(c.recommendations[0]!.text).toContain('Use a parameterised query');
    expect(c.testRequirements[0]!.kind).toBe('unit');
    expect(c.limitations[0]).toContain('consolidation step failed');
  });

  test('a model claiming completeness is downgraded when file reviews failed', async () => {
    const llm = new FakeLLM({ consolidate: () => output() });
    const c = await consolidate(
      makeDeps(llm),
      cs,
      input({ fileReviews: [fileReview(), fileReview({ path: 'src/b.ts', status: 'timeout' })] }),
    );
    expect(c.completeness).toBe('partial');
  });

  test('the prompt carries docs, impact, rules, file reviews and the evidence-only rules', async () => {
    const llm = new FakeLLM({ consolidate: () => output() });
    await consolidate(makeDeps(llm), cs, input({ docsSummary: 'DOCS-X', impactSummary: 'IMPACT-Y', globalRules: 'RULE-Z' }));
    const prompt = llm.calls[0]!.prompt;
    for (const s of ['DOCS-X', 'IMPACT-Y', 'RULE-Z', 'Builds the user lookup', 'Do not use speculative wording']) {
      expect(prompt).toContain(s);
    }
  });

  test('legacy (summaries, findings) call still works', async () => {
    const llm = new FakeLLM({
      consolidate: () => {
        throw new Error('500');
      },
    });
    const c = await consolidate(makeDeps(llm), cs, {}, [finding()]);
    expect(c.overview).toBe('1 file(s) changed; 1 verified finding(s).');
    expect(c.highlights).toEqual(['SQL injection in findUser']);
  });

  test('fallback with failed file reviews is limited and lists them', () => {
    const c = fallbackConsolidated(cs, input({ findings: [], fileReviews: [fileReview({ status: 'error', error: 'boom' })] }));
    expect(c.completeness).toBe('limited');
    expect(c.limitations[1]).toBe('src/users.ts was not fully reviewed (error: boom).');
    expect(c.risk).toBe('low');
  });
});
