import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalRepoProvider } from '../../src/repo/local-provider';
import { writeFixture } from '../impact/fixture';

let fixture: ReturnType<typeof writeFixture>;
let outside: string;

beforeAll(() => {
  fixture = writeFixture();
  writeFileSync(join(fixture.root, 'src/huge.ts'), `export const s = '${'x'.repeat(600 * 1024)}';\n`);
  outside = mkdtempSync(join(tmpdir(), 'ghr-outside-'));
  writeFileSync(join(outside, 'secret.ts'), 'export const secret = 1;\n');
  symlinkSync(join(outside, 'secret.ts'), join(fixture.root, 'src/link.ts'));
});
afterAll(() => {
  fixture.cleanup();
  rmSync(outside, { recursive: true, force: true });
});

describe('LocalRepoProvider', () => {
  test('lists source files and skips ignored and hidden directories', async () => {
    const files = await new LocalRepoProvider(fixture.root).listFiles();
    expect(files).toEqual([
      'src/app.ts',
      'src/calc.ts',
      'src/huge.ts',
      'src/legacy.js',
      'src/report.ts',
      'src/unrelated.ts',
      'src/util/format.ts',
      'src/util/index.ts',
      'src/util/math.ts',
      'test/calc.test.ts',
    ]);
  });

  test('reads files, caches them, and caps size', async () => {
    const p = new LocalRepoProvider(fixture.root);
    expect(await p.readFile('src/calc.ts')).toContain('export function total');
    writeFileSync(join(fixture.root, 'src/report.ts'), 'changed');
    const first = await p.readFile('src/report.ts');
    writeFileSync(join(fixture.root, 'src/report.ts'), 'changed again');
    expect(await p.readFile('src/report.ts')).toBe(first);
    expect(await p.readFile('src/huge.ts')).toBeNull();
    expect(await new LocalRepoProvider(fixture.root, { maxFileBytes: 10 }).readFile('src/calc.ts')).toBeNull();
    expect(await p.readFile('src/missing.ts')).toBeNull();
  });

  test('refuses paths outside the repository, including through symlinks', async () => {
    const p = new LocalRepoProvider(fixture.root);
    expect(await p.readFile('../outside.ts')).toBeNull();
    expect(await p.readFile('src/../../etc/passwd')).toBeNull();
    expect(await p.readFile('/etc/passwd')).toBeNull();
    expect(await p.readFile('')).toBeNull();
    expect(await p.readFile('src/link.ts')).toBeNull();
  });

  test('repoHash uses git, with a fingerprint fallback', async () => {
    const calls: string[][] = [];
    const p = new LocalRepoProvider(fixture.root, {
      git: async args => {
        calls.push(args);
        return 'deadbeef\n';
      },
    });
    expect(await p.repoHash()).toBe('deadbeef');
    expect(calls).toEqual([['rev-parse', 'HEAD']]);
    const fallback = new LocalRepoProvider(fixture.root, {
      git: async () => {
        throw new Error('not a repo');
      },
    });
    expect(await fallback.repoHash()).toMatch(/^worktree-[0-9a-f]{16}$/);
  });

  test('lists top-level .review markdown and .github/code-review.md', async () => {
    const rules = await new LocalRepoProvider(fixture.root).listRuleFiles();
    expect(rules.map(r => r.path)).toEqual(['.review/security.md', '.review/style.md', '.github/code-review.md']);
    expect(rules[0]?.content).toContain('No secrets');
    const empty = writeFixture({ 'a.ts': '' });
    try {
      expect(await new LocalRepoProvider(empty.root).listRuleFiles()).toEqual([]);
    } finally {
      empty.cleanup();
    }
  });
});

describe('LocalRepoProvider.listAllFiles', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'ghr-allfiles-'));
    for (const d of ['src', 'node_modules/pkg', '.github/workflows', '.git', 'docs']) {
      mkdirSync(join(dir, d), { recursive: true });
    }
    for (const f of ['src/a.ts', 'node_modules/pkg/index.js', '.github/workflows/ci.yml', '.git/HEAD', 'docs/guide.md']) {
      writeFileSync(join(dir, f), 'x\n');
    }
    writeFileSync(join(dir, 'package.json'), '{}\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('without git, walks every file regardless of extension, skipping .git and ignored dirs', async () => {
    const provider = new LocalRepoProvider(dir, { git: async () => Promise.reject(new Error('not a repo')) });
    expect(await provider.listAllFiles()).toEqual(['.github/workflows/ci.yml', 'docs/guide.md', 'package.json', 'src/a.ts']);
    // The source-only listing is unchanged.
    expect(await provider.listFiles()).toEqual(['src/a.ts']);
  });

  test('with git, uses ls-files (gitignore-aware) and drops deleted and ignored-dir paths', async () => {
    const calls: string[][] = [];
    const git = async (args: string[]) => {
      calls.push(args);
      return ['src/a.ts', 'docs/guide.md', 'gone.txt', 'node_modules/pkg/index.js', 'src/a.ts', ''].join('\0');
    };
    const provider = new LocalRepoProvider(dir, { git });
    expect(await provider.listAllFiles()).toEqual(['docs/guide.md', 'src/a.ts']);
    await provider.listAllFiles();
    expect(calls).toEqual([['ls-files', '-z', '--cached', '--others', '--exclude-standard']]);
  });
});
