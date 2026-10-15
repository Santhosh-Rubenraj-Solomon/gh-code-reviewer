import { describe, expect, test } from 'bun:test';
import { labelFor, ReviewHistory, type HistoryEntry, type HistoryIO } from '../../src/history';

function memoryIO(initial?: string) {
  const files = new Map<string, string>(initial === undefined ? [] : [['/h.json', initial]]);
  const io: HistoryIO = {
    readText: p => files.get(p) ?? null,
    writeText: (p, t) => void files.set(p, t),
    remove: p => void files.delete(p),
  };
  return { io, files };
}

const at = (h: number) => new Date(Date.UTC(2026, 9, 15, h)).toISOString();
const pr = (target: string, h = 0): HistoryEntry => ({ kind: 'pr', target, cwd: '/w', at: at(h) });

describe('ReviewHistory', () => {
  test('keeps the newest 5, newest first', () => {
    const { io } = memoryIO();
    const history = new ReviewHistory({ path: '/h.json', io });
    for (let i = 1; i <= 7; i++) history.add(pr(`o/r#${i}`, i));
    expect(history.load().map(e => e.target)).toEqual(['o/r#7', 'o/r#6', 'o/r#5', 'o/r#4', 'o/r#3']);
    expect(history.latest()!.target).toBe('o/r#7');
  });

  test('dedupes PRs by target, local runs by cwd + title, commits by cwd + shas', () => {
    const { io } = memoryIO();
    const history = new ReviewHistory({ path: '/h.json', io });
    history.add(pr('o/r#1', 1));
    history.add(pr('o/r#2', 2));
    history.add({ ...pr('o/r#1', 3), persona: 'mentor' });
    history.add({ kind: 'local', target: 'main', title: 'Fix', cwd: '/a', at: at(4) });
    history.add({ kind: 'local', target: 'main', title: 'Fix', cwd: '/b', at: at(5) });
    history.add({ kind: 'local', target: 'dev', title: 'Fix', cwd: '/a', at: at(6) });
    history.add({ kind: 'commits', target: 'abc,def', cwd: '/a', at: at(7) });
    const entries = history.load();
    expect(entries.map(e => `${e.kind}:${e.target}:${e.cwd}`)).toEqual([
      'commits:abc,def:/a',
      'local:dev:/a',
      'local:main:/b',
      'pr:o/r#1:/w',
      'pr:o/r#2:/w',
    ]);
    expect(entries[3]!.persona).toBe('mentor');
  });

  test.each(['not json', '{"kind":"pr"}', '[{"kind":"gitlab","target":"x","cwd":"/","at":"2026-01-01"}]', '[{"kind":"pr"}]'])(
    'a corrupt file (%s) is reset',
    content => {
      const { io, files } = memoryIO(content);
      const history = new ReviewHistory({ path: '/h.json', io });
      expect(history.load()).toEqual([]);
      expect(files.has('/h.json')).toBe(false);
      history.add(pr('o/r#1'));
      expect(history.load()).toHaveLength(1);
    },
  );
});

test('labelFor formats kind, target, persona and age', () => {
  const now = new Date(Date.UTC(2026, 9, 15, 15));
  expect(labelFor({ ...pr('owner/repo#12', 12), persona: 'mentor' }, now)).toBe('[pr] owner/repo#12 (mentor) – 3h ago');
  expect(labelFor({ kind: 'local', target: 'main', cwd: '/x/app', at: now.toISOString() }, now)).toBe(
    '[local] app – just now',
  );
  expect(labelFor({ kind: 'local', target: 'main', title: 'Fix cache', cwd: '/x', at: at(14) }, now)).toBe(
    '[local] Fix cache – 1h ago',
  );
  const twoDays = new Date(now.getTime() - 2 * 86_400_000 - 1).toISOString();
  expect(labelFor({ kind: 'commits', target: 'abc1234', cwd: '/x/app', at: twoDays }, now)).toBe(
    '[commits] app @ abc1234 – 2d ago',
  );
  expect(labelFor({ ...pr('o/r#1'), at: new Date(now.getTime() - 5 * 60_000).toISOString() }, now)).toBe(
    '[pr] o/r#1 – 5m ago',
  );
});

test('uncommitted runs are kept, deduped by cwd only, and labelled', () => {
  const { io } = memoryIO();
  const history = new ReviewHistory({ path: '/h.json', io });
  history.add({ kind: 'uncommitted', target: 'HEAD', title: 'WIP', cwd: '/a', at: at(1) });
  history.add({ kind: 'uncommitted', target: 'HEAD', cwd: '/b', at: at(2) });
  history.add({ kind: 'local', target: 'main', cwd: '/a', at: at(3) });
  history.add({ kind: 'uncommitted', target: 'HEAD', title: 'Other', cwd: '/a', at: at(4) });
  // A fresh instance re-reads the file: the kind must validate.
  const entries = new ReviewHistory({ path: '/h.json', io }).load();
  expect(entries.map(e => `${e.kind}:${e.cwd}`)).toEqual(['uncommitted:/a', 'local:/a', 'uncommitted:/b']);
  expect(entries[0]!.title).toBe('Other');

  const now = new Date(Date.UTC(2026, 9, 15, 5));
  expect(labelFor(entries[0]!, now)).toBe('[uncommitted] Other – 1h ago');
  expect(labelFor(entries[2]!, now)).toBe('[uncommitted] b – 3h ago');
});
