import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { open } from 'lmdb';
import { cacheKey, IMPACT_TTL_MS, impactKey, ReviewStore, SESSION_STAGES, STORE_SCHEMA_VERSION } from '../../src/store';
import type { TimingEntry } from '../../src/timing';
import type { FileReview, ImpactResult, ReviewReport } from '../../src/types';
import { changeSet, file, testConfig } from '../helpers';

const DAY = 24 * 60 * 60 * 1000;
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ghr-infra-store-'));
  dirs.push(dir);
  return dir;
}

function makeStore(path = tempDir(), start = 1_700_000_000_000) {
  let clock = start;
  let ids = 0;
  const store = new ReviewStore({ path, now: () => clock, newId: () => `id${++ids}` });
  return { store, path, advance: (ms: number) => (clock += ms) };
}

const identity = (key = 'gh:o/r#1') => ({
  key,
  source: { type: 'github', id: 'o/r#1', title: 'Add login' },
  target: 'github',
  config: { persona: 'mentor' },
});

describe('sessions', () => {
  test('creates a session with every stage pending and resumes it by identity', async () => {
    const { store, advance } = makeStore();
    const first = await store.getOrCreateSession(identity());
    expect(first.schemaVersion).toBe(STORE_SCHEMA_VERSION);
    expect(Object.keys(first.stages)).toEqual([...SESSION_STAGES]);
    expect(Object.values(first.stages).every(s => s.state === 'pending')).toBe(true);

    advance(1000);
    const again = await store.getOrCreateSession({ ...identity(), target: 'markdown', config: { persona: 'terse' } });
    expect(again.id).toBe(first.id);
    expect(again.target).toBe('markdown');
    expect(again.config).toEqual({ persona: 'terse' });
    expect(again.updatedAt).toBe(first.updatedAt + 1000);

    const fresh = await store.getOrCreateSession(identity(), { fresh: true });
    expect(fresh.id).not.toBe(first.id);
    expect((await store.getOrCreateSession(identity())).id).toBe(fresh.id);
    await store.close();
  });

  test('tracks stage status with timestamps and errors, and stores stage data', async () => {
    const { store, advance } = makeStore();
    const s = await store.getOrCreateSession(identity());
    await store.setStageStatus(s.id, 'review', 'running');
    advance(500);
    await store.setStageStatus(s.id, 'review', 'failed', 'model down');
    expect(store.getSession(s.id)!.stages.review).toEqual({
      state: 'failed',
      startedAt: 1_700_000_000_000,
      finishedAt: 1_700_000_000_500,
      error: 'model down',
    });

    await store.saveStageData(s.id, 'fetch', { files: ['a.ts', 'b.ts'] });
    expect(store.getStageData(s.id, 'fetch')).toEqual({ files: ['a.ts', 'b.ts'] });
    expect(store.getSession(s.id)!.stages.fetch.state).toBe('completed');
    expect(store.getStageData(s.id, 'triage')).toBeUndefined();
    await expect(store.saveStageData('nope', 'fetch', {})).rejects.toThrow(/No review session/);
    await store.close();
  });

  test('findSessions filters and sorts newest first; deleteSession removes everything', async () => {
    const { store, advance } = makeStore();
    const a = await store.getOrCreateSession(identity('k1'));
    advance(10);
    const b = await store.getOrCreateSession({ ...identity('k2'), source: { type: 'local', id: 'feature', title: 'Fix cache' } });
    expect(store.findSessions().map(s => s.id)).toEqual([b.id, a.id]);
    expect(store.findSessions('CACHE').map(s => s.id)).toEqual([b.id]);
    expect(store.findSessions(undefined, 1)).toHaveLength(1);

    await store.saveStageData(b.id, 'fetch', { files: [] });
    expect(await store.deleteSession(b.id)).toBe(true);
    expect(await store.deleteSession(b.id)).toBe(false);
    expect(store.getSession(b.id)).toBeNull();
    expect(store.getStageData(b.id, 'fetch')).toBeUndefined();
    // The identity index no longer points at the deleted session.
    expect((await store.getOrCreateSession(identity('k2'))).id).not.toBe(b.id);
    await store.close();
  });

  test('cleanupOlderThan removes stale and corrupt sessions; dry run only lists them', async () => {
    const path = tempDir();
    const first = makeStore(path);
    const old = await first.store.getOrCreateSession(identity('old'));
    first.advance(40 * DAY);
    const recent = await first.store.getOrCreateSession(identity('recent'));
    await first.store.close();

    // Write records an older or broken version might have left behind.
    const raw = open({ path, maxDbs: 16, compression: true });
    const sessions = raw.openDB<unknown, string>({ name: 'sessions' });
    await sessions.put('junk', 'not a session');
    await sessions.put('legacy', { id: 'legacy', createdAt: 1_700_000_000_000 + 40 * DAY, source: { title: 'Old shape' } });
    await raw.close();

    const { store } = makeStore(path, 1_700_000_000_000 + 40 * DAY);
    const legacy = store.getSession('legacy')!;
    expect(legacy.schemaVersion).toBe(1);
    expect(legacy.stages.review.state).toBe('pending');
    expect(legacy.source).toEqual({ type: 'unknown', id: '', title: 'Old shape' });
    expect(store.findSessions().map(s => s.id).sort()).toEqual(['legacy', old.id, recent.id].sort());

    const dry = await store.cleanupOlderThan(30, { dryRun: true });
    expect(dry.sessions.sort()).toEqual(['junk', old.id].sort());
    expect(store.getSession(old.id)).not.toBeNull();

    const removed = await store.cleanupOlderThan(30);
    expect(removed.sessions.sort()).toEqual(['junk', old.id].sort());
    expect(store.getSession(old.id)).toBeNull();
    expect((await store.cleanupOlderThan(30)).sessions).toEqual([]);
    await store.close();
  });
});

describe('caches and timings', () => {
  const review: FileReview = {
    path: 'a.ts',
    status: 'ok',
    whatChanged: 'x',
    findings: [],
    positives: [],
    testingRecommendations: [],
  };

  test('batch cache round-trips and ignores malformed entries', async () => {
    const { store } = makeStore();
    expect(store.getBatch('b1')).toBeUndefined();
    await store.putBatch('b1', [review]);
    expect(store.getBatch('b1')).toEqual([review]);
    await store.putBatch('bad', [{ nope: true }] as unknown as FileReview[]);
    expect(store.getBatch('bad')).toBeUndefined();
    await store.close();
  });

  test('report cache API persists across instances', async () => {
    const path = tempDir();
    const report = { title: 't', headSha: 'h' } as ReviewReport;
    const a = makeStore(path).store;
    await a.put('k', report);
    await a.close();
    const b = makeStore(path).store;
    expect(b.get('k')).toEqual(report);
    expect(b.get('missing')).toBeUndefined();
    await b.close();
  });

  test('timings are stored per session and summarised by stage', async () => {
    const { store } = makeStore();
    const s = await store.getOrCreateSession(identity());
    const other = await store.getOrCreateSession(identity('other'));
    const entry = (over: Partial<TimingEntry>): TimingEntry => ({
      callId: 'review-1',
      stage: 'review',
      model: 'm',
      startedAt: 1,
      ttfcMs: 100,
      durationMs: 1000,
      inputTokens: 10,
      outputTokens: 5,
      status: 'success',
      streamed: true,
      ...over,
    });
    await store.recordTiming(s.id, entry({}));
    await store.recordTiming(s.id, entry({ ttfcMs: 300, durationMs: 3000, status: 'timeout' }));
    await store.recordTiming(s.id, entry({ stage: 'critic', ttfcMs: null, durationMs: 50, streamed: false }));
    await store.recordTiming(other.id, entry({}));

    expect(store.getTimings(s.id)).toHaveLength(3);
    const summary = store.timingSummary(s.id);
    expect(summary.review).toEqual({
      stage: 'review',
      calls: 2,
      failures: 1,
      ttfc: { count: 2, avgMs: 200, minMs: 100, maxMs: 300 },
      duration: { count: 2, avgMs: 2000, minMs: 1000, maxMs: 3000 },
      inputTokens: 20,
      outputTokens: 10,
    });
    expect(summary.critic!.ttfc).toBeNull();

    await store.deleteSession(s.id);
    expect(store.getTimings(s.id)).toEqual([]);
    expect(store.getTimings(other.id)).toHaveLength(1);
    await store.close();
  });

  test('close waits for un-awaited timing writes; writes after close are silent no-ops', async () => {
    const path = tempDir();
    const first = makeStore(path);
    const s = await first.store.getOrCreateSession(identity());
    const entry: TimingEntry = {
      callId: 'c',
      stage: 'review',
      model: 'm',
      startedAt: 1,
      ttfcMs: null,
      durationMs: 5,
      inputTokens: 0,
      outputTokens: 0,
      status: 'success',
      streamed: false,
    };
    void first.store.recordTiming(s.id, entry);
    void first.store.recordTiming(s.id, { ...entry, callId: 'd' });
    await first.store.close();

    await first.store.recordTiming(s.id, entry);
    await first.store.put('late', { title: 't' } as unknown as ReviewReport);
    await first.store.putBatch('late', [review]);
    await first.store.putImpact('late', { files: {} } as unknown as ImpactResult);
    await first.store.saveChat(s.id, 'i', []);
    await first.store.setStageStatus(s.id, 'review', 'running');
    await first.store.close();

    const { store } = makeStore(path);
    expect(store.getTimings(s.id)).toHaveLength(2);
    expect(store.get('late')).toBeUndefined();
    await store.close();
  });
});

test('cacheKey includes local diff content but not for pull requests', () => {
  const config = testConfig();
  const local = (patch: string) => changeSet([file({ path: 'a.ts', patch })], { pull: undefined, baseRef: 'HEAD' });
  expect(cacheKey(local('@@ -1 +1 @@\n+a'), config)).not.toBe(cacheKey(local('@@ -1 +1 @@\n+b'), config));
  const pr = (patch: string) => changeSet([file({ path: 'a.ts', patch })]);
  expect(cacheKey(pr('x'), config)).toBe(cacheKey(pr('y'), config));
});

test('cacheKey includes skipValidation, impact.enabled and the rules fingerprint', () => {
  const config = testConfig();
  const cs = changeSet([]);
  const base = cacheKey(cs, config);
  expect(cacheKey(cs, config)).toBe(base);
  expect(cacheKey(cs, { ...config, skipValidation: !config.skipValidation })).not.toBe(base);
  expect(cacheKey(cs, { ...config, impact: { ...config.impact, enabled: !config.impact.enabled } })).not.toBe(base);
  expect(cacheKey(cs, config, 'rules-a')).not.toBe(base);
  expect(cacheKey(cs, config, 'rules-a')).not.toBe(cacheKey(cs, config, 'rules-b'));
  // Older callers that pass only the model settings still get a stable key.
  const minimal = { tiers: config.tiers, stageTiers: config.stageTiers, persona: config.persona };
  expect(cacheKey(cs, minimal)).toBe(cacheKey(cs, minimal));
});

test('cacheKey hashes the optional extra input; omitting it keeps the old key', () => {
  const config = testConfig();
  const cs = changeSet([]);
  const base = cacheKey(cs, config, 'r');
  expect(cacheKey(cs, config, 'r', undefined)).toBe(base);
  const extra = { title: 'T', securityContexts: [{ name: 'web' }], maxBatchTokens: 1000 };
  expect(cacheKey(cs, config, 'r', extra)).not.toBe(base);
  expect(cacheKey(cs, config, 'r', extra)).toBe(cacheKey(cs, config, 'r', { ...extra }));
  expect(cacheKey(cs, config, 'r', { ...extra, maxBatchTokens: 2000 })).not.toBe(cacheKey(cs, config, 'r', extra));
});

describe('cache stamps, pruning, impact and chats', () => {
  const review: FileReview = {
    path: 'a.ts',
    status: 'ok',
    whatChanged: 'x',
    findings: [],
    positives: [],
    testingRecommendations: [],
  };
  const report = { title: 't', headSha: 'h', findings: [] } as unknown as ReviewReport;

  test('reads entries written before cache values were stamped', async () => {
    const path = tempDir();
    const raw = open({ path, maxDbs: 16, compression: true });
    await raw.openDB<unknown, string>({ name: 'reports' }).put('old', report);
    await raw.openDB<unknown, string>({ name: 'batch-reviews' }).put('oldb', [review]);
    await raw.close();
    const { store } = makeStore(path);
    expect(store.get('old')).toEqual(report);
    expect(store.getBatch('oldb')).toEqual([review]);
    await store.close();
  });

  test('cleanupOlderThan prunes report and batch entries older than the cutoff, including unstamped ones', async () => {
    const path = tempDir();
    const raw = open({ path, maxDbs: 16, compression: true });
    await raw.openDB<unknown, string>({ name: 'reports' }).put('legacy', report);
    await raw.close();

    const { store, advance } = makeStore(path);
    await store.put('stale', report);
    await store.putBatch('staleb', [review]);
    advance(40 * DAY);
    await store.put('fresh', report);
    await store.putBatch('freshb', [review]);

    expect(await store.pruneCachesOlderThan(30, { dryRun: true })).toEqual({ reports: 2, batches: 1, impacts: 0 });
    expect(store.get('stale')).toBeDefined();
    expect((await store.cleanupOlderThan(30)).caches).toEqual({ reports: 2, batches: 1, impacts: 0 });
    expect(store.get('stale')).toBeUndefined();
    expect(store.get('legacy')).toBeUndefined();
    expect(store.getBatch('staleb')).toBeUndefined();
    expect(store.get('fresh')).toEqual(report);
    expect(store.getBatch('freshb')).toEqual([review]);
    await store.close();
  });

  test('clearCaches empties reports and batches and reports counts', async () => {
    const { store } = makeStore();
    await store.put('a', report);
    await store.put('b', report);
    await store.putBatch('c', [review]);
    expect(await store.clearCaches()).toEqual({ reports: 2, batches: 1 });
    expect(store.get('a')).toBeUndefined();
    expect(store.getBatch('c')).toBeUndefined();
    expect(await store.clearCaches()).toEqual({ reports: 0, batches: 0 });
    await store.close();
  });

  test('impact cache expires after 24 hours; impactKey ignores path order and duplicates', async () => {
    const { store, advance } = makeStore();
    const key = impactKey('repo1', ['b.ts', 'a.ts', 'a.ts']);
    expect(key).toBe(impactKey('repo1', ['a.ts', 'b.ts']));
    expect(key).not.toBe(impactKey('repo2', ['a.ts', 'b.ts']));
    expect(key).not.toBe(impactKey('repo1', ['a.ts']));

    const impact = { files: {} } as unknown as ImpactResult;
    expect(store.getImpact(key)).toBeUndefined();
    await store.putImpact(key, impact);
    advance(IMPACT_TTL_MS - 1);
    expect(store.getImpact(key)).toEqual(impact);
    advance(2);
    expect(store.getImpact(key)).toBeUndefined();
    await store.close();
  });

  test('concurrent stage updates on one session do not lose writes', async () => {
    const { store } = makeStore();
    const s = await store.getOrCreateSession(identity());
    await Promise.all([
      store.setStageStatus(s.id, 'review', 'running'),
      store.saveStageData(s.id, 'fetch', { n: 1 }),
      store.setStageStatus(s.id, 'triage', 'skipped'),
      store.saveStageData(s.id, 'docs', { n: 2 }),
      store.setStageStatus(s.id, 'critic', 'failed', 'boom'),
    ]);
    const stages = store.getSession(s.id)!.stages;
    expect(stages.review.state).toBe('running');
    expect(stages.fetch.state).toBe('completed');
    expect(stages.triage.state).toBe('skipped');
    expect(stages.docs.state).toBe('completed');
    expect(stages.critic).toMatchObject({ state: 'failed', error: 'boom' });
    await store.close();
  });

  test('a failing serialised write does not block later ones; flush waits for pending writes', async () => {
    const { store } = makeStore();
    const s = await store.getOrCreateSession(identity());
    const bad = store.setStageStatus('missing', 'review', 'running');
    const p1 = store.saveStageData(s.id, 'fetch', { ok: true });
    const p2 = store.putBatch('k', [review]);
    await expect(bad).rejects.toThrow(/No review session/);
    await store.flush();
    expect(store.getStageData(s.id, 'fetch')).toEqual({ ok: true });
    expect(store.getBatch('k')).toEqual([review]);
    await Promise.all([p1, p2]);
    await store.close();
  });

  test('close() waits for a write started just before it', async () => {
    const path = tempDir();
    const first = makeStore(path);
    void first.store.put('late', report);
    await first.store.close();
    const { store } = makeStore(path);
    expect(store.get('late')).toEqual(report);
    await store.close();
  });

  test('chats are saved per session and issue, and removed with the session', async () => {
    const path = tempDir();
    const first = makeStore(path);
    const s = await first.store.getOrCreateSession(identity());
    const messages = [
      { role: 'user' as const, content: 'Why?' },
      { role: 'assistant' as const, content: 'Because.' },
    ];
    await first.store.saveChat(s.id, 'ISSUE-1', messages);
    await first.store.close();

    const { store } = makeStore(path);
    expect(store.getChat(s.id, 'ISSUE-1')).toEqual(messages);
    expect(store.getChat(s.id, 'ISSUE-2')).toBeUndefined();
    await store.deleteSession(s.id);
    expect(store.getChat(s.id, 'ISSUE-1')).toBeUndefined();
    await store.close();
  });
});
