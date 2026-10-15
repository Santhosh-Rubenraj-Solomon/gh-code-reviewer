import { createRequire } from 'node:module';
import type { CodeSymbol } from '../types';

/**
 * Tree-sitter front end for TypeScript and JavaScript. Native grammars are loaded lazily and any failure
 * (missing prebuild, parse crash) degrades to empty results so impact analysis never breaks a review.
 *
 * Kotlin, Swift and Dart are intentionally not supported: their imports are package/module names, which
 * never resolve to repository files with path-based resolution, so parsing them added cost and no edges.
 */

export type Language = 'typescript' | 'tsx' | 'javascript';

export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'] as const;

const LANGUAGE_BY_EXTENSION: Record<string, Language> = {
  '.ts': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.tsx': 'tsx',
  // The TSX grammar is a superset of JSX, so .jsx parses fine with the JavaScript grammar.
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
};

export function languageFor(path: string): Language | null {
  const dot = path.lastIndexOf('.');
  if (dot === -1 || dot < path.lastIndexOf('/')) return null;
  return LANGUAGE_BY_EXTENSION[path.slice(dot).toLowerCase()] ?? null;
}

// ---- native binding ------------------------------------------------------

interface Point {
  row: number;
  column: number;
}

/** The subset of tree-sitter's SyntaxNode this module relies on. */
export interface SyntaxNode {
  type: string;
  text: string;
  startPosition: Point;
  endPosition: Point;
  namedChildren: SyntaxNode[];
  parent: SyntaxNode | null;
  hasError: boolean;
  childForFieldName(name: string): SyntaxNode | null;
}

interface NativeParser {
  setLanguage(language: unknown): void;
  parse(input: string | ((index: number) => string | null)): { rootNode: SyntaxNode };
}

type ParserCtor = new () => NativeParser;

const requireNative = createRequire(import.meta.url);
const parsers = new Map<Language, NativeParser | null>();

function loadGrammar(language: Language): unknown {
  if (language === 'javascript') return requireNative('tree-sitter-javascript');
  const ts = requireNative('tree-sitter-typescript') as { typescript: unknown; tsx: unknown };
  return language === 'tsx' ? ts.tsx : ts.typescript;
}

function parserFor(language: Language): NativeParser | null {
  if (parsers.has(language)) return parsers.get(language) ?? null;
  let parser: NativeParser | null = null;
  try {
    const Parser = requireNative('tree-sitter') as ParserCtor;
    parser = new Parser();
    parser.setLanguage(loadGrammar(language));
  } catch {
    parser = null;
  }
  parsers.set(language, parser);
  return parser;
}

// The native binding rejects very long strings passed directly, so large inputs are streamed in chunks.
const CHUNK = 16 * 1024;

export function parse(path: string, code: string): SyntaxNode | null {
  const language = languageFor(path);
  if (!language) return null;
  const parser = parserFor(language);
  if (!parser) return null;
  try {
    const tree = code.length < CHUNK ? parser.parse(code) : parser.parse(i => (i < code.length ? code.slice(i, i + CHUNK) : null));
    return tree.rootNode;
  } catch {
    return null;
  }
}

export function isParserHealthy(): boolean {
  const root = parse('health.ts', 'const probe: number = 1;');
  return root !== null && root.type === 'program' && !root.hasError;
}

function* walk(root: SyntaxNode): Generator<SyntaxNode> {
  const stack = [root];
  while (stack.length > 0) {
    const node = stack.pop() as SyntaxNode;
    yield node;
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as SyntaxNode);
  }
}

function stringValue(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  if (node.type === 'string') return node.text.slice(1, -1);
  if (node.type === 'template_string' && !node.namedChildren.some(c => c.type === 'template_substitution')) {
    return node.text.slice(1, -1);
  }
  return null;
}

// ---- imports -------------------------------------------------------------

export type ImportKind = 'import' | 'require' | 'dynamic' | 'reexport';

export interface ImportBinding {
  /** Name as exported by the source module: 'default', '*' for namespaces/wildcards, or the export name. */
  imported: string;
  /** Name bound in the importing file. */
  local: string;
}

export interface ParsedImport {
  source: string;
  /** Local names this import binds (for re-exports, the names re-exported). */
  names: string[];
  kind: ImportKind;
  bindings: ImportBinding[];
}

function importClauseBindings(clause: SyntaxNode): ImportBinding[] {
  const out: ImportBinding[] = [];
  for (const child of clause.namedChildren) {
    if (child.type === 'identifier') out.push({ imported: 'default', local: child.text });
    else if (child.type === 'namespace_import') {
      const id = child.namedChildren.find(c => c.type === 'identifier');
      if (id) out.push({ imported: '*', local: id.text });
    } else if (child.type === 'named_imports') {
      for (const spec of child.namedChildren) {
        if (spec.type !== 'import_specifier') continue;
        const name = spec.childForFieldName('name')?.text;
        const alias = spec.childForFieldName('alias')?.text;
        if (name) out.push({ imported: name, local: alias ?? name });
      }
    }
  }
  return out;
}

function exportClauseBindings(statement: SyntaxNode): ImportBinding[] {
  const clause = statement.namedChildren.find(c => c.type === 'export_clause');
  if (!clause) {
    const ns = statement.namedChildren.find(c => c.type === 'namespace_export');
    const id = ns?.namedChildren.find(c => c.type === 'identifier' || c.type === 'string');
    return [{ imported: '*', local: id ? id.text : '*' }];
  }
  const out: ImportBinding[] = [];
  for (const spec of clause.namedChildren) {
    if (spec.type !== 'export_specifier') continue;
    const name = spec.childForFieldName('name')?.text;
    const alias = spec.childForFieldName('alias')?.text;
    if (name) out.push({ imported: name, local: alias ?? name });
  }
  return out;
}

/** Names bound by `const x = require('y')` / `const { a, b: c } = await import('y')`. */
function declaratorBindings(call: SyntaxNode): ImportBinding[] {
  let node: SyntaxNode | null = call.parent;
  while (node && (node.type === 'await_expression' || node.type === 'parenthesized_expression')) node = node.parent;
  if (!node || node.type !== 'variable_declarator') return [];
  const target = node.childForFieldName('name');
  if (!target) return [];
  if (target.type === 'identifier') return [{ imported: '*', local: target.text }];
  if (target.type !== 'object_pattern') return [];
  const out: ImportBinding[] = [];
  for (const prop of target.namedChildren) {
    if (prop.type === 'shorthand_property_identifier_pattern') out.push({ imported: prop.text, local: prop.text });
    else if (prop.type === 'pair_pattern') {
      const key = prop.childForFieldName('key')?.text;
      const value = prop.childForFieldName('value');
      if (key && value?.type === 'identifier') out.push({ imported: key, local: value.text });
    }
  }
  return out;
}

function toImport(source: string, kind: ImportKind, bindings: ImportBinding[]): ParsedImport {
  return { source, kind, bindings, names: bindings.map(b => b.local).filter(n => n !== '*') };
}

export function extractImports(path: string, code: string): ParsedImport[] {
  const root = parse(path, code);
  return root ? importsFromRoot(root) : [];
}

function importsFromRoot(root: SyntaxNode): ParsedImport[] {
  const out: ParsedImport[] = [];
  try {
    for (const node of walk(root)) {
      if (node.type === 'import_statement') {
        const source = stringValue(node.childForFieldName('source'));
        if (source === null) continue;
        const clause = node.namedChildren.find(c => c.type === 'import_clause');
        out.push(toImport(source, 'import', clause ? importClauseBindings(clause) : []));
      } else if (node.type === 'export_statement') {
        const source = stringValue(node.childForFieldName('source'));
        if (source !== null) out.push(toImport(source, 'reexport', exportClauseBindings(node)));
      } else if (node.type === 'call_expression') {
        const fn = node.childForFieldName('function');
        const args = node.childForFieldName('arguments');
        const source = stringValue(args?.namedChildren[0]);
        if (!fn || source === null) continue;
        if (fn.type === 'identifier' && fn.text === 'require') out.push(toImport(source, 'require', declaratorBindings(node)));
        else if (fn.type === 'import') out.push(toImport(source, 'dynamic', declaratorBindings(node)));
      }
    }
  } catch {
    return out;
  }
  return out;
}

// ---- symbols -------------------------------------------------------------

const DECLARATION_KINDS: Record<string, string> = {
  function_declaration: 'function',
  generator_function_declaration: 'function',
  function_signature: 'function',
  class_declaration: 'class',
  abstract_class_declaration: 'class',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
};

const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);

function symbolFrom(outer: SyntaxNode, name: string, kind: string, exported: boolean): CodeSymbol {
  return {
    name,
    kind,
    exported,
    startLine: outer.startPosition.row + 1,
    endLine: outer.endPosition.row + 1,
    code: outer.text,
  };
}

function declarationSymbols(node: SyntaxNode, outer: SyntaxNode, exported: boolean): CodeSymbol[] {
  const kind = DECLARATION_KINDS[node.type];
  if (kind) {
    const name = node.childForFieldName('name')?.text;
    return name ? [symbolFrom(outer, name, kind, exported)] : [];
  }
  if (node.type === 'lexical_declaration' || node.type === 'variable_declaration') {
    const keyword = node.type === 'variable_declaration' ? 'var' : node.text.startsWith('let') ? 'let' : 'const';
    const out: CodeSymbol[] = [];
    for (const declarator of node.namedChildren) {
      if (declarator.type !== 'variable_declarator') continue;
      const name = declarator.childForFieldName('name');
      if (name?.type !== 'identifier') continue;
      const value = declarator.childForFieldName('value');
      const kind = value && FUNCTION_VALUES.has(value.type) ? 'function' : keyword;
      out.push(symbolFrom(outer, name.text, kind, exported));
    }
    return out;
  }
  return [];
}

/** `module.exports = { a, b }`, `module.exports.x = ...`, `exports.x = ...`. */
function commonJsExports(node: SyntaxNode): { names: string[]; defined?: CodeSymbol } {
  const expr = node.namedChildren[0];
  if (node.type !== 'expression_statement' || expr?.type !== 'assignment_expression') return { names: [] };
  const left = expr.childForFieldName('left');
  const right = expr.childForFieldName('right');
  if (!left || !right) return { names: [] };
  if (left.text === 'module.exports') {
    if (right.type === 'identifier') return { names: [right.text] };
    if (right.type !== 'object') return { names: [] };
    const names = right.namedChildren.flatMap(p => {
      if (p.type === 'shorthand_property_identifier') return [p.text];
      if (p.type === 'pair' && p.childForFieldName('value')?.type === 'identifier') {
        return [p.childForFieldName('value')?.text ?? ''];
      }
      return [];
    });
    return { names: names.filter(Boolean) };
  }
  const match = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(left.text);
  if (!match?.[1]) return { names: [] };
  if (right.type === 'identifier') return { names: [right.text] };
  const kind = FUNCTION_VALUES.has(right.type) ? 'function' : 'const';
  return { names: [], defined: symbolFrom(node, match[1], kind, true) };
}

export function extractSymbols(path: string, code: string): CodeSymbol[] {
  const root = parse(path, code);
  return root ? symbolsFromRoot(root).symbols : [];
}

export interface ModuleFacts {
  imports: ParsedImport[];
  symbols: CodeSymbol[];
  /** Name of the local symbol behind `export default`, if any. */
  defaultExport: string | null;
}

/** Imports, symbols and the default export from a single parse. */
export function analyzeModule(path: string, code: string): ModuleFacts {
  const root = parse(path, code);
  if (!root) return { imports: [], symbols: [], defaultExport: null };
  return { imports: importsFromRoot(root), ...symbolsFromRoot(root) };
}

function symbolsFromRoot(root: SyntaxNode): { symbols: CodeSymbol[]; defaultExport: string | null } {
  const symbols: CodeSymbol[] = [];
  const lateExports = new Set<string>();
  let defaultExport: string | null = null;
  try {
    for (const node of root.namedChildren) {
      if (node.type === 'export_statement') {
        if (node.childForFieldName('source')) continue;
        const declaration = node.childForFieldName('declaration');
        if (declaration) {
          const declared = declarationSymbols(declaration, node, true);
          if (/^export\s+default\b/.test(node.text) && declared[0]) defaultExport = declared[0].name;
          symbols.push(...declared);
          continue;
        }
        const value = node.childForFieldName('value');
        if (value) {
          // `export default foo` marks an existing symbol; anonymous defaults become a symbol named 'default'.
          if (value.type === 'identifier') {
            lateExports.add(value.text);
            defaultExport = value.text;
          } else {
            const name = value.childForFieldName('name')?.text ?? 'default';
            const kind =
              DECLARATION_KINDS[value.type] ??
              (value.type === 'class' ? 'class' : FUNCTION_VALUES.has(value.type) ? 'function' : 'const');
            symbols.push(symbolFrom(node, name, kind, true));
            defaultExport = name;
          }
          continue;
        }
        for (const binding of exportClauseBindings(node)) {
          lateExports.add(binding.imported);
          if (binding.local === 'default') defaultExport = binding.imported;
        }
        continue;
      }
      const cjs = commonJsExports(node);
      if (cjs.defined) symbols.push(cjs.defined);
      for (const name of cjs.names) lateExports.add(name);
      symbols.push(...declarationSymbols(node, node, false));
    }
  } catch {
    return { symbols, defaultExport };
  }
  for (const symbol of symbols) if (lateExports.has(symbol.name)) symbol.exported = true;
  return { symbols, defaultExport };
}

export function symbolSource(path: string, code: string, name: string): string | null {
  return extractSymbols(path, code).find(s => s.name === name)?.code ?? null;
}

// ---- references ----------------------------------------------------------

const KEYWORDS = new Set(
  (
    'abstract any as async await boolean break case catch class const constructor continue debugger declare default ' +
    'delete do else enum export extends false finally for from function get if implements import in infer instanceof ' +
    'interface is keyof let module namespace never new null number object of package private protected public readonly ' +
    'require return satisfies set static string super switch symbol this throw true try type typeof undefined unique ' +
    'unknown var void while with yield bigint'
  ).split(' '),
);

const BUILTINS = new Set(
  (
    'Array ArrayBuffer Boolean BigInt Date Error EvalError Function Infinity Intl JSON Map Math NaN Number Object ' +
    'Promise Proxy RangeError ReferenceError Reflect RegExp Set String Symbol SyntaxError TypeError URIError URL ' +
    'URLSearchParams WeakMap WeakSet Uint8Array Int32Array Float64Array Buffer console process globalThis window ' +
    'document setTimeout clearTimeout setInterval clearInterval queueMicrotask structuredClone fetch Response Request ' +
    'Headers AbortController TextEncoder TextDecoder Record Partial Required Readonly Pick Omit Exclude Extract ' +
    'NonNullable ReturnType Parameters Awaited InstanceType PromiseLike Iterable AsyncIterable exports'
  ).split(' '),
);

// Locals that show up everywhere and would otherwise link unrelated symbols that happen to share a name.
const COMMON_LOCALS = new Set(
  (
    'args arg acc item items index idx key keys value values val result results res req err error e ev event ' +
    'data body text json obj options opts config cfg ctx context state props params param input output out ' +
    'node nodes list map set count total len length size name names id ids type kind path file files dir line lines ' +
    'start end min max prev next current cur temp tmp str num buf callback cb fn handler resolve reject done ' +
    'self that payload message msg response request headers status code entry entries row rows col cols left right ' +
    'first last other target source src dest parts part chunk chunks match matches label labels log push pop then ' +
    'catch toString filter forEach reduce slice splice concat join split trim includes indexOf'
  ).split(' '),
);

/**
 * Identifier tokens in `code` that may refer to other symbols. Common local names are dropped unless
 * `keepCommonNames` is set: callers that resolve names through imports can afford to keep them.
 */
export function extractReferences(code: string, ownName: string, keepCommonNames = false): string[] {
  const seen = new Set<string>();
  for (const token of code.match(/[A-Za-z_$][\w$]*/g) ?? []) {
    if (token === ownName || token.length < 2 || seen.has(token)) continue;
    if (token.length < 3 && token === token.toLowerCase()) continue;
    if (KEYWORDS.has(token) || BUILTINS.has(token) || (!keepCommonNames && COMMON_LOCALS.has(token))) continue;
    seen.add(token);
  }
  return [...seen];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether `code` mentions `name` as a whole identifier. */
export function usesName(code: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${escapeRegExp(name)}(?![\\w$])`).test(code);
}
