import { describe, expect, test } from 'bun:test';
import {
  analyzeModule,
  extractImports,
  extractReferences,
  extractSymbols,
  isParserHealthy,
  languageFor,
  symbolSource,
  usesName,
} from '../../src/impact/parser';
import { FIXTURE_FILES } from './fixture';

describe('languageFor', () => {
  test('maps supported extensions and rejects others', () => {
    expect(languageFor('a/b.ts')).toBe('typescript');
    expect(languageFor('a/b.mts')).toBe('typescript');
    expect(languageFor('a/b.cts')).toBe('typescript');
    expect(languageFor('a/b.tsx')).toBe('tsx');
    expect(languageFor('a/b.jsx')).toBe('javascript');
    expect(languageFor('a/b.mjs')).toBe('javascript');
    expect(languageFor('a/b.cjs')).toBe('javascript');
    expect(languageFor('a/b.kt')).toBeNull();
    expect(languageFor('a/b.swift')).toBeNull();
    expect(languageFor('Makefile')).toBeNull();
    expect(languageFor('dir.ts/file')).toBeNull();
  });
});

test('native tree-sitter loads under bun', () => {
  expect(isParserHealthy()).toBe(true);
});

describe('extractImports', () => {
  test('covers default, named, aliased, namespace, type, require, re-export and dynamic forms', () => {
    const code = [
      "import def, { a, b as c } from './x';",
      "import * as ns from './ns';",
      "import type { T } from './types';",
      "import './side-effect';",
      "export { r as rr } from './r';",
      "export * from './all';",
      "const m = require('./m');",
      "const { p, q: qq } = require('./pq');",
      "async function lazy() { const mod = await import('./lazy'); return mod; }",
      "import(`./template`);",
      'require(name);',
    ].join('\n');
    const imports = extractImports('a.ts', code);
    const bySource = Object.fromEntries(imports.map(i => [i.source, i]));
    expect(bySource['./x']?.names).toEqual(['def', 'a', 'c']);
    expect(bySource['./x']?.bindings).toContainEqual({ imported: 'b', local: 'c' });
    expect(bySource['./x']?.bindings).toContainEqual({ imported: 'default', local: 'def' });
    expect(bySource['./ns']?.bindings).toEqual([{ imported: '*', local: 'ns' }]);
    expect(bySource['./types']?.names).toEqual(['T']);
    expect(bySource['./side-effect']?.names).toEqual([]);
    expect(bySource['./r']).toMatchObject({ kind: 'reexport', names: ['rr'] });
    expect(bySource['./all']).toMatchObject({ kind: 'reexport', names: [] });
    expect(bySource['./m']).toMatchObject({ kind: 'require', names: ['m'] });
    expect(bySource['./pq']?.bindings).toEqual([
      { imported: 'p', local: 'p' },
      { imported: 'q', local: 'qq' },
    ]);
    expect(bySource['./lazy']).toMatchObject({ kind: 'dynamic', names: ['mod'] });
    expect(bySource['./template']?.kind).toBe('dynamic');
    expect(imports).toHaveLength(10);
  });

  test('parses JSX and TSX files', () => {
    const jsx = "import React from 'react';\nexport const App = () => <div>hi</div>;\n";
    expect(extractImports('App.jsx', jsx).map(i => i.source)).toEqual(['react']);
    expect(extractImports('App.tsx', jsx).map(i => i.source)).toEqual(['react']);
    expect(extractSymbols('App.tsx', jsx)[0]).toMatchObject({ name: 'App', kind: 'function', exported: true });
  });

  test('returns empty results for unsupported files and never throws on garbage', () => {
    expect(extractImports('a.kt', 'import a.b.C')).toEqual([]);
    expect(() => extractImports('a.ts', '}}}{{{ import from ;;')).not.toThrow();
    expect(extractSymbols('a.py', 'def x(): pass')).toEqual([]);
  });
});

describe('extractSymbols', () => {
  test('finds declarations with export flags, kinds and 1-based lines', () => {
    const code = [
      'export function f() {}',
      'export const g = () => 1, h = 2;',
      'let z = 3;',
      'export { z };',
      'export interface I { x: number }',
      'export type U = string;',
      'export enum E { A }',
      'export abstract class K {}',
      'class Hidden {}',
      'var old = 1;',
      'export default function () { return 1; }',
    ].join('\n');
    const symbols = extractSymbols('a.ts', code);
    const brief = symbols.map(s => [s.name, s.kind, s.exported, s.startLine]);
    expect(brief).toEqual([
      ['f', 'function', true, 1],
      ['g', 'function', true, 2],
      ['h', 'const', true, 2],
      ['z', 'let', true, 3],
      ['I', 'interface', true, 5],
      ['U', 'type', true, 6],
      ['E', 'enum', true, 7],
      ['K', 'class', true, 8],
      ['Hidden', 'class', false, 9],
      ['old', 'var', false, 10],
      ['default', 'function', true, 11],
    ]);
    expect(symbols[0]?.code).toBe('export function f() {}');
  });

  test('tracks multi-line ranges and CommonJS exports', () => {
    const symbols = extractSymbols('src/util/math.ts', FIXTURE_FILES['src/util/math.ts'] as string);
    expect(symbols.map(s => [s.name, s.startLine, s.endLine])).toEqual([
      ['add', 1, 3],
      ['mul', 5, 7],
      ['PI', 9, 9],
    ]);
    const legacy = extractSymbols('src/legacy.js', FIXTURE_FILES['src/legacy.js'] as string);
    expect(legacy).toEqual([expect.objectContaining({ name: 'run', exported: true })]);
    const cjs = extractSymbols('x.js', 'exports.hello = function () { return 1; };');
    expect(cjs[0]).toMatchObject({ name: 'hello', kind: 'function', exported: true });
  });

  test('reports the default export name', () => {
    expect(analyzeModule('a.ts', 'function boot() {}\nexport default boot;').defaultExport).toBe('boot');
    expect(analyzeModule('a.ts', 'export default class Store {}').defaultExport).toBe('Store');
    expect(analyzeModule('a.ts', 'const x = 1;\nexport { x as default };').defaultExport).toBe('x');
  });

  test('handles files larger than the native string limit', () => {
    const big = 'export const value = 1;\n'.repeat(4000);
    expect(big.length).toBeGreaterThan(64 * 1024);
    expect(extractSymbols('big.ts', big)).toHaveLength(4000);
  });

  test('symbolSource returns code text or null', () => {
    expect(symbolSource('a.ts', 'export function f() { return 1; }', 'f')).toContain('return 1');
    expect(symbolSource('a.ts', 'export function f() {}', 'nope')).toBeNull();
  });
});

describe('extractReferences', () => {
  test('drops own name, keywords, builtins, short tokens and common locals', () => {
    const refs = extractReferences(
      'function total(xs) { const result = xs.reduce((s, x) => add(s, x), 0); return Math.max(result, LIMIT) as Foo; }',
      'total',
    );
    expect(refs).toEqual(['add', 'LIMIT', 'Foo']);
  });

  test('usesName matches whole identifiers only', () => {
    expect(usesName('return add(a, b)', 'add')).toBe(true);
    expect(usesName('return addAll(a)', 'add')).toBe(false);
    expect(usesName('x.$add', 'add')).toBe(false);
    expect(usesName('$add()', '$add')).toBe(true);
  });
});
