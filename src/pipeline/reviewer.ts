import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { annotatePatch } from '../diff';
import { FINDING_CATEGORIES, SEVERITY_ORDER, type FileReview, type Finding, type Occurrence, type Severity } from '../types';
import { extractJson } from '../utils/json';
import type { BatchItem } from './batcher';
import { truncate, type StageDeps } from './deps';
import {
  dedupeRequests,
  fetchRequestedFiles,
  formatRequestedFiles,
  parseFileRequests,
  parseRequestLine,
  requestKey,
  type FetchOptions,
  type FileReader,
  type FileRequest,
} from './file-requests';

/** Bump when the prompt or output handling changes so cached batch results are not reused. */
export const REVIEW_PROMPT_VERSION = 'review-v2';

/** How many times the model may ask for more files before its answer is final. */
export const MAX_FILE_REQUEST_ROUNDS = 2;

export interface BatchCache {
  get(key: string): FileReview[] | undefined;
  put(key: string, value: FileReview[]): void | Promise<void>;
}

export interface ReviewContext {
  title: string;
  description: string;
  docsSummary?: string;
  summaries: Record<string, string>;
  /** Rules that apply to every file; shown once per batch. */
  rules?: string;
  /** Rules for one file. If every file in a batch gets the same text it is shown once. */
  rulesFor?: (path: string) => string;
  securityContextFor?: (path: string) => { name: string; instructions: string };
  /** Ripple-effect description for one file (who uses what it changed). */
  impactFor?: (path: string) => string;
  /** Enables the file-request capability. */
  reader?: FileReader;
  symbolSource?: FetchOptions['symbolSource'];
  cache?: BatchCache;
  /** Extra text mixed into the batch cache key, e.g. the review model id and its settings. */
  cacheSalt?: string;
  /** When set (and GHR_NO_DEBUG is not), unparseable model answers are saved here for inspection. */
  debugDir?: string;
}

// ---- output parsing -------------------------------------------------------

const LineSchema = z.union([z.number(), z.string()]);

const LooseFindingSchema = z.object({
  file: z.string().optional().nullable(),
  line: LineSchema.optional().nullable(),
  severity: z.string().optional().nullable(),
  category: z.string().optional().nullable(),
  title: z.string().optional().nullable(),
  explanation: z.string().optional().nullable(),
  observation: z.string().optional().nullable(),
  evidence: z.string().optional().nullable(),
  suggestion: z.string().optional().nullable(),
  impact: z.string().optional().nullable(),
  occurrences: z
    .array(z.object({ line: LineSchema, snippet: z.string().optional().nullable() }))
    .optional()
    .nullable(),
});

const LooseFileReviewSchema = z.object({
  path: z.string(),
  whatChanged: z.string().optional().nullable(),
  findings: z.array(z.unknown()).optional().nullable(),
  positives: z.array(z.unknown()).optional().nullable(),
  testingRecommendations: z.array(z.unknown()).optional().nullable(),
});

const ReviewResponseSchema = z.object({
  fileReviews: z.array(LooseFileReviewSchema),
  additionalFilesNeeded: z
    .object({ files: z.array(z.string()).optional().nullable(), reason: z.string().optional().nullable() })
    .optional()
    .nullable(),
});

const POSITIVE_MARKERS = new Set(['positive', 'praise', 'strength', 'good', 'kudos']);

function parseLine(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isInteger(value) && value > 0 ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const match = /(\d+)/.exec(value);
  const n = match ? Number(match[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

const SEVERITY_SYNONYMS: Record<string, Severity> = {
  blocker: 'critical',
  severe: 'critical',
  major: 'high',
  error: 'high',
  moderate: 'medium',
  warning: 'medium',
  minor: 'low',
  info: 'low',
  note: 'low',
  trivial: 'low',
};

/** Models sometimes use their own scale; map common words so `--fail-on` is not silently weakened. */
function normalizeSeverity(value: string | null | undefined): Severity {
  const v = (value ?? '').trim().toLowerCase();
  if ((SEVERITY_ORDER as string[]).includes(v)) return v as Severity;
  return SEVERITY_SYNONYMS[v] ?? 'medium';
}

function normalizeCategory(value: string | null | undefined): string {
  const v = (value ?? '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  return (FINDING_CATEGORIES as readonly string[]).includes(v) ? v : 'improvement';
}

/** Text from a string, or from the obvious field of an object, never "[object Object]". */
function textOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (value && typeof value === 'object') {
    const o = value as Record<string, unknown>;
    for (const key of ['text', 'description', 'recommendation', 'message', 'note', 'title']) {
      if (typeof o[key] === 'string') return (o[key] as string).trim();
    }
    return JSON.stringify(value);
  }
  return value === undefined || value === null ? '' : String(value);
}

interface ParsedResponse {
  reviews: Map<string, FileReview>;
  requests: FileRequest[];
}

function isPositive(raw: z.infer<typeof LooseFindingSchema>): boolean {
  const sev = (raw.severity ?? '').trim().toLowerCase();
  const cat = (raw.category ?? '').trim().toLowerCase();
  return POSITIVE_MARKERS.has(sev) || POSITIVE_MARKERS.has(cat);
}

function toFinding(raw: z.infer<typeof LooseFindingSchema>, file: string): Finding | null {
  const explanation = (raw.explanation ?? raw.observation ?? '').trim();
  const title = (raw.title ?? '').trim() || explanation.split(/(?<=[.!?])\s/)[0]!.slice(0, 100).trim();
  const evidence = (raw.evidence ?? '').trim();
  if (!title || !evidence) return null;
  const occurrences: Occurrence[] = (raw.occurrences ?? []).flatMap(o => {
    const line = parseLine(o.line);
    return line ? [{ line, snippet: (o.snippet ?? '').trim() }] : [];
  });
  const finding: Finding = {
    file,
    severity: normalizeSeverity(raw.severity),
    category: normalizeCategory(raw.category),
    title,
    explanation: explanation || title,
    evidence,
  };
  const line = parseLine(raw.line) ?? occurrences[0]?.line;
  if (line) finding.line = line;
  if (raw.suggestion?.trim()) finding.suggestion = raw.suggestion.trim();
  if (raw.impact?.trim()) finding.impact = raw.impact.trim();
  if (occurrences.length) finding.occurrences = occurrences;
  return finding;
}

export function parseReviewResponse(text: string, batchPaths: Set<string>, log: (m: string) => void): ParsedResponse {
  const parsed = ReviewResponseSchema.parse(extractJson(text));
  const reviews = new Map<string, FileReview>();
  const reviewFor = (path: string): FileReview => {
    let review = reviews.get(path);
    if (!review) {
      review = { path, status: 'ok', whatChanged: '', findings: [], positives: [], testingRecommendations: [] };
      reviews.set(path, review);
    }
    return review;
  };

  for (const raw of parsed.fileReviews) {
    if (!batchPaths.has(raw.path)) {
      log(`dropping review for unknown file "${raw.path}"`);
      continue;
    }
    const review = reviewFor(raw.path);
    if (raw.whatChanged?.trim()) review.whatChanged = raw.whatChanged.trim();
    review.positives.push(...(raw.positives ?? []).map(textOf).filter(Boolean));
    review.testingRecommendations.push(...(raw.testingRecommendations ?? []).map(textOf).filter(Boolean));

    for (const item of raw.findings ?? []) {
      const loose = LooseFindingSchema.safeParse(item);
      if (!loose.success) {
        log(`dropping malformed finding in ${raw.path}`);
        continue;
      }
      if (isPositive(loose.data)) {
        const note = (loose.data.explanation ?? loose.data.observation ?? loose.data.title ?? '').trim();
        if (note) review.positives.push(note);
        continue;
      }
      const target = loose.data.file?.trim() || raw.path;
      if (!batchPaths.has(target)) {
        log(`dropping finding for unknown file "${target}"`);
        continue;
      }
      const finding = toFinding(loose.data, target);
      if (!finding) {
        log(`dropping finding without a title or evidence in ${raw.path}`);
        continue;
      }
      reviewFor(target).findings.push(finding);
    }
  }

  const asked = (parsed.additionalFilesNeeded?.files ?? []).flatMap(line => {
    const request = parseRequestLine(line);
    return request ? [request] : [];
  });
  return { reviews, requests: dedupeRequests([...asked, ...parseFileRequests(text)]) };
}

// ---- prompt ---------------------------------------------------------------

function sharedRules(batch: BatchItem[], context: ReviewContext): string | null {
  if (!context.rulesFor || batch.length === 0) return null;
  const texts = batch.map(item => context.rulesFor!(item.file.path).trim());
  return texts.every(t => t === texts[0]) ? texts[0]! : null;
}

const OUTPUT_FORMAT = `## Answer format
Reply with one JSON object and nothing else:
{
  "fileReviews": [
    {
      "path": "<a path from this batch>",
      "whatChanged": "<two or three sentences on what the change does>",
      "findings": [
        {
          "category": "${FINDING_CATEGORIES.join(' | ')}",
          "severity": "critical | high | medium | low",
          "title": "<short name of the problem>",
          "explanation": "<why it is wrong and when it fails>",
          "evidence": "<the problematic code copied exactly from the diff>",
          "line": <new-file line number from the left column>,
          "impact": "<what users or the system experience if it ships>",
          "suggestion": "<a concrete fix>",
          "occurrences": [{ "line": <number>, "snippet": "<code>" }]
        }
      ],
      "positives": ["<things done well>"],
      "testingRecommendations": ["<specific tests worth adding>"]
    }
  ],
  "additionalFilesNeeded": { "files": [], "reason": "" }
}
Rules for the answer:
- Include one entry in fileReviews for every file in the batch, even when it has no findings.
- \`evidence\` is copied from the diff without the line number or the +/- marker.
- severity: critical = exploitable or destroys data; high = wrong behaviour users will hit;
  medium = an edge-case bug or a real maintainability risk; low = minor but still a real defect.
- \`findings\` holds problems only. Anything positive goes in \`positives\`, never in \`findings\`.
- \`occurrences\` lists other lines in the same file with the same problem; omit it otherwise.
- An empty findings list is a good outcome when nothing is wrong.`;

function fileRequestNote(): string {
  return [
    '## Reading other files',
    'If you cannot judge a change without seeing code outside this batch (a called function, a type, a caller),',
    'ask for it before concluding. Either list paths in `additionalFilesNeeded.files` or add a block such as',
    '<file_requests>',
    'src/db/client.ts',
    'src/auth/session.ts:validateToken',
    '</file_requests>',
    'with one `path` or `path:symbol` per line (repository-relative). You will get the files and be asked again,',
    `at most ${MAX_FILE_REQUEST_ROUNDS} times. Still return your best review of every file each time.`,
  ].join('\n');
}

export function buildReviewPrompt(batch: BatchItem[], context: ReviewContext): string {
  const parts: string[] = [
    '## Pull request',
    `Title: ${context.title}`,
    context.description ? `Description:\n${truncate(context.description, 4_000)}` : 'Description: (none)',
  ];

  if (context.docsSummary?.trim()) {
    parts.push('', '## Project documentation (summary)', truncate(context.docsSummary.trim(), 4_000));
  }

  const shared = sharedRules(batch, context);
  const globalRules = context.rules?.trim();
  if (globalRules || shared) {
    parts.push('', "## This team's review rules");
    if (globalRules) parts.push(globalRules);
    if (shared && shared !== globalRules) parts.push(shared);
  }

  parts.push('', '## Files in this batch');
  for (const { file, includeContent } of batch) {
    parts.push('', `### ${file.path} (${file.status})`);
    const summary = context.summaries[file.path];
    if (summary) parts.push(`Summary: ${summary}`);

    const security = context.securityContextFor?.(file.path);
    if (security) parts.push(`Security focus (${security.name}): ${security.instructions}`);

    if (context.rulesFor && shared === null) {
      const rules = context.rulesFor(file.path).trim();
      if (rules && rules !== globalRules) parts.push('Rules for this file:', rules);
    }

    parts.push('Diff, with the new-file line number in the left column:', '```diff', annotatePatch(file.patch), '```');
    if (includeContent && file.content) {
      parts.push('Whole file after the change, for context:', '```', file.content, '```');
    }

    const impact = context.impactFor?.(file.path)?.trim();
    if (impact) parts.push('Ripple effects (code elsewhere that depends on this change):', impact);
  }

  if (context.reader) parts.push('', fileRequestNote());
  parts.push('', OUTPUT_FORMAT);
  return parts.join('\n');
}

function followUpPrompt(base: string, supplements: string[], round: number): string {
  return [
    base,
    '',
    ...supplements,
    '',
    `## Follow-up ${round}`,
    'The files you asked for are above. Review the batch again with this extra context and answer in the same',
    'JSON format, covering every file in the batch.',
  ].join('\n');
}

// ---- review ---------------------------------------------------------------

type CacheKeyContext = Pick<
  ReviewContext,
  'rulesFor' | 'rules' | 'title' | 'description' | 'docsSummary' | 'securityContextFor' | 'impactFor' | 'cacheSalt'
>;

/**
 * Everything that shapes the review prompt (or the model answering it) goes into the key, so a cached
 * answer is only reused when the model would have been asked exactly the same thing.
 */
export function batchCacheKey(batch: BatchItem[], context: Partial<CacheKeyContext> = {}): string {
  const hash = createHash('sha256');
  const add = (label: string, value: string): void => {
    hash.update(`\0${label}\0`);
    hash.update(value);
  };
  add('version', REVIEW_PROMPT_VERSION);
  add('salt', context.cacheSalt ?? '');
  add('title', context.title ?? '');
  add('description', context.description ?? '');
  add('docs', context.docsSummary ?? '');
  add('rules', context.rules ?? '');
  for (const { file, includeContent } of batch) {
    const security = context.securityContextFor?.(file.path);
    add('path', file.path);
    add('patch', file.patch);
    add('content', includeContent ? (file.content ?? '') : '');
    add('file-rules', context.rulesFor?.(file.path) ?? '');
    add('security', security ? `${security.name}\n${security.instructions}` : '');
    add('impact', context.impactFor?.(file.path) ?? '');
  }
  return hash.digest('hex');
}

function isCritical(error: unknown): boolean {
  return error instanceof Error && error.name === 'CriticalFailureError';
}

function failed(batch: BatchItem[], error: unknown): FileReview[] {
  const message = error instanceof Error ? error.message : String(error);
  const status = /timed?\s?out|timeout/i.test(message) ? 'timeout' : 'error';
  const advice = status === 'timeout' ? ' (retry, or review fewer files per batch)' : '';
  return batch.map(item => ({
    path: item.file.path,
    status,
    whatChanged: '',
    findings: [],
    positives: [],
    testingRecommendations: [],
    error: `${message}${advice}`,
  }));
}

/**
 * Saves a model answer that could not be parsed, so a failing review can be diagnosed after the fact.
 * Returns the file path, or null when dumping is off or the write failed (a debug aid must never break a review).
 */
export async function dumpRawResponse(
  debugDir: string | undefined,
  text: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  if (!debugDir || env.GHR_NO_DEBUG) return null;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  try {
    await mkdir(debugDir, { recursive: true });
    // Parallel batches can fail in the same millisecond; `wx` refuses to overwrite, so try a suffix.
    for (let n = 0; n < 100; n++) {
      const path = join(debugDir, `review-response-${stamp}${n ? `-${n}` : ''}.txt`);
      try {
        await writeFile(path, text, { flag: 'wx' });
        return path;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Deep review of one batch. Returns one FileReview per file, in batch order. Model and parse
 * errors become per-file error/timeout results; only a CriticalFailureError is thrown.
 */
export async function reviewBatch(deps: StageDeps, batch: BatchItem[], context: ReviewContext): Promise<FileReview[]> {
  if (batch.length === 0) return [];
  const key = context.cache ? batchCacheKey(batch, context) : '';
  const hit = context.cache?.get(key);
  if (hit) {
    deps.log(`review: reusing cached result for ${batch.length} file(s)`);
    return hit;
  }

  const paths = new Set(batch.map(item => item.file.path));
  const ask = async (prompt: string): Promise<ParsedResponse> => {
    const result = await deps.llm.generateText('review', prompt);
    deps.cost.record('review', result.model, result.usage);
    try {
      return parseReviewResponse(result.text, paths, deps.log);
    } catch (error) {
      const dumped = await dumpRawResponse(context.debugDir, result.text);
      if (dumped) deps.log(`review: could not parse the model answer; raw text saved to ${dumped}`);
      throw error;
    }
  };

  const base = buildReviewPrompt(batch, context);
  let response: ParsedResponse;
  try {
    response = await ask(base);
  } catch (error) {
    if (isCritical(error)) throw error;
    deps.log(`review of ${batch.length} file(s) failed: ${(error as Error).message}`);
    return failed(batch, error);
  }

  const merged = new Map(response.reviews);
  if (context.reader) {
    const fetched = new Set<string>();
    const supplements: string[] = [];
    for (let round = 1; round <= MAX_FILE_REQUEST_ROUNDS; round++) {
      const fresh = response.requests.filter(r => !fetched.has(requestKey(r)));
      if (fresh.length === 0) break;
      for (const r of fresh) fetched.add(requestKey(r));
      deps.log(`review: model asked for ${fresh.length} more file(s), round ${round}`);
      const results = await fetchRequestedFiles(fresh, context.reader, { symbolSource: context.symbolSource });
      supplements.push(formatRequestedFiles(results));
      try {
        response = await ask(followUpPrompt(base, supplements, round));
      } catch (error) {
        if (isCritical(error)) throw error;
        deps.log(`review follow-up ${round} failed, keeping the earlier answer: ${(error as Error).message}`);
        break;
      }
      // A later answer saw more context, so it replaces earlier reviews of the same file.
      for (const [path, review] of response.reviews) merged.set(path, review);
    }
  }

  let complete = true;
  const reviews = batch.map(({ file }) => {
    const review = merged.get(file.path);
    if (review) {
      if (!review.whatChanged) review.whatChanged = context.summaries[file.path] ?? `Changes to ${file.path}`;
      return review;
    }
    complete = false;
    const summary = context.summaries[file.path] ?? `Changes to ${file.path}`;
    return {
      path: file.path,
      status: 'ok' as const,
      whatChanged: `${summary} (the reviewer returned no detailed review for this file)`,
      findings: [],
      positives: [],
      testingRecommendations: [],
    };
  });

  if (context.cache && complete) await context.cache.put(key, reviews);
  return reviews;
}
