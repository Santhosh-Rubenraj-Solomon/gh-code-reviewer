import type { Consolidated, FileReview, Finding, ReviewReport } from '../../src/types';
import { finding, SQL_CONTENT } from '../helpers';

export const SQL_EVIDENCE = 'const sql = "SELECT * FROM users WHERE name = \'" + name + "\'";';

export function fileReview(overrides: Partial<FileReview> = {}): FileReview {
  return {
    path: 'src/users.ts',
    status: 'ok',
    whatChanged: 'Builds the user lookup query by hand.',
    findings: [finding()],
    positives: ['Small, focused function.'],
    testingRecommendations: ['Test a name containing a quote.'],
    ...overrides,
  };
}

export function consolidated(overrides: Partial<Consolidated> = {}): Consolidated {
  return {
    overview: 'Adds a user lookup that concatenates SQL.',
    risk: 'high',
    highlights: ['SQL built from user input'],
    architectureChanges: ['New query helper in src/users.ts'],
    securityConcerns: [
      {
        description: 'User input reaches SQL unescaped.',
        severity: 'critical',
        category: 'taint',
        affectedFiles: ['src/users.ts'],
        remediation: 'Use a parameterised query.',
        evidence: { file: 'src/users.ts', snippet: SQL_EVIDENCE, line: 3 },
      },
    ],
    securityChecklist: {
      impactsSecurity: true,
      cryptographicChange: false,
      secureChannelModified: false,
      dataManagementChange: true,
      otherSecurityImpact: false,
    },
    recommendations: [
      { text: 'Pass name as a query parameter.', priority: 'high', evidence: { file: 'src/users.ts', snippet: 'return db.query(sql);' } },
    ],
    functionality: { isComplete: true, missing: [], explanation: 'The lookup works for plain names.' },
    testRequirements: [
      {
        kind: 'unit',
        description: 'findUser escapes quotes',
        rationale: 'The name is concatenated into SQL.',
        evidence: { file: 'src/users.ts', snippet: SQL_EVIDENCE, line: 3 },
      },
      {
        kind: 'e2e',
        description: 'Admin search with a quote in the name',
        rationale: 'The admin page calls findUser.',
        evidence: { file: 'src/users.ts', snippet: 'return db.query(sql);' },
      },
    ],
    codeQuality: { patterns: 'Plain functions.', complexity: 'Low.', maintainability: 'Good.' },
    dependencies: { added: 'None.', impact: '', security: '' },
    performance: { bottlenecks: '', resources: '', scalability: '' },
    limitations: [],
    completeness: 'complete',
    ...overrides,
  };
}

export function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    title: 'Look up users by name',
    headSha: 'abc1234def',
    overview: 'Adds a user lookup that builds SQL by hand.',
    risk: 'high',
    highlights: ['SQL built from user input'],
    findings: [finding()],
    rejected: [],
    skipped: [],
    reviewedFiles: ['src/users.ts'],
    validated: true,
    cost: { totalUsd: 0.01, byStage: {} },
    ...overrides,
  };
}

export { SQL_CONTENT };
export type { Finding };
