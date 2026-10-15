import { describe, expect, test } from 'bun:test';
import { evidenceProblem, validateConsolidated } from '../../src/pipeline/validator';
import { FakeLLM, file, makeDeps } from '../helpers';
import { consolidated, fileReview, SQL_CONTENT, SQL_EVIDENCE } from './fixtures';

const users = file({ path: 'src/users.ts', content: SQL_CONTENT });
const files = new Map([[users.path, users]]);
const reviews = [fileReview()];
const keepAll = (n: number) => Array.from({ length: n }, (_, index) => ({ index, keep: true, reason: 'ok' }));

describe('evidenceProblem', () => {
  const reviewed = new Set(['src/users.ts']);
  test('accepts real evidence and rejects placeholders, unknown files, empty and invented snippets', () => {
    expect(evidenceProblem({ file: 'src/users.ts', snippet: SQL_EVIDENCE }, reviewed, files)).toBeNull();
    expect(evidenceProblem({ file: 'path/to/file.ts', snippet: 'x' }, reviewed, files)).toContain('placeholder');
    expect(evidenceProblem({ file: 'src/other.ts', snippet: 'x' }, reviewed, files)).toContain('not one of the reviewed');
    expect(evidenceProblem({ file: 'src/users.ts', snippet: ' ' }, reviewed, files)).toBe('no evidence code');
    expect(evidenceProblem({ file: 'src/users.ts', snippet: 'eval(x)' }, reviewed, files)).toContain('does not appear');
    expect(evidenceProblem({ file: '', snippet: 'x' }, reviewed, files)).toBe('no evidence file');
    // Without file contents the snippet cannot be checked, so only the path rules apply.
    expect(evidenceProblem({ file: 'src/users.ts', snippet: 'eval(x)' }, reviewed)).toBeNull();
  });
});

describe('validateConsolidated', () => {
  test('drops ungrounded items before the model, then applies index verdicts', async () => {
    const input = consolidated({
      recommendations: [
        { text: 'Real', priority: 'high', evidence: { file: 'src/users.ts', snippet: 'return db.query(sql);' } },
        { text: 'Fake path', priority: 'low', evidence: { file: 'path/to/file.ts', snippet: 'x' } },
        { text: 'Generic', priority: 'low', evidence: { file: 'src/users.ts', snippet: 'return db.query(sql);' } },
      ],
    });
    const llm = new FakeLLM({
      validate: prompt => {
        expect(prompt).not.toContain('Fake path');
        return {
          securityConcerns: keepAll(1),
          recommendations: [
            { index: 0, keep: true, reason: 'specific' },
            { index: 1, keep: false, reason: 'generic advice' },
          ],
          testRequirements: [{ index: 0, keep: true, reason: 'ok' }],
        };
      },
    });
    const { consolidated: out, removals } = await validateConsolidated(makeDeps(llm), input, reviews, { files });
    expect(llm.callsFor('validate')).toHaveLength(1);
    expect(out.recommendations.map(r => r.text)).toEqual(['Real']);
    expect(removals.recommendations.map(r => [r.item.text, r.reason])).toEqual([
      ['Fake path', 'placeholder evidence path "path/to/file.ts"'],
      ['Generic', 'generic advice'],
    ]);
    // The e2e test had no verdict: unconfirmed items are removed.
    expect(out.testRequirements.map(t => t.kind)).toEqual(['unit']);
    expect(removals.testRequirements[0]!.reason).toBe('the validator did not confirm it');
    expect(out.securityConcerns).toHaveLength(1);
    expect(out.overview).toBe(input.overview);
  });

  test('splits into parallel per-section calls for large reviews', async () => {
    const llm = new FakeLLM({ validate: prompt => ({ verdicts: keepAll(prompt.includes('Test requirements') ? 2 : 1) }) });
    const { consolidated: out, removals } = await validateConsolidated(makeDeps(llm), consolidated(), reviews, {
      files,
      splitAboveTokens: 10,
      count: () => 1_000,
    });
    const prompts = llm.callsFor('validate').map(c => c.prompt.split('\n')[0]);
    expect(prompts).toHaveLength(3);
    expect(prompts.some(p => p!.includes('security concerns'))).toBe(true);
    expect(out.testRequirements).toHaveLength(2);
    expect(removals.testRequirements).toEqual([]);
  });

  test('split mode skips empty sections', async () => {
    const llm = new FakeLLM({ validate: () => ({ verdicts: keepAll(2) }) });
    await validateConsolidated(makeDeps(llm), consolidated({ securityConcerns: [], recommendations: [] }), reviews, {
      splitAboveTokens: 0,
    });
    expect(llm.callsFor('validate')).toHaveLength(1);
  });

  test('any model failure returns the input unchanged with empty removals', async () => {
    const llm = new FakeLLM({
      validate: () => {
        throw new Error('timeout');
      },
    });
    const input = consolidated();
    const result = await validateConsolidated(makeDeps(llm), input, reviews, { files });
    expect(result.consolidated).toBe(input);
    expect(result.removals).toEqual({ securityConcerns: [], recommendations: [], testRequirements: [] });
  });

  test('a malformed answer also counts as a failure', async () => {
    const llm = new FakeLLM({ validate: () => ({ nope: true }) });
    const input = consolidated();
    expect((await validateConsolidated(makeDeps(llm), input, reviews)).consolidated).toBe(input);
  });

  test('makes no call when nothing survives the pre-check', async () => {
    const llm = new FakeLLM({});
    const input = consolidated({
      securityConcerns: [],
      recommendations: [],
      testRequirements: [
        { kind: 'unit', description: 'x', rationale: 'y', evidence: { file: 'src/ghost.ts', snippet: 'a' } },
      ],
    });
    const { consolidated: out, removals } = await validateConsolidated(makeDeps(llm), input, reviews, { files });
    expect(llm.calls).toHaveLength(0);
    expect(out.testRequirements).toEqual([]);
    expect(removals.testRequirements).toHaveLength(1);
  });
});
