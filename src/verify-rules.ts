import { z } from 'zod';
import type { StageDeps } from './pipeline/deps';
import { ALWAYS_GLOBAL_RULE_FILE, DEFAULT_RULE_LIMITS, parseRuleFile, type RuleFile, type RuleLimits } from './review-rules';
import type { Stage } from './types';
import { globProblem, matchesAny } from './utils/glob';
import { estimateTokens } from './utils/tokens';

/** Default token budget of one review call, used to express rule overhead as a percentage. */
export const DEFAULT_REVIEW_BUDGET_TOKENS = 189_999;

export interface RuleFileReport {
  path: string;
  chars: number;
  tokens: number;
  globs: string[];
  global: boolean;
  /** Repo files the rule applies to (all of them for a global rule). */
  matches: number;
  errors: string[];
  warnings: string[];
}

export type VerifyStatus = 'ok' | 'warnings' | 'errors';

export interface VerifyReport {
  files: RuleFileReport[];
  totals: {
    chars: number;
    maxTotalChars: number;
    tokens: number;
    globalTokens: number;
    scopedTokensMin: number;
    scopedTokensMax: number;
    budgetTokens: number;
    /** Worst case rule overhead for one file (global plus its largest scoped rule) as % of the budget. */
    budgetPercent: number;
  };
  warnings: string[];
  status: VerifyStatus;
}

export interface VerifyOptions {
  ruleFiles: RuleFile[];
  repoFiles: string[];
  limits?: Partial<RuleLimits>;
  budgetTokens?: number;
  count?: (text: string) => number;
}

export function verifyRules(options: VerifyOptions): VerifyReport {
  const limits = { ...DEFAULT_RULE_LIMITS, ...options.limits };
  const budgetTokens = options.budgetTokens ?? DEFAULT_REVIEW_BUDGET_TOKENS;
  const count = options.count ?? estimateTokens;

  const files = [...options.ruleFiles]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(file => checkFile(file, options.repoFiles, limits, count));

  const chars = files.reduce((n, f) => n + f.chars, 0);
  const tokens = files.reduce((n, f) => n + f.tokens, 0);
  const globalTokens = files.filter(f => f.global).reduce((n, f) => n + f.tokens, 0);
  const scoped = files.filter(f => !f.global).map(f => f.tokens);
  const scopedTokensMin = scoped.length ? Math.min(...scoped) : 0;
  const scopedTokensMax = scoped.length ? Math.max(...scoped) : 0;
  const budgetPercent = budgetTokens > 0 ? ((globalTokens + scopedTokensMax) / budgetTokens) * 100 : 0;

  const warnings: string[] = [];
  if (chars > limits.maxTotalChars) {
    warnings.push(`rules total ${chars} characters, over the ${limits.maxTotalChars} limit; later files will be skipped`);
  }
  if (files.length === 0) warnings.push('no rule files found');

  const status: VerifyStatus = files.some(f => f.errors.length)
    ? 'errors'
    : warnings.length || files.some(f => f.warnings.length)
      ? 'warnings'
      : 'ok';

  return {
    files,
    totals: {
      chars,
      maxTotalChars: limits.maxTotalChars,
      tokens,
      globalTokens,
      scopedTokensMin,
      scopedTokensMax,
      budgetTokens,
      budgetPercent,
    },
    warnings,
    status,
  };
}

function checkFile(
  file: RuleFile,
  repoFiles: string[],
  limits: RuleLimits,
  count: (text: string) => number,
): RuleFileReport {
  const parsed = parseRuleFile(file.content);
  const errors: string[] = [];
  const warnings: string[] = [];

  if (file.content.length > limits.maxFileChars) {
    errors.push(`too large: ${file.content.length} characters (limit ${limits.maxFileChars})`);
  }
  if (parsed.error) errors.push(parsed.error);
  const badGlobs = parsed.globs.flatMap(g => {
    const problem = globProblem(g);
    return problem ? [`invalid glob "${g}": ${problem}`] : [];
  });
  errors.push(...badGlobs);
  if (!parsed.body) warnings.push('empty rule body');

  const global =
    file.path === ALWAYS_GLOBAL_RULE_FILE ||
    parsed.globs.length === 0 ||
    (parsed.globs.length === 1 && parsed.globs[0] === '*');
  const usable = parsed.globs.filter(g => !globProblem(g));
  const matches = global ? repoFiles.length : repoFiles.filter(p => matchesAny(p, usable)).length;
  if (!global && matches === 0 && badGlobs.length === 0) warnings.push('globs match no files in the repository');

  return {
    path: file.path,
    chars: file.content.length,
    tokens: parsed.body ? count(parsed.body) : 0,
    globs: global ? [] : parsed.globs,
    global,
    matches,
    errors,
    warnings,
  };
}

export function formatVerifyReport(report: VerifyReport): string {
  const lines: string[] = [];
  for (const f of report.files) {
    const scope = f.global ? 'global' : f.globs.join(', ');
    lines.push(`${f.path}`);
    lines.push(`  scope: ${scope}`);
    lines.push(`  size: ${f.chars} chars, ~${f.tokens} tokens, applies to ${f.matches} file(s)`);
    for (const e of f.errors) lines.push(`  error: ${e}`);
    for (const w of f.warnings) lines.push(`  warning: ${w}`);
  }
  const t = report.totals;
  if (lines.length) lines.push('');
  lines.push(`Total: ${t.chars}/${t.maxTotalChars} chars, ~${t.tokens} tokens`);
  lines.push(`Global rules add ~${t.globalTokens} tokens to every review call`);
  if (t.scopedTokensMax > 0) lines.push(`Scoped rules add ~${t.scopedTokensMin}-${t.scopedTokensMax} tokens per file`);
  lines.push(`Worst-case overhead: ${t.budgetPercent.toFixed(1)}% of the ${t.budgetTokens}-token review budget`);
  for (const w of report.warnings) lines.push(`warning: ${w}`);
  const verdict =
    report.status === 'errors'
      ? 'Status: errors found - fix them before relying on these rules'
      : report.status === 'warnings'
        ? 'Status: valid, with warnings'
        : 'Status: all rules valid';
  lines.push(verdict);
  return lines.join('\n');
}

export interface RuleSuggestion {
  type: 'redundancy' | 'gap' | 'glob' | 'clarity';
  message: string;
}

const SuggestionsSchema = z.object({
  suggestions: z.array(
    z.object({
      type: z.enum(['redundancy', 'gap', 'glob', 'clarity']),
      message: z.string().min(1),
    }),
  ),
});

/**
 * Asks a model for improvements based on rule metadata (not rule text) and a sample of
 * repository paths. Returns [] when the model is unavailable or answers badly.
 */
export async function suggestRuleImprovements(
  deps: StageDeps,
  report: VerifyReport,
  repoFiles: string[],
  options: { stage?: Stage; maxPaths?: number } = {},
): Promise<RuleSuggestion[]> {
  const stage = options.stage ?? 'docs';
  const sample = repoFiles.slice(0, options.maxPaths ?? 200);
  const metadata = report.files.map(f => ({
    path: f.path,
    scope: f.global ? 'global' : f.globs,
    tokens: f.tokens,
    matchingFiles: f.matches,
    problems: [...f.errors, ...f.warnings],
  }));
  const prompt = [
    'A repository keeps code review rules in markdown files. Each rule file applies to every file (global)',
    'or only to paths matching its globs. Below is metadata about each rule file and a sample of repository paths.',
    '',
    'Suggest concrete improvements. Use these types:',
    '- redundancy: rule files whose scopes overlap so much they could be merged',
    '- gap: important areas of the repository that no rule covers',
    '- glob: globs that look wrong, too broad, or too narrow for the paths shown',
    '- clarity: rule files whose size or scope suggests they should be split or tightened',
    'Return at most 8 suggestions; return none if the setup already looks sound.',
    '',
    '## Rule files',
    JSON.stringify(metadata, null, 2),
    '',
    `## Repository paths (${sample.length} of ${repoFiles.length})`,
    sample.join('\n'),
  ].join('\n');

  try {
    const result = await deps.llm.generateObject(stage, prompt, SuggestionsSchema);
    deps.cost.record(stage, result.model, result.usage);
    return result.object.suggestions;
  } catch (error) {
    deps.log(`rule suggestions unavailable: ${(error as Error).message}`);
    return [];
  }
}
