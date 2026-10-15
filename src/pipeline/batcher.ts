import { dirname } from 'node:path';
import type { ChangedFile } from '../types';
import { estimateTokens } from '../utils/tokens';

export interface BatchItem {
  file: ChangedFile;
  /** False when the full file would not fit; the reviewer then sees only the diff. */
  includeContent: boolean;
}

export interface BatchOptions {
  maxTokens: number;
  maxFiles: number;
  count?: (text: string) => number;
}

/**
 * Packs files into review batches under a token budget. Files are ordered by directory
 * so that related changes usually land in the same batch and can be read together.
 */
export function buildBatches(files: ChangedFile[], options: BatchOptions): BatchItem[][] {
  const count = options.count ?? estimateTokens;
  const sorted = [...files].sort(
    (a, b) => dirname(a.path).localeCompare(dirname(b.path)) || a.path.localeCompare(b.path),
  );

  const batches: BatchItem[][] = [];
  let current: BatchItem[] = [];
  let used = 0;

  for (const file of sorted) {
    const patchTokens = count(file.patch);
    const contentTokens = file.content ? count(file.content) : 0;
    const includeContent = Boolean(file.content) && patchTokens + contentTokens <= options.maxTokens;
    const size = includeContent ? patchTokens + contentTokens : patchTokens;

    if (current.length > 0 && (used + size > options.maxTokens || current.length >= options.maxFiles)) {
      batches.push(current);
      current = [];
      used = 0;
    }
    current.push({ file, includeContent });
    used += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}
