import { OverviewSchema } from '../schemas';
import type { ChangeSet, Finding, Risk } from '../types';
import { truncate, type StageDeps } from './deps';

export interface Overview {
  overview: string;
  risk: Risk;
  highlights: string[];
}

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

export function riskFromFindings(findings: Finding[]): Risk {
  if (findings.some(f => f.severity === 'critical' || f.severity === 'high')) return 'high';
  if (findings.some(f => f.severity === 'medium')) return 'medium';
  return 'low';
}

export function buildConsolidationPrompt(
  changeSet: ChangeSet,
  summaries: Record<string, string>,
  findings: Finding[],
): string {
  const fileLines = changeSet.files.map(f => `- ${f.path} (${f.status})${summaries[f.path] ? `: ${summaries[f.path]}` : ''}`);
  const findingLines = findings.length
    ? findings.map(f => `- [${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} ${f.title}`)
    : ['- none'];
  return [
    `Pull request: ${changeSet.title}`,
    changeSet.description ? `Description:\n${truncate(changeSet.description, 3_000)}` : '',
    '',
    'Changed files:',
    ...fileLines,
    '',
    'Verified findings:',
    ...findingLines,
    '',
    'Write `overview` (3-6 sentences on what the change does and its overall quality),',
    '`risk` (low/medium/high for merging as-is), and up to 4 `highlights` the reviewers should look at first.',
  ].join('\n');
}

/** Falls back to a plain summary if the model call fails; never reports less risk than the findings imply. */
export async function consolidate(
  deps: StageDeps,
  changeSet: ChangeSet,
  summaries: Record<string, string>,
  findings: Finding[],
): Promise<Overview> {
  const floor = riskFromFindings(findings);
  try {
    const result = await deps.llm.generateObject(
      'consolidate',
      buildConsolidationPrompt(changeSet, summaries, findings),
      OverviewSchema,
    );
    deps.cost.record('consolidate', result.model, result.usage);
    const risk = RISK_RANK[result.object.risk] >= RISK_RANK[floor] ? result.object.risk : floor;
    return { ...result.object, risk };
  } catch (error) {
    deps.log(`consolidation failed, using a plain summary: ${(error as Error).message}`);
    return {
      overview: `${changeSet.files.length} file(s) changed; ${findings.length} verified finding(s).`,
      risk: floor,
      highlights: findings.slice(0, 4).map(f => f.title),
    };
  }
}
