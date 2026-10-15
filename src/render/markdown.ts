import type { Finding, ReviewReport, Severity } from '../types';

/** Hidden marker used to find and update our own summary comment on re-runs. */
export const SUMMARY_MARKER = '<!-- gh-code-reviewer:summary -->';

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: '🛑 Critical',
  high: '🔴 High',
  medium: '🟠 Medium',
  low: '🟡 Low',
};

const location = (f: Finding) => `\`${f.file}${f.line ? `:${f.line}` : ''}\``;
const escapeCell = (text: string) => text.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** Body of an inline review comment, or of a detailed entry in the summary. */
export function renderFinding(finding: Finding): string {
  const parts = [
    `**${SEVERITY_LABEL[finding.severity]} · ${finding.category}: ${finding.title}**`,
    '',
    finding.explanation,
  ];
  if (finding.suggestion) parts.push('', `**Suggestion:** ${finding.suggestion}`);
  return parts.join('\n');
}

export interface SummaryOptions {
  /** Findings to describe in full; the rest are assumed to be posted inline. Defaults to all. */
  detailed?: Finding[];
}

export function renderSummary(report: ReviewReport, options: SummaryOptions = {}): string {
  const detailed = options.detailed ?? report.findings;
  const out: string[] = [SUMMARY_MARKER, `## 🔍 Code review: ${report.title}`, ''];

  if (report.intro) out.push(`> ${report.intro.replace(/\n/g, '\n> ')}`, '');
  out.push(`**Merge risk:** ${report.risk.toUpperCase()}`, '', report.overview, '');

  if (report.highlights.length) {
    out.push('**Look at first:**', ...report.highlights.map(h => `- ${h}`), '');
  }

  if (report.findings.length === 0) {
    out.push('No verified issues found. ✅', '');
  } else {
    out.push('| Severity | Location | Issue |', '| --- | --- | --- |');
    for (const f of report.findings) {
      out.push(`| ${SEVERITY_LABEL[f.severity]} | ${location(f)} | ${escapeCell(f.title)} |`);
    }
    out.push('');
  }

  if (detailed.length) {
    out.push('### Details', '');
    for (const f of detailed) out.push(`#### ${location(f)}`, renderFinding(f), '');
  }

  if (!report.validated) {
    out.push('> ⚠️ The critic step failed, so these findings were not double-checked.', '');
  }

  const collapsible = (title: string, rows: string[]) =>
    rows.length ? [`<details><summary>${title}</summary>`, '', ...rows, '', '</details>', ''] : [];
  out.push(
    ...collapsible(
      `${report.rejected.length} draft finding(s) dropped by the critic`,
      report.rejected.map(r => `- ${location(r.finding)} ${r.finding.title}: _${r.reason}_`),
    ),
    ...collapsible(
      `${report.skipped.length} file(s) not reviewed`,
      report.skipped.map(s => `- \`${s.path}\`: ${s.reason}`),
    ),
  );

  out.push(
    `<sub>Reviewed ${report.reviewedFiles.length} file(s) at ${report.headSha.slice(0, 7)} · ` +
      `estimated model cost $${report.cost.totalUsd.toFixed(4)} · gh-code-reviewer</sub>`,
  );
  return out.join('\n');
}
