import { parsePatch } from '../diff';
import type { RepoFileProvider } from '../repo/provider';
import type {
  BlastRadius,
  ChangedFile,
  CodeSymbol,
  FileImpact,
  ImpactedFile,
  ImpactLevel,
  ImpactResult,
  SemanticChange,
  TestCoverage,
} from '../types';
import { DependencyGraph } from './dependency-graph';
import { EntityGraph, entityId, type FileFacts } from './entity-graph';
import { analyzeModule, isParserHealthy, languageFor, usesName } from './parser';

export interface AnalyzeOptions {
  maxDepth?: number;
  maxRepoFiles?: number;
  timeoutMs?: number;
  now?: () => number;
  /** Files read and parsed concurrently per step. */
  batchSize?: number;
}

/**
 * ImpactResult plus short code previews of impacted symbols, keyed `file::symbol`, so prompt formatting can
 * show the reviewer how dependents use the change. Assignable to ImpactResult.
 */
export type AnalyzedImpact = ImpactResult & { snippets: Record<string, string> };

const PREVIEW_CHARS = 300;
const PREVIEWS_PER_DEPENDENT = 3;

export function emptyImpact(notes: string[] = []): AnalyzedImpact {
  return {
    files: {},
    blastRadius: { level: 'low', description: 'No cross-file impact detected.', criticalPaths: [] },
    coverage: { untested: [], testsToUpdate: [], coveredBy: {} },
    semantic: [],
    edges: [],
    notes,
    snippets: {},
  };
}

// ---- pure helpers --------------------------------------------------------

const TEST_FILE_PATTERNS: RegExp[] = [
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /_test\.go$/,
  /(^|\/)test_[^/]+\.py$/,
  /_test\.py$/,
  /\.test\.dart$/,
  /Test\.kts?$/,
  /Tests?\.swift$/,
  /(^|\/)__tests__\//,
];

export function isTestFile(path: string): boolean {
  return TEST_FILE_PATTERNS.some(p => p.test(path));
}

const CODE_EXTENSIONS = /\.(?:[cm]?[jt]sx?|py|go|kt|kts|swift|dart|java|rb|rs|php|cs|c|cc|cpp|h|hpp|m|mm|scala|vue|svelte)$/i;

/** Lowercased file stem with test markers removed, used to pair `foo.ts` with `foo.test.ts` / `test_foo.py`. */
function stem(path: string): string {
  const base = path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');
  return base
    .replace(/\.(test|spec)$/, '')
    .replace(/^test_/, '')
    .replace(/_test$/, '')
    .replace(/Tests?$/, '')
    .toLowerCase();
}

export function impactLevel(dependents: number): ImpactLevel {
  if (dependents >= 10) return 'high';
  if (dependents >= 4) return 'medium';
  if (dependents >= 1) return 'low';
  return 'none';
}

export function blastRadiusFor(totalImpacts: number, criticalPaths: string[]): BlastRadius {
  const n = criticalPaths.length;
  const level: BlastRadius['level'] =
    totalImpacts >= 20 || n >= 3 ? 'critical' : totalImpacts >= 10 || n >= 2 ? 'high' : totalImpacts >= 5 ? 'medium' : 'low';
  const files = `${totalImpacts} dependent file${totalImpacts === 1 ? '' : 's'}`;
  const hubs = n > 0 ? `; ${n} changed file${n === 1 ? ' feeds' : 's feed'} several impacted symbols (${criticalPaths.join(', ')})` : '';
  const advice: Record<BlastRadius['level'], string> = {
    low: 'The change is well contained.',
    medium: 'Check the listed dependents for behavioural assumptions.',
    high: 'Many callers rely on the changed code; verify contracts and run the wider test suite.',
    critical: 'A large part of the codebase depends on this change; treat it as high risk and test broadly.',
  };
  return { level, criticalPaths, description: `${files} affected${hubs}. ${advice[level]}` };
}

/** New-side line numbers touched by the patch. A deletion marks the new-side line where it happened. */
export function touchedLines(patch: string): Set<number> {
  const lines = new Set<number>();
  for (const hunk of parsePatch(patch)) {
    let cursor = hunk.newStart;
    for (const line of hunk.lines) {
      if (line.kind === 'del') lines.add(cursor);
      else {
        if (line.kind === 'add' && line.newLine !== undefined) lines.add(line.newLine);
        cursor = (line.newLine ?? cursor) + 1;
      }
    }
  }
  return lines;
}

function addedLines(patch: string): Set<number> {
  const lines = new Set<number>();
  for (const hunk of parsePatch(patch)) {
    for (const l of hunk.lines) if (l.kind === 'add' && l.newLine !== undefined) lines.add(l.newLine);
  }
  return lines;
}

function overlaps(symbol: CodeSymbol, lines: Set<number>): boolean {
  for (let n = symbol.startLine; n <= symbol.endLine; n++) if (lines.has(n)) return true;
  return false;
}

function isNewFile(file: ChangedFile): boolean {
  return file.status === 'added' || /^--- \/dev\/null$/m.test(file.patch) || /^new file/m.test(file.patch);
}

function classify(file: ChangedFile, symbol: CodeSymbol, touched: Set<number>, added: Set<number>): SemanticChange['change'] {
  if (isNewFile(file)) return 'added';
  let allAdded = true;
  for (let n = symbol.startLine; n <= symbol.endLine; n++) if (!added.has(n)) allAdded = false;
  if (allAdded) return 'added';
  return overlaps(symbol, touched) ? 'modified' : 'unchanged';
}

// ---- analysis ------------------------------------------------------------

interface ParseOutcome {
  facts: Map<string, FileFacts>;
  timedOut: boolean;
}

async function parseRepo(
  provider: RepoFileProvider,
  files: string[],
  overrides: Map<string, string>,
  deadline: number,
  now: () => number,
  batchSize: number,
): Promise<ParseOutcome> {
  const facts = new Map<string, FileFacts>();
  // Changed files go first so a timeout still leaves their own symbols available.
  const ordered = [...files].sort((a, b) => Number(overrides.has(b)) - Number(overrides.has(a)));
  for (let i = 0; i < ordered.length; i += batchSize) {
    if (now() > deadline) return { facts, timedOut: true };
    const batch = ordered.slice(i, i + batchSize);
    const contents = await Promise.all(batch.map(p => (overrides.has(p) ? overrides.get(p) ?? null : provider.readFile(p).catch(() => null))));
    batch.forEach((path, j) => {
      const code = contents[j];
      if (code == null || !languageFor(path)) return;
      facts.set(path, analyzeModule(path, code));
    });
  }
  return { facts, timedOut: false };
}

function usedSymbolsIn(
  dependent: string,
  facts: Map<string, FileFacts>,
  graph: DependencyGraph,
  upstream: Set<string>,
  entityHits: Set<string>,
): string[] {
  const fileFacts = facts.get(dependent);
  if (!fileFacts) return [];
  const names: string[] = [];
  for (const imp of fileFacts.imports) {
    const target = graph.resolve(dependent, imp.source);
    if (target && upstream.has(target)) names.push(...imp.bindings.map(b => b.local).filter(n => n !== '*'));
  }
  const used = new Set<string>();
  for (const s of fileFacts.symbols) {
    if (entityHits.has(entityId(dependent, s.name)) || names.some(n => usesName(s.code, n))) used.add(s.name);
  }
  return [...used];
}

export async function analyzeImpact(
  provider: RepoFileProvider,
  changedFiles: ChangedFile[],
  options: AnalyzeOptions = {},
): Promise<AnalyzedImpact> {
  try {
    return await analyze(provider, changedFiles, options);
  } catch (err) {
    return emptyImpact([`Impact analysis failed: ${err instanceof Error ? err.message : String(err)}`]);
  }
}

async function analyze(provider: RepoFileProvider, changedFiles: ChangedFile[], options: AnalyzeOptions): Promise<AnalyzedImpact> {
  const maxDepth = options.maxDepth ?? 3;
  const maxRepoFiles = options.maxRepoFiles ?? 10_000;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const now = options.now ?? Date.now;
  const start = now();
  const notes: string[] = [];

  if (!isParserHealthy()) return emptyImpact(['Impact analysis skipped: the tree-sitter parser could not be loaded.']);

  const repoFiles = await provider.listFiles();
  if (repoFiles.length > maxRepoFiles) {
    return emptyImpact([
      `Impact analysis skipped: the repository has ${repoFiles.length} source files (limit ${maxRepoFiles}).`,
    ]);
  }

  const live = changedFiles.filter(f => f.status !== 'removed');
  const overrides = new Map<string, string>();
  for (const f of live) if (f.content !== undefined) overrides.set(f.path, f.content);
  const universe = new Set([...repoFiles, ...live.filter(f => languageFor(f.path)).map(f => f.path)]);
  // Removed files stay resolvable so their former importers still show up as impacted.
  const known = new Set([...universe, ...changedFiles.filter(f => f.status === 'removed').map(f => f.path)]);

  const { facts, timedOut } = await parseRepo(provider, [...universe], overrides, start + timeoutMs, now, options.batchSize ?? 50);
  if (timedOut) {
    notes.push(`Impact analysis is partial: parsed ${facts.size} of ${universe.size} files within the ${timeoutMs} ms budget.`);
  }

  const graph = new DependencyGraph(known);
  for (const [path, f] of facts) graph.addFile(path, f.imports);

  let entities: EntityGraph | null = null;
  const entityStart = now();
  try {
    entities = new EntityGraph(facts, graph);
    if (now() - entityStart > timeoutMs / 2) {
      entities = null;
      notes.push('Symbol-level graph dropped because it took too long; impact is file-level only.');
    }
  } catch (err) {
    notes.push(`Symbol-level graph failed (${err instanceof Error ? err.message : String(err)}); impact is file-level only.`);
  }

  const changedPaths = new Set(changedFiles.map(f => f.path));
  const result = emptyImpact(notes);
  const snippets: Record<string, string> = {};
  const allImpacted = new Set<string>();
  const criticalPaths: string[] = [];
  const testsFor = new Map<string, Set<string>>();

  for (const file of changedFiles) {
    const symbols = facts.get(file.path)?.symbols ?? [];
    const touched = touchedLines(file.patch);
    const added = addedLines(file.patch);
    const wholeFile = isNewFile(file) || parsePatch(file.patch).length === 0;

    const modified = wholeFile ? symbols : symbols.filter(s => overlaps(s, touched));
    const modifiedExports = modified.filter(s => s.exported);
    for (const s of symbols) {
      result.semantic.push({ path: file.path, symbol: s.name, change: classify(file, s, touched, added) });
    }

    const entityHits = new Set(entities?.impactedBy(modified.map(s => entityId(file.path, s.name))).keys() ?? []);
    const dependents = graph.dependentsOf([file.path], maxDepth);
    const byDepth = [...dependents.entries()].sort((a, b) => a[1].depth - b[1].depth || a[0].localeCompare(b[0]));

    const tests = new Set<string>();
    const impacted: ImpactedFile[] = [];
    const upstream = new Set([file.path]);
    let impactedSymbols = 0;
    for (const [path, { depth, via }] of byDepth) {
      if (isTestFile(path)) tests.add(path);
      if (changedPaths.has(path)) continue;
      // Names imported from the changed file or from anything already known to be impacted at a lower depth.
      const usedSymbols = usedSymbolsIn(path, facts, graph, upstream, entityHits).sort();
      upstream.add(path);
      impacted.push({ path, depth, kind: depth === 1 ? 'direct' : 'transitive', via, usedSymbols });
      impactedSymbols += usedSymbols.length;
      allImpacted.add(path);
      if (depth === 1) {
        for (const name of usedSymbols.slice(0, PREVIEWS_PER_DEPENDENT)) {
          const code = facts.get(path)?.symbols.find(s => s.name === name)?.code;
          if (code) snippets[entityId(path, name)] = code.length > PREVIEW_CHARS ? `${code.slice(0, PREVIEW_CHARS)}…` : code;
        }
      }
    }
    testsFor.set(file.path, tests);
    if (impactedSymbols >= 3) criticalPaths.push(file.path);

    const fileImpact: FileImpact = { path: file.path, modifiedExports, impacted, level: impactLevel(impacted.length) };
    result.files[file.path] = fileImpact;
  }

  result.blastRadius = blastRadiusFor(allImpacted.size, criticalPaths);
  result.coverage = coverageFor(changedFiles, testsFor);
  result.edges = graph.edgesWithin(new Set([...changedPaths, ...allImpacted]));
  result.snippets = snippets;
  return result;
}

function coverageFor(changedFiles: ChangedFile[], testsFor: Map<string, Set<string>>): TestCoverage {
  const changedTests = changedFiles.filter(f => f.status !== 'removed' && isTestFile(f.path)).map(f => f.path);
  const changedTestStems = new Set(changedTests.map(stem));
  const coverage: TestCoverage = { untested: [], testsToUpdate: [], coveredBy: {} };
  const toUpdate = new Set<string>();

  for (const file of changedFiles) {
    if (file.status === 'removed' || isTestFile(file.path) || !CODE_EXTENSIONS.test(file.path)) continue;
    const tests = [...(testsFor.get(file.path) ?? [])].sort();
    if (tests.length > 0) coverage.coveredBy[file.path] = tests;
    for (const t of tests) if (!changedTests.includes(t)) toUpdate.add(t);
    if (tests.length === 0 && !changedTestStems.has(stem(file.path))) coverage.untested.push(file.path);
  }
  coverage.testsToUpdate = [...toUpdate].sort();
  return coverage;
}
