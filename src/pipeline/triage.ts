import { z } from 'zod';
import type { ChangedFile, ChangeSet, SkippedFile } from '../types';
import { truncate, type StageDeps } from './deps';
import { isProjectDoc } from './docs';

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

/** Tooling config at the repository root that rarely changes behaviour. Matched by exact path. */
export const DEFAULT_ROOT_CONFIG_FILES = ['.gitignore', '.prettierrc', '.editorconfig', '.eslintignore'];

export interface StaticTriageOptions {
  rootConfigFiles?: string[];
}

/** Cheap, deterministic filtering that needs no model call. */
export function staticTriage(
  files: ChangedFile[],
  options: StaticTriageOptions = {},
): { candidates: ChangedFile[]; skipped: SkippedFile[] } {
  const rootConfig = new Set(options.rootConfigFiles ?? DEFAULT_ROOT_CONFIG_FILES);
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
    if (rootConfig.has(file.path)) {
      skipped.push({ path: file.path, reason: 'tooling config' });
      continue;
    }
    if (isProjectDoc(file.path)) {
      skipped.push({ path: file.path, reason: 'project documentation' });
      continue;
    }
    const rule = SKIP_RULES.find(r => r.pattern.test(file.path));
    if (rule) skipped.push({ path: file.path, reason: rule.reason });
    else candidates.push(file);
  }
  return { candidates, skipped };
}

const TRIAGE_DIFF_CHARS = 1_500;

const TriageSchema = z.object({
  files: z.array(
    z.object({
      path: z.string(),
      review: z.boolean(),
      reason: z.string(),
      summary: z.string(),
      /** Other changed files this one uses or is used by. */
      relatedFiles: z.array(z.string()).optional(),
    }),
  ),
});

type TriageVerdict = z.infer<typeof TriageSchema>['files'][number];

export interface TriageOptions {
  docsSummary?: string;
}

export function buildTriagePrompt(changeSet: ChangeSet, files: ChangedFile[], options: TriageOptions = {}): string {
  const listing = files
    .map(
      f =>
        `### ${f.path} (${f.status}, +${f.additions}/-${f.deletions})\n` +
        '```diff\n' +
        truncate(f.patch, TRIAGE_DIFF_CHARS) +
        '\n```',
    )
    .join('\n\n');
  const parts = [`Pull request: ${changeSet.title}`];
  if (changeSet.description) parts.push(`Description:\n${truncate(changeSet.description, 2_000)}`);
  if (options.docsSummary?.trim()) {
    parts.push(`Project documentation, summarised:\n${truncate(options.docsSummary.trim(), 3_000)}`);
  }
  parts.push(
    '',
    'For every file below return:',
    '- path, exactly as given;',
    '- review: true unless the change clearly cannot hide a defect (whitespace only, images, generated output);',
    '  when in doubt answer true;',
    '- reason: a few words explaining the decision;',
    '- summary: one sentence (under 100 words) on what changed in that file;',
    '- relatedFiles: other paths from this list that this file imports, calls, or is called by (empty if none).',
    'Diffs are cut short, so judge by what you can see.',
    '',
    listing,
  );
  return parts.join('\n');
}

export interface TriageResult {
  reviewable: ChangedFile[];
  skipped: SkippedFile[];
  summaries: Record<string, string>;
  /** Changed files each file depends on or is used by, as reported by the model. */
  dependencies: Record<string, string[]>;
}

/**
 * Asks the cheap model which candidates need a deep review. Fails open: a file the
 * model forgets, or a model error, means the file is reviewed rather than dropped.
 */
export async function triage(
  deps: StageDeps,
  changeSet: ChangeSet,
  candidates: ChangedFile[],
  options: TriageOptions = {},
): Promise<TriageResult> {
  if (candidates.length === 0) return { reviewable: [], skipped: [], summaries: {}, dependencies: {} };

  let verdicts: Map<string, TriageVerdict>;
  try {
    const prompt = buildTriagePrompt(changeSet, candidates, options);
    const result = await deps.llm.generateObject('triage', prompt, TriageSchema);
    deps.cost.record('triage', result.model, result.usage);
    verdicts = new Map(result.object.files.map(f => [f.path, f]));
  } catch (error) {
    deps.log(`triage failed, reviewing every file: ${(error as Error).message}`);
    return { reviewable: candidates, skipped: [], summaries: {}, dependencies: {} };
  }

  const known = new Set(candidates.map(f => f.path));
  const reviewable: ChangedFile[] = [];
  const skipped: SkippedFile[] = [];
  const summaries: Record<string, string> = {};
  const dependencies: Record<string, string[]> = {};
  for (const file of candidates) {
    const verdict = verdicts.get(file.path);
    if (verdict?.summary) summaries[file.path] = verdict.summary;
    const related = [...new Set(verdict?.relatedFiles ?? [])].filter(p => p !== file.path && known.has(p));
    if (related.length) dependencies[file.path] = related;
    if (verdict && !verdict.review) skipped.push({ path: file.path, reason: `triage: ${verdict.reason}` });
    else reviewable.push(file);
  }
  return { reviewable, skipped, summaries, dependencies };
}
