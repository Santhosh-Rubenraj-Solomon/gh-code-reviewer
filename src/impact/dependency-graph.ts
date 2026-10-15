import { posix } from 'node:path';
import { SOURCE_EXTENSIONS, type ParsedImport } from './parser';

export interface Dependent {
  depth: number;
  /** The seed file this dependent was first reached from. */
  via: string;
}

// ESM TypeScript imports name the emitted file (`./foo.js`) while the repo holds `./foo.ts`.
const EMITTED_TO_SOURCE: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

/** File-level import graph over repository-relative paths. */
export class DependencyGraph {
  private readonly known: Set<string>;
  private readonly imports = new Map<string, Set<string>>();
  private readonly importedBy = new Map<string, Set<string>>();

  constructor(files: Iterable<string>) {
    this.known = new Set(files);
  }

  /** Resolves an import specifier written in `from` to a repository file, or null for packages/unknown paths. */
  resolve(from: string, source: string): string | null {
    let base: string;
    if (source.startsWith('.')) base = posix.normalize(posix.join(posix.dirname(from), source));
    else if (source.startsWith('/')) base = posix.normalize(source.slice(1));
    else return null;
    if (base.startsWith('..') || base === '.') return null;
    base = base.replace(/\/$/, '');

    const candidates = [base];
    const ext = posix.extname(base);
    for (const replacement of EMITTED_TO_SOURCE[ext] ?? []) candidates.push(base.slice(0, -ext.length) + replacement);
    for (const e of SOURCE_EXTENSIONS) candidates.push(base + e);
    for (const e of SOURCE_EXTENSIONS) candidates.push(`${base}/index${e}`);
    return candidates.find(c => this.known.has(c)) ?? null;
  }

  addFile(path: string, parsed: ParsedImport[]): void {
    for (const imp of parsed) {
      const target = this.resolve(path, imp.source);
      if (!target || target === path) continue;
      this.link(this.imports, path, target);
      this.link(this.importedBy, target, path);
    }
  }

  private link(map: Map<string, Set<string>>, key: string, value: string): void {
    let set = map.get(key);
    if (!set) map.set(key, (set = new Set()));
    set.add(value);
  }

  importsOf(path: string): string[] {
    return [...(this.imports.get(path) ?? [])];
  }

  importersOf(path: string): string[] {
    return [...(this.importedBy.get(path) ?? [])];
  }

  /** Breadth-first walk over importers, up to `maxDepth` hops, excluding the seeds themselves. */
  dependentsOf(paths: string[], maxDepth = 3): Map<string, Dependent> {
    const seeds = new Set(paths);
    const found = new Map<string, Dependent>();
    let frontier = paths.map(p => ({ path: p, via: p }));
    for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: typeof frontier = [];
      for (const { path, via } of frontier) {
        for (const importer of this.importedBy.get(path) ?? []) {
          if (seeds.has(importer) || found.has(importer)) continue;
          found.set(importer, { depth, via });
          next.push({ path: importer, via });
        }
      }
      frontier = next;
    }
    return found;
  }

  /** Import edges (`from` imports `to`) whose endpoints are both in `nodes`. */
  edgesWithin(nodes: Set<string>): { from: string; to: string }[] {
    const out: { from: string; to: string }[] = [];
    for (const from of nodes) {
      for (const to of this.imports.get(from) ?? []) if (nodes.has(to)) out.push({ from, to });
    }
    return out.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  }
}
