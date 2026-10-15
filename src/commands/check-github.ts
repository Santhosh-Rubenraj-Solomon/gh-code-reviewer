import type { GitHubClient, RepositoryInfo } from '../github/client';
import type { PullRef } from '../types';

export type CheckClient = Pick<
  GitHubClient,
  'getAuthenticatedUser' | 'getPull' | 'listPullFiles' | 'getFileContent' | 'getRepository'
>;

const DAY_MS = 86_400_000;
/** Warn this long before a token stops working. */
const EXPIRY_WARNING_DAYS = 7;

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scopeLines(scopes: string[] | null): string[] {
  if (scopes === null) {
    return [
      'Token type: fine-grained or GitHub Actions token (no OAuth scopes reported)',
      'PR comments: need "Pull requests: Read and write" on the repository (Actions: permissions: pull-requests: write)',
    ];
  }
  const list = scopes.length ? scopes.join(', ') : '(none)';
  const coverage = scopes.includes('repo')
    ? 'yes, "repo" covers public and private repositories'
    : scopes.includes('public_repo')
      ? 'public repositories only ("public_repo"); private PRs need "repo"'
      : 'no - add the "repo" scope (or "public_repo" for public repositories)';
  return [`Token scopes: ${list}`, `Can post PR comments: ${coverage}`];
}

/** GitHub sends e.g. "2026-11-01 12:00:00 UTC" or "2026-11-01 12:00:00 -0700"; make it something Date can read. */
export function parseTokenExpiry(raw: string): number | null {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)\s*(UTC|Z|[+-]\d{2}:?\d{2})?$/i.exec(raw.trim());
  const iso = m
    ? `${m[1]}T${m[2]}${!m[3] || /^(utc|z)$/i.test(m[3]) ? 'Z' : m[3].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}`
    : raw;
  const time = Date.parse(iso);
  return Number.isNaN(time) ? null : time;
}

export function expiryLine(expiresAt: string | null, now: number): string {
  if (expiresAt === null) return 'Token expiry: none reported (the token does not expire, or GitHub does not say)';
  const time = parseTokenExpiry(expiresAt);
  if (time === null) return `Token expiry: ${expiresAt}`;
  if (time <= now) return `Token expiry: EXPIRED on ${expiresAt} - create a new token`;
  const days = Math.ceil((time - now) / DAY_MS);
  if (days <= EXPIRY_WARNING_DAYS) return `Token expiry: WARNING - expires in ${days} day(s), on ${expiresAt}`;
  return `Token expiry: ${expiresAt} (in ${days} days)`;
}

function hasRepoScope(scopes: string[] | null, isPrivate: boolean): boolean {
  if (scopes === null) return true; // fine-grained/Actions: not visible here, so do not claim a failure
  return scopes.includes('repo') || (!isPrivate && scopes.includes('public_repo'));
}

function permissionLines(repo: RepositoryInfo, scopes: string[] | null): string[] {
  const p = repo.permissions;
  if (!p) return ['  [skip] repository permissions: not reported for this token'];
  const flags = `admin=${p.admin ? 'yes' : 'no'}, push=${p.push ? 'yes' : 'no'}, pull=${p.pull ? 'yes' : 'no'}`;
  const out = [`  [${p.pull || p.push ? 'ok' : 'FAIL'}] repository permissions (${repo.fullName}): ${flags}`];
  const access = p.push || p.pull;
  const scoped = hasRepoScope(scopes, repo.private);
  const detail = !access
    ? 'no - the token has no read access to this repository'
    : !scoped
      ? `no - the token's scopes do not cover this ${repo.private ? 'private' : 'public'} repository`
      : scopes === null
        ? 'likely - also needs "Pull requests: Read and write" on a fine-grained or Actions token'
        : 'yes';
  out.push(`  [${access && scoped ? 'ok' : 'FAIL'}] post PR comments: ${detail}`);
  return out;
}

/** `ghr check-github [pr]`: who the token belongs to, what it may do, and (with a PR) whether it can read it. */
export async function checkGithubCommand(deps: {
  client: CheckClient;
  ref?: PullRef;
  now?: () => number;
}): Promise<string> {
  const out: string[] = [];
  let scopes: string[] | null = null;
  try {
    const user = await deps.client.getAuthenticatedUser();
    scopes = user.scopes;
    out.push(`Authenticated as: ${user.login}`, ...scopeLines(user.scopes), expiryLine(user.expiresAt, (deps.now ?? Date.now)()));
  } catch (error) {
    // Actions tokens cannot call /user, so this is not fatal for the PR checks below.
    out.push(`Authenticated user: unavailable (${describeError(error)})`);
  }
  const ref = deps.ref;
  if (!ref) return out.join('\n');

  out.push('', `Checks for ${ref.owner}/${ref.repo}#${ref.number}:`);
  const check = (label: string, ok: boolean, detail: string) => out.push(`  [${ok ? 'ok' : 'FAIL'}] ${label}: ${detail}`);

  try {
    out.push(...permissionLines(await deps.client.getRepository(ref), scopes));
  } catch (error) {
    // Not blocking: the pull request checks below say more precisely what is missing.
    check('read repository', false, describeError(error));
  }

  let headSha: string;
  try {
    const pull = await deps.client.getPull(ref);
    headSha = pull.headSha;
    check('read pull request', true, pull.title);
  } catch (error) {
    check('read pull request', false, describeError(error));
    return out.join('\n');
  }

  let files: Awaited<ReturnType<CheckClient['listPullFiles']>>;
  try {
    files = await deps.client.listPullFiles(ref);
    check('list changed files', true, `${files.length} file(s)`);
  } catch (error) {
    check('list changed files', false, describeError(error));
    return out.join('\n');
  }

  const sample = files.find(f => f.status !== 'removed');
  if (!sample) {
    out.push('  [skip] read file content: no added or modified files');
    return out.join('\n');
  }
  try {
    const content = await deps.client.getFileContent(ref, sample.filename, headSha);
    check('read file content', content !== null, content === null ? `${sample.filename} not readable` : sample.filename);
  } catch (error) {
    check('read file content', false, describeError(error));
  }
  return out.join('\n');
}
