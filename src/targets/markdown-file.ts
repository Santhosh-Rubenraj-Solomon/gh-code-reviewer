import { spawn as nodeSpawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Persona } from '../personas';
import { renderCompleteMarkdown } from '../render/complete';
import type { ReviewReport } from '../types';

/** The part of a child process we use; lets tests pass a fake. */
export interface SpawnedChild {
  unref(): void;
  on?(event: 'error', listener: (error: Error) => void): unknown;
}
export type SpawnFn = (
  command: string,
  args: string[],
  options: { detached: boolean; stdio: 'ignore' },
) => SpawnedChild;

export interface MarkdownTargetOptions {
  dir: string;
  /** Identifies the review (PR number, branch, ...); sanitised into the file name. */
  id: string;
  persona?: Persona | null;
  /** Editor command to open the file with, e.g. `code` or `code -w`. Omit to not open anything. */
  openWith?: string;
  spawn?: SpawnFn;
  now?: () => Date;
  log?: (message: string) => void;
}

export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 120) || 'review';
}

/** Writes `review-<id>.md` into `dir` and optionally opens it in an editor without waiting for it. */
export async function writeMarkdownReport(report: ReviewReport, options: MarkdownTargetOptions): Promise<string> {
  const now = (options.now ?? (() => new Date()))();
  const path = join(options.dir, `review-${safeId(options.id)}.md`);
  const header =
    `<!-- gh-code-reviewer report · id: ${options.id.replace(/--+/g, '-')} · generated: ${now.toISOString()} · ` +
    `files: ${report.reviewedFiles.length} -->`;
  await mkdir(options.dir, { recursive: true });
  await writeFile(path, `${header}\n\n${renderCompleteMarkdown(report, options.persona)}`, 'utf8');

  if (options.openWith?.trim()) {
    // No shell: the editor command is split into words so the path is never interpreted.
    const [command, ...args] = options.openWith.trim().split(/\s+/);
    const spawn = options.spawn ?? (nodeSpawn as unknown as SpawnFn);
    try {
      const child = spawn(command!, [...args, path], { detached: true, stdio: 'ignore' });
      child.on?.('error', error => options.log?.(`could not open ${path}: ${error.message}`));
      child.unref();
    } catch (error) {
      options.log?.(`could not open ${path}: ${(error as Error).message}`);
    }
  }
  return path;
}
