import { z } from 'zod';
import type { ChangedFile } from '../types';
import type { StageDeps } from './deps';
import { isMarkdown } from './docs';

export interface ChangeIdentity {
  title: string;
  problem: string;
  solution: string;
}

export const MAX_FILE_DIFF_CHARS = 2_000;
export const MAX_PROMPT_DIFF_CHARS = 15_000;
const TITLE_TARGET = 80;
const TITLE_HARD_LIMIT = 100;

const IdentitySchema = z.object({
  title: z.string().min(1),
  problem: z.string(),
  solution: z.string(),
});

/** Keeps the start and end of a long diff, where signatures and returns usually are. */
export function headTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  const removed = text.length - half * 2;
  return `${text.slice(0, half)}\n…[${removed} characters omitted]…\n${text.slice(text.length - half)}`;
}

export function buildIdentifyPrompt(files: Pick<ChangedFile, 'path' | 'status' | 'patch'>[]): string {
  const sections: string[] = [];
  let used = 0;
  let included = 0;
  for (const file of files) {
    const section = `### ${file.path} (${file.status})\n\`\`\`diff\n${headTail(file.patch, MAX_FILE_DIFF_CHARS)}\n\`\`\``;
    if (included > 0 && used + section.length > MAX_PROMPT_DIFF_CHARS) break;
    sections.push(section);
    used += section.length;
    included++;
  }
  const rest = files.length - included;
  if (rest > 0) sections.push(`…and ${rest} more file${rest === 1 ? '' : 's'}`);
  return [
    'Name this change as if writing the title and description of its pull request.',
    `- title: imperative mood, at most ${TITLE_TARGET} characters, no trailing period;`,
    '- problem: one or two sentences on what was wrong or missing before;',
    '- solution: one or two sentences on how the change addresses it.',
    'Base everything on the diff; do not guess at motives the code does not show.',
    '',
    `Files changed (${files.length}):`,
    files.map(f => `- ${f.path}`).join('\n'),
    '',
    ...sections,
  ].join('\n');
}

const TEST_FILE = /(^|\/)(__tests__|tests?|spec)\/|\.(test|spec)\.[^/]+$|_test\.[^/]+$/i;
const CONFIG_FILE =
  /\.(json|ya?ml|toml|ini|cfg|conf|properties|env)$|(^|\/)\.[^/]+rc(\.[^/]+)?$|(^|\/)(Dockerfile|Makefile|\.gitignore|\.editorconfig)$/i;

function isDocFile(path: string): boolean {
  return isMarkdown(path) || /\.(txt|rst|adoc)$/i.test(path) || path.startsWith('docs/');
}

/** Title, problem and solution guessed from paths alone. */
export function heuristicIdentity(files: Pick<ChangedFile, 'path'>[]): ChangeIdentity {
  const paths = files.map(f => f.path);
  let title = 'Code changes';
  if (paths.length > 0 && paths.length <= 3) {
    if (paths.every(p => TEST_FILE.test(p))) title = 'Add or update tests';
    else if (paths.every(isDocFile)) title = 'Update documentation';
    else if (paths.every(p => CONFIG_FILE.test(p))) title = 'Update configuration';
  }
  if (title === 'Code changes') {
    const counts = new Map<string, number>();
    for (const p of paths) {
      if (!p.includes('/')) continue;
      const top = p.split('/')[0]!;
      counts.set(top, (counts.get(top) ?? 0) + 1);
    }
    const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
    if (top) title = `Changes in ${top[0]}`;
  }
  const n = paths.length;
  return {
    title,
    problem: 'Not stated; inferred from the changed files.',
    solution: `Modifies ${n} file${n === 1 ? '' : 's'}${n ? `: ${paths.slice(0, 5).join(', ')}${n > 5 ? ', …' : ''}` : ''}.`,
  };
}

function clampTitle(title: string): string {
  const t = title.trim().replace(/\s+/g, ' ').replace(/\.$/, '');
  return t.length <= TITLE_HARD_LIMIT ? t : `${t.slice(0, TITLE_HARD_LIMIT - 1).trimEnd()}…`;
}

/** Proposes a title and description for an unnamed change (e.g. a local diff or an empty PR title). */
export async function identifyChange(
  deps: StageDeps,
  files: Pick<ChangedFile, 'path' | 'status' | 'patch'>[],
): Promise<ChangeIdentity> {
  const fallback = heuristicIdentity(files);
  if (files.length === 0) return fallback;
  try {
    const result = await deps.llm.generateObject('identify', buildIdentifyPrompt(files), IdentitySchema);
    deps.cost.record('identify', result.model, result.usage);
    const title = clampTitle(result.object.title);
    if (!title) return fallback;
    return {
      title,
      problem: result.object.problem.trim() || fallback.problem,
      solution: result.object.solution.trim() || fallback.solution,
    };
  } catch (error) {
    deps.log(`could not identify the change, naming it from paths: ${(error as Error).message}`);
    return fallback;
  }
}
