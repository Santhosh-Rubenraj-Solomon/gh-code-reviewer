import { annotatePatch } from '../diff';
import { ReviewBatchSchema } from '../schemas';
import type { Finding } from '../types';
import type { BatchItem } from './batcher';
import { truncate, type StageDeps } from './deps';

export interface ReviewContext {
  title: string;
  description: string;
  rules?: string;
  summaries: Record<string, string>;
}

export function buildReviewPrompt(batch: BatchItem[], context: ReviewContext): string {
  const parts: string[] = [
    '## Pull request',
    `Title: ${context.title}`,
    context.description ? `Description:\n${truncate(context.description, 4_000)}` : 'Description: (none)',
  ];

  if (context.rules?.trim()) {
    parts.push('', "## This team's review rules", context.rules.trim());
  }

  parts.push('', '## Files in this batch');
  for (const { file, includeContent } of batch) {
    parts.push('', `### ${file.path} (${file.status})`);
    const summary = context.summaries[file.path];
    if (summary) parts.push(`Summary: ${summary}`);
    parts.push('Diff, with the new-file line number in the left column:', '```diff', annotatePatch(file.patch), '```');
    if (includeContent && file.content) {
      parts.push('Whole file after the change, for context:', '```', file.content, '```');
    }
  }

  parts.push(
    '',
    '## How to answer',
    '- `file` must be one of the paths listed above, spelled exactly the same.',
    '- `line` is the number from the left column of the diff for the line the problem is on.',
    '- `evidence` is the problematic code copied exactly from the diff, without the line number or the +/- marker.',
    '- severity: critical = exploitable or data-destroying; high = wrong behaviour users will hit;',
    '  medium = bug in an edge case or a real maintainability risk; low = minor but still a real defect.',
    '- Return an empty `findings` list when nothing in this batch is wrong. That is a good outcome.',
  );
  return parts.join('\n');
}

export async function reviewBatch(deps: StageDeps, batch: BatchItem[], context: ReviewContext): Promise<Finding[]> {
  const result = await deps.llm.generateObject('review', buildReviewPrompt(batch, context), ReviewBatchSchema);
  deps.cost.record('review', result.model, result.usage);

  const paths = new Set(batch.map(item => item.file.path));
  return result.object.findings.filter(finding => {
    if (paths.has(finding.file)) return true;
    deps.log(`dropping finding for unknown file "${finding.file}"`);
    return false;
  });
}
