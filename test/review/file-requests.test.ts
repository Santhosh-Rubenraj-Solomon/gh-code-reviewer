import { describe, expect, test } from 'bun:test';
import { fetchRequestedFiles, formatRequestedFiles, parseFileRequests } from '../../src/pipeline/file-requests';

const repo: Record<string, string> = {
  'src/db.ts': 'export function query() {}\nexport function close() {}\n',
  'src/big.ts': 'y'.repeat(100),
};
const reader = { readFile: async (p: string) => repo[p] ?? null };

describe('parseFileRequests', () => {
  test('reads path and path:symbol lines and ignores comments', () => {
    const text = [
      'Some prose',
      '<file_requests>',
      '# need the client',
      'src/db.ts',
      '// and one symbol',
      'src/auth.ts:validateToken',
      '- `src/util.ts`',
      'src/db.ts',
      'src/lines.ts:42',
      '',
      '</file_requests>',
    ].join('\n');
    expect(parseFileRequests(text)).toEqual([
      { path: 'src/db.ts' },
      { path: 'src/auth.ts', symbol: 'validateToken' },
      { path: 'src/util.ts' },
      { path: 'src/lines.ts' },
    ]);
  });

  test('no block means no requests', () => {
    expect(parseFileRequests('src/db.ts')).toEqual([]);
  });
});

describe('fetchRequestedFiles', () => {
  test('rejects unsafe paths and reports missing files', async () => {
    const results = await fetchRequestedFiles(
      [{ path: '/etc/passwd' }, { path: '../secret' }, { path: 'src/../../x' }, { path: 'missing.ts' }],
      reader,
    );
    expect(results.map(r => r.error)).toEqual([
      'absolute paths are not allowed',
      'paths may not leave the repository',
      'paths may not leave the repository',
      'file not found',
    ]);
  });

  test('extracts a symbol, or falls back to the whole file with a note', async () => {
    const symbolSource = (_p: string, code: string, name: string) =>
      code.split('\n').find(l => l.includes(`function ${name}`)) ?? null;
    const [found, missing] = await fetchRequestedFiles(
      [{ path: 'src/db.ts', symbol: 'close' }, { path: 'src/db.ts', symbol: 'nope' }],
      reader,
      { symbolSource },
    );
    expect(found!.content).toBe('export function close() {}');
    expect(found!.note).toBeUndefined();
    expect(missing!.content).toBe(repo['src/db.ts']!);
    expect(missing!.note).toContain('not found');
  });

  test('truncates long files and caps the number of requests', async () => {
    const results = await fetchRequestedFiles(
      [{ path: 'src/big.ts' }, { path: 'src/db.ts' }, { path: 'a.ts' }],
      reader,
      { maxChars: 10, maxFiles: 2 },
    );
    expect(results[0]!.content).toBe('y'.repeat(10));
    expect(results[0]!.note).toContain('truncated');
    expect(results[2]!.error).toContain('over the limit of 2');
  });

  test('reader errors become per-file errors', async () => {
    const results = await fetchRequestedFiles([{ path: 'x.ts' }], { readFile: async () => { throw new Error('io'); } });
    expect(results[0]!.error).toBe('could not read: io');
  });

  test('formatRequestedFiles shows content in fences and errors in italics', () => {
    const text = formatRequestedFiles([
      { request: { path: 'a.ts', symbol: 'f' }, content: 'code', note: 'n' },
      { request: { path: 'b.ts' }, error: 'file not found' },
    ]);
    expect(text).toContain('### a.ts (symbol f)\n_Note: n_\n```\ncode\n```');
    expect(text).toContain('### b.ts\n_Not available: file not found_');
    expect(formatRequestedFiles([])).toBe('');
  });
});
