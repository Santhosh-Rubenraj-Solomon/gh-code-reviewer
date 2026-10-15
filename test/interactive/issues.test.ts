import { describe, expect, test } from 'bun:test';
import { severityCounts, suggestChatTier, toInteractiveIssues } from '../../src/issues';
import type { Consolidated, Presentation, PresentationIssue, ReviewReport, SecurityConcern } from '../../src/types';
import { finding } from '../helpers';

function report(overrides: Partial<ReviewReport> = {}): ReviewReport {
  return {
    title: 't',
    headSha: 'abc',
    overview: '',
    risk: 'low',
    highlights: [],
    findings: [],
    rejected: [],
    skipped: [],
    reviewedFiles: [],
    validated: true,
    cost: { totalUsd: 0, byStage: {} },
    ...overrides,
  };
}

function concern(overrides: Partial<SecurityConcern> = {}): SecurityConcern {
  return {
    description: 'Secrets are logged in plain text. This leaks credentials.',
    severity: 'high',
    category: 'secrets',
    affectedFiles: ['src/log.ts'],
    remediation: 'Redact the token before logging.',
    evidence: { file: 'src/log.ts', snippet: 'console.log(token)', line: 9 },
    ...overrides,
  };
}

describe('toInteractiveIssues', () => {
  test('converts findings with lines, evidence, fix and impact', () => {
    const [issue] = toInteractiveIssues(
      report({ findings: [finding({ impact: 'Data loss', occurrences: [{ line: 8, snippet: 'x' }] })] }),
    );
    expect(issue).toMatchObject({
      id: 'ISSUE-1',
      title: 'SQL injection in findUser',
      severity: 'critical',
      type: 'security',
      files: ['src/users.ts'],
      lines: [3, 8],
      chatTier: 'advanced',
    });
    expect(issue!.description).toContain('Impact: Data loss');
    expect(issue!.evidence).toContain('SELECT');
    expect(issue!.suggestedFix).toContain('parameterised');
  });

  test('includes consolidated security concerns with a short title', () => {
    const issues = toInteractiveIssues(
      report({ consolidated: { securityConcerns: [concern()] } as unknown as Consolidated }),
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ title: 'Secrets are logged in plain text.', type: 'security', lines: [9] });
    expect(issues[0]!.suggestedFix).toBe('Redact the token before logging.');
  });

  test('dedupes by normalised title and file, keeping presentation wording but merging lines', () => {
    const issues = toInteractiveIssues(
      report({
        findings: [finding(), finding({ file: 'src/other.ts' })],
        presentation: {
          persona: 'neutral',
          intro: '',
          aspects: [],
          filesTable: [],
          cleanFiles: [],
          verdict: '',
          issues: [
            {
              id: 'p1',
              title: 'SQL Injection in findUser!',
              severity: 'critical',
              type: 'security',
              description: 'Polished wording',
              files: ['src/users.ts'],
            },
          ],
        },
      }),
    );
    expect(issues).toHaveLength(2);
    expect(issues[0]!.description).toBe('Polished wording');
    expect(issues[0]!.lines).toEqual([3]);
    expect(issues[1]!.files).toEqual(['src/other.ts']);
  });

  describe('merging a persona rewrite with its source finding', () => {
    const presented = (issues: PresentationIssue[]) =>
      ({ persona: 'neutral', intro: '', aspects: [], filesTable: [], cleanFiles: [], verdict: '', issues }) as Presentation;
    const rewrite = (over: Partial<PresentationIssue> = {}): PresentationIssue => ({
      id: 'p1',
      title: 'Your query trusts user input',
      severity: 'high',
      type: 'security',
      description: 'The name goes straight into the SQL string.',
      files: ['src/users.ts'],
      evidence: 'paraphrased code',
      fix: 'paraphrased fix',
      ...over,
    });

    test('by sourceTitle: presentation wording, finding lines/evidence/fix, one issue', () => {
      const f = finding({ occurrences: [{ line: 9, snippet: 'x' }] });
      const issues = toInteractiveIssues(
        report({ findings: [f], presentation: presented([rewrite({ sourceTitle: f.title })]) }),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({
        title: 'Your query trusts user input',
        description: 'The name goes straight into the SQL string.',
        type: 'security',
        lines: [3, 9],
        evidence: f.evidence,
        suggestedFix: f.suggestion,
        // The finding is critical, the rewrite said high: the more severe one wins.
        severity: 'critical',
      });
    });

    test('sourceTitle in another file does not swallow a finding elsewhere', () => {
      const f = finding({ file: 'src/other.ts' });
      const issues = toInteractiveIssues(
        report({ findings: [f], presentation: presented([rewrite({ sourceTitle: f.title })]) }),
      );
      expect(issues).toHaveLength(2);
    });

    test('without sourceTitle: same first file and same evidence', () => {
      const f = finding();
      const issues = toInteractiveIssues(
        report({ findings: [f], presentation: presented([rewrite({ evidence: `  ${f.evidence}\n` })]) }),
      );
      expect(issues).toHaveLength(1);
      expect(issues[0]!.title).toBe('Your query trusts user input');
      expect(issues[0]!.lines).toEqual([3]);
      expect(issues[0]!.suggestedFix).toBe(f.suggestion);
    });

    test('without sourceTitle: same file and an overlapping line the persona mentions', () => {
      const f = finding({ line: 12, evidence: 'something else' });
      const byLine = rewrite({ description: 'On lines 11-13 the name is concatenated into SQL.' });
      expect(toInteractiveIssues(report({ findings: [f], presentation: presented([byLine]) }))).toHaveLength(1);
      const byRef = rewrite({ description: 'See src/users.ts:12 for the concatenation.' });
      expect(toInteractiveIssues(report({ findings: [f], presentation: presented([byRef]) }))).toHaveLength(1);
      const farAway = rewrite({ description: 'On line 40 something unrelated happens.' });
      expect(toInteractiveIssues(report({ findings: [f], presentation: presented([farAway]) }))).toHaveLength(2);
    });

    test('a different file never matches by evidence or line', () => {
      const f = finding();
      const elsewhere = rewrite({ files: ['src/other.ts'], evidence: f.evidence, description: 'line 3' });
      expect(toInteractiveIssues(report({ findings: [f], presentation: presented([elsewhere]) }))).toHaveLength(2);
    });
  });

  test('sorts by severity, stable within a severity, and numbers ids in order', () => {
    const issues = toInteractiveIssues(
      report({
        findings: [
          finding({ title: 'a', severity: 'low', category: 'style' }),
          finding({ title: 'b', severity: 'high', category: 'bug' }),
          finding({ title: 'c', severity: 'medium', category: 'bug' }),
          finding({ title: 'd', severity: 'high', category: 'bug' }),
        ],
      }),
    );
    expect(issues.map(i => i.title)).toEqual(['b', 'd', 'c', 'a']);
    expect(issues.map(i => i.id)).toEqual(['ISSUE-1', 'ISSUE-2', 'ISSUE-3', 'ISSUE-4']);
    expect(severityCounts(issues)).toEqual({ critical: 0, high: 2, medium: 1, low: 1 });
  });

  test('an empty report gives no issues', () => {
    expect(toInteractiveIssues(report())).toEqual([]);
  });
});

describe('suggestChatTier', () => {
  test('heavy issues go advanced, cosmetic ones basic, everything else standard', () => {
    expect(suggestChatTier({ type: 'architecture', severity: 'low', files: ['a'] })).toBe('advanced');
    expect(suggestChatTier({ type: 'bug', severity: 'critical', files: ['a'] })).toBe('advanced');
    expect(suggestChatTier({ type: 'bug', severity: 'medium', files: ['a', 'b', 'c'] })).toBe('advanced');
    expect(suggestChatTier({ type: 'style', severity: 'low', files: ['a'] })).toBe('basic');
    expect(suggestChatTier({ type: 'style', severity: 'medium', files: ['a'] })).toBe('standard');
    expect(suggestChatTier({ type: 'bug', severity: 'high', files: ['a'] })).toBe('standard');
  });
});
