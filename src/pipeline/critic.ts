import { annotatePatch, parsePatch } from '../diff';
import { VerdictSchema } from '../schemas';
import type { ChangedFile, Finding, RejectedFinding } from '../types';
import { truncate, type StageDeps } from './deps';

const squash = (text: string) => text.replace(/\s+/g, ' ').trim();

/**
 * Deterministic grounding check: the quoted evidence must actually exist in the diff
 * or in the file. This catches invented code before any model is asked about it.
 */
export function evidenceAppears(finding: Finding, file: ChangedFile | undefined): boolean {
  if (!file) return false;
  const diffText = parsePatch(file.patch)
    .flatMap(h => h.lines.map(l => l.text))
    .join('\n');
  const haystack = squash(`${diffText}\n${file.content ?? ''}`);

  const quoted = squash(finding.evidence);
  if (quoted && haystack.includes(quoted)) return true;

  // Models sometimes keep the diff markers; try again without them.
  const unmarked = squash(
    finding.evidence
      .split('\n')
      .map(line => line.replace(/^[+-]/, ''))
      .join('\n'),
  );
  return unmarked.length > 0 && haystack.includes(unmarked);
}

export function buildCriticPrompt(findings: Finding[], files: Map<string, ChangedFile>): string {
  const listed = findings
    .map(
      (f, i) =>
        `[${i}] ${f.severity.toUpperCase()} ${f.file}${f.line ? `:${f.line}` : ''} - ${f.title}\n` +
        `Explanation: ${f.explanation}\nEvidence:\n${f.evidence}`,
    )
    .join('\n\n');

  const referenced = [...new Set(findings.map(f => f.file))];
  const diffs = referenced
    .map(path => {
      const file = files.get(path);
      return file ? `### ${path}\n\`\`\`diff\n${truncate(annotatePatch(file.patch), 12_000)}\n\`\`\`` : '';
    })
    .join('\n\n');

  return [
    'Here are draft review findings, then the diffs they refer to.',
    'Return one verdict per finding: its index, keep true or false, and a one-sentence reason.',
    '',
    '## Findings',
    listed,
    '',
    '## Diffs',
    diffs,
  ].join('\n');
}

export interface CritiqueResult {
  kept: Finding[];
  rejected: RejectedFinding[];
  /** False when the model check could not run and grounded findings were kept unverified. */
  validated: boolean;
}

export async function critique(
  deps: StageDeps,
  findings: Finding[],
  files: Map<string, ChangedFile>,
): Promise<CritiqueResult> {
  const rejected: RejectedFinding[] = [];
  const grounded: Finding[] = [];
  for (const finding of findings) {
    if (evidenceAppears(finding, files.get(finding.file))) grounded.push(finding);
    else rejected.push({ finding, reason: 'quoted evidence does not appear in the changed file' });
  }
  if (grounded.length === 0) return { kept: [], rejected, validated: true };

  let verdicts: Map<number, { keep: boolean; reason: string }>;
  try {
    const result = await deps.llm.generateObject('critic', buildCriticPrompt(grounded, files), VerdictSchema);
    deps.cost.record('critic', result.model, result.usage);
    verdicts = new Map(result.object.verdicts.map(v => [v.index, v]));
  } catch (error) {
    deps.log(`critic failed, keeping grounded findings unverified: ${(error as Error).message}`);
    return { kept: grounded, rejected, validated: false };
  }

  const kept: Finding[] = [];
  grounded.forEach((finding, index) => {
    const verdict = verdicts.get(index);
    if (verdict?.keep) kept.push(finding);
    else rejected.push({ finding, reason: verdict ? `critic: ${verdict.reason}` : 'critic did not confirm it' });
  });
  return { kept, rejected, validated: true };
}
