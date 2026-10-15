export type FileStatus = 'added' | 'modified' | 'removed' | 'renamed';

export interface ChangedFile {
  path: string;
  previousPath?: string;
  status: FileStatus;
  /** Unified diff hunks for this file ('' for binary or oversized files). */
  patch: string;
  additions: number;
  deletions: number;
  /** Full file content at the head revision, when available. */
  content?: string;
}

export interface PullRef {
  owner: string;
  repo: string;
  number: number;
}

export interface ChangeSet {
  source: 'github' | 'local';
  title: string;
  description: string;
  baseRef: string;
  headSha: string;
  files: ChangedFile[];
  pull?: PullRef;
}

export type Severity = 'critical' | 'high' | 'medium' | 'low';
export const SEVERITY_ORDER: Severity[] = ['critical', 'high', 'medium', 'low'];

export interface Finding {
  file: string;
  line?: number;
  severity: Severity;
  category: string;
  title: string;
  explanation: string;
  /** Code copied verbatim from the diff that demonstrates the problem. */
  evidence: string;
  suggestion?: string;
}

export interface RejectedFinding {
  finding: Finding;
  reason: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

/** Pipeline stages. Each stage runs on the model of its configured tier. */
export type Stage = 'triage' | 'review' | 'consolidate' | 'critic' | 'persona';
export type Tier = 'deep' | 'balanced' | 'cheap';

export const PERSONA_NAMES = ['neutral', 'mentor', 'terse', 'detective'] as const;
export type PersonaName = (typeof PERSONA_NAMES)[number];

export type Risk = 'low' | 'medium' | 'high';

export interface StageCost {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  calls: number;
}

export interface CostSummary {
  totalUsd: number;
  byStage: Partial<Record<Stage, StageCost>>;
}

export interface ReviewReport {
  title: string;
  headSha: string;
  overview: string;
  risk: Risk;
  highlights: string[];
  intro?: string;
  findings: Finding[];
  rejected: RejectedFinding[];
  skipped: SkippedFile[];
  reviewedFiles: string[];
  /** False when the critic stage failed and findings were not verified. */
  validated: boolean;
  cost: CostSummary;
}
