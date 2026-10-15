import { describe, expect, test } from 'bun:test';
import { BUILT_IN_PERSONA_DEFS } from '../../src/personas';
import {
  assemblePresentation,
  assignIssueIds,
  basicPresentation,
  buildPresentation,
  checkFixQuality,
  countSpeculation,
  groundedIn,
  isContradictory,
  type PresentationInput,
  type PresentationOutput,
} from '../../src/pipeline/presentation';
import type { ImpactResult, PresentationIssue } from '../../src/types';
import { FakeLLM, file, finding, makeDeps } from '../helpers';
import { consolidated, fileReview, SQL_CONTENT } from './fixtures';

const persona = BUILT_IN_PERSONA_DEFS.captain!;
const users = file({ path: 'src/users.ts', content: SQL_CONTENT });
const readme = file({ path: 'src/clean.ts', patch: '@@ -0,0 +1 @@\n+export const answer = 42;', content: 'export const answer = 42;\n' });

const noSuggestion = finding({ title: 'Query result unchecked', severity: 'medium', category: 'bug', suggestion: undefined, evidence: 'return db.query(sql);' });

function input(overrides: Partial<PresentationInput> = {}): PresentationInput {
  return {
    title: 'Look up users by name',
    consolidated: consolidated(),
    fileReviews: [fileReview(), fileReview({ path: 'src/clean.ts', findings: [], whatChanged: 'Adds a constant.' })],
    findings: [finding(), noSuggestion],
    files: new Map([
      [users.path, users],
      [readme.path, readme],
    ]),
    ...overrides,
  };
}

function output(overrides: Partial<PresentationOutput> = {}): PresentationOutput {
  return {
    intro: 'Crew, the lookup is ready to inspect.',
    aspects: [{ name: 'Security', status: 'critical', note: 'Injection.' }],
    issues: [
      { sourceId: 'ISSUE-1', title: 'Injection off the bow', description: 'Names flow into SQL.', fix: 'model fix ignored' },
      { sourceId: 'issue-2', title: 'Unchecked result', description: 'The query result is returned as is.', fix: 'if (!sql) throw new Error(name);' },
      { sourceId: 'ISSUE-9', title: 'Invented', description: 'Not real.' },
    ],
    files: [{ path: 'src/users.ts', description: 'Lookup helper.' }],
    verdict: 'Hold the ship until the query is fixed.',
    ...overrides,
  };
}

describe('ids and filters', () => {
  test('ids are stable and skip praise and notes', () => {
    const ids = assignIssueIds([
      finding({ title: 'A' }),
      finding({ title: 'Good use of early returns', severity: 'low' }),
      finding({ title: 'B', category: 'note' }),
      finding({ title: 'C' }),
    ]);
    expect(ids.map(i => [i.id, i.finding.title])).toEqual([
      ['ISSUE-1', 'A'],
      ['ISSUE-2', 'C'],
    ]);
  });

  test('isContradictory flags serious bug/security issues that call the code fine with no caveat', () => {
    const base: PresentationIssue = { id: 'ISSUE-1', title: 't', severity: 'high', type: 'security', description: '', files: [] };
    expect(isContradictory({ ...base, description: 'The input is properly validated here.' })).toBe(true);
    expect(isContradictory({ ...base, description: 'This code is correct and safe.' })).toBe(true);
    expect(isContradictory({ ...base, description: 'The parsing is correct, but the length is not checked.' })).toBe(false);
    expect(isContradictory({ ...base, severity: 'low', description: 'This code is correct.' })).toBe(false);
    expect(isContradictory({ ...base, type: 'style', description: 'This code is correct.' })).toBe(false);
  });

  test('groundedIn needs at least half of the significant identifiers', () => {
    const known = new Set(['findUser', 'query', 'sql', 'name']);
    expect(groundedIn('findUser(name) query', known)).toBe(true); // 3 of 3 (name, findUser, query)
    expect(groundedIn('findUser alpha', known)).toBe(true); // 1 of 2 = 50%
    expect(groundedIn('findUser alpha beta', known)).toBe(false); // 1 of 3
    expect(groundedIn('if (a) { x }', known)).toBe(true); // nothing significant to check
  });

  test('countSpeculation ignores code and finds hedges in prose', () => {
    const md = 'This might fail. If the user retries, make sure to log.\n```ts\nit("should work")\n```\n`would`';
    expect(countSpeculation(md)).toEqual({ count: 3, phrases: ['might', 'if the', 'make sure'] });
  });
});

describe('assemblePresentation', () => {
  test('takes evidence and fixes from the source, drops unknown ids and appends skipped issues', () => {
    const p = assemblePresentation(persona, input(), assignIssueIds(input().findings), output({ issues: [output().issues[0]!, output().issues[2]!] }));
    expect(p.persona).toBe('captain');
    expect(p.issues.map(i => i.id)).toEqual(['ISSUE-1', 'ISSUE-2']);
    const [first, second] = p.issues;
    expect(first).toMatchObject({ title: 'Injection off the bow', severity: 'critical', type: 'security', files: ['src/users.ts'] });
    expect(first!.evidence).toBe(finding().evidence);
    expect(first!.fix).toBe(finding().suggestion);
    // ISSUE-2 was skipped by the model, so it keeps the source wording.
    expect(second!.title).toBe('Query result unchecked');
  });

  test('accepts a model fix only when the source has none and it refers to real code', () => {
    const grounded = assemblePresentation(persona, input(), assignIssueIds(input().findings), output());
    expect(grounded.issues[1]!.fix).toBe('if (!sql) throw new Error(name);');
    const invented = output();
    invented.issues[1] = { ...invented.issues[1]!, fix: 'sanitizeEverything(payload, schemaRegistry)' };
    const logs: string[] = [];
    const p = assemblePresentation(persona, input(), assignIssueIds(input().findings), invented, m => logs.push(m));
    expect(p.issues[1]!.fix).toBeUndefined();
    expect(logs[0]).toContain('proposed fix does not refer to the changed code');
  });

  test('drops ungrounded evidence', () => {
    const ghost = finding({ evidence: 'totallyInvented(ghostValue, phantom)' });
    const p = assemblePresentation(persona, input({ findings: [ghost] }), assignIssueIds([ghost]), output({ issues: [] }));
    expect(p.issues[0]!.evidence).toBeUndefined();
  });

  test('drops self-contradicting serious issues', () => {
    const raw = output();
    raw.issues[0] = { ...raw.issues[0]!, description: 'The query is correct and safe.' };
    const p = assemblePresentation(persona, input(), assignIssueIds(input().findings), raw);
    expect(p.issues.map(i => i.id)).toEqual(['ISSUE-2']);
  });

  test('builds the files table with missing files, clean files and impact labels', () => {
    const impact = {
      files: { 'src/users.ts': { path: 'src/users.ts', modifiedExports: [], impacted: [{}, {}], level: 'high' } },
      blastRadius: { level: 'high', description: 'Used by admin.', criticalPaths: [] },
      coverage: { untested: [], testsToUpdate: [], coveredBy: {} },
      semantic: [],
      edges: [],
      notes: [],
    } as unknown as ImpactResult;
    const p = assemblePresentation(persona, input({ impact }), assignIssueIds(input().findings), output());
    expect(p.filesTable).toEqual([
      { path: 'src/users.ts', status: 'critical', description: 'Lookup helper.', impact: 'high · 2 dependent file(s)' },
      { path: 'src/clean.ts', status: 'clean', description: 'Adds a constant.' },
    ]);
    expect(p.cleanFiles).toEqual(['src/clean.ts']);
  });

  test('empty model text falls back to data', () => {
    const p = assemblePresentation(persona, input(), assignIssueIds(input().findings), output({ intro: '', aspects: [], verdict: ' ' }));
    expect(p.intro).toBe(consolidated().overview);
    expect(p.aspects.map(a => [a.name, a.status])).toEqual([
      ['Correctness', 'warning'],
      ['Security', 'critical'],
      ['Performance', 'clean'],
      ['Maintainability', 'clean'],
    ]);
    expect(p.verdict).toContain('Not ready to merge');
  });
});

describe('checkFixQuality', () => {
  const issue = (i: number): PresentationIssue => ({
    id: `ISSUE-${i + 1}`, title: `t${i}`, severity: 'low', type: 'bug', description: 'd', files: ['a.ts'], fix: `fix${i}`,
  });

  test('checks fixes in batches of 15 and strips rejected ones', async () => {
    const issues = [...Array.from({ length: 20 }, (_, i) => issue(i)), { ...issue(20), fix: undefined }];
    const llm = new FakeLLM({
      validate: prompt => {
        const n = (prompt.match(/\[FIX-\d+\]/g) ?? []).length;
        return { verdicts: Array.from({ length: n }, (_, i) => i !== 0) };
      },
    });
    const out = await checkFixQuality(makeDeps(llm), issues);
    expect(llm.callsFor('validate').map(c => (c.prompt.match(/\[FIX-\d+\]/g) ?? []).length)).toEqual([15, 5]);
    expect(out.filter(i => !i.fix).map(i => i.id)).toEqual(['ISSUE-1', 'ISSUE-16', 'ISSUE-21']);
  });

  test('keeps fixes when the answer has the wrong length or the call fails', async () => {
    const wrong = new FakeLLM({ validate: () => ({ verdicts: [false] }) });
    expect((await checkFixQuality(makeDeps(wrong), [issue(0), issue(1)])).every(i => i.fix)).toBe(true);
    const broken = new FakeLLM({ validate: () => { throw new Error('x'); } });
    expect((await checkFixQuality(makeDeps(broken), [issue(0)]))[0]!.fix).toBe('fix0');
  });
});

describe('buildPresentation', () => {
  test('returns straight away when the first attempt has no hedging', async () => {
    const llm = new FakeLLM({ persona: () => output(), validate: () => ({ verdicts: [true, true] }) });
    const p = await buildPresentation(makeDeps(llm), persona, input());
    expect(llm.callsFor('persona')).toHaveLength(1);
    expect(llm.callsFor('validate')).toHaveLength(1);
    expect(p.intro).toBe('Crew, the lookup is ready to inspect.');
    expect(llm.calls[0]!.prompt).toContain(persona.voice);
    expect(llm.calls[0]!.prompt).toContain('[ISSUE-1] critical security in src/users.ts:3');
  });

  test('retries with a correction and keeps the attempt with the fewest hedges', async () => {
    const intros = ['This might, could and would fail.', 'This might fail.', 'It could and should fail.'];
    let n = 0;
    const llm = new FakeLLM({ persona: () => output({ intro: intros[n++]! }), validate: () => ({ verdicts: [true, true] }) });
    const deps = makeDeps(llm);
    const p = await buildPresentation(deps, persona, input());
    const calls = llm.callsFor('persona');
    expect(calls).toHaveLength(3);
    expect(calls[0]!.prompt).not.toContain('Correction:');
    expect(calls[1]!.prompt).toContain('Correction: The previous attempt used speculative wording (might, could, would)');
    expect(p.intro).toBe('This might fail.');
  });

  test('failed attempts count, and a later success is used', async () => {
    let n = 0;
    const llm = new FakeLLM({
      persona: () => {
        if (++n < 3) throw new Error('timeout');
        return output();
      },
    });
    const p = await buildPresentation(makeDeps(llm), persona, input());
    expect(n).toBe(3);
    expect(p.verdict).toBe('Hold the ship until the query is fixed.');
  });

  test('falls back to the basic presentation when every attempt fails', async () => {
    const llm = new FakeLLM({ persona: () => ({ wrong: 'shape' }) });
    const p = await buildPresentation(makeDeps(llm), persona, input(), { maxAttempts: 2 });
    expect(llm.callsFor('persona')).toHaveLength(2);
    expect(p).toEqual(basicPresentation(persona, input()));
    expect(p.issues.map(i => i.id)).toEqual(['ISSUE-1', 'ISSUE-2']);
    expect(p.issues[0]!.fix).toBe(finding().suggestion);
    expect(p.cleanFiles).toEqual(['src/clean.ts']);
  });
});
