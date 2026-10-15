import { personaByKey, type Persona } from '../personas';
import type { FileReview, Finding, ReviewReport } from '../types';
import { renderFinding, renderPresentationReport, renderSummary, renderTesting } from './markdown';
import { fence, langFor, location } from './util';

const findingKey = (f: Finding) => `${f.file}\0${f.line ?? ''}\0${f.title.trim().toLowerCase()}`;
const evidenceKey = (f: Finding) => `${f.file}\0${f.evidence.trim()}`;

/**
 * The final version of each draft that survived the critic and later checks, matched by location and title or
 * by its evidence (the critic may reword a title or adjust severity). Drafts with no match were dropped.
 */
function survivorsOf(review: FileReview, final: Finding[]): Finding[] {
  const byKey = new Map(final.map(f => [findingKey(f), f]));
  const byEvidence = new Map(final.filter(f => f.evidence.trim()).map(f => [evidenceKey(f), f]));
  const seen = new Set<Finding>();
  const kept: Finding[] = [];
  for (const draft of review.findings) {
    const match = byKey.get(findingKey(draft)) ?? (draft.evidence.trim() ? byEvidence.get(evidenceKey(draft)) : undefined);
    if (match && !seen.has(match)) {
      seen.add(match);
      kept.push(match);
    }
  }
  return kept;
}

function renderFileReview(review: FileReview, final: Finding[]): string[] {
  const findings = survivorsOf(review, final);
  const dropped = review.findings.length - findings.length;
  const label = review.status === 'ok' ? `${findings.length} finding(s)` : review.status;
  const out = [`<details><summary><code>${review.path}</code> — ${label}</summary>`, ''];
  if (review.whatChanged.trim()) out.push(review.whatChanged.trim(), '');
  if (review.error) out.push(`> Review ${review.status}: ${review.error}`, '');
  for (const f of findings) {
    out.push(`#### ${location(f)}`, renderFinding(f), '');
    if (f.evidence.trim()) out.push(fence(f.evidence, langFor(f.file)), '');
  }
  if (findings.length === 0 && review.status === 'ok') out.push('No findings.', '');
  if (dropped > 0) {
    out.push(`_${dropped} draft finding(s) for this file did not survive verification; see the audit trail._`, '');
  }
  if (review.positives.length) out.push('**What works well**', ...review.positives.map(p => `- ${p}`), '');
  if (review.testingRecommendations.length) {
    out.push('**Testing suggestions**', ...review.testingRecommendations.map(t => `- ${t}`), '');
  }
  out.push('</details>', '');
  return out;
}

/** The whole review as one local Markdown document. */
export function renderCompleteMarkdown(report: ReviewReport, persona?: Persona | null): string {
  const out: string[] = [];
  if (report.presentation) {
    const chosen = persona ?? personaByKey(report.presentation.persona);
    out.push(`# Code review: ${report.title}`, '', renderPresentationReport(report, report.presentation, chosen));
  } else {
    out.push(renderSummary(report, { marker: false }));
  }

  if (report.fileReviews?.length) {
    out.push('', '## File reviews', '', ...report.fileReviews.flatMap(r => renderFileReview(r, report.findings)));
  }
  out.push('', renderTesting(report, { marker: false }));
  return `${out.join('\n').trimEnd()}\n`;
}
