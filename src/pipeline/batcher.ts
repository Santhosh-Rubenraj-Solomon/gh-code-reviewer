import { dirname } from 'node:path';
import { z } from 'zod';
import type { ChangedFile } from '../types';
import { estimateTokens } from '../utils/tokens';
import { truncate, type StageDeps } from './deps';

export interface BatchItem {
  file: ChangedFile;
  /** False when the full file would not fit; the reviewer then sees only the diff. */
  includeContent: boolean;
}

export interface BatchOptions {
  maxTokens: number;
  maxFiles: number;
  count?: (text: string) => number;
  /** Tokens a file adds beyond its diff and content, such as the review rules scoped to it. */
  extraTokens?: (path: string) => number;
  /** Changed files connected to each file (e.g. from impact analysis). */
  related?: Record<string, string[]>;
  /** Dependencies reported by triage. */
  dependencies?: Record<string, string[]>;
}

export interface SizedItem extends BatchItem {
  tokens: number;
}

export function sizeFiles(files: ChangedFile[], options: BatchOptions): SizedItem[] {
  const count = options.count ?? estimateTokens;
  return files.map(file => {
    const patchTokens = count(file.patch) + (options.extraTokens?.(file.path) ?? 0);
    const contentTokens = file.content ? count(file.content) : 0;
    const includeContent = Boolean(file.content) && patchTokens + contentTokens <= options.maxTokens;
    return { file, includeContent, tokens: includeContent ? patchTokens + contentTokens : patchTokens };
  });
}

/**
 * Most-connected files first (they benefit most from company), then by directory and size.
 * Each file is immediately followed by its still-unplaced related files so they share a batch.
 */
function impactOrder(items: SizedItem[], options: BatchOptions): SizedItem[] {
  const related = options.related ?? {};
  const deps = options.dependencies ?? {};
  const relatedCount = (p: string) => related[p]?.length ?? 0;
  const depCount = (p: string) => deps[p]?.length ?? 0;
  const sorted = [...items].sort(
    (a, b) =>
      relatedCount(b.file.path) - relatedCount(a.file.path) ||
      depCount(b.file.path) - depCount(a.file.path) ||
      dirname(a.file.path).localeCompare(dirname(b.file.path)) ||
      b.tokens - a.tokens ||
      a.file.path.localeCompare(b.file.path),
  );
  const byPath = new Map(sorted.map(i => [i.file.path, i]));
  const placed = new Set<string>();
  const out: SizedItem[] = [];
  for (const item of sorted) {
    if (placed.has(item.file.path)) continue;
    placed.add(item.file.path);
    out.push(item);
    const partners = new Set([...(related[item.file.path] ?? []), ...(deps[item.file.path] ?? [])]);
    for (const candidate of sorted) {
      if (partners.has(candidate.file.path) && !placed.has(candidate.file.path) && byPath.has(candidate.file.path)) {
        placed.add(candidate.file.path);
        out.push(candidate);
      }
    }
  }
  return out;
}

/** Greedy packing in the given order. A single file over budget still gets a batch of its own. */
function pack(items: SizedItem[], maxTokens: number, maxFiles: number): BatchItem[][] {
  const batches: BatchItem[][] = [];
  let current: BatchItem[] = [];
  let used = 0;
  for (const item of items) {
    if (current.length > 0 && (used + item.tokens > maxTokens || current.length >= maxFiles)) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push({ file: item.file, includeContent: item.includeContent });
    used += item.tokens;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/**
 * Packs files into review batches under a token budget, deterministically. Connected files
 * come first and are kept together; otherwise files of one directory stay adjacent.
 */
export function buildBatches(files: ChangedFile[], options: BatchOptions): BatchItem[][] {
  return pack(impactOrder(sizeFiles(files, options), options), options.maxTokens, options.maxFiles);
}

export interface PlanOptions extends BatchOptions {
  summaries?: Record<string, string>;
}

const BatchPlanSchema = z.object({
  batches: z.array(z.array(z.string())),
  reasoning: z.string().optional(),
});

export function buildBatchingPrompt(items: SizedItem[], options: PlanOptions): string {
  const lines = items.map(item => {
    const path = item.file.path;
    const links = [...new Set([...(options.related?.[path] ?? []), ...(options.dependencies?.[path] ?? [])])];
    const summary = options.summaries?.[path];
    return [
      `- ${path} (~${item.tokens} tokens)`,
      summary ? `  summary: ${truncate(summary, 300)}` : '',
      links.length ? `  connected to: ${links.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  });
  return [
    `Split these ${items.length} changed files into review batches.`,
    `Each batch may hold at most ${options.maxFiles} files and about ${options.maxTokens} tokens in total.`,
    'Put files that depend on each other, or implement one feature together, in the same batch so the reviewer',
    'sees both sides of an interface. Use every path exactly once and exactly as written.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * Turns a model's plan into valid batches: unknown paths are dropped, duplicates keep their
 * first position, missing files are packed into extra batches, and over-budget batches are split.
 */
export function validatePlan(plan: string[][], items: SizedItem[], options: BatchOptions): BatchItem[][] {
  const byPath = new Map(items.map(i => [i.file.path, i]));
  const seen = new Set<string>();
  const batches: BatchItem[][] = [];
  for (const group of plan) {
    const members: SizedItem[] = [];
    for (const path of group) {
      const item = byPath.get(path);
      if (!item || seen.has(path)) continue;
      seen.add(path);
      members.push(item);
    }
    if (members.length) batches.push(...pack(members, options.maxTokens, options.maxFiles));
  }
  const missing = items.filter(i => !seen.has(i.file.path));
  if (missing.length) batches.push(...pack(impactOrder(missing, options), options.maxTokens, options.maxFiles));
  return batches;
}

/**
 * Batches for the review stage. Everything in one batch needs no model call; otherwise the
 * batching model groups related files, and any failure falls back to `buildBatches`.
 */
export async function planBatches(deps: StageDeps, files: ChangedFile[], options: PlanOptions): Promise<BatchItem[][]> {
  if (files.length === 0) return [];
  const items = sizeFiles(files, options);
  const total = items.reduce((sum, i) => sum + i.tokens, 0);
  if (total <= options.maxTokens && files.length <= options.maxFiles) return buildBatches(files, options);

  try {
    const result = await deps.llm.generateObject('batching', buildBatchingPrompt(items, options), BatchPlanSchema);
    deps.cost.record('batching', result.model, result.usage);
    const batches = validatePlan(result.object.batches, items, options);
    if (batches.length === 0) throw new Error('plan contained no batches');
    return batches;
  } catch (error) {
    deps.log(`batch planning failed, packing by size instead: ${(error as Error).message}`);
    return buildBatches(files, options);
  }
}
