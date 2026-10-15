import { describe, expect, test } from 'bun:test';
import { DEFAULT_SECURITY_CONTEXT_RULES, securityContextFor } from '../../src/security-context';
import { formatDocsSummary, heuristicDocsSummary, partitionDocs, summarizeDocs } from '../../src/pipeline/docs';
import { FakeLLM, makeDeps } from '../helpers';

describe('securityContextFor', () => {
  test('entry points get untrusted-input focus', () => {
    expect(securityContextFor('src/controllers/user.ts').name).toBe('entry-point');
    expect(securityContextFor('app/api/v1/items.ts').name).toBe('entry-point');
    expect(securityContextFor('src/userController.ts').name).toBe('entry-point');
  });

  test('auth code gets access-control focus', () => {
    expect(securityContextFor('src/auth/login.ts').name).toBe('access-control');
    expect(securityContextFor('server/middleware/cors.ts').name).toBe('access-control');
  });

  test('everything else gets a normal review that still covers injection', () => {
    const ctx = securityContextFor('src/internal/report.ts');
    expect(ctx.name).toBe('general');
    expect(ctx.instructions).toContain('injection');
  });

  test('defaults never tell the reviewer to suppress findings', () => {
    for (const rule of DEFAULT_SECURITY_CONTEXT_RULES) {
      expect(rule.instructions).not.toMatch(/do not flag|don't flag|ignore|skip/i);
    }
  });

  test('custom rules take over', () => {
    const rules = [{ name: 'payments', patterns: ['billing/**'], instructions: 'Money!' }];
    expect(securityContextFor('billing/charge.ts', rules)).toEqual({ name: 'payments', instructions: 'Money!' });
    expect(securityContextFor('src/controllers/a.ts', rules).name).toBe('general');
  });
});

describe('docs', () => {
  test('partitionDocs separates project docs from reviewable markdown', () => {
    const files = ['README.md', 'docs/setup.md', '.github/PULL_REQUEST_TEMPLATE.md', 'CHANGELOG.md', 'src/prompts/system.md', 'src/a.ts', 'LICENSE.md'].map(path => ({ path }));
    const { docOnly, reviewable } = partitionDocs(files);
    expect(docOnly.map(f => f.path)).toEqual(['README.md', 'docs/setup.md', '.github/PULL_REQUEST_TEMPLATE.md', 'CHANGELOG.md', 'LICENSE.md']);
    expect(reviewable.map(f => f.path)).toEqual(['src/prompts/system.md', 'src/a.ts']);
  });

  const docs = [
    { path: 'README.md', content: '# Demo service\n\nIntro\n\n## Setup\n\n## Usage\n' },
    { path: 'docs/arch.md', content: 'Plain first line\nmore' },
  ];

  test('no docs means no model call', async () => {
    const llm = new FakeLLM({});
    expect(await summarizeDocs(makeDeps(llm), [])).toEqual({ perFile: {}, overall: '' });
    expect(llm.calls).toHaveLength(0);
  });

  test('uses the model and fills files it forgot heuristically', async () => {
    const llm = new FakeLLM({
      docs: () => ({ files: [{ path: 'README.md', summary: 'How to run it' }, { path: 'nope.md', summary: 'x' }], overall: 'A demo service' }),
    });
    const result = await summarizeDocs(makeDeps(llm), docs);
    expect(result.overall).toBe('A demo service');
    expect(result.perFile['README.md']).toBe('How to run it');
    expect(result.perFile['docs/arch.md']).toContain('Plain first line');
    expect(result.perFile['nope.md']).toBeUndefined();
    expect(formatDocsSummary(result)).toContain('- README.md: How to run it');
  });

  test('falls back to headings and section counts on failure', async () => {
    const llm = new FakeLLM({ docs: () => { throw new Error('down'); } });
    const deps = makeDeps(llm);
    const result = await summarizeDocs(deps, docs);
    expect(result).toEqual(heuristicDocsSummary(docs));
    expect(result.perFile['README.md']).toBe('README.md: Demo service (3 sections)');
    expect(result.overall).toContain('Demo service');
    expect(deps.logs[0]).toContain('docs summary failed');
  });
});
