import type { PullRef } from '../types';
import { withRetry } from '../utils/retry';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** True for 429 and for 403 responses that GitHub marks as (secondary) rate limiting. */
    readonly rateLimited = false,
    /** How long GitHub asked us to wait, from `retry-after` or `x-ratelimit-reset`. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

/** Rate limits and server errors are transient; any other 4xx (401, 404, 422, plain 403) will fail again. */
export function isRetryableGitHubError(error: GitHubError): boolean {
  return error.rateLimited || error.status === 429 || error.status >= 500;
}

export interface PullInfo {
  title: string;
  body: string;
  baseRef: string;
  headSha: string;
}

export interface PullFile {
  filename: string;
  previous_filename?: string;
  status: string;
  patch?: string;
  additions: number;
  deletions: number;
}

export interface InlineComment {
  path: string;
  line: number;
  body: string;
}

export interface ExistingReviewComment {
  path: string;
  line: number | null;
  body: string;
}

export interface RepositoryInfo {
  fullName: string;
  defaultBranch: string;
  private: boolean;
  /** What the token may do here; null when GitHub does not say (e.g. some app tokens). */
  permissions: { admin: boolean; push: boolean; pull: boolean } | null;
}

export interface ReleaseInfo {
  tag: string;
  name: string;
  body: string;
  url: string;
}

export interface GitHubClientOptions {
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  /** Retries after the first attempt for rate limits, 5xx and network errors (default 3). */
  retries?: number;
  /** First backoff delay; doubles per attempt (default 1000 ms). */
  retryBaseDelayMs?: number;
  /** Upper bound for any single wait, including one GitHub asks for (default 60 s). */
  maxRetryDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Clock for `x-ratelimit-reset`; mostly for tests. */
  now?: () => number;
}

export interface AuthenticatedUser {
  login: string;
  /** Classic token scopes, or null when GitHub does not report them (fine-grained and Actions tokens). */
  scopes: string[] | null;
  /** Raw `github-authentication-token-expiration` value, or null when the token has no reported expiry. */
  expiresAt: string | null;
}

export interface IssueComment {
  id: number;
  body?: string;
}

const PAGE_SIZE = 100;
const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_BASE_MS = 1_000;
const DEFAULT_MAX_RETRY_MS = 60_000;
/** Errors thrown by `fetch` itself (DNS, refused or reset connections); only these count as network failures. */
const NETWORK_ERRORS = new WeakSet<object>();
const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** The wait GitHub asks for: `retry-after` seconds, else the primary limit's reset time when it is exhausted. */
function retryAfterMs(headers: Headers, now: number): number | undefined {
  const retryAfter = headers.get('retry-after');
  if (retryAfter !== null && Number.isFinite(Number(retryAfter))) return Math.max(0, Number(retryAfter) * 1000);
  const reset = headers.get('x-ratelimit-reset');
  if (headers.get('x-ratelimit-remaining') === '0' && reset !== null && Number.isFinite(Number(reset))) {
    return Math.max(0, Number(reset) * 1000 - now);
  }
  return undefined;
}

function isRateLimited(status: number, headers: Headers, detail: string): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  return (
    headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after') || /secondary rate limit/i.test(detail)
  );
}

/** The contents API refuses files over 1 MB; there is no point reviewing those anyway. */
const MAX_CONTENT_BYTES = 1_000_000;

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export class GitHubClient {
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(private readonly options: GitHubClientOptions) {
    this.apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? Date.now;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    return (await this.requestWithHeaders<T>(method, path, body)).data;
  }

  private async requestWithHeaders<T>(method: string, path: string, body?: unknown): Promise<{ data: T; headers: Headers }> {
    const maxDelay = this.options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_MS;
    // withRetry picks an exponential delay; a wait GitHub asked for takes precedence over it.
    let hinted: number | undefined;
    const idempotent = method !== 'POST';
    return withRetry(
      () => this.attempt<T>(method, path, body),
      {
        retries: this.options.retries ?? DEFAULT_RETRIES,
        baseDelayMs: this.options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_MS,
        maxDelayMs: maxDelay,
        // A rate-limited request was never processed, so it is always safe to repeat. After a 5xx or a dropped
        // connection a POST may already have taken effect, and repeating it could post a review twice.
        isRetryable: error =>
          error instanceof GitHubError
            ? error.rateLimited || error.status === 429 || (idempotent && isRetryableGitHubError(error))
            : idempotent && typeof error === 'object' && error !== null && NETWORK_ERRORS.has(error),
        onRetry: error => {
          hinted = error instanceof GitHubError ? error.retryAfterMs : undefined;
        },
        sleep: ms => this.sleep(hinted === undefined ? ms : Math.min(hinted, maxDelay)),
      },
    );
  }

  private async attempt<T>(method: string, path: string, body?: unknown): Promise<{ data: T; headers: Headers }> {
    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${this.options.token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'gh-code-reviewer',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }).catch((error: unknown) => {
      if (typeof error === 'object' && error !== null) NETWORK_ERRORS.add(error);
      throw error;
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      const limited = isRateLimited(response.status, response.headers, detail);
      throw new GitHubError(
        `${method} ${path} failed with ${response.status}: ${detail.slice(0, 300)}`,
        response.status,
        limited,
        limited || response.status >= 500 ? retryAfterMs(response.headers, this.now()) : undefined,
      );
    }
    if (response.status === 204) return { data: undefined as T, headers: response.headers };
    return { data: (await response.json()) as T, headers: response.headers };
  }

  private async paginate<T>(path: string): Promise<T[]> {
    const all: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; ; page++) {
      const batch = await this.request<T[]>('GET', `${path}${sep}per_page=${PAGE_SIZE}&page=${page}`);
      all.push(...batch);
      if (batch.length < PAGE_SIZE) return all;
    }
  }

  private repoPath(ref: PullRef): string {
    return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
  }

  async getPull(ref: PullRef): Promise<PullInfo> {
    const pr = await this.request<{
      title: string;
      body: string | null;
      base: { ref: string };
      head: { sha: string };
    }>('GET', `${this.repoPath(ref)}/pulls/${ref.number}`);
    return { title: pr.title, body: pr.body ?? '', baseRef: pr.base.ref, headSha: pr.head.sha };
  }

  listPullFiles(ref: PullRef): Promise<PullFile[]> {
    return this.paginate<PullFile>(`${this.repoPath(ref)}/pulls/${ref.number}/files`);
  }

  /** File text at a commit, or null when missing, binary-sized or not a regular file. */
  async getFileContent(ref: PullRef, path: string, sha: string): Promise<string | null> {
    try {
      const file = await this.request<{ type: string; size: number; encoding?: string; content?: string }>(
        'GET',
        `${this.repoPath(ref)}/contents/${encodePath(path)}?ref=${encodeURIComponent(sha)}`,
      );
      if (file.type !== 'file' || file.size > MAX_CONTENT_BYTES || file.encoding !== 'base64' || !file.content) {
        return null;
      }
      return Buffer.from(file.content, 'base64').toString('utf8');
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }

  listReviewComments(ref: PullRef): Promise<ExistingReviewComment[]> {
    return this.paginate<ExistingReviewComment>(`${this.repoPath(ref)}/pulls/${ref.number}/comments`);
  }

  async createReview(ref: PullRef, commitId: string, body: string, comments: InlineComment[]): Promise<void> {
    await this.request('POST', `${this.repoPath(ref)}/pulls/${ref.number}/reviews`, {
      commit_id: commitId,
      body,
      event: 'COMMENT',
      comments: comments.map(c => ({ path: c.path, line: c.line, side: 'RIGHT', body: c.body })),
    });
  }

  listIssueComments(ref: PullRef): Promise<IssueComment[]> {
    return this.paginate<IssueComment>(`${this.repoPath(ref)}/issues/${ref.number}/comments`);
  }

  /** Edits the PR comment containing `marker` if there is one, otherwise posts a new one. */
  async upsertIssueComment(ref: PullRef, marker: string, body: string): Promise<'created' | 'updated'> {
    return this.upsertIssueCommentIn(ref, await this.listIssueComments(ref), marker, body);
  }

  /** Like `upsertIssueComment`, but searches a listing the caller already fetched (saves one request per part). */
  async upsertIssueCommentIn(
    ref: PullRef,
    comments: IssueComment[],
    marker: string,
    body: string,
  ): Promise<'created' | 'updated'> {
    const existing = comments.find(c => c.body?.includes(marker));
    if (existing) {
      await this.request('PATCH', `${this.repoPath(ref)}/issues/comments/${existing.id}`, { body });
      return 'updated';
    }
    await this.request('POST', `${this.repoPath(ref)}/issues/${ref.number}/comments`, { body });
    return 'created';
  }

  async deleteIssueComment(ref: PullRef, commentId: number): Promise<void> {
    await this.request('DELETE', `${this.repoPath(ref)}/issues/comments/${commentId}`);
  }

  /**
   * The token's user. Classic tokens report their scopes in `x-oauth-scopes`; fine-grained and
   * GitHub Actions tokens do not send the header, so `scopes` is null for them. Tokens with an expiry date
   * report it in `github-authentication-token-expiration`.
   */
  async getAuthenticatedUser(): Promise<AuthenticatedUser> {
    const { data, headers } = await this.requestWithHeaders<{ login: string }>('GET', '/user');
    const header = headers.get('x-oauth-scopes');
    const scopes = header === null ? null : header.split(',').map(s => s.trim()).filter(Boolean);
    const expiresAt = headers.get('github-authentication-token-expiration')?.trim() || null;
    return { login: data.login, scopes, expiresAt };
  }

  async getRepository(ref: { owner: string; repo: string }): Promise<RepositoryInfo> {
    const repo = await this.request<{
      full_name: string;
      default_branch: string;
      private: boolean;
      permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
    }>('GET', `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`);
    return {
      fullName: repo.full_name,
      defaultBranch: repo.default_branch,
      private: repo.private,
      permissions: repo.permissions
        ? { admin: !!repo.permissions.admin, push: !!repo.permissions.push, pull: !!repo.permissions.pull }
        : null,
    };
  }

  /** The newest published release, or null when the repository has none. */
  async getLatestRelease(owner: string, repo: string): Promise<ReleaseInfo | null> {
    try {
      const release = await this.request<{ tag_name: string; name: string | null; body: string | null; html_url: string }>(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/latest`,
      );
      return { tag: release.tag_name, name: release.name || release.tag_name, body: release.body ?? '', url: release.html_url };
    } catch (error) {
      if (error instanceof GitHubError && error.status === 404) return null;
      throw error;
    }
  }
}
