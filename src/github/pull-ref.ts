import type { PullRef } from '../types';

const URL_FORM = /^https?:\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;
const SHORT_FORM = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/** Accepts `https://github.com/owner/repo/pull/12` (any host, for GHE) or `owner/repo#12`. */
export function parsePullRef(input: string): PullRef {
  const match = URL_FORM.exec(input.trim()) ?? SHORT_FORM.exec(input.trim());
  if (!match) {
    throw new Error(`Cannot read "${input}" as a pull request; use a PR URL or owner/repo#number`);
  }
  return { owner: match[1]!, repo: match[2]!, number: Number(match[3]) };
}

export function formatPullRef(ref: PullRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/**
 * Inside a GitHub Actions run triggered by pull_request (or pull_request_target),
 * the PR number lives in the event payload at GITHUB_EVENT_PATH.
 */
export function pullRefFromActions(
  env: Record<string, string | undefined>,
  readText: (path: string) => string,
): PullRef | null {
  const repository = env.GITHUB_REPOSITORY;
  const eventPath = env.GITHUB_EVENT_PATH;
  if (!repository || !eventPath) return null;

  const event = JSON.parse(readText(eventPath)) as { pull_request?: { number?: number } };
  const number = event.pull_request?.number;
  if (!number) return null;

  const [owner, repo] = repository.split('/');
  if (!owner || !repo) return null;
  return { owner, repo, number };
}
