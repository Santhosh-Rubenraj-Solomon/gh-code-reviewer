import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { truncate } from './pipeline/deps';

function readIfExists(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

/**
 * Collects team review rules (e.g. `.github/code-review.md`) from the repository
 * checkout so the reviewer applies house conventions rather than generic advice.
 */
export function loadRules(
  files: string[],
  cwd: string,
  readText: (path: string) => string | null = readIfExists,
  maxChars = 20_000,
): string | undefined {
  const sections: string[] = [];
  for (const file of files) {
    const text = readText(join(cwd, file))?.trim();
    if (text) sections.push(`<!-- from ${file} -->\n${text}`);
  }
  return sections.length ? truncate(sections.join('\n\n'), maxChars) : undefined;
}
