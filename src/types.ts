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

export const FINDING_CATEGORIES = [
  'bug',
  'security',
  'performance',
  'maintainability',
  'architecture',
  'edge-case',
  'improvement',
  'style',
] as const;

export interface Occurrence {
  line: number;
  snippet: string;
}

export interface Finding {
  file: string;
  line?: number;
  severity: Severity;
  /** Usually one of FINDING_CATEGORIES; free text is tolerated. */
  category: string;
  title: string;
  explanation: string;
  /** Code copied verbatim from the diff that demonstrates the problem. */
  evidence: string;
  suggestion?: string;
  /** What goes wrong for users or the system if this is not fixed. */
  impact?: string;
  /** Other places in the same file with the same problem. */
  occurrences?: Occurrence[];
}

export interface RejectedFinding {
  finding: Finding;
  reason: string;
}

export interface SkippedFile {
  path: string;
  reason: string;
}

/** Per-file result of the deep review stage. */
export interface FileReview {
  path: string;
  status: 'ok' | 'error' | 'timeout';
  whatChanged: string;
  findings: Finding[];
  positives: string[];
  testingRecommendations: string[];
  error?: string;
}

/** Pipeline stages. Each stage runs on the model of its configured tier. */
export type Stage =
  | 'identify'
  | 'triage'
  | 'docs'
  | 'batching'
  | 'review'
  | 'critic'
  | 'consolidate'
  | 'validate'
  | 'persona'
  | 'chat'
  | 'memory';
export type Tier = 'deep' | 'balanced' | 'cheap';

export const BUILT_IN_PERSONAS = ['neutral', 'mentor', 'terse', 'detective', 'captain', 'monk'] as const;
/** A built-in persona key, an external style key, 'random', or 'none'. */
export type PersonaName = string;

export type Risk = 'low' | 'medium' | 'high';

// ---- consolidation -------------------------------------------------------

export const SECURITY_CATEGORIES = [
  'general',
  'taint',
  'secrets',
  'common-vulnerability',
  'dependency',
  'api-misuse',
] as const;
export type SecurityCategory = (typeof SECURITY_CATEGORIES)[number];

export interface Evidence {
  file: string;
  snippet: string;
  line?: number;
}

export interface SecurityConcern {
  description: string;
  severity: Severity;
  category: SecurityCategory;
  affectedFiles: string[];
  remediation: string;
  evidence: Evidence;
}

export interface Recommendation {
  text: string;
  priority: 'high' | 'medium' | 'low';
  evidence: Evidence;
}

export interface TestRequirement {
  kind: 'unit' | 'e2e';
  description: string;
  rationale: string;
  evidence: Evidence;
}

export interface SecurityChecklist {
  impactsSecurity: boolean;
  cryptographicChange: boolean;
  secureChannelModified: boolean;
  dataManagementChange: boolean;
  otherSecurityImpact: boolean;
}

export interface Consolidated {
  overview: string;
  risk: Risk;
  highlights: string[];
  architectureChanges: string[];
  securityConcerns: SecurityConcern[];
  securityChecklist: SecurityChecklist;
  recommendations: Recommendation[];
  functionality: { isComplete: boolean; missing: string[]; explanation: string };
  testRequirements: TestRequirement[];
  codeQuality: { patterns: string; complexity: string; maintainability: string };
  dependencies: { added: string; impact: string; security: string };
  performance: { bottlenecks: string; resources: string; scalability: string };
  limitations: string[];
  completeness: 'complete' | 'partial' | 'limited';
}

/** Items the validation stage removed from the consolidated review, with reasons. */
export interface ValidationRemovals {
  securityConcerns: { item: SecurityConcern; reason: string }[];
  recommendations: { item: Recommendation; reason: string }[];
  testRequirements: { item: TestRequirement; reason: string }[];
}

// ---- impact analysis -----------------------------------------------------

export interface CodeSymbol {
  name: string;
  kind: string;
  exported: boolean;
  startLine: number;
  endLine: number;
  code: string;
}

export interface ImpactedFile {
  path: string;
  depth: number;
  kind: 'direct' | 'transitive';
  /** The changed file this impact flows from. */
  via: string;
  /** Symbols in the impacted file that use something the change touched. */
  usedSymbols: string[];
}

export type ImpactLevel = 'none' | 'low' | 'medium' | 'high';

export interface FileImpact {
  path: string;
  modifiedExports: CodeSymbol[];
  impacted: ImpactedFile[];
  level: ImpactLevel;
}

export interface BlastRadius {
  level: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  criticalPaths: string[];
}

export interface TestCoverage {
  /** Changed non-test files that no test depends on and that were not changed alongside a test. */
  untested: string[];
  /** Existing test files that depend on changed code and may need updating. */
  testsToUpdate: string[];
  coveredBy: Record<string, string[]>;
}

export interface SemanticChange {
  path: string;
  symbol: string;
  change: 'added' | 'modified' | 'unchanged';
}

export interface ImpactResult {
  files: Record<string, FileImpact>;
  blastRadius: BlastRadius;
  coverage: TestCoverage;
  semantic: SemanticChange[];
  edges: { from: string; to: string }[];
  /** Why analysis was partial or skipped, if it was. */
  notes: string[];
}

// ---- persona presentation ------------------------------------------------

export interface PresentationIssue {
  id: string;
  title: string;
  severity: Severity;
  type: string;
  description: string;
  files: string[];
  evidence?: string;
  fix?: string;
}

export interface Presentation {
  persona: string;
  intro: string;
  aspects: { name: string; status: 'clean' | 'warning' | 'issue' | 'critical'; note: string }[];
  issues: PresentationIssue[];
  filesTable: { path: string; status: string; description: string; impact?: string }[];
  cleanFiles: string[];
  verdict: string;
}

// ---- report --------------------------------------------------------------

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
  /** Short persona opening; also available as presentation.intro when a presentation exists. */
  intro?: string;
  findings: Finding[];
  rejected: RejectedFinding[];
  skipped: SkippedFile[];
  reviewedFiles: string[];
  /** False when the critic stage failed and findings were not verified. */
  validated: boolean;
  cost: CostSummary;
  fileReviews?: FileReview[];
  consolidated?: Consolidated;
  removals?: ValidationRemovals;
  presentation?: Presentation;
  impact?: ImpactResult;
  docsSummary?: string;
}
