import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DeveloperMemory, memoryCommand } from '../../src/memory';

let dir: string;
let store: DeveloperMemory;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghr-memcmd-'));
  store = new DeveloperMemory({ developerId: 'dev', dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (...args: string[]) => memoryCommand(args, { store });

describe('memoryCommand', () => {
  test('every output starts with the developer id; list is the default', async () => {
    const r = await memoryCommand([], { store });
    expect(r.exitCode).toBe(0);
    expect(r.output.split('\n')[0]).toBe('Developer: dev');
    expect(r.output).toContain('No memories yet');
  });

  test('add strips the --type flag from the content', async () => {
    const r = await run('add', 'Prefer', 'small', 'PRs', '--type=preference');
    expect(r.exitCode).toBe(0);
    const [item] = store.all();
    expect(item).toMatchObject({ content: 'Prefer small PRs', type: 'preference', source: 'cli', importance: 6 });
    expect(r.output).toContain('[preference]: Prefer small PRs');
  });

  test('add defaults to context and validates the type', async () => {
    await run('add', '--type=decision', 'We', 'ship', 'weekly');
    await run('add', 'I', 'always', 'want', 'tests');
    expect(store.all().map(x => x.type).sort()).toEqual(['context', 'decision']);
    const bad = await run('add', 'x', '--type=nope');
    expect(bad.exitCode).toBe(1);
    expect(bad.output).toContain('Unknown memory type "nope"');
    expect((await run('add')).exitCode).toBe(1);
  });

  test('list shows counts and recent items', async () => {
    await run('add', 'first', '--type=pattern');
    await run('add', 'second');
    const r = await run('ls');
    expect(r.output).toContain('2 memories (');
    expect(r.output).toContain('pattern: 1');
    expect(r.output).toContain('second');
  });

  test('search, delete/rm', async () => {
    await run('add', 'Use zod everywhere');
    await run('add', 'Tabs not spaces');
    expect((await run('search', 'ZOD')).output).toContain('1 match(es)');
    expect((await run('search', 'nothing')).output).toContain('No memories match');
    const id = store.all()[0]!.id;
    expect((await run('rm', id)).output).toContain(`Deleted ${id}`);
    const missing = await run('delete', id);
    expect(missing.exitCode).toBe(1);
    expect(missing.output).toContain('No memory with id');
  });

  test('clear needs --yes', async () => {
    await run('add', 'x');
    const refused = await run('clear');
    expect(refused.exitCode).toBe(1);
    expect(store.all()).toHaveLength(1);
    expect((await run('clear', '--yes')).output).toContain('Cleared 1 memories.');
  });

  test('compact reports counts', async () => {
    expect((await run('compact')).output).toContain('removed 0, merged 0');
  });

  test('export and import round-trip', async () => {
    await run('add', 'Keep functions small');
    const exported = (await run('export')).output.split('\n').slice(1).join('\n');
    expect(JSON.parse(exported).memories).toHaveLength(1);
    const other = new DeveloperMemory({ developerId: 'other', dir });
    const r = await memoryCommand(['import', 'f.json'], { store: other, readFile: () => exported });
    expect(r.output).toContain('Imported 1 memories (0 skipped');
    const again = await memoryCommand(['import', 'f.json'], { store: other, readFile: () => exported });
    expect(again.output).toContain('Imported 0 memories (1 skipped');
    const failed = await memoryCommand(['import', 'f.json'], { store: other, readFile: () => { throw new Error('ENOENT'); } });
    expect(failed.exitCode).toBe(1);
  });

  test('help and unknown actions', async () => {
    expect((await run('help')).output).toContain('Usage: ghr memory');
    const unknown = await run('frobnicate');
    expect(unknown.exitCode).toBe(1);
    expect(unknown.output).toContain('Usage: ghr memory');
  });
});
