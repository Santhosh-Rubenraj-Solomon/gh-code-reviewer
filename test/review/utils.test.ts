import { describe, expect, test } from 'bun:test';
import { globProblem, globToRegExp, matchesAny } from '../../src/utils/glob';
import { extractJson } from '../../src/utils/json';

describe('extractJson', () => {
  test('parses plain JSON', () => {
    expect(extractJson(' {"a":1} ')).toEqual({ a: 1 });
    expect(extractJson('[1,2]')).toEqual([1, 2]);
  });

  test('reads a fenced json block surrounded by prose', () => {
    expect(extractJson('Here you go:\n```json\n{"ok": true}\n```\nThanks')).toEqual({ ok: true });
    expect(extractJson('```\n{"bare": 1}\n```')).toEqual({ bare: 1 });
  });

  test('finds the first balanced value, respecting braces inside strings and escapes', () => {
    const text = 'Sure! {"code": "if (x) { return \\"}\\"; }", "n": [1, {"m": 2}]} trailing } junk';
    expect(extractJson(text)).toEqual({ code: 'if (x) { return "}"; }', n: [1, { m: 2 }] });
  });

  test('skips an unbalanced or invalid candidate and uses a later one', () => {
    expect(extractJson('see {not json} then {"x": 2}')).toEqual({ x: 2 });
  });

  test('throws clear errors', () => {
    expect(() => extractJson('')).toThrow('empty');
    expect(() => extractJson('no json here')).toThrow('no JSON value found');
    expect(() => extractJson('{"open": ')).toThrow('no JSON value found');
  });
});

describe('glob', () => {
  test('* stays within a segment, ** spans directories', () => {
    expect(matchesAny('src/a.ts', ['src/*.ts'])).toBe(true);
    expect(matchesAny('src/x/a.ts', ['src/*.ts'])).toBe(false);
    expect(matchesAny('src/x/y/a.ts', ['src/**/*.ts'])).toBe(true);
    expect(matchesAny('src/x/y/a.ts', ['src/**'])).toBe(true);
  });

  test('**/ may match zero directories', () => {
    expect(matchesAny('src/a.ts', ['src/**/*.ts'])).toBe(true);
    expect(matchesAny('a.ts', ['**/*.ts'])).toBe(true);
    expect(matchesAny('deep/er/a.ts', ['**/*.ts'])).toBe(true);
  });

  test('? is one non-slash character and patterns are anchored', () => {
    expect(matchesAny('a1.ts', ['a?.ts'])).toBe(true);
    expect(matchesAny('a12.ts', ['a?.ts'])).toBe(false);
    expect(matchesAny('a/.ts', ['a?.ts'])).toBe(false);
    expect(matchesAny('x/src/a.ts', ['src/*.ts'])).toBe(false);
    expect(matchesAny('src/a.tsx', ['src/*.ts'])).toBe(false);
  });

  test('regex metacharacters are literal; braces alternate', () => {
    expect(matchesAny('a+b.ts', ['a+b.ts'])).toBe(true);
    expect(matchesAny('aab.ts', ['a+b.ts'])).toBe(false);
    expect(matchesAny('app/[id]/page.tsx', ['app/[id]/*.tsx'])).toBe(true);
    expect(matchesAny('src/a.tsx', ['src/*.{ts,tsx}'])).toBe(true);
    expect(matchesAny('src/a.js', ['src/*.{ts,tsx}'])).toBe(false);
    expect(globToRegExp('*.md').test('README.md')).toBe(true);
  });

  test('globProblem flags unusable patterns', () => {
    expect(globProblem('src/**')).toBeNull();
    expect(globProblem('')).toContain('empty');
    expect(globProblem('/abs/*.ts')).toContain('relative');
    expect(globProblem('../x')).toContain('..');
    expect(globProblem('src/{a,b')).toContain('unbalanced');
    expect(globProblem('src/{a,{b,c}}')).toContain('nested');
  });
});
