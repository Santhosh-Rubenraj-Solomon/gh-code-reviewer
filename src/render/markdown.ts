import type { Consolidated, Finding, Presentation, ReviewReport, SecurityCategory, Severity, TestRequirement } from '../types';
import type { Persona } from '../personas';
import { renderPresentation } from './presentation';
import { collapsible, escapeCell, evidenceLocation, fence, langFor, location, quote } from './util';

export { escapeCell } from './util';

/** Hidden marker used to find and update our own summary comment on re-runs. */
export const SUMMARY_MARKER = '<!-- gh-code-reviewer:summary -->';
/** Hidden marker for the separate testing comment. */
export const TESTING_MARKER = '<!-- gh-code-reviewer:testing -->';

export const SEVERITY_LABEL: Record<Severity, string> = {
  critical: '🛑 Critical',
  high: '🔴 High',
  medium: '🟠 Medium',
  low: '🟡 Low',
};

export const SECURITY_CATEGORY_LABEL: Record<SecurityCategory, string> = {
  general: 'General',
  taint: 'Untrusted input and data flow',
  secrets: 'Secrets and credentials',
  'common-vulnerability': 'Common vulnerabilities',
  dependency: 'Dependencies',
  'api-misuse': 'API misuse',
};

const CHECKLIST_LABELS: [keyof Consolidated['securityChecklist'], string][] = [
  ['impactsSecurity', 'Affects security'],
  ['cryptographicChange', 'Changes cryptography'],
  ['secureChannelModified', 'Changes a secure channel (TLS, auth transport)'],
  ['dataManagementChange', 'Changes how data is stored or handled'],
  ['otherSecurityImpact', 'Other security impact'],
];

const yesNo = (value: boolean) => (value ? 'Yes' : 'No');

/** Body of an inline review comment, or of a detailed entry in the summary. */
export function renderFinding(finding: Finding): string {
  const parts = [
    `**${SEVERITY_LABEL[finding.severity]} · ${finding.category}: ${finding.title}**`,
    '',
    finding.explanation,
  ];
  if (finding.impact) parts.push('', `**Impact:** ${finding.impact}`);
  if (finding.suggestion) parts.push('', `**Suggestion:** ${finding.suggestion}`);
  return parts.join('\n');
}

export interface SummaryOptions {
  /** Findings to describe in full; the rest are assumed to be posted inline. Defaults to all. */
  detailed?: Finding[];
  /** Include the hidden marker (default true). Local files do not need it. */
  marker?: boolean;
}

/** The consolidated review's sections: architecture, security, functionality, recommendations, checklist, details. */
export function consolidatedSections(c: Consolidated): string[] {
  const out: string[] = [];
  if (c.architectureChanges.length) {
    out.push('### Architecture changes', ...c.architectureChanges.map(a => `- ${a}`), '');
  }

  if (c.securityConcerns.length) {
    out.push('### Security concerns', '');
    const categories = [...new Set(c.securityConcerns.map(s => s.category))];
    for (const category of categories) {
      out.push(`#### ${SECURITY_CATEGORY_LABEL[category] ?? category}`);
      for (const s of c.securityConcerns.filter(x => x.category === category)) {
        const files = s.affectedFiles.length ? ` (${s.affectedFiles.map(f => `\`${f}\``).join(', ')})` : '';
        out.push(`- **${SEVERITY_LABEL[s.severity]}** ${s.description}${files}`);
        if (s.remediation) out.push(`  - Remediation: ${s.remediation}`);
        out.push(`  - Evidence: ${evidenceLocation(s.evidence)}`);
      }
      out.push('');
    }
  }

  const f = c.functionality;
  if (f.explanation || f.missing.length) {
    out.push(`### Functionality: ${f.isComplete ? '✅ complete' : '❌ incomplete'}`, '');
    if (f.explanation) out.push(f.explanation, '');
    if (f.missing.length) out.push('Missing:', ...f.missing.map(m => `- ${m}`), '');
  }

  if (c.recommendations.length) {
    out.push('### Recommendations', '');
    c.recommendations.forEach((r, i) =>
      out.push(`${i + 1}. **${r.priority}** ${r.text} (${evidenceLocation(r.evidence)})`),
    );
    out.push('');
  }

  out.push(
    '### Security checklist',
    '',
    '| Question | Answer |',
    '| --- | --- |',
    ...CHECKLIST_LABELS.map(([key, label]) => `| ${label} | ${yesNo(c.securityChecklist[key])} |`),
    '',
  );

  const details = [
    ['Patterns', c.codeQuality.patterns],
    ['Complexity', c.codeQuality.complexity],
    ['Maintainability', c.codeQuality.maintainability],
    ['New dependencies', c.dependencies.added],
    ['Dependency impact', c.dependencies.impact],
    ['Dependency security', c.dependencies.security],
    ['Bottlenecks', c.performance.bottlenecks],
    ['Resources', c.performance.resources],
    ['Scalability', c.performance.scalability],
  ].filter(([, value]) => value?.trim());
  out.push(...collapsible('Code quality, dependencies and performance', details.map(([k, v]) => `- **${k}:** ${v}`)));

  const limitations = [...c.limitations];
  if (c.completeness !== 'complete') limitations.unshift(`Review completeness: ${c.completeness}.`);
  out.push(...collapsible('Review limitations', limitations.map(l => `- ${l}`)));
  return out;
}

function removalRows(report: ReviewReport): string[] {
  const r = report.removals;
  if (!r) return [];
  return [
    ...r.securityConcerns.map(x => `- Security concern: ${x.item.description} — _${x.reason}_`),
    ...r.recommendations.map(x => `- Recommendation: ${x.item.text} — _${x.reason}_`),
    ...r.testRequirements.map(x => `- Test (${x.item.kind}): ${x.item.description} — _${x.reason}_`),
  ];
}

/** What the review left out and why: unverified warning, critic rejections, evidence-check removals, skipped files. */
export function auditTrail(report: ReviewReport): string[] {
  const out: string[] = [];
  if (!report.validated) {
    out.push('> ⚠️ The critic step failed, so these findings were not double-checked.', '');
  }
  const removed = removalRows(report);
  out.push(
    ...collapsible(
      `${report.rejected.length} draft finding(s) dropped by the critic`,
      report.rejected.map(r => `- ${location(r.finding)} ${r.finding.title}: _${r.reason}_`),
    ),
    ...collapsible(`${removed.length} item(s) removed by the evidence check`, removed),
    ...collapsible(
      `${report.skipped.length} file(s) not reviewed`,
      report.skipped.map(s => `- \`${s.path}\`: ${s.reason}`),
    ),
  );
  return out;
}

/** Everything below the findings: consolidated sections, a pointer to the testing comment, and the audit trail. */
export function reviewDetailSections(report: ReviewReport): string[] {
  const out: string[] = report.consolidated ? consolidatedSections(report.consolidated) : [];
  const tests = report.consolidated?.testRequirements.length ?? 0;
  if (tests) out.push(`🧪 ${tests} test requirement(s) are listed in the testing section.`, '');
  out.push(...auditTrail(report));
  return out;
}

export const reviewFooter = (report: ReviewReport) =>
  `<sub>Reviewed ${report.reviewedFiles.length} file(s) at ${report.headSha.slice(0, 7)} · ` +
  `estimated model cost $${report.cost.totalUsd.toFixed(4)} · gh-code-reviewer</sub>`;

/**
 * A persona presentation followed by the consolidated review and audit trail. The presentation already shows the
 * overview, the issues and (with impact) the blast radius, so only the merge risk is added on top of it.
 */
export function renderPresentationReport(report: ReviewReport, presentation: Presentation, persona: Persona): string {
  const out = [
    renderPresentation(presentation, persona, { impact: report.impact }),
    '',
    `**Merge risk:** ${report.risk.toUpperCase()}`,
    '',
    ...reviewDetailSections(report),
  ];
  return out.join('\n').trimEnd();
}

export function renderSummary(report: ReviewReport, options: SummaryOptions = {}): string {
  const detailed = options.detailed ?? report.findings;
  const out: string[] = options.marker === false ? [] : [SUMMARY_MARKER];
  out.push(`## 🔍 Code review: ${report.title}`, '');

  if (report.intro) out.push(quote(report.intro), '');
  out.push(`**Merge risk:** ${report.risk.toUpperCase()}`, '');
  if (report.impact) {
    const b = report.impact.blastRadius;
    const paths = b.criticalPaths.length ? ` Critical paths: ${b.criticalPaths.map(p => `\`${p}\``).join(', ')}.` : '';
    out.push(`**Blast radius:** ${b.level.toUpperCase()} — ${b.description}${paths}`, '');
  }
  out.push(report.overview, '');

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

  out.push(...reviewDetailSections(report));

  out.push(reviewFooter(report));
  return out.join('\n');
}

// ---- testing -----------------------------------------------------------------

function renderRequirement(t: TestRequirement): string[] {
  const out = [`- **${t.description}**`];
  if (t.rationale) out.push(`  - Why: ${t.rationale}`);
  out.push(`  - Where: ${evidenceLocation(t.evidence)}`);
  if (t.evidence.snippet.trim()) out.push('', fence(t.evidence.snippet, langFor(t.evidence.file), '  '));
  return out;
}

/** True when the report has anything worth a testing section. */
export function hasTestingContent(report: ReviewReport): boolean {
  const coverage = report.impact?.coverage;
  return Boolean(
    report.consolidated?.testRequirements.length || coverage?.untested.length || coverage?.testsToUpdate.length,
  );
}

export function renderTesting(report: ReviewReport, options: { marker?: boolean } = {}): string {
  const out: string[] = options.marker === false ? [] : [TESTING_MARKER];
  out.push(`## 🧪 Testing: ${report.title}`, '');
  const requirements = report.consolidated?.testRequirements ?? [];
  const unit = requirements.filter(t => t.kind === 'unit');
  const e2e = requirements.filter(t => t.kind === 'e2e');

  if (unit.length) out.push('### Unit tests', '', ...unit.flatMap(renderRequirement), '');
  if (e2e.length) out.push('### End-to-end tests', '', ...e2e.flatMap(renderRequirement), '');
  if (!requirements.length) out.push('No specific test requirements were identified.', '');

  const coverage = report.impact?.coverage;
  if (coverage && (coverage.untested.length || coverage.testsToUpdate.length)) {
    out.push('### Coverage gaps', '');
    if (coverage.untested.length) {
      out.push('Changed files that no test exercises:', ...coverage.untested.map(p => `- \`${p}\``), '');
    }
    if (coverage.testsToUpdate.length) {
      out.push('Existing tests that depend on the changed code:', ...coverage.testsToUpdate.map(p => `- \`${p}\``), '');
    }
  }
  return out.join('\n').trimEnd();
}
