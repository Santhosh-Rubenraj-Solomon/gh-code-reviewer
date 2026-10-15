import type { AspectStatus, Persona } from '../personas';
import type { ImpactResult, Presentation, PresentationIssue } from '../types';
import { collapsible, escapeCell, fence, langFor } from './util';

export interface PresentationRenderOptions {
  /** Adds blast radius, semantic change and test coverage details when present. */
  impact?: ImpactResult;
}

export interface SplitPresentation {
  summary: string;
  issues: string[];
  filesAndVerdict: string;
}

/** More than this many clean files collapse into one line plus a hidden list. */
const CLEAN_FILES_INLINE = 5;

const looksMultiLine = (text: string) => text.includes('\n');

export function renderIssue(issue: PresentationIssue, persona: Persona): string {
  const r = persona.render;
  const prefix = r.issuePrefix ? `${r.issuePrefix} ` : '';
  const out = [
    `### ${prefix}${issue.id} · ${r.severityLabels[issue.severity]} · ${issue.type}: ${issue.title}`,
    '',
    issue.description,
  ];
  if (issue.files.length) out.push('', `**Files:** ${issue.files.map(f => `\`${f}\``).join(', ')}`);
  const lang = langFor(issue.files[0] ?? '');
  if (issue.evidence?.trim()) out.push('', '**Evidence**', '', fence(issue.evidence, lang));
  if (issue.fix?.trim()) {
    out.push('', looksMultiLine(issue.fix) ? ['**Fix**', '', fence(issue.fix, lang)].join('\n') : `**Fix:** ${issue.fix}`);
  }
  return out.join('\n');
}

function renderSummarySection(p: Presentation, persona: Persona, impact?: ImpactResult): string {
  const r = persona.render;
  const out = [`## ${r.headers.summary}`, '', p.intro, ''];
  const rows = p.aspects.map(a => `| ${escapeCell(a.name)} | ${r.statusLabels[a.status]} | ${escapeCell(a.note)} |`);
  if (impact) {
    const b = impact.blastRadius;
    rows.push(`| Blast radius | ${b.level.toUpperCase()} | ${escapeCell(b.description)} |`);
    const changed = impact.semantic.filter(s => s.change !== 'unchanged');
    if (changed.length) {
      const added = changed.filter(s => s.change === 'added').length;
      const note = `${added} added, ${changed.length - added} modified symbol(s)`;
      rows.push(`| Semantic changes | ${changed.length} | ${note} |`);
    }
  }
  if (rows.length) out.push('| Aspect | Status | Note |', '| --- | --- | --- |', ...rows);
  return out.join('\n').trimEnd();
}

function renderCoverage(persona: Persona, impact?: ImpactResult): string[] {
  const c = impact?.coverage;
  if (!c || (!c.untested.length && !c.testsToUpdate.length)) return [];
  const out = [`## ${persona.render.headers.testCoverage}`, ''];
  if (c.untested.length) out.push('No test exercises:', ...c.untested.map(p => `- \`${p}\``), '');
  if (c.testsToUpdate.length) out.push('Tests that depend on this change:', ...c.testsToUpdate.map(p => `- \`${p}\``), '');
  return out;
}

function renderFilesAndVerdict(p: Presentation, persona: Persona, impact?: ImpactResult): string {
  const r = persona.render;
  const out: string[] = [...renderCoverage(persona, impact)];

  if (p.filesTable.length) {
    const withImpact = p.filesTable.some(f => f.impact);
    out.push(`## ${r.headers.files}`, '');
    out.push(withImpact ? '| File | Status | Description | Impact |' : '| File | Status | Description |');
    out.push(withImpact ? '| --- | --- | --- | --- |' : '| --- | --- | --- |');
    for (const f of p.filesTable) {
      const status = r.statusLabels[f.status as AspectStatus] ?? f.status;
      const cells = [`\`${escapeCell(f.path)}\``, escapeCell(status), escapeCell(f.description)];
      if (withImpact) cells.push(escapeCell(f.impact ?? ''));
      out.push(`| ${cells.join(' | ')} |`);
    }
    out.push('');
  }

  if (p.cleanFiles.length) {
    const remarks = persona.cleanRemarks.length ? persona.cleanRemarks : ['No findings.'];
    out.push(`## ${r.headers.cleanFiles}`, '');
    if (p.cleanFiles.length > CLEAN_FILES_INLINE) {
      out.push(`${p.cleanFiles.length} files — ${remarks[0]}`, '');
      out.push(...collapsible('Show files', p.cleanFiles.map(f => `- \`${f}\``)));
    } else {
      out.push(...p.cleanFiles.map((f, i) => `- \`${f}\` — ${remarks[i % remarks.length]}`), '');
    }
  }

  out.push(`## ${r.headers.verdict}`, '', p.verdict);
  return out.join('\n').trimEnd();
}

function renderIssuesSection(p: Presentation, persona: Persona): string[] {
  return p.issues.map(i => renderIssue(i, persona));
}

export function renderPresentationSplit(
  presentation: Presentation,
  persona: Persona,
  options: PresentationRenderOptions = {},
): SplitPresentation {
  return {
    summary: renderSummarySection(presentation, persona, options.impact),
    issues: renderIssuesSection(presentation, persona),
    filesAndVerdict: renderFilesAndVerdict(presentation, persona, options.impact),
  };
}

export function renderPresentation(
  presentation: Presentation,
  persona: Persona,
  options: PresentationRenderOptions = {},
): string {
  const split = renderPresentationSplit(presentation, persona, options);
  const issues = split.issues.length
    ? [`## ${persona.render.headers.issues}`, '', split.issues.join('\n\n')]
    : [`## ${persona.render.headers.issues}`, '', 'No issues to report.'];
  return [split.summary, '', ...issues, '', split.filesAndVerdict].join('\n');
}
