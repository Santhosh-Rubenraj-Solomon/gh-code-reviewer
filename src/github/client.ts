import type { PullRef } from '../types';

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
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

export interface GitHubClientOptions {
  token: string;
  apiUrl?: string;
  fetch?: typeof fetch;
}

const PAGE_SIZE = 100;
/** The contents API refuses files over 1 MB; there is no point reviewing those anyway. */
const MAX_CONTENT_BYTES = 1_000_000;

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/');
}

export class GitHubClient {
  private readonly apiUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: GitHubClientOptions) {
    this.apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new GitHubError(`${method} ${path} failed with ${response.status}: ${detail.slice(0, 300)}`, response.status);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
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

  /** Edits the PR comment containing `marker` if there is one, otherwise posts a new one. */
  async upsertIssueComment(ref: PullRef, marker: string, body: string): Promise<'created' | 'updated'> {
    const comments = await this.paginate<{ id: number; body?: string }>(
      `${this.repoPath(ref)}/issues/${ref.number}/comments`,
    );
    const existing = comments.find(c => c.body?.includes(marker));
    if (existing) {
      await this.request('PATCH', `${this.repoPath(ref)}/issues/comments/${existing.id}`, { body });
      return 'updated';
    }
    await this.request('POST', `${this.repoPath(ref)}/issues/${ref.number}/comments`, { body });
    return 'created';
  }
}
