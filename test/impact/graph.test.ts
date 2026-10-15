import { describe, expect, test } from 'bun:test';
import { DependencyGraph } from '../../src/impact/dependency-graph';
import { EntityGraph, entityId, type FileFacts } from '../../src/impact/entity-graph';
import { analyzeModule } from '../../src/impact/parser';
import { FIXTURE_FILES } from './fixture';

const SOURCES = Object.keys(FIXTURE_FILES).filter(p => /\.(ts|js)$/.test(p) && !p.startsWith('node_modules') && !p.startsWith('dist') && !p.startsWith('.'));

function build(files: Record<string, string> = FIXTURE_FILES, paths = SOURCES) {
  const graph = new DependencyGraph(paths);
  const facts = new Map<string, FileFacts>();
  for (const p of paths) {
    const f = analyzeModule(p, files[p] as string);
    facts.set(p, f);
    graph.addFile(p, f.imports);
  }
  return { graph, facts, entities: new EntityGraph(facts, graph) };
}

describe('DependencyGraph.resolve', () => {
  const graph = new DependencyGraph(['src/a.ts', 'src/lib/index.ts', 'src/b.tsx', 'src/c.mts', 'root.js']);
  test('resolves exact, extension, index, emitted .js and absolute paths', () => {
    expect(graph.resolve('src/x.ts', './a')).toBe('src/a.ts');
    expect(graph.resolve('src/x.ts', './a.ts')).toBe('src/a.ts');
    expect(graph.resolve('src/x.ts', './a.js')).toBe('src/a.ts');
    expect(graph.resolve('src/x.ts', './b.js')).toBe('src/b.tsx');
    expect(graph.resolve('src/x.ts', './c.mjs')).toBe('src/c.mts');
    expect(graph.resolve('src/x.ts', './lib')).toBe('src/lib/index.ts');
    expect(graph.resolve('src/x.ts', './lib/')).toBe('src/lib/index.ts');
    expect(graph.resolve('src/deep/x.ts', '../../root')).toBe('root.js');
    expect(graph.resolve('src/x.ts', '/src/a')).toBe('src/a.ts');
  });

  test('leaves packages, missing files and paths above the root unresolved', () => {
    expect(graph.resolve('src/x.ts', 'react')).toBeNull();
    expect(graph.resolve('src/x.ts', '@/a')).toBeNull();
    expect(graph.resolve('src/x.ts', './missing')).toBeNull();
    expect(graph.resolve('src/x.ts', '../../../etc/passwd')).toBeNull();
  });
});

describe('fixture file graph', () => {
  const { graph } = build();

  test('links ES imports, re-exports, require and dynamic import', () => {
    expect(graph.importsOf('src/calc.ts').sort()).toEqual(['src/util/index.ts', 'src/util/math.ts']);
    expect(graph.importsOf('src/util/index.ts').sort()).toEqual(['src/util/format.ts', 'src/util/math.ts']);
    expect(graph.importsOf('src/app.ts').sort()).toEqual(['src/legacy.js', 'src/report.ts']);
    expect(graph.importersOf('src/calc.ts').sort()).toEqual(['src/report.ts', 'test/calc.test.ts']);
  });

  test('BFS reports depth and the seed it came from, honouring maxDepth', () => {
    const deps = graph.dependentsOf(['src/util/math.ts'], 3);
    expect(Object.fromEntries([...deps].map(([p, d]) => [p, d.depth]))).toEqual({
      'src/util/index.ts': 1,
      'src/calc.ts': 1,
      'src/report.ts': 2,
      'test/calc.test.ts': 2,
      'src/app.ts': 3,
    });
    expect(deps.get('src/app.ts')?.via).toBe('src/util/math.ts');
    expect(graph.dependentsOf(['src/util/math.ts'], 1).size).toBe(2);
    expect(graph.dependentsOf(['src/app.ts']).size).toBe(0);
  });

  test('edgesWithin keeps only edges between the given nodes', () => {
    expect(graph.edgesWithin(new Set(['src/calc.ts', 'src/report.ts', 'src/util/math.ts']))).toEqual([
      { from: 'src/calc.ts', to: 'src/util/math.ts' },
      { from: 'src/report.ts', to: 'src/calc.ts' },
    ]);
  });
});

describe('EntityGraph', () => {
  const { entities } = build();
  const add = entityId('src/util/math.ts', 'add');

  test('follows re-exports and aliases to the declaring file', () => {
    expect(entities.referrersOf(add)).toEqual([entityId('src/calc.ts', 'total')]);
    expect(entities.referrersOf(entityId('src/util/math.ts', 'mul'))).toEqual([entityId('src/calc.ts', 'product')]);
    expect(entities.referrersOf(entityId('src/util/format.ts', 'fmt'))).toEqual([entityId('src/calc.ts', 'pretty')]);
  });

  test('does not link same-named symbols in files that never import each other', () => {
    expect(entities.referrersOf(entityId('src/unrelated.ts', 'add'))).toEqual([entityId('src/unrelated.ts', 'bump')]);
    expect(entities.referrersOf(add)).not.toContain(entityId('src/unrelated.ts', 'bump'));
  });

  test('BFS walks referrers transitively with depths', () => {
    const hits = entities.impactedBy([add]);
    expect(Object.fromEntries(hits)).toEqual({
      [entityId('src/calc.ts', 'total')]: 1,
      [entityId('src/calc.ts', 'pretty')]: 2,
      [entityId('src/report.ts', 'buildReport')]: 2,
      // `reporting.buildReport` through a namespace-style dynamic import.
      [entityId('src/app.ts', 'boot')]: 3,
    });
  });

  test('resolves default imports and unresolved alias imports', () => {
    const files = {
      'src/store.ts': 'function makeStore() { return 1; }\nexport default makeStore;\n',
      'src/use.ts': "import createStore from './store';\nexport function init() { return createStore(); }\n",
      'src/alias.ts': "import { helper } from '@/shared';\nexport function viaAlias() { return helper(); }\n",
      'src/shared.ts': 'export function helper() { return 2; }\n',
    };
    const { entities: g } = build(files, Object.keys(files));
    expect(g.referrersOf(entityId('src/store.ts', 'makeStore'))).toEqual([entityId('src/use.ts', 'init')]);
    expect(g.referrersOf(entityId('src/shared.ts', 'helper'))).toEqual([entityId('src/alias.ts', 'viaAlias')]);
  });

  test('caps the impacted set', () => {
    const files: Record<string, string> = { 'src/base.ts': 'export function base() { return 0; }\n' };
    for (let i = 0; i < 30; i++) files[`src/f${i}.ts`] = `import { base } from './base';\nexport function use${i}() { return base(); }\n`;
    const { entities: g } = build(files, Object.keys(files));
    expect(g.impactedBy([entityId('src/base.ts', 'base')]).size).toBe(30);
    expect(g.impactedBy([entityId('src/base.ts', 'base')], 10).size).toBe(10);
  });
});
