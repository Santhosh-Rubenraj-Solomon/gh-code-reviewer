import { TriageSchema } from '../schemas';
import type { ChangedFile, ChangeSet, SkippedFile } from '../types';
import { truncate, type StageDeps } from './deps';

const SKIP_RULES: { pattern: RegExp; reason: string }[] = [
  {
    pattern: /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Cargo\.lock|poetry\.lock|Gemfile\.lock|composer\.lock|go\.sum)$/,
    reason: 'lockfile',
  },
  { pattern: /\.min\.(js|css)$|\.map$/, reason: 'minified or source map' },
  { pattern: /(^|\/)(dist|build|vendor|node_modules|__generated__)\//, reason: 'build output or vendored code' },
  { pattern: /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|woff2?|ttf|eot|mp4|mov)$/i, reason: 'binary asset' },
  { pattern: /\.snap$/, reason: 'test snapshot' },
];

/** Cheap, deterministic filtering that needs no model call. */
export function staticTriage(files: ChangedFile[]): { candidates: ChangedFile[]; skipped: SkippedFile[] } {
  const candidates: ChangedFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const file of files) {
    if (file.status === 'removed') {
      skipped.push({ path: file.path, reason: 'file deleted' });
      continue;
    }
    if (!file.patch.trim()) {
      skipped.push({ path: file.path, reason: 'no text diff (binary, too large, or rename only)' });
      continue;
    }
    const rule = SKIP_RULES.find(r => r.pattern.test(file.path));
    if (rule) skipped.push({ path: file.path, reason: rule.reason });
    else candidates.push(file);
  }
  return { candidates, skipped };
}

export function buildTriagePrompt(changeSet: ChangeSet, files: ChangedFile[]): string {
  const listing = files
    .map(
      f =>
        `### ${f.path} (${f.status}, +${f.additions}/-${f.deletions})\n` +
        '```diff\n' +
        truncate(f.patch, 2_500) +
        '\n```',
    )
    .join('\n\n');
  return [
    `Pull request: ${changeSet.title}`,
    changeSet.description ? `Description:\n${truncate(changeSet.description, 2_000)}` : '',
    '',
    'For every file below return: path (exactly as given), review (true/false), a short reason,',
    'and a one-sentence summary of what changed in that file.',
    '',
    listing,
  ].join('\n');
}

export interface TriageResult {
  reviewable: ChangedFile[];
  skipped: SkippedFile[];
  summaries: Record<string, string>;
}

/**
 * Asks the cheap model which candidates need a deep review. Fails open: a file the
 * model forgets, or a model error, means the file is reviewed rather than dropped.
 */
export async function triage(deps: StageDeps, changeSet: ChangeSet, candidates: ChangedFile[]): Promise<TriageResult> {
  if (candidates.length === 0) return { reviewable: [], skipped: [], summaries: {} };

  let verdicts: Map<string, { review: boolean; reason: string; summary: string }>;
  try {
    const result = await deps.llm.generateObject('triage', buildTriagePrompt(changeSet, candidates), TriageSchema);
    deps.cost.record('triage', result.model, result.usage);
    verdicts = new Map(result.object.files.map(f => [f.path, f]));
  } catch (error) {
    deps.log(`triage failed, reviewing every file: ${(error as Error).message}`);
    return { reviewable: candidates, skipped: [], summaries: {} };
  }

  const reviewable: ChangedFile[] = [];
  const skipped: SkippedFile[] = [];
  const summaries: Record<string, string> = {};
  for (const file of candidates) {
    const verdict = verdicts.get(file.path);
    if (verdict?.summary) summaries[file.path] = verdict.summary;
    if (verdict && !verdict.review) skipped.push({ path: file.path, reason: `triage: ${verdict.reason}` });
    else reviewable.push(file);
  }
  return { reviewable, skipped, summaries };
}
