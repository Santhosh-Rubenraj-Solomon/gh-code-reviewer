import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DeveloperMemory,
  inferMemoryType,
  nodeMemoryFs,
  resolveDeveloperId,
  sanitizeDeveloperId,
  type MemoryFs,
} from '../../src/memory';
import { FakeLLM } from '../helpers';

const DAY = 86_400_000;
let dir: string;
let clock: number;
const now = () => clock;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ghr-memory-'));
  clock = Date.parse('2026-06-01T00:00:00Z');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function store(extra: Partial<ConstructorParameters<typeof DeveloperMemory>[0]> = {}) {
  return new DeveloperMemory({ developerId: 'dev@example.com', dir, now, ...extra });
}

describe('identity', () => {
  test('prefers git email, then name, then anonymous', async () => {
    const git = (map: Record<string, string | null>) => async (args: string[]) => map[args[1]!] ?? null;
    expect(await resolveDeveloperId(git({ 'user.email': 'Jane.Doe@Example.com', 'user.name': 'Jane' }))).toBe(
      'jane.doe@example.com',
    );
    expect(await resolveDeveloperId(git({ 'user.name': 'Jane Doe' }))).toBe('jane_doe');
    expect(await resolveDeveloperId(git({}))).toBe('anonymous');
  });

  test('sanitises path characters', () => {
    expect(sanitizeDeveloperId('../../etc/passwd')).toBe('etc_passwd');
    expect(sanitizeDeveloperId('   ')).toBe('anonymous');
  });
});

describe('CRUD and persistence', () => {
  test('add, update, delete, clear persist to one file per developer', async () => {
    const m = store();
    const a = await m.add({ content: 'I prefer early returns', tags: ['Style'] });
    expect(a.type).toBe('preference');
    expect(a.tags).toEqual(['style']);
    expect(a.importance).toBe(5);
    await m.add({ content: 'We use zod for validation', type: 'pattern', importance: 42 });

    const reloaded = store();
    expect(reloaded.all()).toHaveLength(2);
    expect(reloaded.all().find(x => x.type === 'pattern')!.importance).toBe(10);
    expect(existsSync(join(dir, 'dev@example.com.json'))).toBe(true);

    expect(reloaded.update(a.id, { content: 'Early returns please', importance: 0 })!.importance).toBe(1);
    expect(store().get(a.id)!.content).toBe('Early returns please');
    expect(reloaded.update('nope', { content: 'x' })).toBeNull();
    expect(reloaded.delete(a.id)).toBe(true);
    expect(reloaded.delete(a.id)).toBe(false);
    expect(reloaded.clear()).toBe(1);
    expect(store().all()).toEqual([]);
  });

  test('rejects empty content', async () => {
    await expect(store().add({ content: '  ' })).rejects.toThrow('empty');
  });

  test('infers the type from keywords', () => {
    expect(inferMemoryType('I always want tests')).toBe('preference');
    expect(inferMemoryType('Our convention is kebab-case')).toBe('pattern');
    expect(inferMemoryType('We agreed to drop v1')).toBe('decision');
    expect(inferMemoryType('You should check nulls')).toBe('feedback');
    expect(inferMemoryType('The service runs on k8s')).toBe('context');
  });
});

describe('atomic writes', () => {
  test('writes via a temp file and leaves no temp files behind', async () => {
    const m = store();
    await m.add({ content: 'one' });
    expect(readdirSync(dir)).toEqual(['dev@example.com.json']);
  });

  test('a failed rename keeps the previous file intact and removes the temp file', async () => {
    const m = store();
    await m.add({ content: 'original' });
    const before = readFileSync(m.path, 'utf8');
    const failing: MemoryFs = { ...nodeMemoryFs, rename: () => { throw new Error('disk full'); } };
    const broken = store({ fs: failing });
    await expect(broken.add({ content: 'second' })).rejects.toThrow('disk full');
    expect(readFileSync(m.path, 'utf8')).toBe(before);
    expect(readdirSync(dir)).toEqual(['dev@example.com.json']);
  });

  test('an invalid memory file is reported, not silently overwritten', () => {
    writeFileSync(join(dir, 'dev@example.com.json'), '{oops');
    expect(() => store().all()).toThrow('not valid JSON');
  });
});

describe('query, scoring and staleness', () => {
  test('scores importance x usage x age decay', async () => {
    const m = store();
    const item = await m.add({ content: 'x', importance: 8 });
    expect(m.score(item)).toBe(8);
    clock += 45 * DAY;
    expect(m.score({ ...item, accessCount: 5 })).toBeCloseTo(8 * 1.5 * 0.5);
    clock += 60 * DAY;
    expect(m.score(item)).toBe(0);
  });

  test('filters by type, tag, project (global always included) and importance; touches results', async () => {
    const m = store();
    await m.add({ content: 'global pref', type: 'preference', importance: 9 });
    await m.add({ content: 'repo pattern', type: 'pattern', project: 'o/r', tags: ['db'], importance: 6 });
    await m.add({ content: 'other repo', type: 'pattern', project: 'o/other', importance: 7 });
    await m.add({ content: 'minor', type: 'context', importance: 2 });

    expect(m.query({ project: 'o/r' }).map(x => x.content)).toEqual(['global pref', 'repo pattern', 'minor']);
    expect(m.query({ types: ['pattern'] }).map(x => x.content)).toEqual(['other repo', 'repo pattern']);
    expect(m.query({ tags: ['DB'] }).map(x => x.content)).toEqual(['repo pattern']);
    expect(m.query({ minImportance: 7 }).map(x => x.content)).toEqual(['global pref', 'other repo']);
    expect(m.query({ limit: 1 })).toHaveLength(1);
    expect(m.query({ text: 'REPO' })).toHaveLength(2);

    clock += DAY;
    const [top] = m.query({ limit: 1 });
    const stored = store().get(top!.id)!;
    expect(stored.lastAccessedAt).toBe(new Date(clock).toISOString());
    expect(stored.accessCount).toBeGreaterThan(1);
  });

  test('stale memories are hidden unless includeStale', async () => {
    const m = store();
    await m.add({ content: 'old' });
    clock += 31 * DAY;
    await m.add({ content: 'new' });
    expect(m.query().map(x => x.content)).toEqual(['new']);
    expect(m.query({ includeStale: true }).map(x => x.content).sort()).toEqual(['new', 'old']);
    expect(m.stats()).toMatchObject({ total: 2, stale: 0 }); // includeStale query just touched "old"
  });
});

describe('chat memories and relevance', () => {
  test('recordFromChat stores a discussion plus typed key points', async () => {
    const m = store();
    const saved = await m.recordFromChat(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'Is this really injectable?' },
        { role: 'assistant', content: 'Yes.' },
      ],
      { issueTitle: 'SQL injection', project: 'o/r', resolved: true, keyPoints: ['We decided to use prepared statements', ' '] },
    );
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({ type: 'discussion', importance: 7, source: 'chat', project: 'o/r' });
    expect(saved[0]!.content).toContain('SQL injection');
    expect(saved[0]!.content).toContain('Is this really injectable?');
    expect(saved[1]).toMatchObject({ type: 'decision', importance: 6 });
    const open = await m.recordFromChat([], { issueTitle: 'x' });
    expect(open[0]!.importance).toBe(5);
  });

  test('few candidates skip the model', async () => {
    const llm = new FakeLLM({});
    const m = store({ llm });
    for (let i = 0; i < 5; i++) await m.add({ content: `note ${i}` });
    expect(await m.relevantFor({ issueTitle: 'x' })).toHaveLength(5);
    expect(llm.calls).toHaveLength(0);
  });

  test('more than five candidates are ranked by the memory stage', async () => {
    const llm = new FakeLLM({ memory: () => ({ indices: [3, 3, 99, 1] }) });
    const m = store({ llm });
    for (let i = 0; i < 8; i++) await m.add({ content: `note ${i}`, importance: 10 - i });
    const result = await m.relevantFor({ issueTitle: 'Null check', project: 'o/r' });
    expect(result.map(x => x.content)).toEqual(['note 3', 'note 1']);
    expect(llm.callsFor('memory')[0]!.prompt).toContain('Null check');
  });

  test('falls back to score order when ranking fails or there is no title', async () => {
    const llm = new FakeLLM({ memory: () => { throw new Error('boom'); } });
    const m = store({ llm });
    for (let i = 0; i < 12; i++) await m.add({ content: `note ${i}`, importance: 10 - (i % 10) });
    const failed = await m.relevantFor({ issueTitle: 'x' });
    expect(failed).toHaveLength(10);
    expect(failed[0]!.importance).toBe(10);
    expect(await m.relevantFor({})).toHaveLength(10);
  });
});

describe('compaction', () => {
  test('drops expired low-importance and never-used memories', async () => {
    const m = store();
    await m.add({ content: 'old trivia', importance: 2 });
    const kept = await m.add({ content: 'old but important', importance: 9 });
    await m.add({ content: 'never used' , importance: 9 });
    m.query({ text: 'important', includeStale: true });
    clock += 100 * DAY;
    const fresh = await m.add({ content: 'fresh' });
    const r = await m.compact();
    expect(r).toEqual({ removed: 2, summarized: 0, remaining: 2 });
    expect(store().all().map(x => x.id).sort()).toEqual([kept.id, fresh.id].sort());
  });

  test('summarises crowded groups of five or more into one item with the max importance', async () => {
    const llm = new FakeLLM({ memory: () => 'Merged preferences' });
    const m = store({ llm, settings: { maxItems: 10, autoCompactAt: 1_000 } });
    for (let i = 0; i < 6; i++) await m.add({ content: `pref ${i}`, type: 'preference', tags: ['style'], importance: i + 1 });
    for (let i = 0; i < 3; i++) await m.add({ content: `ctx ${i}`, type: 'context' });
    const r = await m.compact();
    expect(r).toEqual({ removed: 0, summarized: 6, remaining: 4 });
    const summary = m.all().find(x => x.type === 'summarized')!;
    expect(summary).toMatchObject({ content: 'Merged preferences', importance: 6, tags: ['style'] });
    expect(llm.callsFor('memory')[0]!.prompt).toContain('pref 5');
  });

  test('a failed summary keeps the original group', async () => {
    const llm = new FakeLLM({ memory: () => { throw new Error('down'); } });
    const m = store({ llm, settings: { maxItems: 5, autoCompactAt: 1_000 } });
    for (let i = 0; i < 6; i++) await m.add({ content: `pref ${i}`, type: 'preference' });
    expect(await m.compact()).toEqual({ removed: 0, summarized: 0, remaining: 6 });
  });

  test('auto-compacts at the threshold and enforces the hard cap', async () => {
    const m = store({ settings: { maxItems: 5, autoCompactAt: 4 } });
    for (let i = 0; i < 8; i++) await m.add({ content: `n${i}`, importance: i + 1 });
    const left = m.all();
    expect(left).toHaveLength(5);
    expect(left.map(x => x.content)).not.toContain('n0');
  });
});

describe('export, import and stats', () => {
  test('import skips type+content duplicates and assigns fresh ids', async () => {
    const a = store();
    const original = await a.add({ content: 'Use tabs', type: 'preference', project: 'o/r' });
    await a.add({ content: 'Deploys on Fridays are banned', type: 'decision' });
    const exported = a.export();

    const b = new DeveloperMemory({ developerId: 'other', dir, now });
    await b.add({ content: 'use  TABS', type: 'preference' });
    const r = b.import(exported);
    expect(r).toEqual({ imported: 1, skipped: 1 });
    expect(b.all().every(x => x.id !== original.id)).toBe(true);
    expect(b.import(JSON.stringify([{ type: 'bogus', content: 'x' }, { type: 'context', content: 'plain array' }]))).toEqual({
      imported: 1,
      skipped: 1,
    });
    expect(() => b.import('nope')).toThrow('not valid JSON');
    expect(() => b.import('{}')).toThrow('memories');
  });

  test('stats count by type and project', async () => {
    const m = store();
    await m.add({ content: 'a', type: 'pattern', project: 'o/r' });
    clock += DAY;
    await m.add({ content: 'b', type: 'pattern' });
    const s = m.stats();
    expect(s).toMatchObject({ total: 2, byType: { pattern: 2 }, byProject: { 'o/r': 1, '(global)': 1 } });
    expect(s.oldest! < s.newest!).toBe(true);
  });
});
