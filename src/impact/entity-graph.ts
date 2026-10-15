import type { CodeSymbol } from '../types';
import type { DependencyGraph } from './dependency-graph';
import { extractReferences, type ParsedImport } from './parser';

export const MAX_IMPACTED_ENTITIES = 500;
const MAX_REEXPORT_HOPS = 5;

export const entityId = (file: string, name: string) => `${file}::${name}`;

export interface FileFacts {
  symbols: CodeSymbol[];
  imports: ParsedImport[];
  defaultExport?: string | null;
}

/**
 * Symbol-level dependency graph. A reference from symbol S (in file F) to name N resolves, in order, to:
 *  1. a symbol named N declared in F itself;
 *  2. the export behind F's import binding N (following `export … from` re-exports);
 *  3. an exported N from any file F imports (covers namespace imports and wildcard re-exports);
 *  4. only when N is bound by an import that does not resolve to a repo path (aliases such as `@/x`),
 *     any exported N in the repository.
 * Plain name matches without an import are ignored, which removes most false edges between unrelated files.
 */
export class EntityGraph {
  private readonly referencedBy = new Map<string, Set<string>>();
  private readonly exportedByName = new Map<string, string[]>();
  private readonly facts: Map<string, FileFacts>;

  constructor(
    facts: Map<string, FileFacts>,
    private readonly files: DependencyGraph,
  ) {
    this.facts = facts;
    for (const [file, { symbols }] of facts) {
      for (const s of symbols) {
        if (!s.exported) continue;
        const list = this.exportedByName.get(s.name) ?? [];
        list.push(file);
        this.exportedByName.set(s.name, list);
      }
    }
    for (const [file, fileFacts] of facts) this.linkFile(file, fileFacts);
  }

  private hasExport(file: string, name: string): boolean {
    return this.facts.get(file)?.symbols.some(s => s.exported && s.name === name) ?? false;
  }

  /** Finds the file that actually declares export `name` of `file`, walking re-exports. */
  resolveExport(file: string, name: string, hops = 0): string | null {
    if (name === 'default') {
      const local = this.facts.get(file)?.defaultExport;
      if (local && this.facts.get(file)?.symbols.some(s => s.name === local)) return entityId(file, local);
    }
    if (this.hasExport(file, name)) return entityId(file, name);
    if (hops >= MAX_REEXPORT_HOPS) return null;
    for (const imp of this.facts.get(file)?.imports ?? []) {
      if (imp.kind !== 'reexport') continue;
      const target = this.files.resolve(file, imp.source);
      if (!target) continue;
      for (const b of imp.bindings) {
        if (b.local === name && b.imported !== '*') {
          const found = this.resolveExport(target, b.imported, hops + 1);
          if (found) return found;
        } else if (b.local === '*') {
          const found = this.resolveExport(target, name, hops + 1);
          if (found) return found;
        }
      }
    }
    return null;
  }

  private linkFile(file: string, { symbols, imports }: FileFacts): void {
    const local = new Set(symbols.map(s => s.name));
    const bound = new Map<string, { target: string | null; imported: string }>();
    const importedFiles: string[] = [];
    for (const imp of imports) {
      if (imp.kind === 'reexport') continue;
      const target = this.files.resolve(file, imp.source);
      if (target) importedFiles.push(target);
      for (const b of imp.bindings) bound.set(b.local, { target, imported: b.imported });
    }

    for (const symbol of symbols) {
      const from = entityId(file, symbol.name);
      for (const ref of extractReferences(symbol.code, symbol.name, true)) {
        for (const to of this.resolveReference(file, ref, local, bound, importedFiles)) {
          if (to !== from) this.addEdge(from, to);
        }
      }
    }
  }

  private resolveReference(
    file: string,
    ref: string,
    local: Set<string>,
    bound: Map<string, { target: string | null; imported: string }>,
    importedFiles: string[],
  ): string[] {
    if (local.has(ref)) return [entityId(file, ref)];
    const binding = bound.get(ref);
    if (binding?.target) {
      // Namespace/CommonJS bindings stand for the whole module; members are matched via rule 3 instead.
      if (binding.imported === '*') return [];
      const found = this.resolveExport(binding.target, binding.imported);
      return found ? [found] : [];
    }
    if (binding && !binding.target) {
      return (this.exportedByName.get(ref) ?? []).map(f => entityId(f, ref));
    }
    for (const target of importedFiles) {
      const found = this.resolveExport(target, ref);
      if (found) return [found];
    }
    return [];
  }

  private addEdge(from: string, to: string): void {
    let set = this.referencedBy.get(to);
    if (!set) this.referencedBy.set(to, (set = new Set()));
    set.add(from);
  }

  referrersOf(id: string): string[] {
    return [...(this.referencedBy.get(id) ?? [])];
  }

  /** Entities that (transitively) reference any seed, with their hop distance; seeds are excluded. */
  impactedBy(seeds: string[], cap = MAX_IMPACTED_ENTITIES): Map<string, number> {
    const visited = new Set(seeds);
    const found = new Map<string, number>();
    let frontier = [...seeds];
    for (let depth = 1; frontier.length > 0 && found.size < cap; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const referrer of this.referencedBy.get(id) ?? []) {
          if (visited.has(referrer)) continue;
          visited.add(referrer);
          found.set(referrer, depth);
          next.push(referrer);
          if (found.size >= cap) return found;
        }
      }
      frontier = next;
    }
    return found;
  }
}
