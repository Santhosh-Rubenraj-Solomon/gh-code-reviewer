import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { safeId, writeMarkdownReport, type SpawnFn } from '../../src/targets/markdown-file';
import { report } from './fixtures';

function fakeSpawn(fail = false) {
  const calls: { command: string; args: string[]; options: unknown; unref: boolean }[] = [];
  const spawn: SpawnFn = (command, args, options) => {
    if (fail) throw new Error('ENOENT');
    const entry = { command, args, options, unref: false };
    calls.push(entry);
    return { unref: () => (entry.unref = true), on: () => undefined };
  };
  return { spawn, calls };
}

describe('writeMarkdownReport', () => {
  const dir = () => join(mkdtempSync(join(tmpdir(), 'ghr-md-')), 'nested');

  test('writes review-<safe id>.md with a header and the complete markdown', async () => {
    const out = dir();
    const path = await writeMarkdownReport(report(), { dir: out, id: 'feature/login #7', now: () => new Date('2026-01-02T03:04:05Z') });
    expect(path).toBe(join(out, 'review-feature-login-7.md'));
    const text = readFileSync(path, 'utf8');
    expect(text.split('\n')[0]).toBe('<!-- gh-code-reviewer report · id: feature/login #7 · generated: 2026-01-02T03:04:05.000Z · files: 1 -->');
    expect(text).toContain('## 🔍 Code review: Look up users by name');
    expect(text).toContain('## 🧪 Testing');
  });

  test('opens the file detached with the editor command split into words', async () => {
    const { spawn, calls } = fakeSpawn();
    const path = await writeMarkdownReport(report(), { dir: dir(), id: 'x', openWith: 'code -w', spawn });
    expect(calls).toEqual([{ command: 'code', args: ['-w', path], options: { detached: true, stdio: 'ignore' }, unref: true }]);
  });

  test('does not open anything without openWith, and survives a spawn failure', async () => {
    const quiet = fakeSpawn();
    await writeMarkdownReport(report(), { dir: dir(), id: 'x', spawn: quiet.spawn });
    expect(quiet.calls).toHaveLength(0);
    const logs: string[] = [];
    const path = await writeMarkdownReport(report(), { dir: dir(), id: 'y', openWith: 'vim', spawn: fakeSpawn(true).spawn, log: m => logs.push(m) });
    expect(path.endsWith('review-y.md')).toBe(true);
    expect(logs[0]).toContain('ENOENT');
  });

  test('safeId', () => {
    expect(safeId('../../etc/passwd')).toBe('etc-passwd');
    expect(safeId('???')).toBe('review');
  });
});
