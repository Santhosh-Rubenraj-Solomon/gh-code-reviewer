import { commentableLines } from './diff';
import { GitHubError, type GitHubClient, type InlineComment } from './github/client';
import { personaByKey, type Persona } from './personas';
import {
  hasTestingContent,
  renderFinding,
  renderPresentationReport,
  renderSummary,
  renderTesting,
  reviewFooter,
  SUMMARY_MARKER,
  TESTING_MARKER,
} from './render/markdown';
import type { ChangeSet, Finding, PullRef, ReviewReport } from './types';

/** GitHub rejects a whole review if one comment is invalid, and large reviews are noisy. */
export const MAX_INLINE_COMMENTS = 30;
/** GitHub's comment limit is 65 536 characters; stay well below it. */
export const MAX_COMMENT_CHARS = 60_000;

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

/** Marker for part `n` (1-based). Part 1 keeps the base marker so single-part comments stay compatible. */
export function partMarker(marker: string, part: number): string {
  return part === 1 ? marker : marker.replace(/\s*-->$/, `:part-${part} -->`);
}

/**
 * Splits a body into parts that each fit in one comment, cutting at line boundaries and
 * closing/reopening any code fence that a cut lands in. Each part starts with its own marker.
 */
export function splitCommentBody(marker: string, body: string, maxChars = MAX_COMMENT_CHARS): string[] {
  const content = body.startsWith(marker) ? body.slice(marker.length).replace(/^\n/, '') : body;
  if (content.length + marker.length + 1 <= maxChars) return [`${marker}\n${content}`];

  // Room for the part marker, the "Part i of n" line and a closing fence.
  const budget = Math.max(200, maxChars - marker.length - 80);
  const chunks: string[] = [];
  let current: string[] = [];
  let size = 0;
  let openFence: string | null = null;

  const flush = () => {
    if (!current.length) return;
    if (openFence) current.push(openFence.replace(/[^`~]/g, ''));
    chunks.push(current.join('\n'));
    current = openFence ? [openFence] : [];
    size = current.reduce((n, l) => n + l.length + 1, 0);
  };

  for (const rawLine of content.split('\n')) {
    // A single line longer than the budget is hard-wrapped.
    const pieces = rawLine.length > budget ? rawLine.match(new RegExp(`[\\s\\S]{1,${budget}}`, 'g'))! : [rawLine];
    for (const line of pieces) {
      if (size + line.length + 1 > budget) flush();
      current.push(line);
      size += line.length + 1;
      if (/^\s*(`{3,}|~{3,})/.test(line)) openFence = openFence ? null : line.trim();
    }
  }
  openFence = null;
  flush();

  return chunks.map((chunk, i) => `${partMarker(marker, i + 1)}\n<sub>Part ${i + 1} of ${chunks.length}</sub>\n\n${chunk}`);
}

const DOC_FILE = /\.(md|mdx|markdown|rst|adoc|txt)$/i;
const CODE_FILE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|kts|swift|dart|c|cc|cpp|h|hpp|cs|php|scala|sh)$/i;

/** A polite nudge when code changed but no documentation did; null when it does not apply. */
export function docsNotice(changeSet: ChangeSet): string | null {
  const live = changeSet.files.filter(f => f.status !== 'removed');
  if (live.some(f => DOC_FILE.test(f.path))) return null;
  if (!live.some(f => CODE_FILE.test(f.path))) return null;
  return (
    '> 📝 **Docs:** this pull request changes code but no documentation. If it changes behaviour that users or ' +
    'other developers rely on, a README or docs update helps them keep up.'
  );
}

export interface PublishOptions {
  /** Persona used to render `report.presentation`; defaults to the persona named in the presentation. */
  persona?: Persona | null;
  /** Append a short note when code changed but no docs did (opt-in). */
  docsNotice?: boolean;
  /** Per-comment size limit; mostly for tests. */
  maxCommentChars?: number;
}

export interface PublishResult {
  inlinePosted: number;
  duplicatesSkipped: number;
  summary: 'created' | 'updated';
  summaryParts: number;
  testing?: 'created' | 'updated';
  /** Testing comments (all parts) deleted because this report has no testing content. */
  testingRemoved?: number;
}

function summaryBody(report: ReviewReport, plan: CommentPlan, changeSet: ChangeSet, options: PublishOptions): string {
  let body: string;
  if (report.presentation) {
    const persona = options.persona ?? personaByKey(report.presentation.persona);
    body = [SUMMARY_MARKER, renderPresentationReport(report, report.presentation, persona), '', reviewFooter(report)].join(
      '\n',
    );
  } else {
    body = renderSummary(report, { detailed: plan.general });
  }
  const notice = options.docsNotice ? docsNotice(changeSet) : null;
  return notice ? `${body}\n\n${notice}` : body;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Part numbers (>= 2) of `marker` that appear in a comment body. */
function partNumbers(marker: string, body: string): number[] {
  const sentinel = '9999999';
  const [before, after] = partMarker(marker, Number(sentinel)).split(sentinel).map(escapeRegExp);
  return [...body.matchAll(new RegExp(`${before}(\\d+)${after}`, 'g'))].map(m => Number(m[1]));
}

/**
 * Posts or edits each part, then deletes parts left over from an earlier, longer run so a shrinking
 * summary does not leave stale "Part 3 of 3" comments behind. Comments are listed once for all of it.
 */
async function upsertParts(github: GitHubClient, ref: PullRef, marker: string, body: string, max: number) {
  const parts = splitCommentBody(marker, body, max);
  const comments = await github.listIssueComments(ref);
  let first: 'created' | 'updated' = 'created';
  for (const [i, part] of parts.entries()) {
    const result = await github.upsertIssueCommentIn(ref, comments, partMarker(marker, i + 1), part);
    if (i === 0) first = result;
  }
  const kept = new Set(
    parts
      .map((_, i) => comments.find(c => c.body?.includes(partMarker(marker, i + 1)))?.id)
      .filter((id): id is number => id !== undefined),
  );
  const stale = comments.filter(c => !kept.has(c.id) && partNumbers(marker, c.body ?? '').some(k => k > parts.length));
  for (const comment of stale) await github.deleteIssueComment(ref, comment.id);
  return { result: first, parts: parts.length, deleted: stale.length, comments };
}

/** Deletes every comment carrying `marker` or one of its part markers; returns how many were deleted. */
async function removeParts(
  github: GitHubClient,
  ref: PullRef,
  marker: string,
  comments: { id: number; body?: string | null }[],
): Promise<number> {
  const ours = comments.filter(c => (c.body ?? '').includes(marker) || partNumbers(marker, c.body ?? '').length > 0);
  for (const comment of ours) await github.deleteIssueComment(ref, comment.id);
  return ours.length;
}

export async function publishToGitHub(
  github: GitHubClient,
  ref: PullRef,
  report: ReviewReport,
  changeSet: ChangeSet,
  options: PublishOptions = {},
): Promise<PublishResult> {
  const plan = planComments(report, changeSet);
  const max = options.maxCommentChars ?? MAX_COMMENT_CHARS;

  // Re-running on a new commit should not repeat comments that are already on the PR. After a push, older
  // comments become "outdated" (line null), so a matching title on the same file counts as already posted.
  const existing = plan.inline.length ? await github.listReviewComments(ref) : [];
  const fresh = plan.inline.filter(
    ({ comment, finding }) =>
      !existing.some(
        e => e.path === comment.path && (e.line === comment.line || e.line === null) && e.body.includes(finding.title),
      ),
  );

  // GitHub rejects the whole review if any one inline comment is invalid (422). The summary must still go
  // out, so those findings are moved into it instead of failing the run.
  let inlinePosted = fresh.length;
  if (fresh.length) {
    try {
      await github.createReview(
        ref,
        report.headSha,
        `gh-code-reviewer left ${fresh.length} inline comment(s). See the summary comment for the overview.`,
        fresh.map(f => f.comment),
      );
    } catch (error) {
      if (!(error instanceof GitHubError) || error.status !== 422) throw error;
      plan.general.push(...fresh.map(f => f.finding));
      inlinePosted = 0;
    }
  }

  const summary = await upsertParts(github, ref, SUMMARY_MARKER, summaryBody(report, plan, changeSet, options), max);
  const result: PublishResult = {
    inlinePosted,
    duplicatesSkipped: plan.inline.length - fresh.length,
    summary: summary.result,
    summaryParts: summary.parts,
  };
  if (hasTestingContent(report)) {
    result.testing = (await upsertParts(github, ref, TESTING_MARKER, renderTesting(report), max)).result;
  } else {
    // An earlier run's test plan would otherwise stay on the PR, describing code that no longer needs it.
    const removed = await removeParts(github, ref, TESTING_MARKER, summary.comments);
    if (removed) result.testingRemoved = removed;
  }
  return result;
}
