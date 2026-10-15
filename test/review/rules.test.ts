import { describe, expect, test } from 'bun:test';
import { makeDeps, FakeLLM } from '../helpers';
import { loadRuleSet, parseRuleFile } from '../../src/review-rules';
import { formatVerifyReport, suggestRuleImprovements, verifyRules } from '../../src/verify-rules';

describe('parseRuleFile', () => {
  test('no frontmatter means a global body', () => {
    expect(parseRuleFile('Use bound parameters.\n')).toEqual({ globs: [], body: 'Use bound parameters.' });
  });

  test('inline JSON array', () => {
    expect(parseRuleFile('---\nglobs: ["src/**/*.ts", "lib/*.js"]\n---\nBody')).toEqual({
      globs: ['src/**/*.ts', 'lib/*.js'],
      body: 'Body',
    });
  });

  test('unquoted inline list and single value', () => {
    expect(parseRuleFile('---\nglobs: [src/*.ts, \'lib/*\']\n---\nB').globs).toEqual(['src/*.ts', 'lib/*']);
    expect(parseRuleFile('---\nglobs: "api/**"\n---\nB').globs).toEqual(['api/**']);
  });

  test('dash list, other keys, CRLF and BOM', () => {
    const text = '﻿---\r\ntitle: SQL\r\nglobs:\r\n  - "db/**"\r\n  - src/*.sql\r\nowner: data\r\n---\r\n\r\nRules here\r\n';
    expect(parseRuleFile(text)).toEqual({ globs: ['db/**', 'src/*.sql'], body: 'Rules here' });
  });

  test('frontmatter without globs and malformed globs', () => {
    expect(parseRuleFile('---\ntitle: x\n---\nB')).toEqual({ globs: [], body: 'B' });
    expect(parseRuleFile('---\nglobs: [unterminated\n---\nB').error).toContain('cannot read globs');
  });
});

describe('loadRuleSet', () => {
  const files = [
    { path: '.review/sql.md', content: '---\nglobs: ["db/**"]\n---\nUse bound parameters.' },
    { path: '.review/all.md', content: '---\nglobs: ["*"]\n---\nNo console.log.' },
    { path: '.github/code-review.md', content: '---\nglobs: ["nothing/**"]\n---\nBe kind.' },
    { path: '.review/ui.md', content: 'React hooks rules.' },
  ];

  test('separates global and scoped rules', () => {
    const set = loadRuleSet(files);
    expect(set.rules.filter(r => r.global).map(r => r.path)).toEqual([
      '.github/code-review.md',
      '.review/all.md',
      '.review/ui.md',
    ]);
    expect(set.forFile('db/users.ts')).toContain('Use bound parameters.');
    expect(set.forFile('db/users.ts')).toContain('Be kind.');
    expect(set.forFile('web/app.ts')).not.toContain('bound parameters');
    expect(set.scopedFor('web/app.ts')).toBe('');
    expect(set.globalText()).toContain('No console.log.');
    expect(set.globalText()).not.toContain('bound parameters');
  });

  test('token helpers count scoped and global text separately', () => {
    const set = loadRuleSet(files);
    const count = (t: string) => t.length;
    expect(set.tokensForFile('web/app.ts', count)).toBe(0);
    expect(set.tokensForFile('db/x.ts', count)).toBe(set.scopedFor('db/x.ts').length);
    expect(set.globalTokens(count)).toBe(set.globalText().length);
  });

  test('applies per-file and total limits and skips empty or broken files', () => {
    const set = loadRuleSet(
      [
        { path: '.review/a.md', content: 'a'.repeat(30) },
        { path: '.review/b.md', content: 'b'.repeat(200) },
        { path: '.review/c.md', content: 'c'.repeat(30) },
        { path: '.review/d.md', content: '---\nglobs: ["x/**"]\n---\n   ' },
        { path: '.review/e.md', content: '---\nglobs: ["/abs"]\n---\nE' },
        { path: '.review/f.md', content: 'f'.repeat(30) },
      ],
      { maxFileChars: 100, maxTotalChars: 70 },
    );
    expect(set.rules.map(r => r.path)).toEqual(['.review/a.md', '.review/c.md']);
    const reasons = Object.fromEntries(set.skipped.map(s => [s.path, s.reason]));
    expect(reasons['.review/b.md']).toContain('larger than 100');
    expect(reasons['.review/d.md']).toContain('no rule text');
    expect(reasons['.review/e.md']).toContain('invalid glob');
    expect(reasons['.review/f.md']).toContain('total rule size');
  });
});

describe('verifyRules', () => {
  const repoFiles = ['src/a.ts', 'src/b.ts', 'db/q.sql'];

  test('all valid', () => {
    const report = verifyRules({
      ruleFiles: [
        { path: '.review/sql.md', content: '---\nglobs: ["db/**"]\n---\nBind.' },
        { path: '.review/all.md', content: 'Everything.' },
      ],
      repoFiles,
      count: t => t.length,
      budgetTokens: 1000,
    });
    expect(report.status).toBe('ok');
    const sql = report.files.find(f => f.path === '.review/sql.md')!;
    expect(sql.matches).toBe(1);
    expect(report.files.find(f => f.path === '.review/all.md')!.matches).toBe(3);
    expect(report.totals.globalTokens).toBe('Everything.'.length);
    expect(report.totals.budgetPercent).toBeCloseTo(((11 + 5) / 1000) * 100);
    expect(formatVerifyReport(report)).toContain('Status: all rules valid');
  });

  test('warnings for empty bodies and zero matches', () => {
    const report = verifyRules({
      ruleFiles: [
        { path: '.review/none.md', content: '---\nglobs: ["mobile/**"]\n---\nX' },
        { path: '.review/empty.md', content: '' },
      ],
      repoFiles,
    });
    expect(report.status).toBe('warnings');
    expect(report.files.find(f => f.path === '.review/none.md')!.warnings[0]).toContain('match no files');
    expect(report.files.find(f => f.path === '.review/empty.md')!.warnings).toContain('empty rule body');
    expect(formatVerifyReport(report)).toContain('valid, with warnings');
  });

  test('errors for oversized files and invalid globs; total over limit is a warning', () => {
    const report = verifyRules({
      ruleFiles: [
        { path: '.review/big.md', content: 'x'.repeat(50) },
        { path: '.review/bad.md', content: '---\nglobs: ["src/{a"]\n---\nX' },
      ],
      repoFiles,
      limits: { maxFileChars: 40, maxTotalChars: 45 },
    });
    expect(report.status).toBe('errors');
    expect(report.files.find(f => f.path === '.review/big.md')!.errors[0]).toContain('too large');
    expect(report.files.find(f => f.path === '.review/bad.md')!.errors[0]).toContain('invalid glob');
    expect(report.warnings[0]).toContain('over the 45 limit');
    expect(formatVerifyReport(report)).toContain('errors found');
  });

  test('suggestions send metadata and at most 200 paths, and return [] on failure', async () => {
    const report = verifyRules({ ruleFiles: [{ path: '.review/a.md', content: 'SECRET RULE TEXT' }], repoFiles });
    const many = Array.from({ length: 300 }, (_, i) => `f${i}.ts`);
    const llm = new FakeLLM({ docs: () => ({ suggestions: [{ type: 'gap', message: 'Nothing covers db/' }] }) });
    const result = await suggestRuleImprovements(makeDeps(llm), report, many);
    expect(result).toEqual([{ type: 'gap', message: 'Nothing covers db/' }]);
    const prompt = llm.calls[0]!.prompt;
    expect(prompt).not.toContain('SECRET RULE TEXT');
    expect(prompt).toContain('f199.ts');
    expect(prompt).not.toContain('f200.ts');

    const broken = new FakeLLM({ docs: () => ({ suggestions: [{ type: 'nonsense', message: 'x' }] }) });
    expect(await suggestRuleImprovements(makeDeps(broken), report, many)).toEqual([]);
  });
});
