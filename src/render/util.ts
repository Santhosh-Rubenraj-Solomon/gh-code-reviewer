import type { Evidence, Finding } from '../types';

/** Keeps a value on one table row and stops `|` from starting a new cell. */
export const escapeCell = (text: string) => text.replace(/\r?\n+/g, ' ').replace(/\|/g, '\\|').trim();

export const location = (f: Pick<Finding, 'file' | 'line'>) => `\`${f.file}${f.line ? `:${f.line}` : ''}\``;
export const evidenceLocation = (e: Evidence) => `\`${e.file}${e.line ? `:${e.line}` : ''}\``;

/** Fenced code block whose fence is longer than any backtick run inside the code. */
export function fence(code: string, lang = '', indent = ''): string {
  const longest = Math.max(0, ...[...code.matchAll(/`+/g)].map(m => m[0].length));
  const ticks = '`'.repeat(Math.max(3, longest + 1));
  return [`${ticks}${lang}`, ...code.replace(/\s+$/, '').split('\n'), ticks].map(l => `${indent}${l}`).join('\n');
}

export function collapsible(title: string, rows: string[]): string[] {
  return rows.length ? [`<details><summary>${title}</summary>`, '', ...rows, '', '</details>', ''] : [];
}

export const quote = (text: string) => `> ${text.trim().replace(/\n/g, '\n> ')}`;

/** Guesses a fence language from a path so evidence renders with highlighting. */
export function langFor(path: string): string {
  const ext = /\.([a-z0-9]+)$/i.exec(path)?.[1]?.toLowerCase() ?? '';
  const map: Record<string, string> = {
    ts: 'ts',
    tsx: 'tsx',
    js: 'js',
    jsx: 'jsx',
    mjs: 'js',
    cjs: 'js',
    py: 'python',
    go: 'go',
    rs: 'rust',
    rb: 'ruby',
    java: 'java',
    kt: 'kotlin',
    swift: 'swift',
    sh: 'bash',
    yml: 'yaml',
    yaml: 'yaml',
    json: 'json',
    sql: 'sql',
  };
  return map[ext] ?? '';
}
