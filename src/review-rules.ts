import { globProblem, matchesAny } from './utils/glob';
import { estimateTokens } from './utils/tokens';

export interface RuleFile {
  path: string;
  content: string;
}

export interface ReviewRule {
  path: string;
  /** Empty for global rules. */
  globs: string[];
  global: boolean;
  body: string;
}

export interface RuleLimits {
  maxFileChars: number;
  maxTotalChars: number;
}

export const DEFAULT_RULE_LIMITS: RuleLimits = { maxFileChars: 10_000, maxTotalChars: 50_000 };

/** The team-wide rule file that applies to everything regardless of frontmatter. */
export const ALWAYS_GLOBAL_RULE_FILE = '.github/code-review.md';

export interface ParsedRuleFile {
  globs: string[];
  body: string;
  /** Set when the frontmatter could not be understood. */
  error?: string;
}

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

function parseInlineList(value: string): { globs: string[]; error?: string } {
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed) && parsed.every(g => typeof g === 'string')) return { globs: parsed };
  } catch {
    // Not strict JSON; accept the common unquoted form `[src/**, lib/*.ts]`.
  }
  const inner = value.trim();
  if (!inner.startsWith('[') || !inner.endsWith(']')) return { globs: [], error: `cannot read globs: ${value}` };
  const items = inner
    .slice(1, -1)
    .split(',')
    .map(unquote)
    .filter(Boolean);
  return { globs: items };
}

/** Splits optional `---` frontmatter from the body and reads its `globs:` key. */
export function parseRuleFile(content: string): ParsedRuleFile {
  const normalized = content.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const fm = /^---[^\S\n]*\n([\s\S]*?)\n---[^\S\n]*(?:\n|$)/.exec(normalized);
  if (!fm) return { globs: [], body: normalized.trim() };

  const body = normalized.slice(fm[0].length).trim();
  const lines = fm[1]!.split('\n');
  const index = lines.findIndex(l => /^globs\s*:/.test(l));
  if (index === -1) return { globs: [], body };

  const rest = lines[index]!.replace(/^globs\s*:/, '').trim();
  if (rest.startsWith('[')) {
    const { globs, error } = parseInlineList(rest);
    return { globs, body, error };
  }
  if (rest) return { globs: [unquote(rest)].filter(Boolean), body };

  const globs: string[] = [];
  for (const line of lines.slice(index + 1)) {
    const item = /^\s*-\s*(.*)$/.exec(line);
    if (!item) break;
    const glob = unquote(item[1]!);
    if (glob) globs.push(glob);
  }
  return { globs, body };
}

function isGlobal(path: string, globs: string[]): boolean {
  return path === ALWAYS_GLOBAL_RULE_FILE || globs.length === 0 || (globs.length === 1 && globs[0] === '*');
}

function section(rule: ReviewRule): string {
  return `### Rules from ${rule.path}\n${rule.body}`;
}

/** Team review rules, each either global or scoped to files by glob. */
export class RuleSet {
  private perFile = new Map<string, string>();

  constructor(
    readonly rules: ReviewRule[],
    readonly skipped: { path: string; reason: string }[] = [],
  ) {}

  get globalRules(): ReviewRule[] {
    return this.rules.filter(r => r.global);
  }

  scopedRulesFor(path: string): ReviewRule[] {
    return this.rules.filter(r => !r.global && matchesAny(path, r.globs));
  }

  /** Global rules plus the scoped rules whose globs match `path`. */
  forFile(path: string): string {
    let text = this.perFile.get(path);
    if (text === undefined) {
      text = [...this.globalRules, ...this.scopedRulesFor(path)].map(section).join('\n\n');
      this.perFile.set(path, text);
    }
    return text;
  }

  /** Only the scoped rules for `path`, for callers that show the global rules once elsewhere. */
  scopedFor(path: string): string {
    return this.scopedRulesFor(path).map(section).join('\n\n');
  }

  globalText(): string {
    return this.globalRules.map(section).join('\n\n');
  }

  /** Tokens the file-specific (non-global) rules add to a file's review. */
  tokensForFile(path: string, count: (text: string) => number = estimateTokens): number {
    const text = this.scopedFor(path);
    return text ? count(text) : 0;
  }

  /** Tokens the global rules add to every review batch once. */
  globalTokens(count: (text: string) => number = estimateTokens): number {
    const text = this.globalText();
    return text ? count(text) : 0;
  }

  get isEmpty(): boolean {
    return this.rules.length === 0;
  }
}

/**
 * Builds a RuleSet from rule files (e.g. `.review/*.md` and `.github/code-review.md`).
 * Files are taken in path order; oversized, empty, malformed, or over-budget files are skipped with a reason.
 */
export function loadRuleSet(files: RuleFile[], limits: Partial<RuleLimits> = {}): RuleSet {
  const { maxFileChars, maxTotalChars } = { ...DEFAULT_RULE_LIMITS, ...limits };
  const rules: ReviewRule[] = [];
  const skipped: { path: string; reason: string }[] = [];
  let total = 0;

  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    if (file.content.length > maxFileChars) {
      skipped.push({ path: file.path, reason: `larger than ${maxFileChars} characters (${file.content.length})` });
      continue;
    }
    const parsed = parseRuleFile(file.content);
    if (parsed.error) {
      skipped.push({ path: file.path, reason: parsed.error });
      continue;
    }
    if (!parsed.body) {
      skipped.push({ path: file.path, reason: 'no rule text after the frontmatter' });
      continue;
    }
    const bad = parsed.globs.map(g => [g, globProblem(g)] as const).find(([, problem]) => problem);
    if (bad) {
      skipped.push({ path: file.path, reason: `invalid glob "${bad[0]}": ${bad[1]}` });
      continue;
    }
    if (total + parsed.body.length > maxTotalChars) {
      skipped.push({ path: file.path, reason: `total rule size would exceed ${maxTotalChars} characters` });
      continue;
    }
    total += parsed.body.length;
    const global = isGlobal(file.path, parsed.globs);
    rules.push({ path: file.path, globs: global ? [] : parsed.globs, global, body: parsed.body });
  }
  return new RuleSet(rules, skipped);
}
