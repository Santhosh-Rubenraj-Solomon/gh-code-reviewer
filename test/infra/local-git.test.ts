import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  addedFileDiff,
  listUnmergedCommits,
  loadCommitChanges,
  loadLocalChanges,
  loadWorkingTreeChanges,
  MAX_FILE_BYTES,
  repoRoot,
  type GitRunner,
} from '../../src/sources/local-git';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'ghr-infra-git-'));
  dirs.push(dir);
  const git = (args: string[], env: Record<string, string> = {}) =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } }).trim();
  git(['init', '-q', '-b', 'main']);
  git(['config', 'user.email', 'test@example.com']);
  git(['config', 'user.name', 'Test']);
  git(['config', 'commit.gpgsign', 'false']);
  const write = (path: string, text: string) => {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), text);
  };
  const commit = (message: string, date?: string) => {
    git(['add', '-A']);
    const env: Record<string, string> = date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {};
    git(['commit', '-qm', message], env);
    return git(['rev-parse', 'HEAD']);
  };
  return { dir, git, write, commit };
}

test('addedFileDiff builds an all-added hunk', () => {
  expect(addedFileDiff('a.txt', 'one\ntwo\n')).toEqual({
    path: 'a.txt',
    status: 'added',
    patch: '@@ -0,0 +1,2 @@\n+one\n+two',
    additions: 2,
    deletions: 0,
    content: 'one\ntwo\n',
  });
  expect(addedFileDiff('e.txt', '').patch).toBe('');
});

describe('loadWorkingTreeChanges', () => {
  test('combines unstaged, staged and untracked changes; skips binaries and ignored files', () => {
    const r = repo();
    r.write('app.ts', 'export const a = 1;\n');
    r.write('staged.ts', 'export const s = 1;\n');
    r.write('.gitignore', 'dist/\n');
    const head = r.commit('initial');

    r.write('app.ts', 'export const a = 2;\n');
    r.write('staged.ts', 'export const s = 2;\n');
    r.git(['add', 'staged.ts']);
    r.write('src/new.ts', 'export const n = 1;\nexport const m = 2;\n');
    r.write('logo.png', 'binary-ish');
    r.write('dist/out.js', 'ignored');

    const cs = loadWorkingTreeChanges({ cwd: r.dir });
    expect(cs).toMatchObject({ source: 'local', baseRef: 'HEAD', headSha: head, title: 'Uncommitted changes on main' });
    const byPath = Object.fromEntries(cs.files.map(f => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(['app.ts', 'src/new.ts', 'staged.ts']);
    expect(byPath['app.ts']!.patch).toContain('+export const a = 2;');
    expect(byPath['app.ts']!.content).toBe('export const a = 2;\n');
    expect(byPath['staged.ts']!.patch).toContain('+export const s = 2;');
    expect(byPath['src/new.ts']).toMatchObject({ status: 'added', additions: 2, patch: '@@ -0,0 +1,2 @@\n+export const n = 1;\n+export const m = 2;' });
  });

  test('files over 1 MB are listed without content', () => {
    const r = repo();
    r.write('small.ts', 'x\n');
    r.commit('initial');
    r.write('huge.txt', 'a'.repeat(MAX_FILE_BYTES + 1));
    r.write('small.ts', 'y\n');
    const cs = loadWorkingTreeChanges({ cwd: r.dir, title: 'WIP' });
    expect(cs.title).toBe('WIP');
    const huge = cs.files.find(f => f.path === 'huge.txt')!;
    expect(huge).toEqual({ path: 'huge.txt', status: 'added', patch: '', additions: 0, deletions: 0 });
    // A tracked file over the limit keeps its diff but not its content.
    const sized = loadWorkingTreeChanges({ cwd: r.dir, fileSize: p => (p.endsWith('small.ts') ? MAX_FILE_BYTES + 1 : 1) });
    expect(sized.files.find(f => f.path === 'small.ts')!.content).toBeUndefined();
  });

  test('works in a repository with no commits yet', () => {
    const r = repo();
    r.write('first.ts', 'hello\n');
    const cs = loadWorkingTreeChanges({ cwd: r.dir });
    expect(cs.headSha).toBe('initial');
    expect(cs.files.map(f => f.path)).toEqual(['first.ts']);
  });
});

describe('loadCommitChanges', () => {
  test('orders selected commits oldest to newest regardless of the order given', () => {
    const r = repo();
    r.write('a.ts', 'v0\n');
    r.commit('base', '2026-01-01T00:00:00Z');
    r.write('a.ts', 'v1\n');
    const c1 = r.commit('first change', '2026-01-02T00:00:00Z');
    r.write('b.ts', 'b\n');
    const c2 = r.commit('second change', '2026-01-03T00:00:00Z');
    r.write('a.ts', 'v3\n');
    const c3 = r.commit('third change', '2026-01-04T00:00:00Z');

    // The picker lists newest first; that used to produce a reversed (empty or inverted) range.
    const cs = loadCommitChanges({ cwd: r.dir, shas: [c3.slice(0, 8), c1] });
    expect(cs.headSha).toBe(c3);
    expect(cs.baseRef).toBe(r.git(['rev-parse', `${c1}^`]));
    expect(cs.files.map(f => f.path).sort()).toEqual(['a.ts', 'b.ts']);
    const a = cs.files.find(f => f.path === 'a.ts')!;
    expect(a.patch).toContain('-v0');
    expect(a.patch).toContain('+v3');
    expect(a.content).toBe('v3\n');
    expect(cs.title).toBe('2 commits: third change');
    expect(cs.description).toContain(`- ${c1.slice(0, 7)} first change\n- ${c3.slice(0, 7)} third change`);
    expect(cs.description).toContain('1 commit(s) between the selected ones');
    expect(c2).toBeTruthy();
  });

  test('breaks same-second ties by ancestry and handles a root commit', () => {
    const r = repo();
    const date = '2026-02-01T00:00:00Z';
    r.write('x.ts', '1\n');
    const root = r.commit('root', date);
    r.write('x.ts', '2\n');
    const next = r.commit('next', date);
    const cs = loadCommitChanges({ cwd: r.dir, shas: [next, root] });
    expect(cs.headSha).toBe(next);
    expect(cs.files).toHaveLength(1);
    expect(cs.files[0]).toMatchObject({ path: 'x.ts', status: 'added', content: '2\n' });

    const single = loadCommitChanges({ cwd: r.dir, shas: [next] });
    expect(single.title).toBe('next');
    expect(single.files[0]!.patch).toContain('-1');
  });

  test('rejects unknown commits and empty selections', () => {
    const r = repo();
    r.write('x.ts', '1\n');
    r.commit('root');
    expect(() => loadCommitChanges({ cwd: r.dir, shas: ['deadbeef'] })).toThrow(/not a commit/);
    expect(() => loadCommitChanges({ cwd: r.dir, shas: [] })).toThrow(/at least one/);
  });
});

describe('listUnmergedCommits', () => {
  test('lists commits not on the base branch, newest first, with short subjects', () => {
    const r = repo();
    r.write('x.ts', '1\n');
    r.commit('on main');
    r.git(['checkout', '-qb', 'feature']);
    r.write('x.ts', '2\n');
    const older = r.commit('older', '2026-03-01T00:00:00Z');
    r.write('x.ts', '3\n');
    const long = 'L'.repeat(80);
    const newer = r.commit(long, '2026-03-02T00:00:00Z');

    const { base, commits } = listUnmergedCommits({ cwd: r.dir });
    expect(base).toBe('main');
    expect(commits.map(c => c.sha)).toEqual([newer, older]);
    expect(commits[0]!.subject).toHaveLength(60);
    expect(commits[0]!.subject.endsWith('…')).toBe(true);
    expect(commits[1]).toMatchObject({ subject: 'older', shortSha: older.slice(0, 7), timestamp: Date.parse('2026-03-01T00:00:00Z') });
    expect(commits[1]!.relativeDate).toMatch(/ago/);
  });

  test('prefers origin/main and fails without any base', () => {
    const asked: string[] = [];
    const git: GitRunner = args => {
      if (args[1] === '--show-toplevel') return '/r\n';
      if (args[0] === 'rev-parse') {
        asked.push(args[3]!);
        if (args[3] === 'origin/master^{commit}') return 'abc\n';
        throw new Error('missing');
      }
      return '';
    };
    expect(listUnmergedCommits({ cwd: '/r', git })).toEqual({ base: 'origin/master', commits: [] });
    expect(asked).toEqual(['origin/main^{commit}', 'origin/master^{commit}']);
    const none: GitRunner = () => {
      throw new Error('missing');
    };
    expect(() => listUnmergedCommits({ cwd: '/r', git: none })).toThrow(/No base branch/);
  });
});

describe('running from a subdirectory with hostile diff config', () => {
  function hostile() {
    const r = repo();
    // Settings that change `git diff` output: no a/ b/ prefixes, mnemonic prefixes, forced color, an external tool.
    r.git(['config', 'diff.noprefix', 'true']);
    r.git(['config', 'diff.mnemonicPrefix', 'true']);
    r.git(['config', 'color.ui', 'always']);
    r.git(['config', 'diff.external', 'false']);
    r.write('pkg/app/main.ts', 'export const a = 1;\n');
    r.write('README.md', 'hello\n');
    r.commit('init');
    const sub = join(r.dir, 'pkg', 'app');
    return { ...r, sub };
  }

  test('repoRoot resolves the top level from a subdirectory and falls back to cwd', () => {
    const r = hostile();
    expect(repoRoot(r.sub)).toBe(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: r.dir, encoding: 'utf8' }).trim());
    const failing: GitRunner = () => {
      throw new Error('not a repo');
    };
    expect(repoRoot('/somewhere', failing)).toBe('/somewhere');
  });

  test('working tree changes: diff paths, contents and untracked files resolve from the top level', () => {
    const r = hostile();
    r.write('pkg/app/main.ts', 'export const a = 2;\n');
    r.write('README.md', 'hello again\n');
    r.write('docs/new.md', 'new file\n');
    r.write('pkg/app/extra.ts', 'export {};\n');
    const cs = loadWorkingTreeChanges({ cwd: r.sub });
    const byPath = Object.fromEntries(cs.files.map(f => [f.path, f]));
    expect(Object.keys(byPath).sort()).toEqual(['README.md', 'docs/new.md', 'pkg/app/extra.ts', 'pkg/app/main.ts']);
    expect(byPath['pkg/app/main.ts']!.content).toBe('export const a = 2;\n');
    expect(byPath['pkg/app/main.ts']!.patch).toContain('+export const a = 2;');
    expect(byPath['pkg/app/main.ts']!.patch).not.toContain('\u001b[');
    expect(byPath['README.md']!.content).toBe('hello again\n');
    expect(byPath['docs/new.md']!.content).toBe('new file\n');
  });

  test('branch and commit loaders work from a subdirectory too', () => {
    const r = hostile();
    r.git(['branch', 'base']);
    r.write('pkg/app/main.ts', 'export const a = 3;\n');
    r.write('lib/util.ts', 'export const u = 1;\n');
    const sha = r.commit('change');

    const branch = loadLocalChanges({ cwd: r.sub, base: 'base' });
    expect(branch.files.map(f => f.path).sort()).toEqual(['lib/util.ts', 'pkg/app/main.ts']);
    expect(branch.files.find(f => f.path === 'lib/util.ts')!.content).toBe('export const u = 1;\n');

    const commits = loadCommitChanges({ cwd: r.sub, shas: [sha] });
    expect(commits.files.map(f => f.path).sort()).toEqual(['lib/util.ts', 'pkg/app/main.ts']);
    expect(commits.files.find(f => f.path === 'pkg/app/main.ts')!.content).toBe('export const a = 3;\n');
  });
});
