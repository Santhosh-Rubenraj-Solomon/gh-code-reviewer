import type { GitHubClient, PullFile } from '../github/client';
import type { ChangedFile, ChangeSet, FileStatus, PullRef } from '../types';
import { mapLimit } from '../utils/pool';

function toStatus(status: string): FileStatus {
  if (status === 'added' || status === 'removed' || status === 'renamed') return status;
  // GitHub also reports 'modified', 'changed', 'copied' and 'unchanged'.
  return 'modified';
}

export function toChangedFile(file: PullFile): ChangedFile {
  return {
    path: file.filename,
    previousPath: file.previous_filename,
    status: toStatus(file.status),
    patch: file.patch ?? '',
    additions: file.additions,
    deletions: file.deletions,
  };
}

export async function loadPullRequest(
  github: GitHubClient,
  ref: PullRef,
  options: { withContent?: boolean } = {},
): Promise<ChangeSet> {
  const [pull, rawFiles] = await Promise.all([github.getPull(ref), github.listPullFiles(ref)]);
  const files = rawFiles.map(toChangedFile);

  if (options.withContent ?? true) {
    await mapLimit(files, 5, async file => {
      if (file.status === 'removed' || !file.patch) return;
      file.content = (await github.getFileContent(ref, file.path, pull.headSha)) ?? undefined;
    });
  }

  return {
    source: 'github',
    title: pull.title,
    description: pull.body,
    baseRef: pull.baseRef,
    headSha: pull.headSha,
    files,
    pull: ref,
  };
}
