import { z } from 'zod';
import { annotatePatch } from '../diff';
import type {
  ChangedFile,
  Consolidated,
  Evidence,
  FileReview,
  Recommendation,
  SecurityConcern,
  TestRequirement,
  ValidationRemovals,
} from '../types';
import { estimateTokens } from '../utils/tokens';
import { snippetAppears } from './critic';
import { truncate, type StageDeps } from './deps';

export interface ValidateOptions {
  /** Above this many tokens of consolidated JSON, each section is validated in its own call. */
  splitAboveTokens?: number;
  /** Token counter; defaults to the shared estimator. */
  count?: (text: string) => number;
  /** Changed files by path; when present, evidence snippets must appear in the file's diff or content. */
  files?: Map<string, ChangedFile>;
}

export interface ValidationResult {
  consolidated: Consolidated;
  removals: ValidationRemovals;
}

type Section = 'securityConcerns' | 'recommendations' | 'testRequirements';
const SECTIONS: Section[] = ['securityConcerns', 'recommendations', 'testRequirements'];

const VerdictList = z.array(z.object({ index: z.number().int().nonnegative(), keep: z.boolean(), reason: z.string() }));
export const SectionVerdictSchema = z.object({ verdicts: VerdictList });
export const ValidationVerdictSchema = z.object({
  securityConcerns: VerdictList,
  recommendations: VerdictList,
  testRequirements: VerdictList,
});
type Verdict = z.infer<typeof VerdictList>[number];

const emptyRemovals = (): ValidationRemovals => ({ securityConcerns: [], recommendations: [], testRequirements: [] });

// ---- deterministic pre-check -------------------------------------------------

const PLACEHOLDER_PATH = /(^|\/)path\/to\/|^(file|filename|example|your[-_]?file)\.\w+$|<[^>]+>|\.\.\.|^n\/?a$|^unknown$/i;

/** Why an evidence reference cannot be trusted, or null when it checks out. */
export function evidenceProblem(
  evidence: Evidence | undefined,
  reviewed: Set<string>,
  files?: Map<string, ChangedFile>,
): string | null {
  const path = evidence?.file?.trim() ?? '';
  const snippet = evidence?.snippet?.trim() ?? '';
  if (!path) return 'no evidence file';
  if (PLACEHOLDER_PATH.test(path)) return `placeholder evidence path "${path}"`;
  if (!reviewed.has(path)) return `evidence file ${path} is not one of the reviewed files`;
  if (!snippet) return 'no evidence code';
  const file = files?.get(path);
  if (file && (file.patch || file.content) && !snippetAppears(snippet, file)) {
    return `evidence code does not appear in ${path}`;
  }
  return null;
}

interface Item {
  evidence: Evidence;
}

function precheck<T extends Item>(
  items: T[],
  reviewed: Set<string>,
  files: Map<string, ChangedFile> | undefined,
): { passed: T[]; removed: { item: T; reason: string }[] } {
  const passed: T[] = [];
  const removed: { item: T; reason: string }[] = [];
  for (const item of items) {
    const problem = evidenceProblem(item.evidence, reviewed, files);
    if (problem) removed.push({ item, reason: problem });
    else passed.push(item);
  }
  return { passed, removed };
}

// ---- prompt ------------------------------------------------------------------

const where = (e: Evidence) => `${e.file}${e.line ? `:${e.line}` : ''}`;

function listSection(section: Section, items: (SecurityConcern | Recommendation | TestRequirement)[]): string {
  const lines = items.map((item, i) => {
    const head =
      section === 'securityConcerns'
        ? `${(item as SecurityConcern).severity} ${(item as SecurityConcern).category}: ${(item as SecurityConcern).description}`
        : section === 'recommendations'
          ? `${(item as Recommendation).priority}: ${(item as Recommendation).text}`
          : `${(item as TestRequirement).kind}: ${(item as TestRequirement).description} (why: ${(item as TestRequirement).rationale})`;
    return `[${i}] ${head}\n    evidence ${where(item.evidence)}: ${item.evidence.snippet.replace(/\n/g, '\n    ')}`;
  });
  return lines.join('\n');
}

const SECTION_TITLES: Record<Section, string> = {
  securityConcerns: 'Security concerns',
  recommendations: 'Recommendations',
  testRequirements: 'Test requirements',
};

function contextFor(items: Item[], files?: Map<string, ChangedFile>): string {
  if (!files) return '';
  const paths = [...new Set(items.map(i => i.evidence.file))];
  const blocks = paths
    .map(p => files.get(p))
    .filter((f): f is ChangedFile => Boolean(f?.patch))
    .map(f => `### ${f.path}\n\`\`\`diff\n${truncate(annotatePatch(f.patch), 8_000)}\n\`\`\``);
  return blocks.length ? ['## Diffs the evidence refers to', ...blocks].join('\n\n') : '';
}

const RULES = [
  'Keep an item only when all of these hold:',
  '- its evidence names a real reviewed file and quotes code that actually shows what the item claims;',
  '- it states a concrete fact about this change, not a possibility ("could", "might", "may") or a hypothetical;',
  '- it is specific to this pull request; generic advice that fits any change ("add more tests", "follow best',
  '  practices", "improve error handling") is rejected.',
  'Return one verdict per item: its index, keep true or false, and a one-sentence reason. Never rewrite items.',
].join('\n');

export function buildSectionPrompt(
  section: Section,
  items: Item[],
  reviewedFiles: string[],
  files?: Map<string, ChangedFile>,
): string {
  return [
    `Check these ${SECTION_TITLES[section].toLowerCase()} from a pull request review against the code.`,
    `Reviewed files: ${reviewedFiles.join(', ') || 'none'}`,
    '',
    `## ${SECTION_TITLES[section]}`,
    listSection(section, items as (SecurityConcern | Recommendation | TestRequirement)[]),
    '',
    contextFor(items, files),
    '',
    RULES,
  ].join('\n');
}

export function buildValidationPrompt(
  sections: Record<Section, Item[]>,
  reviewedFiles: string[],
  files?: Map<string, ChangedFile>,
): string {
  const parts = SECTIONS.flatMap(s =>
    sections[s].length
      ? [`## ${SECTION_TITLES[s]} (verdicts go in \`${s}\`)`, listSection(s, sections[s] as never[]), '']
      : [],
  );
  return [
    'Check the security concerns, recommendations and test requirements from a pull request review against the code.',
    `Reviewed files: ${reviewedFiles.join(', ') || 'none'}`,
    '',
    ...parts,
    contextFor(SECTIONS.flatMap(s => sections[s]), files),
    '',
    RULES,
    'Sections with no items get an empty verdict list.',
  ].join('\n');
}

// ---- stage -------------------------------------------------------------------

function applyVerdicts<T>(items: T[], verdicts: Verdict[]): { kept: T[]; removed: { item: T; reason: string }[] } {
  const byIndex = new Map(verdicts.map(v => [v.index, v]));
  const kept: T[] = [];
  const removed: { item: T; reason: string }[] = [];
  items.forEach((item, index) => {
    const verdict = byIndex.get(index);
    if (verdict?.keep) kept.push(item);
    else removed.push({ item, reason: verdict ? verdict.reason : 'the validator did not confirm it' });
  });
  return { kept, removed };
}

/**
 * Evidence gate for the consolidated review. Items whose evidence does not point at real
 * reviewed code are dropped deterministically; the model then judges the rest by index, so
 * it can remove items but never rewrite them. Any failure leaves the input untouched.
 */
export async function validateConsolidated(
  deps: StageDeps,
  consolidated: Consolidated,
  fileReviews: FileReview[],
  options: ValidateOptions = {},
): Promise<ValidationResult> {
  const splitAbove = options.splitAboveTokens ?? 30_000;
  const count = options.count ?? estimateTokens;
  const reviewedFiles = fileReviews.map(r => r.path);
  const reviewed = new Set(reviewedFiles);
  const unchanged = { consolidated, removals: emptyRemovals() };

  const security = precheck(consolidated.securityConcerns, reviewed, options.files);
  const recs = precheck(consolidated.recommendations, reviewed, options.files);
  const tests = precheck(consolidated.testRequirements, reviewed, options.files);
  const survivors = {
    securityConcerns: security.passed,
    recommendations: recs.passed,
    testRequirements: tests.passed,
  };

  let verdicts: Record<Section, Verdict[]>;
  try {
    verdicts = await askModel(deps, survivors, reviewedFiles, options.files, count(JSON.stringify(consolidated)) > splitAbove);
  } catch (error) {
    deps.log(`validation failed, keeping the consolidated review as it was: ${(error as Error).message}`);
    return unchanged;
  }

  const s = applyVerdicts(survivors.securityConcerns, verdicts.securityConcerns);
  const r = applyVerdicts(survivors.recommendations, verdicts.recommendations);
  const t = applyVerdicts(survivors.testRequirements, verdicts.testRequirements);
  const removals: ValidationRemovals = {
    securityConcerns: [...security.removed, ...s.removed],
    recommendations: [...recs.removed, ...r.removed],
    testRequirements: [...tests.removed, ...t.removed],
  };
  const removedCount = SECTIONS.reduce((n, k) => n + removals[k].length, 0);
  deps.log(`validation: removed ${removedCount} unsupported item(s)`);
  return {
    consolidated: { ...consolidated, securityConcerns: s.kept, recommendations: r.kept, testRequirements: t.kept },
    removals,
  };
}

async function askModel(
  deps: StageDeps,
  survivors: Record<Section, Item[]>,
  reviewedFiles: string[],
  files: Map<string, ChangedFile> | undefined,
  split: boolean,
): Promise<Record<Section, Verdict[]>> {
  const none: Record<Section, Verdict[]> = { securityConcerns: [], recommendations: [], testRequirements: [] };
  if (SECTIONS.every(s => survivors[s].length === 0)) return none;

  if (!split) {
    const result = await deps.llm.generateObject(
      'validate',
      buildValidationPrompt(survivors, reviewedFiles, files),
      ValidationVerdictSchema,
    );
    deps.cost.record('validate', result.model, result.usage);
    return result.object;
  }

  // Large reviews: one smaller call per non-empty section, in parallel.
  const answers = await Promise.all(
    SECTIONS.map(async section => {
      if (survivors[section].length === 0) return [section, []] as const;
      const result = await deps.llm.generateObject(
        'validate',
        buildSectionPrompt(section, survivors[section], reviewedFiles, files),
        SectionVerdictSchema,
      );
      deps.cost.record('validate', result.model, result.usage);
      return [section, result.object.verdicts] as const;
    }),
  );
  for (const [section, list] of answers) none[section] = [...list];
  return none;
}
