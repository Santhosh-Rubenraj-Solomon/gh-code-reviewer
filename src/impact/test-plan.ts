import type {
  BlastRadius,
  ChangedFile,
  Finding,
  ImpactLevel,
  ImpactResult,
  ReviewReport,
  SemanticChange,
  TestRequirement,
} from '../types';

export const TEST_PLAN_VERSION = '1';

export interface TestPlanChangedFile {
  path: string;
  status: ChangedFile['status'];
  semanticChanges: { symbol: string; change: Exclude<SemanticChange['change'], 'unchanged'> }[] | null;
  modifiedExports: { name: string; kind: string; startLine: number; endLine: number; code: string }[] | null;
  coverage: { tested: boolean; coveredBy: string[] } | null;
  impact: { direct: string[]; transitive: { path: string; depth: number }[]; level: ImpactLevel } | null;
  review: { whatChanged: string; testingRecommendations: string[]; findings: Finding[] } | null;
}

export interface TestPlan {
  version: string;
  generatedAt: string;
  sourceId: string;
  summary: {
    blastRadius: BlastRadius | null;
    semanticChanges: { added: number; modified: number; unchanged: number } | null;
    coverageGaps: string[] | null;
  };
  changedFiles: TestPlanChangedFile[];
  impactedFiles: { path: string; kind: 'direct' | 'transitive'; depth: number; via: string; usedSymbols: string[] }[] | null;
  testRequirements: { unit: TestRequirement[]; e2e: TestRequirement[] } | null;
}

export interface TestPlanInput {
  sourceId: string;
  changedFiles: ChangedFile[];
  impact?: ImpactResult;
  report?: ReviewReport;
  now?: () => Date;
}

function semanticCounts(impact: ImpactResult) {
  const counts = { added: 0, modified: 0, unchanged: 0 };
  for (const s of impact.semantic) counts[s.change]++;
  return counts;
}

function findingsFor(path: string, report: ReviewReport): Finding[] {
  const fromFile = report.fileReviews?.find(r => r.path === path)?.findings ?? [];
  const all = [...fromFile, ...report.findings.filter(f => f.file === path)];
  const seen = new Set<string>();
  return all.filter(f => {
    const key = `${f.title}|${f.line ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function changedFileEntry(file: ChangedFile, impact?: ImpactResult, report?: ReviewReport): TestPlanChangedFile {
  const fileImpact = impact?.files[file.path];
  const covered = impact?.coverage.coveredBy[file.path] ?? [];
  const exportsSeen = new Set<string>();
  const review = report?.fileReviews?.find(r => r.path === file.path);

  return {
    path: file.path,
    status: file.status,
    semanticChanges: impact
      ? impact.semantic
          .filter(s => s.path === file.path && s.change !== 'unchanged')
          .map(s => ({ symbol: s.symbol, change: s.change as 'added' | 'modified' }))
      : null,
    modifiedExports: fileImpact
      ? fileImpact.modifiedExports
          .filter(s => {
            if (exportsSeen.has(s.name)) return false;
            exportsSeen.add(s.name);
            return true;
          })
          .map(({ name, kind, startLine, endLine, code }) => ({ name, kind, startLine, endLine, code }))
      : null,
    coverage: impact ? { tested: !impact.coverage.untested.includes(file.path), coveredBy: covered } : null,
    impact: fileImpact
      ? {
          direct: fileImpact.impacted.filter(i => i.kind === 'direct').map(i => i.path),
          transitive: fileImpact.impacted.filter(i => i.kind === 'transitive').map(i => ({ path: i.path, depth: i.depth })),
          level: fileImpact.level,
        }
      : null,
    review: report
      ? {
          whatChanged: review?.whatChanged ?? '',
          testingRecommendations: review?.testingRecommendations ?? [],
          findings: findingsFor(file.path, report),
        }
      : null,
  };
}

/** Machine-readable plan of what to test for a change, for QA tooling or test generators. */
export function buildTestPlan(input: TestPlanInput): TestPlan {
  const { impact, report } = input;
  const requirements = report?.consolidated?.testRequirements;

  const impacted = new Map<string, NonNullable<TestPlan['impactedFiles']>[number]>();
  for (const file of Object.values(impact?.files ?? {})) {
    for (const dep of file.impacted) {
      const existing = impacted.get(dep.path);
      if (!existing || dep.depth < existing.depth) impacted.set(dep.path, { ...dep, usedSymbols: [...dep.usedSymbols] });
    }
  }

  return {
    version: TEST_PLAN_VERSION,
    generatedAt: (input.now?.() ?? new Date()).toISOString(),
    sourceId: input.sourceId,
    summary: {
      blastRadius: impact?.blastRadius ?? null,
      semanticChanges: impact ? semanticCounts(impact) : null,
      coverageGaps: impact ? [...impact.coverage.untested] : null,
    },
    changedFiles: input.changedFiles.map(f => changedFileEntry(f, impact, report)),
    impactedFiles: impact ? [...impacted.values()].sort((a, b) => a.depth - b.depth || a.path.localeCompare(b.path)) : null,
    testRequirements: requirements
      ? { unit: requirements.filter(r => r.kind === 'unit'), e2e: requirements.filter(r => r.kind === 'e2e') }
      : null,
  };
}
