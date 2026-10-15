import type { GitHubClient, ReleaseInfo } from '../github/client';

export type ReleaseClient = Pick<GitHubClient, 'getLatestRelease'>;

export interface ReleaseRepo {
  owner: string;
  repo: string;
}

/** Compares `1.2.3`-style versions (a leading `v` and pre-release suffixes are ignored). */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .trim()
      .replace(/^v/i, '')
      .split(/[-+]/)[0]!
      .split('.')
      .map(n => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

function noteLines(body: string, maxLines = 5, maxChars = 72): string[] {
  return body
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .map(l => (l.length <= maxChars ? l : `${l.slice(0, maxChars - 1)}…`));
}

/**
 * A one-off notice when a newer release exists, or null. It never prompts and never installs anything:
 * the user upgrades with their own package manager. Skipped in CI and when no release repo is configured;
 * any error or a slow API counts as "no notice".
 */
export async function updateCheck(deps: {
  client: ReleaseClient;
  repo?: ReleaseRepo;
  current: string;
  ci: boolean;
  timeoutMs?: number;
}): Promise<string | null> {
  if (deps.ci || !deps.repo) return null;
  const { owner, repo } = deps.repo;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), deps.timeoutMs ?? 3_000);
  });
  let release: ReleaseInfo | null;
  try {
    release = await Promise.race([deps.client.getLatestRelease(owner, repo).catch(() => null), timeout]);
  } finally {
    clearTimeout(timer);
  }
  if (!release || compareVersions(release.tag, deps.current) <= 0) return null;
  return [
    `A newer version is available: ${release.tag} (you have ${deps.current}).`,
    ...noteLines(release.body).map(l => `  ${l}`),
    `Release notes: ${release.url}`,
  ].join('\n');
}

/** `ghr changelog`: the latest release notes. */
export async function changelogCommand(deps: {
  client: ReleaseClient;
  repo?: ReleaseRepo;
  current: string;
}): Promise<string> {
  if (!deps.repo) return 'No release repository is configured, so there is no changelog to show.';
  const release = await deps.client.getLatestRelease(deps.repo.owner, deps.repo.repo);
  if (!release) return `${deps.repo.owner}/${deps.repo.repo} has no published releases yet.`;
  const cmp = compareVersions(release.tag, deps.current);
  const status =
    cmp > 0
      ? `You have ${deps.current}; ${release.tag} is newer.`
      : `You are on the latest release (${deps.current}).`;
  return [`${release.name} (${release.tag})`, release.url, '', release.body.trim() || '(no release notes)', '', status].join(
    '\n',
  );
}
