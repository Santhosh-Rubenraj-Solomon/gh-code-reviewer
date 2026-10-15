import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { LLMClient } from '../llm';
import {
  DEFAULT_MEMORY_SETTINGS,
  MEMORY_TYPES,
  type ChatTurn,
  type CompactResult,
  type MemoryFile,
  type MemoryItem,
  type MemoryQuery,
  type MemorySettings,
  type MemoryStats,
  type MemoryType,
  type NewMemory,
} from './types';

const DAY_MS = 86_400_000;
const NEVER_TOUCHED_GRACE_DAYS = 7;
const LOW_IMPORTANCE = 4;
const RELEVANT_CANDIDATES = 50;
const RELEVANT_RESULTS = 10;
const SUMMARY_GROUP_MIN = 5;

/** The file operations the store needs; swapped in tests to prove writes are atomic. */
export interface MemoryFs {
  readText(path: string): string | null;
  writeText(path: string, text: string): void;
  rename(from: string, to: string): void;
  mkdir(dir: string): void;
  remove(path: string): void;
}

export const nodeMemoryFs: MemoryFs = {
  readText: path => (existsSync(path) ? readFileSync(path, 'utf8') : null),
  writeText: (path, text) => writeFileSync(path, text, { encoding: 'utf8', mode: 0o600 }),
  rename: (from, to) => renameSync(from, to),
  mkdir: dir => mkdirSync(dir, { recursive: true, mode: 0o700 }),
  remove: path => rmSync(path, { force: true }),
};

export function defaultMemoryDir(home: string = homedir()): string {
  return join(home, '.gh-code-reviewer', 'memory');
}

export interface DeveloperMemoryOptions {
  developerId: string;
  dir?: string;
  /** Used for relevance ranking and compaction summaries (the `memory` stage). Optional: both fall back without it. */
  llm?: LLMClient;
  now?: () => number;
  settings?: Partial<MemorySettings>;
  fs?: MemoryFs;
}

export interface RecordChatOptions {
  issueTitle: string;
  project?: string | null;
  resolved?: boolean;
  keyPoints?: string[];
}

const TYPE_KEYWORDS: [MemoryType, RegExp][] = [
  ['preference', /\b(prefer|prefers|preferred|like to|always|never)\b/i],
  ['pattern', /\b(pattern|usually|convention|typically|we tend to)\b/i],
  ['decision', /\b(decided|decide|agreed|agree|will|going to)\b/i],
  ['feedback', /\b(feedback|suggestion|suggest|should)\b/i],
];

/** Guesses what kind of memory a free-text note is from the words it uses. */
export function inferMemoryType(text: string): MemoryType {
  for (const [type, pattern] of TYPE_KEYWORDS) if (pattern.test(text)) return type;
  return 'context';
}

const memoryItemSchema = z.object({
  id: z.string().optional(),
  type: z.enum(MEMORY_TYPES),
  content: z.string().min(1),
  tags: z.array(z.string()).default([]),
  source: z.enum(['cli', 'chat', 'review']).default('cli'),
  project: z.string().nullable().default(null),
  filePatterns: z.array(z.string()).default([]),
  createdAt: z.string().optional(),
  lastAccessedAt: z.string().optional(),
  accessCount: z.number().int().nonnegative().default(0),
  importance: z.number().default(5),
});

const rankingSchema = z.object({ indices: z.array(z.number().int()) });

function clampImportance(n: number | undefined): number {
  if (typeof n !== 'number' || Number.isNaN(n)) return 5;
  return Math.min(10, Math.max(1, Math.round(n)));
}

function dedupeKey(item: Pick<MemoryItem, 'type' | 'content'>): string {
  return `${item.type}|${item.content.trim().toLowerCase().replace(/\s+/g, ' ')}`;
}

export class DeveloperMemory {
  readonly developerId: string;
  readonly path: string;
  readonly settings: MemorySettings;
  private readonly dir: string;
  private readonly fs: MemoryFs;
  private readonly now: () => number;
  private readonly llm?: LLMClient;
  private items: MemoryItem[] | null = null;
  private seq = 0;

  constructor(options: DeveloperMemoryOptions) {
    this.developerId = options.developerId;
    this.dir = options.dir ?? defaultMemoryDir();
    this.path = join(this.dir, `${options.developerId}.json`);
    this.settings = { ...DEFAULT_MEMORY_SETTINGS, ...options.settings };
    this.fs = options.fs ?? nodeMemoryFs;
    this.now = options.now ?? Date.now;
    this.llm = options.llm;
  }

  // ---- persistence -------------------------------------------------------

  private load(): MemoryItem[] {
    if (this.items) return this.items;
    const text = this.fs.readText(this.path);
    if (!text) return (this.items = []);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new Error(`Memory file ${this.path} is not valid JSON: ${(error as Error).message}`);
    }
    const raw = (parsed as Partial<MemoryFile>)?.memories;
    this.items = Array.isArray(raw) ? raw.flatMap(r => this.normalise(r) ?? []) : [];
    return this.items;
  }

  /** Writes to a temp file and renames it over the real one, so a crash mid-write never truncates the memory file. */
  private save(): void {
    const data: MemoryFile = { version: 1, developerId: this.developerId, memories: this.load() };
    this.fs.mkdir(this.dir);
    const tmp = `${this.path}.${process.pid}.${this.now()}.tmp`;
    try {
      this.fs.writeText(tmp, `${JSON.stringify(data, null, 2)}\n`);
      this.fs.rename(tmp, this.path);
    } catch (error) {
      try {
        this.fs.remove(tmp);
      } catch {
        // best effort cleanup; the original file is untouched either way
      }
      throw error;
    }
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private newId(): string {
    this.seq = (this.seq + 1) % 1_296;
    const rand = Math.random().toString(36).slice(2, 7);
    return `mem_${this.now().toString(36)}${this.seq.toString(36).padStart(2, '0')}${rand}`;
  }

  private normalise(raw: unknown, freshId = false): MemoryItem | null {
    const result = memoryItemSchema.safeParse(raw);
    if (!result.success) return null;
    const r = result.data;
    const now = this.nowIso();
    return {
      id: !freshId && r.id ? r.id : this.newId(),
      type: r.type,
      content: r.content.trim(),
      tags: [...new Set(r.tags.map(t => t.trim().toLowerCase()).filter(Boolean))],
      source: r.source,
      project: r.project,
      filePatterns: r.filePatterns,
      createdAt: r.createdAt ?? now,
      lastAccessedAt: r.lastAccessedAt ?? r.createdAt ?? now,
      accessCount: r.accessCount,
      importance: clampImportance(r.importance),
    };
  }

  // ---- scoring -----------------------------------------------------------

  private ageMs(item: MemoryItem): number {
    return Math.max(0, this.now() - Date.parse(item.createdAt));
  }

  isStale(item: MemoryItem): boolean {
    return this.now() - Date.parse(item.lastAccessedAt) > this.settings.staleAfterDays * DAY_MS;
  }

  /** Important, frequently used, recent memories win; anything past the retention window scores zero. */
  score(item: MemoryItem): number {
    const decay = Math.max(0, 1 - this.ageMs(item) / (this.settings.retentionDays * DAY_MS));
    return item.importance * (1 + 0.1 * item.accessCount) * decay;
  }

  // ---- CRUD --------------------------------------------------------------

  async add(input: NewMemory): Promise<MemoryItem> {
    const content = input.content.trim();
    if (!content) throw new Error('Memory content cannot be empty');
    const now = this.nowIso();
    const item: MemoryItem = {
      id: this.newId(),
      type: input.type ?? inferMemoryType(content),
      content,
      tags: [...new Set((input.tags ?? []).map(t => t.trim().toLowerCase()).filter(Boolean))],
      source: input.source ?? 'cli',
      project: input.project ?? null,
      filePatterns: input.filePatterns ?? [],
      createdAt: now,
      lastAccessedAt: now,
      accessCount: 0,
      importance: clampImportance(input.importance),
    };
    this.load().push(item);
    this.save();
    await this.maintain();
    return item;
  }

  update(id: string, patch: Partial<Omit<MemoryItem, 'id' | 'createdAt'>>): MemoryItem | null {
    const item = this.load().find(m => m.id === id);
    if (!item) return null;
    Object.assign(item, patch);
    if (patch.importance !== undefined) item.importance = clampImportance(patch.importance);
    this.save();
    return item;
  }

  delete(id: string): boolean {
    const items = this.load();
    const index = items.findIndex(m => m.id === id);
    if (index < 0) return false;
    items.splice(index, 1);
    this.save();
    return true;
  }

  clear(): number {
    const count = this.load().length;
    this.items = [];
    this.save();
    return count;
  }

  get(id: string): MemoryItem | undefined {
    return this.load().find(m => m.id === id);
  }

  /** Every memory, newest first, without touching access statistics. */
  all(): MemoryItem[] {
    return [...this.load()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Filters and ranks memories by score. Returned memories count as "used": their access stats are bumped. */
  query(filters: MemoryQuery = {}): MemoryItem[] {
    const text = filters.text?.toLowerCase();
    const matches = this.load().filter(m => {
      if (filters.types?.length && !filters.types.includes(m.type)) return false;
      if (filters.tags?.length && !filters.tags.some(t => m.tags.includes(t.toLowerCase()))) return false;
      if (filters.project !== undefined && m.project !== null && m.project !== filters.project) return false;
      if (filters.minImportance !== undefined && m.importance < filters.minImportance) return false;
      if (!filters.includeStale && this.isStale(m)) return false;
      if (text && !m.content.toLowerCase().includes(text) && !m.tags.some(t => t.includes(text))) return false;
      return true;
    });
    const ranked = matches
      .map(m => ({ m, s: this.score(m) }))
      .sort((a, b) => b.s - a.s || b.m.createdAt.localeCompare(a.m.createdAt))
      .map(x => x.m)
      .slice(0, filters.limit ?? Number.POSITIVE_INFINITY);
    this.touch(ranked);
    return ranked.map(m => ({ ...m }));
  }

  private touch(items: MemoryItem[]): void {
    if (!items.length) return;
    const now = this.nowIso();
    for (const item of items) {
      item.lastAccessedAt = now;
      item.accessCount++;
    }
    this.save();
  }

  // ---- chat integration --------------------------------------------------

  /** Stores what a chat about one issue established: a discussion record plus one memory per key point. */
  async recordFromChat(messages: ChatTurn[], options: RecordChatOptions): Promise<MemoryItem[]> {
    const project = options.project ?? null;
    const dialogue = messages.filter(m => m.role !== 'system');
    const developerLines = dialogue.filter(m => m.role === 'user').map(m => m.content.trim().replace(/\s+/g, ' '));
    const gist = developerLines.slice(-3).join(' / ').slice(0, 400);
    const outcome = options.resolved ? 'resolved' : 'open';
    const created: MemoryItem[] = [];
    created.push(
      await this.add({
        type: 'discussion',
        content: `Discussed "${options.issueTitle}" (${outcome}).${gist ? ` Developer said: ${gist}` : ''}`,
        tags: ['chat'],
        source: 'chat',
        project,
        importance: options.resolved ? 7 : 5,
      }),
    );
    for (const point of options.keyPoints ?? []) {
      if (!point.trim()) continue;
      created.push(
        await this.add({ type: inferMemoryType(point), content: point, tags: ['chat'], source: 'chat', project, importance: 6 }),
      );
    }
    return created;
  }

  /** Memories worth putting in a chat prompt about this issue, best first. */
  async relevantFor(context: { project?: string | null; issueTitle?: string }): Promise<MemoryItem[]> {
    const candidates = this.query({ project: context.project ?? null, limit: RELEVANT_CANDIDATES });
    if (candidates.length <= 5 || !context.issueTitle || !this.llm) return candidates.slice(0, RELEVANT_RESULTS);
    try {
      const list = candidates.map((m, i) => `${i}. [${m.type}] ${m.content}`).join('\n');
      const prompt = [
        `A developer is about to discuss this code review issue: "${context.issueTitle}".`,
        `Pick up to ${RELEVANT_RESULTS} of the numbered notes below that would most help the reviewer respond well,`,
        'most useful first. Return their numbers in "indices". Ignore notes that have nothing to do with the issue.',
        '',
        list,
      ].join('\n');
      const { object } = await this.llm.generateObject('memory', prompt, rankingSchema);
      const picked = [...new Set(object.indices)].filter(i => i >= 0 && i < candidates.length);
      if (!picked.length) return candidates.slice(0, RELEVANT_RESULTS);
      return picked.slice(0, RELEVANT_RESULTS).map(i => candidates[i]!);
    } catch {
      return candidates.slice(0, RELEVANT_RESULTS);
    }
  }

  // ---- maintenance -------------------------------------------------------

  private async maintain(): Promise<void> {
    if (this.load().length < this.settings.autoCompactAt) return;
    await this.compact();
    const items = this.load();
    if (items.length > this.settings.maxItems) {
      // Still over the hard cap: drop the weakest memories so the file cannot grow without bound.
      const keep = items
        .map(m => ({ m, s: this.score(m) }))
        .sort((a, b) => b.s - a.s)
        .slice(0, this.settings.maxItems)
        .map(x => x.m);
      this.items = keep;
      this.save();
    }
  }

  /**
   * Forgets expired low-value and never-used memories, then, if the store is still crowded, folds groups of
   * similar memories into a single summary. A group whose summary fails is kept as it was.
   */
  async compact(): Promise<CompactResult> {
    const retentionMs = this.settings.retentionDays * DAY_MS;
    const before = this.load().length;
    this.items = this.load().filter(m => {
      const age = this.ageMs(m);
      if (age > retentionMs && m.importance < LOW_IMPORTANCE) return false;
      if (m.accessCount === 0 && age > NEVER_TOUCHED_GRACE_DAYS * DAY_MS) return false;
      return true;
    });
    const removed = before - this.items.length;
    let summarized = 0;

    if (this.items.length > this.settings.maxItems * 0.8 && this.llm) {
      const groups = new Map<string, MemoryItem[]>();
      for (const m of this.items) {
        const key = `${m.type}|${[...m.tags].sort().join(',')}`;
        groups.set(key, [...(groups.get(key) ?? []), m]);
      }
      for (const group of groups.values()) {
        if (group.length < SUMMARY_GROUP_MIN) continue;
        const summary = await this.summarise(group);
        if (!summary) continue;
        const ids = new Set(group.map(m => m.id));
        this.items = this.items.filter(m => !ids.has(m.id));
        this.items.push(summary);
        summarized += group.length;
      }
    }

    this.save();
    return { removed, summarized, remaining: this.items.length };
  }

  private async summarise(group: MemoryItem[]): Promise<MemoryItem | null> {
    const first = group[0]!;
    const prompt = [
      `Merge these ${group.length} notes about a developer (all of type "${first.type}") into one note.`,
      'Keep every concrete preference, rule or decision; drop repetition. Reply with the merged note only, as plain text',
      'of at most 120 words.',
      '',
      ...group.map(m => `- ${m.content}`),
    ].join('\n');
    try {
      const { text } = await this.llm!.generateText('memory', prompt);
      const content = text.trim();
      if (!content) return null;
      const projects = new Set(group.map(m => m.project));
      const now = this.nowIso();
      return {
        id: this.newId(),
        type: 'summarized',
        content,
        tags: first.tags,
        source: first.source,
        project: projects.size === 1 ? first.project : null,
        filePatterns: [...new Set(group.flatMap(m => m.filePatterns))],
        createdAt: now,
        lastAccessedAt: now,
        accessCount: 0,
        importance: Math.max(...group.map(m => m.importance)),
      };
    } catch {
      return null;
    }
  }

  // ---- export / import / stats ------------------------------------------

  export(): string {
    const data: MemoryFile & { exportedAt: string } = {
      version: 1,
      developerId: this.developerId,
      exportedAt: this.nowIso(),
      memories: this.all(),
    };
    return JSON.stringify(data, null, 2);
  }

  /** Adds memories from an export, skipping any whose type and content already exist. Imported items get new ids. */
  import(json: string): { imported: number; skipped: number } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch (error) {
      throw new Error(`Import file is not valid JSON: ${(error as Error).message}`);
    }
    const raw = Array.isArray(parsed) ? parsed : (parsed as { memories?: unknown })?.memories;
    if (!Array.isArray(raw)) throw new Error('Import file has no "memories" array');
    const items = this.load();
    const seen = new Set(items.map(dedupeKey));
    let imported = 0;
    let skipped = 0;
    for (const entry of raw) {
      const item = this.normalise(entry, true);
      if (!item || seen.has(dedupeKey(item))) {
        skipped++;
        continue;
      }
      seen.add(dedupeKey(item));
      items.push(item);
      imported++;
    }
    this.save();
    return { imported, skipped };
  }

  stats(): MemoryStats {
    const items = this.load();
    const byType: Partial<Record<MemoryType, number>> = {};
    const byProject: Record<string, number> = {};
    for (const m of items) {
      byType[m.type] = (byType[m.type] ?? 0) + 1;
      const project = m.project ?? '(global)';
      byProject[project] = (byProject[project] ?? 0) + 1;
    }
    const dates = items.map(m => m.createdAt).sort();
    return {
      total: items.length,
      stale: items.filter(m => this.isStale(m)).length,
      byType,
      byProject,
      oldest: dates[0],
      newest: dates[dates.length - 1],
    };
  }
}
