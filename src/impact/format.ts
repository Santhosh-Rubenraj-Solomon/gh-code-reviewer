import type { ImpactedFile, ImpactResult } from '../types';
import { entityId } from './entity-graph';

type WithSnippets = ImpactResult & { snippets?: Record<string, string> };

const MAX_DIRECT = 5;
const MAX_PREVIEWS = 3;
const MAX_OTHER_NAMES = 8;
const MAX_TRANSITIVE = 8;
const PREVIEW_CHARS = 300;
const SUMMARY_IMPACTS_PER_FILE = 6;
const SUMMARY_SYMBOLS = 5;

function preview(code: string): string {
  return code.length > PREVIEW_CHARS ? `${code.slice(0, PREVIEW_CHARS)}…` : code;
}

function describeDirect(dep: ImpactedFile, snippets: Record<string, string>): string[] {
  const lines = [`- ${dep.path}`];
  const shown: string[] = [];
  for (const name of dep.usedSymbols) {
    if (shown.length >= MAX_PREVIEWS) break;
    const code = snippets[entityId(dep.path, name)];
    if (!code) continue;
    shown.push(name);
    lines.push(`  \`${name}\`:`, '  ```', ...preview(code).split('\n').map(l => `  ${l}`), '  ```');
  }
  const others = dep.usedSymbols.filter(n => !shown.includes(n));
  if (others.length > 0) {
    const extra = others.length > MAX_OTHER_NAMES ? ` (+${others.length - MAX_OTHER_NAMES} more)` : '';
    lines.push(`  Other code using the change: ${others.slice(0, MAX_OTHER_NAMES).join(', ')}${extra}`);
  }
  return lines;
}

/** Prompt section describing who depends on one changed file; '' when nothing depends on it. */
export function formatFileImpactForPrompt(impact: WithSnippets, path: string): string {
  const file = impact.files[path];
  if (!file || (file.modifiedExports.length === 0 && file.impacted.length === 0)) return '';
  const snippets = impact.snippets ?? {};
  const out = [`### Ripple effects of ${path} (impact: ${file.level})`];

  if (file.modifiedExports.length > 0) {
    out.push('Exported symbols touched by this diff:');
    for (const s of file.modifiedExports) out.push(`- ${s.kind} \`${s.name}\` (lines ${s.startLine}-${s.endLine})`);
  }

  const direct = file.impacted.filter(i => i.kind === 'direct');
  if (direct.length > 0) {
    out.push('', `Files that import it directly (${direct.length}):`);
    for (const dep of direct.slice(0, MAX_DIRECT)) out.push(...describeDirect(dep, snippets));
    if (direct.length > MAX_DIRECT) out.push(`- …and ${direct.length - MAX_DIRECT} more`);
  }

  const transitive = file.impacted.filter(i => i.kind === 'transitive');
  if (transitive.length > 0) {
    out.push('', `Indirect dependents (${transitive.length}):`);
    for (const dep of transitive.slice(0, MAX_TRANSITIVE)) out.push(`- ${dep.path} (${dep.depth} imports away, from ${dep.via})`);
    if (transitive.length > MAX_TRANSITIVE) out.push(`- …and ${transitive.length - MAX_TRANSITIVE} more`);
  }

  out.push('', 'Check that the change keeps the contracts these dependents rely on (signatures, return shapes, errors).');
  return out.join('\n');
}

/** Whole-change summary for consolidation prompts; '' when there is nothing to say. */
export function formatImpactSummaryForPrompt(impact: ImpactResult): string {
  const sections: string[] = [];
  const perFile: string[] = [];
  for (const file of Object.values(impact.files)) {
    if (file.impacted.length === 0) continue;
    perFile.push(`- ${file.path}: ${file.impacted.length} dependent file(s), impact ${file.level}`);
    for (const dep of file.impacted.slice(0, SUMMARY_IMPACTS_PER_FILE)) {
      const names = dep.usedSymbols.slice(0, SUMMARY_SYMBOLS).join(', ');
      perFile.push(`  - ${dep.path} [${dep.kind}${dep.kind === 'transitive' ? `, depth ${dep.depth}` : ''}]${names ? ` uses ${names}` : ''}`);
    }
    if (file.impacted.length > SUMMARY_IMPACTS_PER_FILE) perFile.push(`  - …and ${file.impacted.length - SUMMARY_IMPACTS_PER_FILE} more`);
  }
  if (perFile.length > 0) {
    sections.push('## Cross-file impact', ...perFile, '', `Blast radius: ${impact.blastRadius.level}. ${impact.blastRadius.description}`);
  }

  const { untested, testsToUpdate } = impact.coverage;
  if (untested.length > 0 || testsToUpdate.length > 0) {
    sections.push('', '## Test coverage gaps');
    if (untested.length > 0) sections.push(`No test exercises these changed files: ${untested.join(', ')}`);
    if (testsToUpdate.length > 0) sections.push(`Existing tests that depend on the change and may need updates: ${testsToUpdate.join(', ')}`);
  }

  const counts = { added: 0, modified: 0, unchanged: 0 };
  for (const s of impact.semantic) counts[s.change]++;
  if (counts.added + counts.modified > 0) {
    sections.push('', `## Symbol changes`, `${counts.added} added, ${counts.modified} modified, ${counts.unchanged} untouched.`);
  }
  return sections.join('\n').trim();
}

function shortLabel(path: string): string {
  const parts = path.split('/');
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : path;
}

/** Mermaid flowchart: arrows point from a file to the files that import it. */
export function toMermaid(impact: ImpactResult, changedPaths: string[]): string {
  const ids = new Map<string, string>();
  const classOf = new Map<string, 'changed' | 'direct' | 'transitive'>();
  for (const p of changedPaths) classOf.set(p, 'changed');
  for (const file of Object.values(impact.files)) {
    for (const dep of file.impacted) {
      if (classOf.get(dep.path) === 'changed' || classOf.get(dep.path) === 'direct') continue;
      classOf.set(dep.path, dep.kind);
    }
  }
  const lines = ['graph LR'];
  for (const [path, cls] of classOf) {
    const id = `n${ids.size}`;
    ids.set(path, id);
    lines.push(`  ${id}["${shortLabel(path).replace(/"/g, "'")}"]:::${cls}`);
  }
  for (const { from, to } of impact.edges) {
    const a = ids.get(to);
    const b = ids.get(from);
    if (a && b) lines.push(`  ${a} --> ${b}`);
  }
  lines.push(
    '  classDef changed fill:#fde2e1,stroke:#c62828,color:#000',
    '  classDef direct fill:#fff4c2,stroke:#b8860b,color:#000',
    '  classDef transitive fill:#e3f4e1,stroke:#2e7d32,color:#000',
  );
  return lines.join('\n');
}

/** Plain-text tree of each changed file and its dependents. */
export function toText(impact: ImpactResult, changedPaths: string[]): string {
  const blocks: string[] = [];
  for (const path of changedPaths) {
    const file = impact.files[path];
    const header = `* ${path}${file ? ` — impact ${file.level}` : ''}`;
    const deps = file?.impacted ?? [];
    if (deps.length === 0) {
      blocks.push(`${header}\n    (no dependents found)`);
      continue;
    }
    const rows = deps.map((dep, i) => {
      const branch = i === deps.length - 1 ? '└─' : '├─';
      const detail =
        dep.kind === 'direct'
          ? `direct${dep.usedSymbols.length ? `, used by ${dep.usedSymbols.join(', ')}` : ''}`
          : `depth ${dep.depth}`;
      return `    ${branch} ${dep.path} (${detail})`;
    });
    blocks.push([header, ...rows].join('\n'));
  }
  blocks.push(`Blast radius: ${impact.blastRadius.level} — ${impact.blastRadius.description}`);
  return blocks.join('\n\n');
}
