import { describe, expect, test } from 'bun:test';
import { BUILT_IN_PERSONA_DEFS } from '../../src/personas';
import {
  escapeCell,
  fence,
  hasTestingContent,
  renderCompleteMarkdown,
  renderFinding,
  renderPresentation,
  renderPresentationSplit,
  renderSummary,
  renderTesting,
  SUMMARY_MARKER,
  TESTING_MARKER,
} from '../../src/render';
import type { ImpactResult, Presentation } from '../../src/types';
import { finding } from '../helpers';
import { consolidated, fileReview, report } from './fixtures';

const impact = {
  files: {},
  blastRadius: { level: 'medium', description: 'Two callers.', criticalPaths: ['src/admin.ts'] },
  coverage: { untested: ['src/users.ts'], testsToUpdate: ['test/users.test.ts'], coveredBy: {} },
  semantic: [
    { path: 'src/users.ts', symbol: 'findUser', change: 'modified' },
    { path: 'src/users.ts', symbol: 'x', change: 'added' },
  ],
  edges: [],
  notes: [],
} as ImpactResult;

function presentation(overrides: Partial<Presentation> = {}): Presentation {
  return {
    persona: 'detective',
    intro: 'The facts are plain.',
    aspects: [{ name: 'Security', status: 'critical', note: 'Injection | bad' }],
    issues: [
      {
        id: 'ISSUE-1',
        title: 'Concatenated SQL',
        severity: 'critical',
        type: 'security',
        description: 'Names reach SQL.',
        files: ['src/users.ts'],
        evidence: 'const sql = "a" + name;',
        fix: 'db.query("... ?", [name]);\nreturn rows;',
      },
      { id: 'ISSUE-2', title: 'Small', severity: 'low', type: 'style', description: 'd', files: ['src/a.ts'], fix: 'Rename it.' },
    ],
    filesTable: [
      { path: 'src/users.ts', status: 'critical', description: 'Lookup', impact: 'high · 2 dependent file(s)' },
      { path: 'src/clean.ts', status: 'clean', description: 'Const' },
    ],
    cleanFiles: ['src/clean.ts'],
    verdict: 'Case closed once the query is bound.',
    ...overrides,
  };
}

describe('helpers', () => {
  test('escapeCell keeps a value on one row', () => {
    expect(escapeCell('a | b\nc')).toBe('a \\| b c');
  });
  test('fence outgrows backticks in the code', () => {
    expect(fence('x ``` y', 'ts')).toBe('````ts\nx ``` y\n````');
  });
});

describe('renderFinding', () => {
  test('includes impact when present', () => {
    expect(renderFinding(finding({ impact: 'Data leak.' }))).toContain('**Impact:** Data leak.');
  });
});

describe('renderSummary with a consolidated review', () => {
  const md = renderSummary(
    report({
      impact,
      consolidated: consolidated(),
      removals: {
        securityConcerns: [],
        recommendations: [{ item: consolidated().recommendations[0]!, reason: 'generic advice' }],
        testRequirements: [],
      },
    }),
  );

  test('keeps the marker and adds blast radius, architecture, grouped security, functionality, recs, checklist', () => {
    expect(md.startsWith(SUMMARY_MARKER)).toBe(true);
    expect(md).toContain('**Blast radius:** MEDIUM — Two callers. Critical paths: `src/admin.ts`.');
    expect(md).toContain('### Architecture changes\n- New query helper in src/users.ts');
    expect(md).toContain('#### Untrusted input and data flow\n- **🛑 Critical** User input reaches SQL unescaped. (`src/users.ts`)');
    expect(md).toContain('  - Evidence: `src/users.ts:3`');
    expect(md).toContain('### Functionality: ✅ complete');
    expect(md).toContain('1. **high** Pass name as a query parameter. (`src/users.ts`)');
    expect(md).not.toContain('[object Object]');
    expect(md).toContain('| Changes how data is stored or handled | Yes |');
    expect(md).toContain('| Changes cryptography | No |');
    expect(md).toContain('<details><summary>1 item(s) removed by the evidence check</summary>');
    expect(md).toContain('- Recommendation: Pass name as a query parameter. — _generic advice_');
    expect(md).toContain('🧪 2 test requirement(s)');
    expect(md).toContain('- **Patterns:** Plain functions.');
    expect(md).not.toContain('Review limitations');
  });

  test('marker can be left out and limitations show for incomplete reviews', () => {
    const local = renderSummary(report({ consolidated: consolidated({ completeness: 'partial', limitations: ['x.ts timed out'] }) }), { marker: false });
    expect(local.startsWith('## 🔍')).toBe(true);
    expect(local).toContain('- Review completeness: partial.\n- x.ts timed out');
  });
});

describe('renderTesting', () => {
  test('lists unit and e2e requirements with rationale, evidence and coverage gaps', () => {
    const md = renderTesting(report({ consolidated: consolidated(), impact }));
    expect(md.startsWith(TESTING_MARKER)).toBe(true);
    expect(md).toContain('### Unit tests\n\n- **findUser escapes quotes**\n  - Why: The name is concatenated into SQL.\n  - Where: `src/users.ts:3`');
    expect(md).toContain('  ```ts\n  const sql =');
    expect(md).toContain('### End-to-end tests');
    expect(md).toContain('Changed files that no test exercises:\n- `src/users.ts`');
    expect(md).toContain('Existing tests that depend on the changed code:\n- `test/users.test.ts`');
  });

  test('says so when there is nothing to test', () => {
    const r = report({ consolidated: consolidated({ testRequirements: [] }) });
    expect(renderTesting(r)).toContain('No specific test requirements were identified.');
    expect(hasTestingContent(r)).toBe(false);
    expect(hasTestingContent(report({ impact }))).toBe(true);
  });
});

describe('renderPresentation', () => {
  const detective = BUILT_IN_PERSONA_DEFS.detective!;

  test('uses the persona labels for every section', () => {
    const md = renderPresentation(presentation(), detective, { impact });
    expect(md).toContain('## 🔎 The case so far\n\nThe facts are plain.');
    expect(md).toContain('| Security | Culprit | Injection \\| bad |');
    expect(md).toContain('| Blast radius | MEDIUM | Two callers. |');
    expect(md).toContain('| Semantic changes | 2 | 1 added, 1 modified symbol(s) |');
    expect(md).toContain('## 🧾 Exhibits');
    expect(md).toContain('### 🔎 ISSUE-1 · Smoking gun · security: Concatenated SQL');
    expect(md).toContain('**Files:** `src/users.ts`');
    expect(md).toContain('**Evidence**\n\n```ts\nconst sql = "a" + name;\n```');
    expect(md).toContain('**Fix**\n\n```ts\ndb.query');
    expect(md).toContain('**Fix:** Rename it.');
    expect(md).toContain('## 🧪 Unexamined alibis');
    expect(md).toContain('| File | Status | Description | Impact |');
    expect(md).toContain('| `src/users.ts` | Culprit | Lookup | high · 2 dependent file(s) |');
    expect(md).toContain('| `src/clean.ts` | Cleared | Const |  |');
    expect(md).toContain('## ✅ Cleared of suspicion\n\n- `src/clean.ts` — Examined and cleared.');
    expect(md.trimEnd().endsWith('## ⚖️ Conclusion\n\nCase closed once the query is bound.')).toBe(true);
  });

  test('neutral has no prefix, no impact column without labels, and many clean files collapse', () => {
    const clean = Array.from({ length: 7 }, (_, i) => `f${i}.ts`);
    const md = renderPresentation(
      presentation({ issues: [], filesTable: [{ path: 'a.ts', status: 'clean', description: 'x' }], cleanFiles: clean }),
      BUILT_IN_PERSONA_DEFS.neutral!,
    );
    expect(md).toContain('## Issues\n\nNo issues to report.');
    expect(md).toContain('| File | Status | Description |\n| --- | --- | --- |\n| `a.ts` | OK | x |');
    expect(md).toContain('7 files — No findings.');
    expect(md).toContain('<details><summary>Show files</summary>');
  });

  test('split returns summary, one string per issue, and the rest', () => {
    const split = renderPresentationSplit(presentation(), detective);
    expect(split.summary.startsWith('## 🔎 The case so far')).toBe(true);
    expect(split.issues).toHaveLength(2);
    expect(split.issues[1]!.startsWith('### 🔎 ISSUE-2 · Curiosity')).toBe(true);
    expect(split.filesAndVerdict).toContain('## ⚖️ Conclusion');
    expect(split.filesAndVerdict).not.toContain('Unexamined alibis');
  });
});

describe('renderCompleteMarkdown', () => {
  test('without a presentation: summary, per-file details incl. positives and testing, then testing section', () => {
    const md = renderCompleteMarkdown(
      report({
        consolidated: consolidated(),
        fileReviews: [fileReview(), fileReview({ path: 'src/b.ts', status: 'timeout', error: 'slow', findings: [], positives: [], testingRecommendations: [] })],
      }),
    );
    expect(md).not.toContain(SUMMARY_MARKER);
    expect(md).toContain('## File reviews');
    expect(md).toContain('<details><summary><code>src/users.ts</code> — 1 finding(s)</summary>');
    expect(md).toContain('**What works well**\n- Small, focused function.');
    expect(md).toContain('**Testing suggestions**\n- Test a name containing a quote.');
    expect(md).toContain('<code>src/b.ts</code> — timeout');
    expect(md).toContain('> Review timeout: slow');
    expect(md).toContain('## 🧪 Testing: Look up users by name');
    expect(md.endsWith('\n')).toBe(true);
  });

  test('per-file details show only findings that survived, with a count of dropped drafts', () => {
    const kept = finding({ title: 'SQL injection', severity: 'critical' });
    const dropped = finding({ title: 'Rename sql', evidence: 'const sql = 1', line: 3, severity: 'low' });
    const md = renderCompleteMarkdown(
      report({
        // The critic raised the severity of the kept draft; the report's version is the one shown.
        findings: [{ ...kept, severity: 'high' }],
        rejected: [{ finding: dropped, reason: 'style only' }],
        fileReviews: [fileReview({ findings: [kept, dropped] })],
      }),
    );
    const start = md.indexOf('## File reviews');
    const details = md.slice(start, md.indexOf('</details>', start));
    expect(details).toContain('<code>src/users.ts</code> — 1 finding(s)');
    expect(details).toContain('SQL injection');
    expect(details).not.toContain('Rename sql');
    expect(details).toContain('1 draft finding(s) for this file did not survive verification; see the audit trail.');
  });

  test('with a presentation uses it, resolving the persona from the key when none is given', () => {
    const md = renderCompleteMarkdown(report({ presentation: presentation() }));
    expect(md).toContain('# Code review: Look up users by name');
    expect(md).toContain('## 🔎 The case so far');
    expect(md).toContain('No specific test requirements were identified.');
  });

  test('with a presentation still includes the consolidated review and audit trail, without repeating findings', () => {
    const md = renderCompleteMarkdown(
      report({
        presentation: presentation(),
        consolidated: consolidated(),
        impact,
        rejected: [{ finding: finding({ title: 'Rename sql' }), reason: 'style only' }],
        removals: { securityConcerns: [], testRequirements: [], recommendations: [{ item: consolidated().recommendations[0]!, reason: 'generic' }] },
        skipped: [{ path: 'package-lock.json', reason: 'lockfile' }],
      }),
    );
    expect(md).toContain('**Merge risk:** HIGH');
    expect(md).toContain('#### Untrusted input and data flow\n- **🛑 Critical** User input reaches SQL unescaped.');
    expect(md).toContain('### Security checklist');
    expect(md).toContain('### Recommendations');
    expect(md).toContain('1 draft finding(s) dropped by the critic');
    expect(md).toContain('1 item(s) removed by the evidence check');
    expect(md).toContain('`package-lock.json`: lockfile');
    // The presentation already covers these.
    expect(md).not.toContain('**Blast radius:**');
    expect(md).not.toContain('| Severity | Location | Issue |');
    expect(md).not.toContain('### Details');
    // The testing section stays its own section, after the review.
    expect(md.indexOf('## 🧪 Testing')).toBeGreaterThan(md.indexOf('### Security checklist'));
  });
});
