import type { ChangedFile, FileStatus } from './types';

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  oldLine?: number;
  newLine?: number;
  text: string;
}

export interface Hunk {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function parsePatch(patch: string): Hunk[] {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of patch.split('\n')) {
    const header = HUNK_HEADER.exec(raw);
    if (header) {
      oldNo = Number(header[1]);
      newNo = Number(header[2]);
      current = { header: raw, oldStart: oldNo, newStart: newNo, lines: [] };
      hunks.push(current);
      continue;
    }
    if (!current || raw === '' || raw.startsWith('\\')) continue;

    const text = raw.slice(1);
    switch (raw[0]) {
      case '+':
        current.lines.push({ kind: 'add', newLine: newNo++, text });
        break;
      case '-':
        current.lines.push({ kind: 'del', oldLine: oldNo++, text });
        break;
      case ' ':
        current.lines.push({ kind: 'ctx', oldLine: oldNo++, newLine: newNo++, text });
        break;
    }
  }
  return hunks;
}

/**
 * New-file line numbers that appear in the diff. GitHub only accepts inline review
 * comments (side RIGHT) on these lines; anything else must go in the summary.
 */
export function commentableLines(patch: string): Set<number> {
  const lines = new Set<number>();
  for (const hunk of parsePatch(patch)) {
    for (const line of hunk.lines) {
      if (line.newLine !== undefined) lines.add(line.newLine);
    }
  }
  return lines;
}

/** Prefixes each line with its new-file line number so the model can cite real lines. */
export function annotatePatch(patch: string): string {
  const out: string[] = [];
  for (const hunk of parsePatch(patch)) {
    out.push(hunk.header);
    for (const line of hunk.lines) {
      const num = line.newLine === undefined ? '' : String(line.newLine);
      const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' ';
      out.push(`${num.padStart(5)} ${sign}${line.text}`);
    }
  }
  return out.join('\n');
}

export function countChanges(patch: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const hunk of parsePatch(patch)) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') additions++;
      else if (line.kind === 'del') deletions++;
    }
  }
  return { additions, deletions };
}

/** Splits `git diff` output into one ChangedFile per file. */
export function splitUnifiedDiff(diff: string): ChangedFile[] {
  const files: ChangedFile[] = [];
  const sections = diff.split(/^(?=diff --git )/m).filter(s => s.startsWith('diff --git '));

  for (const section of sections) {
    const lines = section.split('\n');
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(lines[0] ?? '');
    let oldPath = header?.[1];
    let newPath = header?.[2];
    let status: FileStatus = 'modified';

    for (const line of lines) {
      if (line.startsWith('@@')) break;
      if (line.startsWith('new file mode')) status = 'added';
      else if (line.startsWith('deleted file mode')) status = 'removed';
      else if (line.startsWith('rename from ')) {
        status = 'renamed';
        oldPath = line.slice('rename from '.length);
      } else if (line.startsWith('rename to ')) newPath = line.slice('rename to '.length);
      else if (line.startsWith('--- a/')) oldPath = line.slice(6);
      else if (line.startsWith('+++ b/')) newPath = line.slice(6);
    }

    const path = status === 'removed' ? oldPath : newPath;
    if (!path) continue;
    const hunkStart = lines.findIndex(l => l.startsWith('@@'));
    const patch = hunkStart === -1 ? '' : lines.slice(hunkStart).join('\n').replace(/\n+$/, '');
    files.push({
      path,
      previousPath: status === 'renamed' ? oldPath : undefined,
      status,
      patch,
      ...countChanges(patch),
    });
  }
  return files;
}
