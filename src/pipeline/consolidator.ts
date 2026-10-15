import { z } from 'zod';
import {
  SECURITY_CATEGORIES,
  type ChangeSet,
  type Consolidated,
  type FileReview,
  type Finding,
  type Recommendation,
  type Risk,
  type SecurityConcern,
  type TestRequirement,
} from '../types';
import { truncate, type StageDeps } from './deps';

/** The subset of `Consolidated` older callers relied on. */
export interface Overview {
  overview: string;
  risk: Risk;
  highlights: string[];
}

export interface ConsolidateInput {
  fileReviews: FileReview[];
  /** Verified findings (after the critic). */
  findings: Finding[];
  summaries: Record<string, string>;
  docsSummary?: string;
  impactSummary?: string;
  globalRules?: string;
}

export const MAX_RECOMMENDATIONS = 5;
const MAX_HIGHLIGHTS = 4;

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export function riskFromFindings(findings: Finding[]): Risk {
  if (findings.some(f => f.severity === 'critical' || f.severity === 'high')) return 'high';
  if (findings.some(f => f.severity === 'medium')) return 'medium';
  return 'low';
}

export function maxRisk(a: Risk, b: Risk): Risk {
  return RISK_RANK[a] >= RISK_RANK[b] ? a : b;
}

// ---- model output schema ---------------------------------------------------

const EvidenceSchema = z.object({
  file: z.string(),
  snippet: z.string(),
  line: z.number().int().positive().optional(),
});
const Severity = z.enum(['critical', 'high', 'medium', 'low']);
const Priority = z.enum(['high', 'medium', 'low']);
const TestSchema = z.object({ description: z.string(), rationale: z.string(), evidence: EvidenceSchema });

export const ConsolidatedSchema = z.object({
  overview: z.string(),
  risk: z.enum(['low', 'medium', 'high']),
  highlights: z.array(z.string()),
  architectureChanges: z.array(z.string()),
  securityConcerns: z.array(
    z.object({
      description: z.string(),
      severity: Severity,
      category: z.enum(SECURITY_CATEGORIES),
      affectedFiles: z.array(z.string()),
      remediation: z.string(),
      evidence: EvidenceSchema,
    }),
  ),
  securityChecklist: z.object({
    impactsSecurity: z.boolean(),
    cryptographicChange: z.boolean(),
    secureChannelModified: z.boolean(),
    dataManagementChange: z.boolean(),
    otherSecurityImpact: z.boolean(),
  }),
  recommendations: z.array(z.object({ text: z.string(), priority: Priority, evidence: EvidenceSchema })),
  functionality: z.object({ isComplete: z.boolean(), missing: z.array(z.string()), explanation: z.string() }),
  unitTests: z.array(TestSchema),
  e2eTests: z.array(TestSchema),
  codeQuality: z.object({ patterns: z.string(), complexity: z.string(), maintainability: z.string() }),
  dependencies: z.object({ added: z.string(), impact: z.string(), security: z.string() }),
  performance: z.object({ bottlenecks: z.string(), resources: z.string(), scalability: z.string() }),
  limitations: z.array(z.string()),
  completeness: z.enum(['complete', 'partial', 'limited']),
});
export type ConsolidatedOutput = z.infer<typeof ConsolidatedSchema>;

// ---- prompt ------------------------------------------------------------------

function compactFileReviews(fileReviews: FileReview[]): string {
  const compact = fileReviews.map(r => ({
    path: r.path,
    status: r.status,
    whatChanged: r.whatChanged,
    findings: r.findings.map(f => ({
      severity: f.severity,
      category: f.category,
      line: f.line,
      title: f.title,
      explanation: f.explanation,
      evidence: f.evidence,
      suggestion: f.suggestion,
    })),
    positives: r.positives,
    testingRecommendations: r.testingRecommendations,
    ...(r.error ? { error: r.error } : {}),
  }));
  return truncate(JSON.stringify(compact, null, 1), 120_000);
}

export function buildConsolidationPrompt(changeSet: ChangeSet, input: ConsolidateInput): string {
  const fileLines = changeSet.files.map(
    f => `- ${f.path} (${f.status})${input.summaries[f.path] ? `: ${input.summaries[f.path]}` : ''}`,
  );
  const findingLines = input.findings.length
    ? input.findings.map(f => `- [${f.severity}] ${f.category} ${f.file}${f.line ? `:${f.line}` : ''} ${f.title}`)
    : ['- none'];
  const section = (heading: string, body: string | undefined, max: number) =>
    body?.trim() ? [`## ${heading}`, truncate(body.trim(), max), ''] : [];

  return [
    `Pull request: ${changeSet.title}`,
    changeSet.description ? `Description:\n${truncate(changeSet.description, 3_000)}` : '',
    '',
    ...section('Project documentation (summary)', input.docsSummary, 6_000),
    ...section('Impact analysis', input.impactSummary, 6_000),
    ...section('Team rules that apply to the whole repository', input.globalRules, 6_000),
    '## Changed files',
    ...fileLines,
    '',
    '## Findings that survived verification',
    ...findingLines,
    '',
    '## Per-file reviews (JSON)',
    compactFileReviews(input.fileReviews),
    '',
    '## What to produce',
    'Merge the per-file reviews into one review of the whole pull request.',
    '- `overview`: 3-6 sentences on what the change does and its overall quality.',
    '- `risk`: low, medium or high for merging as-is. `highlights`: up to 4 things to look at first.',
    '- `architectureChanges`: structural changes actually visible in the diffs (new modules, changed boundaries).',
    '- `securityConcerns`: only problems shown by the code, each with a category, the affected files, a remediation',
    '  and `evidence` naming a reviewed file and quoting its code exactly.',
    '- `securityChecklist`: answer each of the five questions from what the diff shows.',
    `- \`recommendations\`: at most ${MAX_RECOMMENDATIONS}, ordered by priority, each tied to quoted code.`,
    '- `functionality`: is the change complete for what the title and description promise? List what is missing.',
    '- `unitTests` / `e2eTests`: tests this change needs, each with a rationale and the code that needs covering.',
    '- `codeQuality`, `dependencies`, `performance`: one or two factual sentences each; "No change" is fine.',
    '- `limitations`: what you could not judge (for example files whose review failed).',
    '- `completeness`: complete, partial (some file reviews failed or were cut) or limited (little to go on).',
    '',
    'Rules:',
    '- Use only what the reviews and diffs show. Every evidence `snippet` must be copied from a listed file.',
    '- State facts. Do not use speculative wording such as "could", "might", "may", "possibly" or "consider".',
    '- No generic advice that would apply to any pull request. Empty arrays are better than filler.',
  ].join('\n');
}

// ---- normalisation -----------------------------------------------------------

const nonEmpty = (s: string) => s.trim().length > 0;
const trimmed = (items: string[]) => items.map(s => s.trim()).filter(nonEmpty);

function toConsolidated(raw: ConsolidatedOutput, floor: Risk): Consolidated {
  const tests: TestRequirement[] = [
    ...raw.unitTests.map(t => ({ kind: 'unit' as const, ...t })),
    ...raw.e2eTests.map(t => ({ kind: 'e2e' as const, ...t })),
  ].filter(t => nonEmpty(t.description));
  return {
    overview: raw.overview.trim(),
    risk: maxRisk(raw.risk, floor),
    highlights: trimmed(raw.highlights).slice(0, MAX_HIGHLIGHTS),
    architectureChanges: trimmed(raw.architectureChanges),
    securityConcerns: raw.securityConcerns.filter(c => nonEmpty(c.description)),
    securityChecklist: raw.securityChecklist,
    recommendations: raw.recommendations.filter(r => nonEmpty(r.text)).slice(0, MAX_RECOMMENDATIONS),
    functionality: { ...raw.functionality, missing: trimmed(raw.functionality.missing) },
    testRequirements: tests,
    codeQuality: raw.codeQuality,
    dependencies: raw.dependencies,
    performance: raw.performance,
    limitations: trimmed(raw.limitations),
    completeness: raw.completeness,
  };
}

export function completenessOf(fileReviews: FileReview[]): Consolidated['completeness'] {
  if (fileReviews.length === 0) return 'limited';
  const failed = fileReviews.filter(r => r.status !== 'ok').length;
  if (failed === fileReviews.length) return 'limited';
  return failed > 0 ? 'partial' : 'complete';
}

const isSecurityFinding = (f: Finding) => /secur|vuln|inject|xss|csrf|auth|secret/i.test(f.category);

function securityCategoryOf(f: Finding): SecurityConcern['category'] {
  const text = `${f.title} ${f.explanation}`.toLowerCase();
  if (/secret|token|password|credential|api key/.test(text)) return 'secrets';
  if (/inject|taint|unsanitis|unsanitiz|untrusted|user input/.test(text)) return 'taint';
  if (/dependenc|\bcve\b|package/.test(text)) return 'dependency';
  if (/xss|csrf|ssrf|traversal|deserial/.test(text)) return 'common-vulnerability';
  return 'general';
}

const evidenceOf = (f: Finding) => ({ file: f.file, snippet: f.evidence, ...(f.line ? { line: f.line } : {}) });
const priorityOf = (f: Finding): Recommendation['priority'] =>
  f.severity === 'critical' || f.severity === 'high' ? 'high' : f.severity === 'medium' ? 'medium' : 'low';

/** Built only from data we already trust, so the review can still be published when the model fails. */
export function fallbackConsolidated(changeSet: ChangeSet, input: ConsolidateInput): Consolidated {
  const { findings, fileReviews } = input;
  const security = findings.filter(isSecurityFinding);
  const failed = fileReviews.filter(r => r.status !== 'ok');
  const changed = fileReviews
    .filter(r => r.status === 'ok' && nonEmpty(r.whatChanged))
    .slice(0, 3)
    .map(r => `${r.path}: ${r.whatChanged.trim()}`);

  return {
    overview: [`${changeSet.files.length} file(s) changed; ${findings.length} verified finding(s).`, ...changed].join(
      ' ',
    ),
    risk: riskFromFindings(findings),
    highlights: findings.slice(0, MAX_HIGHLIGHTS).map(f => f.title),
    architectureChanges: [],
    securityConcerns: security.map(f => ({
      description: `${f.title}. ${f.explanation}`,
      severity: f.severity,
      category: securityCategoryOf(f),
      affectedFiles: [f.file],
      remediation: f.suggestion?.trim() ?? '',
      evidence: evidenceOf(f),
    })),
    securityChecklist: {
      impactsSecurity: security.length > 0,
      cryptographicChange: false,
      secureChannelModified: false,
      dataManagementChange: false,
      otherSecurityImpact: false,
    },
    recommendations: findings
      .filter(f => f.suggestion?.trim())
      .slice(0, MAX_RECOMMENDATIONS)
      .map(f => ({ text: `${f.title}: ${f.suggestion!.trim()}`, priority: priorityOf(f), evidence: evidenceOf(f) })),
    functionality: {
      isComplete: false,
      missing: [],
      explanation: 'Not assessed: the consolidation step did not produce a result.',
    },
    testRequirements: findings
      .filter(f => f.severity === 'critical' || f.severity === 'high')
      .map(f => ({
        kind: 'unit' as const,
        description: `Add a test that fails while "${f.title}" is present in ${f.file}.`,
        rationale: f.impact?.trim() || f.explanation,
        evidence: evidenceOf(f),
      })),
    codeQuality: { patterns: '', complexity: '', maintainability: '' },
    dependencies: { added: '', impact: '', security: '' },
    performance: { bottlenecks: '', resources: '', scalability: '' },
    limitations: [
      'The overall summary was assembled from the verified findings because the consolidation step failed.',
      ...failed.map(r => `${r.path} was not fully reviewed (${r.status}${r.error ? `: ${r.error}` : ''}).`),
    ],
    completeness: failed.length === 0 && fileReviews.length > 0 ? 'partial' : 'limited',
  };
}

// ---- stage -------------------------------------------------------------------

/**
 * Asks the model for the whole-PR review, retrying once on an empty or invalid answer.
 * Never throws: the deterministic fallback keeps the review going. Risk is never lower
 * than the verified findings imply.
 */
export async function consolidate(deps: StageDeps, changeSet: ChangeSet, input: ConsolidateInput): Promise<Consolidated>;
/** @deprecated Kept so older callers keep working; pass a `ConsolidateInput` instead. */
export async function consolidate(
  deps: StageDeps,
  changeSet: ChangeSet,
  summaries: Record<string, string>,
  findings: Finding[],
): Promise<Consolidated>;
export async function consolidate(
  deps: StageDeps,
  changeSet: ChangeSet,
  inputOrSummaries: ConsolidateInput | Record<string, string>,
  legacyFindings?: Finding[],
): Promise<Consolidated> {
  const input: ConsolidateInput = Array.isArray(legacyFindings)
    ? { fileReviews: [], findings: legacyFindings, summaries: inputOrSummaries as Record<string, string> }
    : (inputOrSummaries as ConsolidateInput);

  const floor = riskFromFindings(input.findings);
  const prompt = buildConsolidationPrompt(changeSet, input);

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await deps.llm.generateObject('consolidate', prompt, ConsolidatedSchema);
      deps.cost.record('consolidate', result.model, result.usage);
      if (nonEmpty(result.object.overview)) {
        const consolidated = toConsolidated(result.object, floor);
        // The model cannot claim a complete review when some file reviews failed.
        const observed = completenessOf(input.fileReviews);
        if (input.fileReviews.length && observed !== 'complete' && consolidated.completeness === 'complete') {
          consolidated.completeness = observed;
        }
        return consolidated;
      }
      deps.log(`consolidation attempt ${attempt} returned an empty overview`);
    } catch (error) {
      deps.log(`consolidation attempt ${attempt} failed: ${(error as Error).message}`);
    }
  }
  deps.log('consolidation failed twice, building the summary from the findings');
  return fallbackConsolidated(changeSet, input);
}
