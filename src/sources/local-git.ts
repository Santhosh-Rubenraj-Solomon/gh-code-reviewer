import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { splitUnifiedDiff } from '../diff';
import type { ChangeSet } from '../types';

export type GitRunner = (args: string[], cwd: string) => string;

export const runGit: GitRunner = (args, cwd) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

export interface LocalOptions {
  base?: string;
  cwd?: string;
  git?: GitRunner;
  readText?: (path: string) => string | null;
}

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/** Reviews committed work on the current branch against the merge base with `base`. */
export function loadLocalChanges(options: LocalOptions = {}): ChangeSet {
  const cwd = options.cwd ?? process.cwd();
  const git = options.git ?? runGit;
  const read = options.readText ?? readIfExists;
  const base = options.base ?? 'origin/main';

  const mergeBase = git(['merge-base', base, 'HEAD'], cwd).trim();
  const headSha = git(['rev-parse', 'HEAD'], cwd).trim();
  const diff = git(['diff', '--no-color', '--find-renames', mergeBase, 'HEAD'], cwd);
  const subject = git(['log', '-1', '--format=%s'], cwd).trim();
  const body = git(['log', `${mergeBase}..HEAD`, '--format=- %s'], cwd).trim();

  const files = splitUnifiedDiff(diff);
  for (const file of files) {
    if (file.status !== 'removed') file.content = read(join(cwd, file.path)) ?? undefined;
  }

  return {
    source: 'local',
    title: subject || `Changes since ${base}`,
    description: body,
    baseRef: base,
    headSha,
    files,
  };
}
