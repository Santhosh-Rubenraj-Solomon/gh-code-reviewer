import { z } from 'zod';
import type { AspectStatus, Persona } from '../personas';
import { renderPresentation } from '../render/presentation';
import type {
  ChangedFile,
  Consolidated,
  FileReview,
  Finding,
  ImpactResult,
  Presentation,
  PresentationIssue,
  Severity,
} from '../types';
import { SEVERITY_ORDER } from '../types';
import { truncate, type StageDeps } from './deps';

export interface PresentationInput {
  title: string;
  consolidated: Consolidated;
  fileReviews: FileReview[];
  /** Verified findings. */
  findings: Finding[];
  files: Map<string, ChangedFile>;
  impact?: ImpactResult;
}

export interface PresentationOptions {
  /** Attempts at a speculation-free presentation before settling for the best one. */
  maxAttempts?: number;
}

export interface SourceIssue {
  id: string;
  finding: Finding;
}

// ---- ids ---------------------------------------------------------------------

const POSITIVE_CATEGORY = /^(note|notes|positive|praise|kudos|info)$/i;
const POSITIVE_TITLE = /^(good|nice|great|well[- ]done|correct(ly)?|proper(ly)?|clean|solid)\b/i;

/** Praise and informational notes are not issues and get no id. */
export function isPositiveFinding(f: Finding): boolean {
  return POSITIVE_CATEGORY.test(f.category.trim()) || POSITIVE_TITLE.test(f.title.trim());
}

export function assignIssueIds(findings: Finding[]): SourceIssue[] {
  return findings.filter(f => !isPositiveFinding(f)).map((finding, i) => ({ id: `ISSUE-${i + 1}`, finding }));
}

// ---- model output ------------------------------------------------------------

const STATUSES = ['clean', 'warning', 'issue', 'critical'] as const;

export const PresentationOutputSchema = z.object({
  intro: z.string(),
  aspects: z.array(z.object({ name: z.string(), status: z.enum(STATUSES), note: z.string() })),
  issues: z.array(
    z.object({
      sourceId: z.string(),
      title: z.string(),
      description: z.string(),
      fix: z.string().optional(),
    }),
  ),
  files: z.array(z.object({ path: z.string(), description: z.string() })),
  verdict: z.string(),
});
export type PresentationOutput = z.infer<typeof PresentationOutputSchema>;

const FixVerdictSchema = z.object({ verdicts: z.array(z.boolean()) });

// ---- prompt ------------------------------------------------------------------

export function buildPresentationPrompt(
  persona: Persona,
  input: PresentationInput,
  sources: SourceIssue[],
  correction?: string,
): string {
  const c = input.consolidated;
  const issueBlocks = sources.map(({ id, finding: f }) =>
    [
      `[${id}] ${f.severity} ${f.category} in ${f.file}${f.line ? `:${f.line}` : ''}: ${f.title}`,
      `Explanation: ${f.explanation}`,
      f.impact ? `Impact: ${f.impact}` : '',
      `Evidence:\n${truncate(f.evidence, 1_500)}`,
      f.suggestion ? `Suggested fix: ${f.suggestion}` : 'Suggested fix: none given',
    ]
      .filter(Boolean)
      .join('\n'),
  );
  const fileLines = input.fileReviews.map(r => `- ${r.path} (${r.status}): ${r.whatChanged || 'no summary'}`);
  const recs = c.recommendations.map(r => `- [${r.priority}] ${r.text}`);
  const security = c.securityConcerns.map(s => `- [${s.severity}] ${s.category}: ${s.description}`);

  return [
    `You are presenting a finished code review as "${persona.name}".`,
    `Voice: ${persona.voice}`,
    '',
    `Pull request: ${input.title}`,
    `Overview: ${c.overview}`,
    `Merge risk: ${c.risk}`,
    input.impact ? `Blast radius: ${input.impact.blastRadius.level} — ${input.impact.blastRadius.description}` : '',
    '',
    '## Verified issues',
    issueBlocks.length ? issueBlocks.join('\n\n') : 'none',
    '',
    '## Security concerns',
    security.length ? security.join('\n') : 'none',
    '',
    '## Recommendations',
    recs.length ? recs.join('\n') : 'none',
    '',
    '## Files',
    ...(fileLines.length ? fileLines : ['none']),
    '',
    '## What to write',
    '- `intro`: two to four sentences opening the review in the voice above.',
    '- `aspects`: 3-5 rows such as Correctness, Security, Performance, Maintainability, Tests, each with a status',
    '  (clean, warning, issue, critical) that matches the verified issues, and a short note.',
    '- `issues`: one entry per verified issue, with `sourceId` set to its [ISSUE-n] id, a short `title` and a',
    '  `description` in the voice. Do not invent issues, merge them, or change what they claim.',
    '  Add `fix` (code only) only when the issue says "Suggested fix: none given".',
    '- `files`: one short description per file listed above.',
    '- `verdict`: one or two sentences on whether to merge.',
    '',
    'Rules: state facts only. Never use could, might, maybe, possibly, perhaps, should or would; never write',
    '"if the/this/that/you/they ..." hypotheticals or "make sure", "ensure that", "remember to". Use direct',
    'statements ("X fails when Y", "Change X to Y"). The voice changes the wording, never the technical content.',
    correction ? `\nCorrection: ${correction}` : '',
  ].join('\n');
}

// ---- deterministic checks ----------------------------------------------------

const AFFIRMATIVE =
  /\b(is|are|looks|seems)\s+(correct|fine|safe|ok|okay|good|secure|valid)\b|\bno (issue|problem|bug|vulnerabilit)|\bworks (as intended|correctly)|\b(properly|correctly) (handles?|validates?|escapes?|sanitizes?)/i;
const CAVEAT = /\b(but|however|although|though|except|yet|unless|still|while|whereas|missing|not)\b/i;

/** A serious bug/security issue whose own description says the code is fine is the model talking itself out of it. */
export function isContradictory(issue: PresentationIssue): boolean {
  const serious = issue.severity === 'critical' || issue.severity === 'high';
  const kind = /bug|secur/i.test(issue.type);
  return serious && kind && AFFIRMATIVE.test(issue.description) && !CAVEAT.test(issue.description);
}

const KEYWORDS = new Set(
  (
    'const let var function return if else for while do switch case break continue new this class extends import ' +
    'export from default async await try catch finally throw typeof instanceof void null undefined true false ' +
    'public private protected static readonly interface type enum implements of in as is def self none elif ' +
    'lambda pass yield with fn pub mut impl struct use mod func package defer nil string number boolean any ' +
    'unknown never and or not the get set'
  ).split(' '),
);
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;

export function significantIdentifiers(text: string): string[] {
  return [...new Set(text.match(IDENTIFIER) ?? [])].filter(t => t.length > 2 && !KEYWORDS.has(t.toLowerCase()));
}

function identifierSet(files: ChangedFile[]): Set<string> {
  const set = new Set<string>();
  for (const f of files) for (const t of `${f.patch}\n${f.content ?? ''}`.match(IDENTIFIER) ?? []) set.add(t);
  return set;
}

/** At least half of the text's significant identifiers must exist in the code; text without any passes. */
export function groundedIn(text: string, known: Set<string>, threshold = 0.5): boolean {
  const ids = significantIdentifiers(text);
  if (ids.length === 0) return true;
  return ids.filter(id => known.has(id)).length / ids.length >= threshold;
}

/** Checks the affected files first, then every changed file (code is often moved between files). */
export function isGrounded(text: string, affected: string[], files: Map<string, ChangedFile>): boolean {
  const own = affected.map(p => files.get(p)).filter((f): f is ChangedFile => Boolean(f));
  if (own.length && groundedIn(text, identifierSet(own))) return true;
  return groundedIn(text, identifierSet([...files.values()]));
}

const SPECULATION = [
  /\b(could|might|maybe|possibly|perhaps|should|would)\b/gi,
  /\bif (the|this|that|you|they)\b/gi,
  /\b(make sure|ensure that|remember to)\b/gi,
];

/** Counts hedging phrases in prose; code blocks and inline code are ignored because code is quoted verbatim. */
export function countSpeculation(markdown: string): { count: number; phrases: string[] } {
  const prose = markdown.replace(/(`{3,})[\s\S]*?\1/g, ' ').replace(/`[^`\n]*`/g, ' ');
  const found: string[] = [];
  for (const pattern of SPECULATION) for (const m of prose.matchAll(pattern)) found.push(m[0].toLowerCase());
  return { count: found.length, phrases: [...new Set(found)] };
}

// ---- assembly ----------------------------------------------------------------

const worst = (severities: Severity[]): Severity | undefined =>
  [...severities].sort((a, b) => SEVERITY_ORDER.indexOf(a) - SEVERITY_ORDER.indexOf(b))[0];

export function statusFor(severity: Severity | undefined): AspectStatus {
  if (!severity) return 'clean';
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'issue';
  return 'warning';
}

function filesTableFor(
  input: PresentationInput,
  issues: PresentationIssue[],
  descriptions: Map<string, string>,
): Pick<Presentation, 'filesTable' | 'cleanFiles'> {
  const paths = [...new Set([...input.fileReviews.map(r => r.path), ...issues.flatMap(i => i.files)])];
  const reviews = new Map(input.fileReviews.map(r => [r.path, r]));
  const filesTable = paths.map(path => {
    const severity = worst(issues.filter(i => i.files.includes(path)).map(i => i.severity));
    const level = input.impact?.files[path];
    const impact =
      level && level.level !== 'none' ? `${level.level} · ${level.impacted.length} dependent file(s)` : undefined;
    const description = descriptions.get(path)?.trim() || reviews.get(path)?.whatChanged.trim() || '—';
    return { path, status: statusFor(severity), description, ...(impact ? { impact } : {}) };
  });
  const cleanFiles = filesTable
    .filter(row => row.status === 'clean' && (reviews.get(row.path)?.status ?? 'ok') === 'ok')
    .map(row => row.path);
  return { filesTable, cleanFiles };
}

const ASPECT_GROUPS: { name: string; match: RegExp }[] = [
  { name: 'Correctness', match: /bug|edge|logic|correct/i },
  { name: 'Security', match: /secur/i },
  { name: 'Performance', match: /perf/i },
  { name: 'Maintainability', match: /maint|architect|style|improve|quality/i },
];

function deterministicAspects(issues: PresentationIssue[]): Presentation['aspects'] {
  return ASPECT_GROUPS.map(({ name, match }) => {
    const hits = issues.filter(i => match.test(i.type));
    const status = statusFor(worst(hits.map(i => i.severity)));
    return { name, status, note: hits.length ? `${hits.length} verified issue(s).` : 'No verified issues.' };
  });
}

function sourceIssue({ id, finding: f }: SourceIssue): PresentationIssue {
  return {
    id,
    title: f.title,
    sourceTitle: f.title,
    severity: f.severity,
    type: f.category,
    description: f.explanation,
    files: [f.file],
    evidence: f.evidence || undefined,
    fix: f.suggestion?.trim() || undefined,
  };
}

const VERDICT_BY_RISK: Record<Consolidated['risk'], string> = {
  high: 'Not ready to merge: the high-severity issues above need fixing first.',
  medium: 'Mergeable after the issues above are addressed.',
  low: 'Ready to merge.',
};

/** Turns raw model output into a presentation the model cannot use to change technical content. */
export function assemblePresentation(
  persona: Persona,
  input: PresentationInput,
  sources: SourceIssue[],
  raw: PresentationOutput,
  log: (message: string) => void = () => {},
): Presentation {
  const byId = new Map(sources.map(s => [s.id, s]));
  const written = new Map<string, PresentationIssue>();

  for (const item of raw.issues) {
    const source = byId.get(item.sourceId.trim().toUpperCase());
    if (!source || written.has(source.id)) continue;
    const base = sourceIssue(source);
    const issue: PresentationIssue = {
      ...base,
      title: item.title.trim() || base.title,
      description: item.description.trim() || base.description,
    };
    // The model may only propose a fix where the review had none, and it must refer to real code.
    const proposed = item.fix?.trim();
    if (!issue.fix && proposed) {
      if (isGrounded(proposed, issue.files, input.files)) issue.fix = proposed;
      else log(`${issue.id}: proposed fix does not refer to the changed code, dropped`);
    }
    written.set(source.id, issue);
  }

  // Every verified issue appears, even ones the model skipped; ids keep their original order.
  const issues = sources
    .map(s => written.get(s.id) ?? sourceIssue(s))
    .map(issue => {
      if (!issue.evidence || isGrounded(issue.evidence, issue.files, input.files)) return issue;
      log(`${issue.id}: evidence not found in the code, dropped`);
      return { ...issue, evidence: undefined };
    })
    .filter(issue => {
      if (!isContradictory(issue)) return true;
      log(`${issue.id}: description contradicts its severity, dropped`);
      return false;
    });

  const aspects = raw.aspects
    .filter(a => a.name.trim())
    .map(a => ({ name: a.name.trim(), status: a.status, note: a.note.trim() }));
  const descriptions = new Map(raw.files.map(f => [f.path.trim(), f.description]));

  return {
    persona: persona.key,
    intro: raw.intro.trim() || input.consolidated.overview,
    aspects: aspects.length ? aspects : deterministicAspects(issues),
    issues,
    ...filesTableFor(input, issues, descriptions),
    verdict: raw.verdict.trim() || VERDICT_BY_RISK[input.consolidated.risk],
  };
}

/** No model involved: used when every presentation attempt failed. */
export function basicPresentation(persona: Persona, input: PresentationInput): Presentation {
  const issues = assignIssueIds(input.findings).map(sourceIssue);
  return {
    persona: persona.key,
    intro: input.consolidated.overview || `${input.title}: ${issues.length} verified issue(s).`,
    aspects: deterministicAspects(issues),
    issues,
    ...filesTableFor(input, issues, new Map()),
    verdict: VERDICT_BY_RISK[input.consolidated.risk],
  };
}

export const FIX_BATCH_SIZE = 15;

/** Asks the validate stage whether each fix is correct; bad answers or errors keep the fixes. */
export async function checkFixQuality(deps: StageDeps, issues: PresentationIssue[]): Promise<PresentationIssue[]> {
  const withFix = issues.filter(i => i.fix);
  const rejected = new Set<string>();
  for (let start = 0; start < withFix.length; start += FIX_BATCH_SIZE) {
    const batch = withFix.slice(start, start + FIX_BATCH_SIZE);
    const prompt = [
      'For each proposed fix below, answer true when it correctly resolves the stated issue without breaking the',
      'surrounding code, and false when it is wrong, incomplete, unrelated or unsafe.',
      `Return \`verdicts\`: exactly ${batch.length} booleans, in order.`,
      '',
      ...batch.map((issue, i) =>
        [
          `[FIX-${i}] ${issue.title} (${issue.files.join(', ')})`,
          `Issue: ${truncate(issue.description, 800)}`,
          issue.evidence ? `Code:\n${truncate(issue.evidence, 1_500)}` : '',
          `Proposed fix:\n${truncate(issue.fix!, 1_500)}`,
          '',
        ]
          .filter(Boolean)
          .join('\n'),
      ),
    ].join('\n');
    try {
      const result = await deps.llm.generateObject('validate', prompt, FixVerdictSchema);
      deps.cost.record('validate', result.model, result.usage);
      if (result.object.verdicts.length !== batch.length) {
        deps.log(`fix check returned ${result.object.verdicts.length} answers for ${batch.length} fixes; keeping them`);
        continue;
      }
      batch.forEach((issue, i) => {
        if (result.object.verdicts[i] === false) rejected.add(issue.id);
      });
    } catch (error) {
      deps.log(`fix check failed, keeping fixes: ${(error as Error).message}`);
    }
  }
  return issues.map(i => (rejected.has(i.id) ? { ...i, fix: undefined } : i));
}

// ---- stage -------------------------------------------------------------------

/**
 * Writes the review in the persona's voice. The model only supplies wording; ids, severities,
 * evidence and the file list are filled in from verified data. Retries while the prose hedges,
 * keeps the attempt with the fewest hedges, and falls back to a model-free presentation.
 */
export async function buildPresentation(
  deps: StageDeps,
  persona: Persona,
  input: PresentationInput,
  options: PresentationOptions = {},
): Promise<Presentation> {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const sources = assignIssueIds(input.findings);
  let best: { presentation: Presentation; violations: number } | undefined;
  let correction: string | undefined;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    let presentation: Presentation;
    try {
      const result = await deps.llm.generateObject(
        'persona',
        buildPresentationPrompt(persona, input, sources, correction),
        PresentationOutputSchema,
      );
      deps.cost.record('persona', result.model, result.usage);
      presentation = assemblePresentation(persona, input, sources, result.object, deps.log);
    } catch (error) {
      deps.log(`presentation attempt ${attempt} failed: ${(error as Error).message}`);
      continue;
    }

    const { count, phrases } = countSpeculation(renderPresentation(presentation, persona, { impact: input.impact }));
    if (!best || count < best.violations) best = { presentation, violations: count };
    if (count === 0) break;
    deps.log(`presentation attempt ${attempt} hedged ${count} time(s): ${phrases.join(', ')}`);
    correction =
      `The previous attempt used speculative wording (${phrases.join(', ')}). ` +
      'Rewrite every sentence as a direct statement of fact.';
  }

  if (!best) {
    deps.log('presentation failed, using a plain one built from the findings');
    return basicPresentation(persona, input);
  }
  return { ...best.presentation, issues: await checkFixQuality(deps, best.presentation.issues) };
}
