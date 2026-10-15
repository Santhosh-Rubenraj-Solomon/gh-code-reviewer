import { SEVERITY_ORDER, type Finding, type PresentationIssue, type ReviewReport, type SecurityConcern, type Severity } from './types';

/** Chat model tiers used by the interactive issue chat (independent of the pipeline's deep/balanced/cheap tiers). */
export type ChatTier = 'basic' | 'standard' | 'advanced';
export const CHAT_TIERS: readonly ChatTier[] = ['basic', 'standard', 'advanced'];

export interface InteractiveIssue {
  id: string;
  title: string;
  severity: Severity;
  type: string;
  files: string[];
  lines: number[];
  description: string;
  evidence?: string;
  suggestedFix?: string;
  chatTier: ChatTier;
}

type Draft = Omit<InteractiveIssue, 'id' | 'chatTier'>;

const LOW_STAKES_TYPES = new Set(['style', 'improvement', 'maintainability']);
const HEAVY_TYPES = new Set(['security', 'architecture']);

/** Picks the first chat tier for an issue: hard problems start on the strongest model, cosmetic ones on the cheapest. */
export function suggestChatTier(issue: Pick<InteractiveIssue, 'type' | 'severity' | 'files'>): ChatTier {
  const type = issue.type.toLowerCase();
  if (HEAVY_TYPES.has(type) || issue.severity === 'critical' || issue.files.length > 2) return 'advanced';
  if (issue.severity === 'low' && LOW_STAKES_TYPES.has(type)) return 'basic';
  return 'standard';
}

function fromFinding(f: Finding): Draft {
  const lines = findingLines(f);
  const description = f.impact ? `${f.explanation}\n\nImpact: ${f.impact}` : f.explanation;
  return {
    title: f.title,
    severity: f.severity,
    type: f.category || 'bug',
    files: [f.file],
    lines: [...new Set(lines)],
    description,
    evidence: f.evidence || undefined,
    suggestedFix: f.suggestion,
  };
}

function shortTitle(text: string, max = 80): string {
  const firstSentence = text.split(/(?<=[.!?])\s/)[0]?.trim() ?? text;
  return firstSentence.length <= max ? firstSentence : `${firstSentence.slice(0, max - 1).trimEnd()}…`;
}

function fromSecurityConcern(c: SecurityConcern): Draft {
  const files = c.affectedFiles.length ? c.affectedFiles : c.evidence.file ? [c.evidence.file] : [];
  return {
    title: shortTitle(c.description),
    severity: c.severity,
    type: 'security',
    files,
    lines: c.evidence.line ? [c.evidence.line] : [],
    description: c.description,
    evidence: c.evidence.snippet || undefined,
    suggestedFix: c.remediation || undefined,
  };
}

function fromPresentation(p: PresentationIssue): Draft {
  return {
    title: p.title,
    severity: p.severity,
    type: p.type || 'bug',
    files: p.files,
    lines: [],
    description: p.description,
    evidence: p.evidence,
    suggestedFix: p.fix,
  };
}

const normText = (text: string | undefined) => (text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
const normTitle = (text: string | undefined) => (text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Line numbers the persona mentions in its prose ("line 12", "lines 12-14", "a.ts:12"). */
function mentionedLines(p: PresentationIssue): number[] {
  const text = `${p.description}\n${p.evidence ?? ''}`;
  const lines: number[] = [];
  for (const m of text.matchAll(/\blines?\s+(\d+)(?:\s*[-–]\s*(\d+))?/gi)) {
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    for (let n = start; n <= Math.min(end, start + 50); n++) lines.push(n);
  }
  for (const file of p.files) {
    for (const m of text.matchAll(new RegExp(`${escapeRegExp(file)}:(\\d+)`, 'g'))) lines.push(Number(m[1]));
  }
  return lines;
}

function findingLines(f: Finding): number[] {
  return [f.line, ...(f.occurrences ?? []).map(o => o.line)].filter((n): n is number => typeof n === 'number');
}

/**
 * The presentation issue a finding was rewritten into: by the recorded source title first; failing that, by the
 * same first file plus the same evidence text or an overlapping line the persona mentions.
 */
function matchPresentation(f: Finding, issues: readonly PresentationIssue[]): number {
  const title = normTitle(f.title);
  const bySource = issues.findIndex(
    p => p.sourceTitle !== undefined && normTitle(p.sourceTitle) === title && (!p.files.length || p.files.includes(f.file)),
  );
  if (bySource !== -1) return bySource;
  const evidence = normText(f.evidence);
  const lines = new Set(findingLines(f));
  return issues.findIndex(p => {
    if (p.sourceTitle !== undefined || p.files[0] !== f.file) return false;
    if (evidence && normText(p.evidence) === evidence) return true;
    return lines.size > 0 && mentionedLines(p).some(n => lines.has(n));
  });
}

/** Persona wording stays; the finding's concrete location, code and fix replace the persona's paraphrase. */
function absorbFinding(kept: Draft, finding: Draft, first: boolean): void {
  kept.lines = [...new Set([...kept.lines, ...finding.lines])];
  if (first) {
    if (finding.evidence) kept.evidence = finding.evidence;
    if (finding.suggestedFix) kept.suggestedFix = finding.suggestedFix;
  } else {
    kept.evidence ??= finding.evidence;
    kept.suggestedFix ??= finding.suggestedFix;
  }
  for (const file of finding.files) if (!kept.files.includes(file)) kept.files.push(file);
  if (SEVERITY_ORDER.indexOf(finding.severity) < SEVERITY_ORDER.indexOf(kept.severity)) kept.severity = finding.severity;
}

export function issueKey(title: string, file: string | undefined): string {
  const norm = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `${norm}|${(file ?? '').toLowerCase()}`;
}

/** Fills gaps in the kept issue with details only the duplicate carries (e.g. line numbers from a raw finding). */
function mergeInto(kept: Draft, dup: Draft): void {
  if (!kept.lines.length && dup.lines.length) kept.lines = dup.lines;
  if (!kept.evidence && dup.evidence) kept.evidence = dup.evidence;
  if (!kept.suggestedFix && dup.suggestedFix) kept.suggestedFix = dup.suggestedFix;
  for (const f of dup.files) if (!kept.files.includes(f)) kept.files.push(f);
  if (SEVERITY_ORDER.indexOf(dup.severity) < SEVERITY_ORDER.indexOf(kept.severity)) kept.severity = dup.severity;
}

/**
 * Flattens a review into the list the issue navigator shows. Persona presentation issues come first because they
 * carry the most polished wording; verified findings and consolidated security concerns fill in the rest.
 */
export function toInteractiveIssues(report: ReviewReport): InteractiveIssue[] {
  const presented = report.presentation?.issues ?? [];
  const presentedDrafts = presented.map(p => ({ ...fromPresentation(p), files: [...p.files] }));
  const absorbed = new Set<number>();
  const unmatched: Draft[] = [];
  for (const finding of report.findings) {
    const index = matchPresentation(finding, presented);
    if (index === -1) {
      unmatched.push(fromFinding(finding));
      continue;
    }
    absorbFinding(presentedDrafts[index]!, fromFinding(finding), !absorbed.has(index));
    absorbed.add(index);
  }

  const drafts: Draft[] = [
    ...presentedDrafts,
    ...unmatched,
    ...(report.consolidated?.securityConcerns ?? []).map(fromSecurityConcern),
  ];

  const byKey = new Map<string, Draft>();
  for (const draft of drafts) {
    if (!draft.title.trim()) continue;
    const key = issueKey(draft.title, draft.files[0]);
    const existing = byKey.get(key);
    if (existing) mergeInto(existing, draft);
    else byKey.set(key, { ...draft, files: [...draft.files] });
  }

  const sorted = [...byKey.values()]
    .map((d, index) => ({ d, index }))
    .sort((a, b) => SEVERITY_ORDER.indexOf(a.d.severity) - SEVERITY_ORDER.indexOf(b.d.severity) || a.index - b.index)
    .map(x => x.d);

  return sorted.map((d, i) => ({ ...d, id: `ISSUE-${i + 1}`, chatTier: suggestChatTier(d) }));
}

export function severityCounts(issues: Pick<InteractiveIssue, 'severity'>[]): Record<Severity, number> {
  const counts: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const issue of issues) counts[issue.severity]++;
  return counts;
}
