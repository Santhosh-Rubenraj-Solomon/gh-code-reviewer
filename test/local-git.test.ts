import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalChanges, type GitRunner } from '../src/sources/local-git';

describe('loadLocalChanges with a scripted git', () => {
  const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
  const answers: Record<string, string> = {
    'merge-base': 'base000\n',
    'rev-parse': 'head111\n',
    diff,
  };

  test('asks git for the right things and builds a change set', () => {
    const calls: string[][] = [];
    const git: GitRunner = args => {
      calls.push(args);
      if (args[0] === 'log') return args[1] === '-1' ? 'Fix the thing\n' : '- Fix the thing\n- Prep\n';
      return answers[args[0]!] ?? '';
    };
    const cs = loadLocalChanges({ base: 'origin/dev', cwd: '/repo', git, readText: p => (p === '/repo/a.ts' ? 'new\n' : null) });

    expect(calls[0]).toEqual(['merge-base', 'origin/dev', 'HEAD']);
    expect(calls).toContainEqual(['diff', '--no-color', '--find-renames', 'base000', 'HEAD']);
    expect(cs).toMatchObject({ source: 'local', title: 'Fix the thing', baseRef: 'origin/dev', headSha: 'head111' });
    expect(cs.description).toBe('- Fix the thing\n- Prep');
    expect(cs.files).toEqual([{ path: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1, content: 'new\n', previousPath: undefined }]);
    expect(cs.pull).toBeUndefined();
  });
});

describe('loadLocalChanges against a real repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ghr-git-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('reviews commits made after the base branch', () => {
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    writeFileSync(join(dir, 'app.ts'), 'export const x = 1;\n');
    git('add', '.');
    git('commit', '-qm', 'initial');
    git('checkout', '-qb', 'feature');
    writeFileSync(join(dir, 'app.ts'), 'export const x = 2;\n');
    writeFileSync(join(dir, 'new.ts'), 'export const y = 3;\n');
    git('add', '.');
    git('commit', '-qm', 'Change x and add y');

    const cs = loadLocalChanges({ base: 'main', cwd: dir });
    expect(cs.title).toBe('Change x and add y');
    expect(cs.files.map(f => [f.path, f.status])).toEqual([
      ['app.ts', 'modified'],
      ['new.ts', 'added'],
    ]);
    expect(cs.files[1]!.content).toBe('export const y = 3;\n');
  });
});
