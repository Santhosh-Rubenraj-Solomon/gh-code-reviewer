import { commentableLines } from './diff';
import type { GitHubClient, InlineComment } from './github/client';
import { renderFinding, renderSummary, SUMMARY_MARKER } from './render/markdown';
import type { ChangeSet, Finding, PullRef, ReviewReport } from './types';

/** GitHub rejects a whole review if one comment is invalid, and large reviews are noisy. */
export const MAX_INLINE_COMMENTS = 30;

export interface CommentPlan {
  inline: { finding: Finding; comment: InlineComment }[];
  general: Finding[];
}

/** Inline only where GitHub will accept it: a line that is part of the diff. Everything else goes in the summary. */
export function planComments(report: ReviewReport, changeSet: ChangeSet): CommentPlan {
  const lineSets = new Map(changeSet.files.map(f => [f.path, commentableLines(f.patch)]));
  const plan: CommentPlan = { inline: [], general: [] };
  for (const finding of report.findings) {
    const canInline =
      finding.line !== undefined &&
      lineSets.get(finding.file)?.has(finding.line) &&
      plan.inline.length < MAX_INLINE_COMMENTS;
    if (canInline) {
      plan.inline.push({
        finding,
        comment: { path: finding.file, line: finding.line!, body: renderFinding(finding) },
      });
    } else {
      plan.general.push(finding);
    }
  }
  return plan;
}

export interface PublishResult {
  inlinePosted: number;
  duplicatesSkipped: number;
  summary: 'created' | 'updated';
}

export async function publishToGitHub(
  github: GitHubClient,
  ref: PullRef,
  report: ReviewReport,
  changeSet: ChangeSet,
): Promise<PublishResult> {
  const plan = planComments(report, changeSet);

  // Re-running on a new commit should not repeat comments that are already on the PR.
  const existing = plan.inline.length ? await github.listReviewComments(ref) : [];
  const fresh = plan.inline.filter(
    ({ comment, finding }) =>
      !existing.some(e => e.path === comment.path && e.line === comment.line && e.body.includes(finding.title)),
  );

  if (fresh.length) {
    await github.createReview(
      ref,
      report.headSha,
      `gh-code-reviewer left ${fresh.length} inline comment(s). See the summary comment for the overview.`,
      fresh.map(f => f.comment),
    );
  }

  const summary = await github.upsertIssueComment(ref, SUMMARY_MARKER, renderSummary(report, { detailed: plan.general }));
  return { inlinePosted: fresh.length, duplicatesSkipped: plan.inline.length - fresh.length, summary };
}
