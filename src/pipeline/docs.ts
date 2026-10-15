import { z } from 'zod';
import { truncate, type StageDeps } from './deps';

const PROJECT_DOC = /^(readme|changelog|contributing|license|docs\/|\.github\/)/i;

export function isMarkdown(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}

/** Markdown that documents the project rather than shipping as part of it. */
export function isProjectDoc(path: string): boolean {
  return isMarkdown(path) && PROJECT_DOC.test(path);
}

/** Splits files into project documentation (summarised, not reviewed) and everything else. */
export function partitionDocs<T extends { path: string }>(files: T[]): { docOnly: T[]; reviewable: T[] } {
  const docOnly: T[] = [];
  const reviewable: T[] = [];
  for (const file of files) (isProjectDoc(file.path) ? docOnly : reviewable).push(file);
  return { docOnly, reviewable };
}

export interface DocsSummary {
  perFile: Record<string, string>;
  overall: string;
}

const DocsSummarySchema = z.object({
  files: z.array(z.object({ path: z.string(), summary: z.string() })),
  overall: z.string().min(1),
});

const PER_DOC_CHARS = 6_000;
const TOTAL_DOC_CHARS = 40_000;

export function buildDocsPrompt(docs: { path: string; content: string }[]): string {
  const parts: string[] = [];
  let used = 0;
  for (const doc of docs) {
    const remaining = TOTAL_DOC_CHARS - used;
    if (remaining <= 200) {
      parts.push(`### ${doc.path}\n(omitted: documentation budget used up)`);
      continue;
    }
    const body = truncate(doc.content, Math.min(PER_DOC_CHARS, remaining));
    used += body.length;
    parts.push(`### ${doc.path}\n${body}`);
  }
  return [
    'These documentation files changed in, or belong to, the repository under review.',
    'For each file write one or two sentences on what it explains that matters to someone reviewing code',
    '(architecture, conventions, constraints, setup). Then write a short overall summary of the project as',
    'the documentation describes it. Use each path exactly as shown.',
    '',
    ...parts,
  ].join('\n\n');
}

function headingOf(content: string): string {
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean);
  const heading = lines.find(l => l.startsWith('#'));
  return (heading ?? lines[0] ?? '(empty)').replace(/^#+\s*/, '').slice(0, 120);
}

/** Model-free summary: each file's first heading (or line) and how many sections it has. */
export function heuristicDocsSummary(docs: { path: string; content: string }[]): DocsSummary {
  const perFile: Record<string, string> = {};
  const topics: string[] = [];
  for (const doc of docs) {
    const title = headingOf(doc.content);
    const sections = doc.content.split('\n').filter(l => /^#{1,6}\s/.test(l)).length;
    const name = doc.path.split('/').pop() ?? doc.path;
    perFile[doc.path] = `${name}: ${title} (${sections} section${sections === 1 ? '' : 's'})`;
    topics.push(title);
  }
  return { perFile, overall: `Project documentation covering: ${topics.join('; ')}` };
}

export async function summarizeDocs(deps: StageDeps, docs: { path: string; content: string }[]): Promise<DocsSummary> {
  if (docs.length === 0) return { perFile: {}, overall: '' };
  try {
    const result = await deps.llm.generateObject('docs', buildDocsPrompt(docs), DocsSummarySchema);
    deps.cost.record('docs', result.model, result.usage);
    const known = new Set(docs.map(d => d.path));
    const perFile: Record<string, string> = {};
    for (const f of result.object.files) if (known.has(f.path) && f.summary.trim()) perFile[f.path] = f.summary.trim();
    const fallback = heuristicDocsSummary(docs).perFile;
    for (const doc of docs) perFile[doc.path] ??= fallback[doc.path]!;
    return { perFile, overall: result.object.overall.trim() };
  } catch (error) {
    deps.log(`docs summary failed, using headings instead: ${(error as Error).message}`);
    return heuristicDocsSummary(docs);
  }
}

/** One block of text for prompts: overall summary followed by per-file lines. */
export function formatDocsSummary(summary: DocsSummary): string {
  const lines = Object.entries(summary.perFile).map(([path, text]) => `- ${path}: ${text}`);
  return [summary.overall, ...lines].filter(Boolean).join('\n');
}
