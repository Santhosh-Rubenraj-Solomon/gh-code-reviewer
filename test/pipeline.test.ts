import { describe, expect, test } from 'bun:test';
import { buildBatches } from '../src/pipeline/batcher';
import { consolidate, riskFromFindings } from '../src/pipeline/consolidator';
import { critique, evidenceAppears } from '../src/pipeline/critic';
import { personaIntro } from '../src/pipeline/persona';
import { buildReviewPrompt, reviewBatch } from '../src/pipeline/reviewer';
import { staticTriage, triage } from '../src/pipeline/triage';
import { changeSet, FakeLLM, file, finding, makeDeps, SQL_CONTENT } from './helpers';

describe('staticTriage', () => {
  test('drops lockfiles, build output, binaries, snapshots, deletions and empty diffs', () => {
    const { candidates, skipped } = staticTriage([
      file({ path: 'src/users.ts' }),
      file({ path: 'package-lock.json' }),
      file({ path: 'web/bun.lock' }),
      file({ path: 'dist/index.js' }),
      file({ path: 'assets/logo.PNG' }),
      file({ path: 'src/__snapshots__/a.test.ts.snap' }),
      file({ path: 'app.min.js' }),
      file({ path: 'src/old.ts', status: 'removed' }),
      file({ path: 'src/renamed.ts', patch: '' }),
    ]);
    expect(candidates.map(f => f.path)).toEqual(['src/users.ts']);
    expect(Object.fromEntries(skipped.map(s => [s.path, s.reason]))).toEqual({
      'package-lock.json': 'lockfile',
      'web/bun.lock': 'lockfile',
      'dist/index.js': 'build output or vendored code',
      'assets/logo.PNG': 'binary asset',
      'src/__snapshots__/a.test.ts.snap': 'test snapshot',
      'app.min.js': 'minified or source map',
      'src/old.ts': 'file deleted',
      'src/renamed.ts': 'no text diff (binary, too large, or rename only)',
    });
  });

  test('does not skip source files whose names merely contain a skip word', () => {
    const { candidates } = staticTriage([file({ path: 'src/build-config.ts' }), file({ path: 'src/distance.ts' })]);
    expect(candidates).toHaveLength(2);
  });
});

describe('triage', () => {
  const files = [file({ path: 'src/users.ts' }), file({ path: 'README.md' }), file({ path: 'src/forgotten.ts' })];

  test('skips what the model rules out and keeps files it forgets to mention', async () => {
    const llm = new FakeLLM({
      triage: () => ({
        files: [
          { path: 'src/users.ts', review: true, reason: 'query logic', summary: 'Builds SQL by hand' },
          { path: 'README.md', review: false, reason: 'docs only', summary: 'Typo fix' },
        ],
      }),
    });
    const deps = makeDeps(llm);
    const result = await triage(deps, changeSet(files), files);
    expect(result.reviewable.map(f => f.path)).toEqual(['src/users.ts', 'src/forgotten.ts']);
    expect(result.skipped).toEqual([{ path: 'README.md', reason: 'triage: docs only' }]);
    expect(result.summaries).toEqual({ 'src/users.ts': 'Builds SQL by hand', 'README.md': 'Typo fix' });
    expect(deps.cost.summary().byStage.triage!.calls).toBe(1);
  });

  test('fails open when the model errors', async () => {
    const deps = makeDeps(
      new FakeLLM({
        triage: () => {
          throw new Error('quota');
        },
      }),
    );
    const result = await triage(deps, changeSet(files), files);
    expect(result.reviewable).toHaveLength(3);
    expect(deps.logs[0]).toContain('triage failed');
  });

  test('makes no model call when there is nothing to triage', async () => {
    const llm = new FakeLLM({});
    await triage(makeDeps(llm), changeSet([]), []);
    expect(llm.calls).toHaveLength(0);
  });
});

describe('buildBatches', () => {
  const count = (text: string) => text.length;

  test('groups by directory and respects the token budget', () => {
    const files = [
      file({ path: 'b/two.ts', patch: 'x'.repeat(40) }),
      file({ path: 'a/one.ts', patch: 'x'.repeat(40) }),
      file({ path: 'a/three.ts', patch: 'x'.repeat(40) }),
    ];
    const batches = buildBatches(files, { maxTokens: 100, maxFiles: 10, count });
    expect(batches.map(b => b.map(i => i.file.path))).toEqual([['a/one.ts', 'a/three.ts'], ['b/two.ts']]);
  });

  test('respects the file cap', () => {
    const files = ['a', 'b', 'c'].map(p => file({ path: `${p}.ts`, patch: 'x' }));
    expect(buildBatches(files, { maxTokens: 1_000, maxFiles: 2, count })).toHaveLength(2);
  });

  test('includes full content only when it fits', () => {
    const small = file({ path: 'a.ts', patch: 'x'.repeat(10), content: 'y'.repeat(20) });
    const huge = file({ path: 'b.ts', patch: 'x'.repeat(10), content: 'y'.repeat(500) });
    const items = buildBatches([small, huge], { maxTokens: 100, maxFiles: 10, count }).flat();
    expect(items.map(i => [i.file.path, i.includeContent])).toEqual([
      ['a.ts', true],
      ['b.ts', false],
    ]);
  });

  test('an oversized diff still gets its own batch', () => {
    const files = [file({ path: 'a.ts', patch: 'x'.repeat(500) }), file({ path: 'b.ts', patch: 'x' })];
    expect(buildBatches(files, { maxTokens: 100, maxFiles: 10, count })).toHaveLength(2);
  });

  test('no files means no batches', () => {
    expect(buildBatches([], { maxTokens: 100, maxFiles: 10 })).toEqual([]);
  });
});

describe('reviewer', () => {
  const users = file({ path: 'src/users.ts', content: SQL_CONTENT });
  const context = { title: 'Lookup', description: 'desc', rules: 'Always use bound parameters.', summaries: { 'src/users.ts': 'SQL helper' } };

  test('prompt carries the numbered diff, file content, rules and summaries', () => {
    const prompt = buildReviewPrompt([{ file: users, includeContent: true }], context);
    expect(prompt).toContain("## This team's review rules\nAlways use bound parameters.");
    expect(prompt).toContain('Summary: SQL helper');
    expect(prompt).toContain('    3 +  const sql');
    expect(prompt).toContain('Whole file after the change');
  });

  test('prompt omits file content when it did not fit', () => {
    const prompt = buildReviewPrompt([{ file: users, includeContent: false }], { ...context, rules: undefined });
    expect(prompt).not.toContain('Whole file after the change');
    expect(prompt).not.toContain('review rules');
  });

  test('drops findings for files that are not in the batch', async () => {
    const llm = new FakeLLM({
      review: () => ({ findings: [finding(), finding({ file: 'src/imaginary.ts' })] }),
    });
    const deps = makeDeps(llm);
    const findings = await reviewBatch(deps, [{ file: users, includeContent: true }], context);
    expect(findings).toHaveLength(1);
    expect(deps.logs).toContain('dropping finding for unknown file "src/imaginary.ts"');
  });

  test('schema-invalid model output surfaces as an error', async () => {
    const llm = new FakeLLM({ review: () => ({ findings: [{ file: 'src/users.ts' }] }) });
    await expect(reviewBatch(makeDeps(llm), [{ file: users, includeContent: true }], context)).rejects.toThrow();
  });
});

describe('critic', () => {
  const users = file({ path: 'src/users.ts', content: SQL_CONTENT });
  const files = new Map([[users.path, users]]);

  test('evidenceAppears accepts exact quotes, reflowed whitespace and leftover diff markers', () => {
    expect(evidenceAppears(finding(), users)).toBe(true);
    expect(evidenceAppears(finding({ evidence: 'const   sql =\n"SELECT * FROM users' }), users)).toBe(true);
    expect(evidenceAppears(finding({ evidence: '+  return db.query(sql);' }), users)).toBe(true);
  });

  test('evidenceAppears rejects invented code and unknown files', () => {
    expect(evidenceAppears(finding({ evidence: 'eval(userInput)' }), users)).toBe(false);
    expect(evidenceAppears(finding(), undefined)).toBe(false);
  });

  test('rejects ungrounded findings before asking the model, then applies verdicts', async () => {
    const real = finding();
    const style = finding({ title: 'Rename sql', severity: 'low', evidence: 'return db.query(sql);' });
    const invented = finding({ title: 'Uses eval', evidence: 'eval(userInput)' });
    const llm = new FakeLLM({
      critic: prompt => {
        expect(prompt).not.toContain('Uses eval');
        return {
          verdicts: [
            { index: 0, keep: true, reason: 'evidence shows concatenation' },
            { index: 1, keep: false, reason: 'style only' },
          ],
        };
      },
    });
    const result = await critique(makeDeps(llm), [real, style, invented], files);
    expect(result.kept).toEqual([real]);
    expect(result.validated).toBe(true);
    expect(result.rejected.map(r => [r.finding.title, r.reason])).toEqual([
      ['Uses eval', 'quoted evidence does not appear in the changed file'],
      ['Rename sql', 'critic: style only'],
    ]);
  });

  test('a finding the critic does not mention is rejected', async () => {
    const llm = new FakeLLM({ critic: () => ({ verdicts: [] }) });
    const result = await critique(makeDeps(llm), [finding()], files);
    expect(result.kept).toEqual([]);
    expect(result.rejected[0]!.reason).toBe('critic did not confirm it');
  });

  test('keeps grounded findings, marked unvalidated, when the critic call fails', async () => {
    const llm = new FakeLLM({
      critic: () => {
        throw new Error('timeout');
      },
    });
    const result = await critique(makeDeps(llm), [finding()], files);
    expect(result.kept).toHaveLength(1);
    expect(result.validated).toBe(false);
  });

  test('skips the model entirely when nothing is grounded', async () => {
    const llm = new FakeLLM({});
    const result = await critique(makeDeps(llm), [finding({ evidence: 'nope()' })], files);
    expect(llm.calls).toHaveLength(0);
    expect(result.kept).toEqual([]);
  });
});

describe('consolidate', () => {
  const cs = changeSet([file({ path: 'src/users.ts' })]);

  test('riskFromFindings follows the worst severity', () => {
    expect(riskFromFindings([])).toBe('low');
    expect(riskFromFindings([finding({ severity: 'low' })])).toBe('low');
    expect(riskFromFindings([finding({ severity: 'medium' })])).toBe('medium');
    expect(riskFromFindings([finding({ severity: 'critical' })])).toBe('high');
  });

  test('never reports less risk than the findings imply', async () => {
    const llm = new FakeLLM({ consolidate: () => ({ overview: 'Fine.', risk: 'low', highlights: [] }) });
    const result = await consolidate(makeDeps(llm), cs, {}, [finding({ severity: 'critical' })]);
    expect(result.risk).toBe('high');
    expect(result.overview).toBe('Fine.');
  });

  test('may report more risk than the findings imply', async () => {
    const llm = new FakeLLM({ consolidate: () => ({ overview: 'Risky migration.', risk: 'high', highlights: ['migration'] }) });
    expect((await consolidate(makeDeps(llm), cs, {}, [])).risk).toBe('high');
  });

  test('falls back to a plain summary on error', async () => {
    const llm = new FakeLLM({
      consolidate: () => {
        throw new Error('500');
      },
    });
    const result = await consolidate(makeDeps(llm), cs, {}, [finding()]);
    expect(result).toEqual({ overview: '1 file(s) changed; 1 verified finding(s).', risk: 'high', highlights: ['SQL injection in findUser'] });
  });
});

describe('personaIntro', () => {
  const overview = { overview: 'Adds a lookup.', risk: 'high' as const, highlights: [] };

  test('neutral persona makes no call', async () => {
    const llm = new FakeLLM({});
    expect(await personaIntro(makeDeps(llm), 'neutral', overview, [])).toBeUndefined();
    expect(llm.calls).toHaveLength(0);
  });

  test('other personas get their voice in the prompt', async () => {
    const llm = new FakeLLM({ persona: () => '  Elementary: the query is unsafe.  ' });
    const intro = await personaIntro(makeDeps(llm), 'detective', overview, [finding()]);
    expect(intro).toBe('Elementary: the query is unsafe.');
    expect(llm.calls[0]!.prompt).toContain('Victorian consulting detective');
  });

  test('errors are swallowed because the intro is cosmetic', async () => {
    const llm = new FakeLLM({
      persona: () => {
        throw new Error('x');
      },
    });
    expect(await personaIntro(makeDeps(llm), 'mentor', overview, [])).toBeUndefined();
  });
});
