import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ChangedFile } from '../../src/types';

/** A small TypeScript/JavaScript project with re-exports, aliases, require and dynamic import. */
export const FIXTURE_FILES: Record<string, string> = {
  'src/util/math.ts': [
    'export function add(a: number, b: number) {',
    '  return a + b;',
    '}',
    '',
    'export function mul(a: number, b: number) {',
    '  return a * b;',
    '}',
    '',
    'export const PI = 3.14159;',
    '',
  ].join('\n'),
  'src/util/format.ts': ['export function fmt(n: number): string {', '  return n.toFixed(2);', '}', ''].join('\n'),
  'src/util/index.ts': ["export { add, mul } from './math';", "export * from './format';", ''].join('\n'),
  'src/calc.ts': [
    "import { add, fmt } from './util';",
    "import { mul as times } from './util/math.js';",
    '',
    'export function total(xs: number[]) {',
    '  return xs.reduce((s, x) => add(s, x), 0);',
    '}',
    '',
    'export function product(xs: number[]) {',
    '  return xs.reduce((s, x) => times(s, x), 1);',
    '}',
    '',
    'export function pretty(xs: number[]) {',
    '  return fmt(total(xs));',
    '}',
    '',
  ].join('\n'),
  'src/report.ts': [
    "import { total } from './calc';",
    '',
    'export interface Report { sum: number }',
    '',
    'export function buildReport(xs: number[]): Report {',
    '  return { sum: total(xs) };',
    '}',
    '',
  ].join('\n'),
  'src/app.ts': [
    "const legacy = require('./legacy');",
    '',
    'async function boot() {',
    "  const reporting = await import('./report');",
    '  return [reporting.buildReport([1, 2]), legacy.run()];',
    '}',
    '',
    'export default boot;',
    '',
  ].join('\n'),
  'src/legacy.js': ['function run() {', "  return 'ok';", '}', '', 'module.exports = { run };', ''].join('\n'),
  'src/unrelated.ts': [
    'function add(x: number) {',
    '  return x + 1;',
    '}',
    '',
    'export function bump(v: number) {',
    '  return add(v);',
    '}',
    '',
  ].join('\n'),
  'test/calc.test.ts': [
    "import { expect, test } from 'bun:test';",
    "import { total } from '../src/calc';",
    '',
    "test('total', () => expect(total([1, 2])).toBe(3));",
    '',
  ].join('\n'),
  'README.md': '# fixture\n',
  'node_modules/pkg/index.ts': 'export const ignored = 1;\n',
  'dist/out.js': 'module.exports = {};\n',
  '.cache/hidden.ts': 'export const hidden = 1;\n',
  '.review/security.md': '# Security rules\nNo secrets in code.\n',
  '.review/style.md': '# Style\nPrefer small functions.\n',
  '.review/nested/deep.md': '# not top level\n',
  '.github/code-review.md': '# GitHub review notes\n',
};

export function writeFixture(files: Record<string, string> = FIXTURE_FILES): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'ghr-impact-'));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** `add` body changed on line 2 of math.ts. */
export const MATH_PATCH = [
  '@@ -1,3 +1,3 @@',
  ' export function add(a: number, b: number) {',
  '-  return a + b;',
  '+  return Number(a) + Number(b);',
  ' }',
].join('\n');

export function mathChange(overrides: Partial<ChangedFile> = {}): ChangedFile {
  return {
    path: 'src/util/math.ts',
    status: 'modified',
    patch: MATH_PATCH,
    additions: 1,
    deletions: 1,
    ...overrides,
  };
}
