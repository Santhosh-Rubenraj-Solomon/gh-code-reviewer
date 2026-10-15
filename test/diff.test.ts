import { describe, expect, test } from 'bun:test';
import { annotatePatch, commentableLines, countChanges, parsePatch, splitUnifiedDiff } from '../src/diff';
import { SQL_PATCH } from './helpers';

describe('parsePatch', () => {
  test('tracks old and new line numbers through adds, deletes and context', () => {
    const [hunk] = parsePatch(SQL_PATCH);
    expect(hunk!.oldStart).toBe(1);
    expect(hunk!.newStart).toBe(1);
    expect(hunk!.lines.map(l => [l.kind, l.oldLine, l.newLine])).toEqual([
      ['ctx', 1, 1],
      ['ctx', 2, 2],
      ['del', 3, undefined],
      ['add', undefined, 3],
      ['add', undefined, 4],
      ['ctx', 4, 5],
    ]);
  });

  test('handles several hunks and the "no newline" marker', () => {
    const patch = ['@@ -1 +1 @@', '-a', '+b', '\\ No newline at end of file', '@@ -10,2 +10,2 @@', ' x', '+y'].join('\n');
    const hunks = parsePatch(patch);
    expect(hunks).toHaveLength(2);
    expect(hunks[0]!.lines).toHaveLength(2);
    expect(hunks[1]!.lines.at(-1)).toEqual({ kind: 'add', newLine: 11, text: 'y' });
  });

  test('returns nothing for an empty patch', () => {
    expect(parsePatch('')).toEqual([]);
  });
});

test('commentableLines lists only new-side lines that are in the diff', () => {
  expect([...commentableLines(SQL_PATCH)].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
});

test('annotatePatch puts the new line number in front of each line', () => {
  const lines = annotatePatch(SQL_PATCH).split('\n');
  expect(lines[0]).toBe('@@ -1,4 +1,5 @@');
  expect(lines[3]).toBe('      -  return db.query("SELECT * FROM users WHERE name = ?", [name]);');
  expect(lines[4]).toStartWith('    3 +  const sql');
});

test('countChanges counts additions and deletions', () => {
  expect(countChanges(SQL_PATCH)).toEqual({ additions: 2, deletions: 1 });
});

describe('splitUnifiedDiff', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1 +1,2 @@',
    ' keep',
    '+added',
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+hello',
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-bye',
    'diff --git a/before.ts b/after.ts',
    'similarity index 100%',
    'rename from before.ts',
    'rename to after.ts',
    'diff --git a/logo.png b/logo.png',
    'Binary files a/logo.png and b/logo.png differ',
  ].join('\n');

  const files = splitUnifiedDiff(diff);

  test('finds every file with the right status', () => {
    expect(files.map(f => [f.path, f.status])).toEqual([
      ['src/a.ts', 'modified'],
      ['new.txt', 'added'],
      ['old.txt', 'removed'],
      ['after.ts', 'renamed'],
      ['logo.png', 'modified'],
    ]);
  });

  test('keeps hunks, counts, and rename origin', () => {
    expect(files[0]!.patch).toBe('@@ -1 +1,2 @@\n keep\n+added');
    expect(files[0]!.additions).toBe(1);
    expect(files[2]!.deletions).toBe(1);
    expect(files[3]!.previousPath).toBe('before.ts');
    expect(files[3]!.patch).toBe('');
    expect(files[4]!.patch).toBe('');
  });
});
