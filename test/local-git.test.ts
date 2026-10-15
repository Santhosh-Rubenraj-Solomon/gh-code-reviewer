import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLocalChanges, MAX_FILE_BYTES, type GitRunner } from '../src/sources/local-git';

describe('loadLocalChanges with a scripted git', () => {
  const diff = ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -1 +1 @@', '-old', '+new', ''].join('\n');
  const answers: Record<string, string> = {
    'merge-base': 'base000\n',
    'rev-parse': 'head111\n',
    diff,
  };

  test('asks git for the right things and builds a change set', () => {
    const calls: string[][] = [];
    const git: GitRunner = (args, cwd) => {
      calls.push(args);
      if (args[1] === '--show-toplevel') return '/repo\n';
      expect(cwd).toBe('/repo');
      if (args[0] === 'log') return args[1] === '-1' ? 'Fix the thing\n' : '- Fix the thing\n- Prep\n';
      if (args[0] === 'show') return args[1] === 'HEAD:a.ts' ? 'new\n' : '';
      return answers[args[0]!] ?? '';
    };
    const cs = loadLocalChanges({ base: 'origin/dev', cwd: '/repo/src', git });

    expect(calls[0]).toEqual(['rev-parse', '--show-toplevel']);
    expect(calls[1]).toEqual(['merge-base', 'origin/dev', 'HEAD']);
    expect(calls).toContainEqual([
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--src-prefix=a/',
      '--dst-prefix=b/',
      '--find-renames',
      'base000',
      'HEAD',
    ]);
    expect(cs).toMatchObject({ source: 'local', title: 'Fix the thing', baseRef: 'origin/dev', headSha: 'head111' });
    expect(cs.description).toBe('- Fix the thing\n- Prep');
    expect(cs.files).toEqual([{ path: 'a.ts', status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new', additions: 1, deletions: 1, content: 'new\n', previousPath: undefined }]);
    expect(cs.pull).toBeUndefined();
    expect(calls).toContainEqual(['show', 'HEAD:a.ts']);
  });

  test('leaves out binary files and the content of files over 1 MB', () => {
    const big = ['diff --git a/big.ts b/big.ts', '--- a/big.ts', '+++ b/big.ts', '@@ -1 +1 @@', '-a', '+b'];
    const img = ['diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ'];
    const git: GitRunner = args => {
      if (args[0] === 'diff') return [...big, ...img, ''].join('\n');
      if (args[0] === 'show') return args[1] === 'HEAD:big.ts' ? 'x'.repeat(MAX_FILE_BYTES + 1) : '';
      return answers[args[0]!] ?? '';
    };
    const cs = loadLocalChanges({ base: 'main', cwd: '/repo', git });
    expect(cs.files.map(f => f.path)).toEqual(['big.ts']);
    expect(cs.files[0]!.content).toBeUndefined();
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

  test('reads committed content even when the working tree has uncommitted edits', () => {
    writeFileSync(join(dir, 'app.ts'), 'export const x = 999; // not committed\n');
    const cs = loadLocalChanges({ base: 'main', cwd: dir });
    expect(cs.files[0]!.content).toBe('export const x = 2;\n');
  });
});
