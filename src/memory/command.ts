import { readFileSync } from 'node:fs';
import type { DeveloperMemory } from './store';
import { isMemoryType, MEMORY_TYPES, type MemoryItem, type MemoryType } from './types';

export interface MemoryCommandOptions {
  store: DeveloperMemory;
  readFile?: (path: string) => string;
}

export interface MemoryCommandResult {
  output: string;
  exitCode: 0 | 1;
}

const USAGE = [
  'Usage: ghr memory <action>',
  '',
  '  list | ls                  Show counts by type and the 10 most recent memories',
  `  add <text> [--type=TYPE]   Remember something (TYPE: ${MEMORY_TYPES.filter(t => t !== 'summarized').join(', ')})`,
  '  search <query>             Find memories containing the text',
  '  delete | rm <id>           Forget one memory',
  '  compact                    Drop stale low-value memories and merge similar ones',
  '  clear --yes                Forget everything',
  '  export                     Print all memories as JSON',
  '  import <file.json>         Add memories from an export (duplicates are skipped)',
  '  help                       Show this help',
].join('\n');

function formatItem(m: MemoryItem): string {
  const scope = m.project ?? 'global';
  const tags = m.tags.length ? ` #${m.tags.join(' #')}` : '';
  return `  ${m.id}  [${m.type}, ${scope}, importance ${m.importance}] ${m.content}${tags}`;
}

/** Separates `--flag=value` / `--flag` tokens from the positional words, so flags never leak into memory text. */
function splitArgs(args: string[]): { words: string[]; flags: Map<string, string | true> } {
  const words: string[] = [];
  const flags = new Map<string, string | true>();
  for (const arg of args) {
    const match = /^--([a-z-]+)(?:=(.*))?$/i.exec(arg);
    if (match) flags.set(match[1]!.toLowerCase(), match[2] ?? true);
    else words.push(arg);
  }
  return { words, flags };
}

function listOutput(store: DeveloperMemory): string {
  const stats = store.stats();
  if (!stats.total) return 'No memories yet. Add one with: ghr memory add "<text>"';
  const byType = Object.entries(stats.byType)
    .map(([type, n]) => `${type}: ${n}`)
    .join(', ');
  const recent = store.all().slice(0, 10);
  return [
    `${stats.total} memories (${byType}); ${stats.stale} stale`,
    '',
    'Most recent:',
    ...recent.map(formatItem),
  ].join('\n');
}

async function run(args: string[], options: MemoryCommandOptions): Promise<string> {
  const { store } = options;
  const [action = 'list', ...rest] = args;
  const { words, flags } = splitArgs(rest);

  switch (action) {
    case 'list':
    case 'ls':
      return listOutput(store);

    case 'add': {
      const content = words.join(' ').trim();
      if (!content) throw new Error('Nothing to remember. Usage: ghr memory add <text> [--type=TYPE]');
      const typeFlag = flags.get('type');
      let type: MemoryType = 'context';
      if (typeof typeFlag === 'string') {
        if (!isMemoryType(typeFlag)) throw new Error(`Unknown memory type "${typeFlag}". Use one of: ${MEMORY_TYPES.join(', ')}`);
        type = typeFlag;
      }
      const item = await store.add({ content, type, source: 'cli', importance: 6 });
      return `Saved ${item.id} [${item.type}]: ${item.content}`;
    }

    case 'search': {
      const query = words.join(' ').trim();
      if (!query) throw new Error('Usage: ghr memory search <query>');
      const hits = store.query({ text: query, includeStale: true, limit: 20 });
      return hits.length ? [`${hits.length} match(es):`, ...hits.map(formatItem)].join('\n') : `No memories match "${query}".`;
    }

    case 'delete':
    case 'rm': {
      const id = words[0];
      if (!id) throw new Error('Usage: ghr memory delete <id>');
      if (!store.delete(id)) throw new Error(`No memory with id ${id}`);
      return `Deleted ${id}`;
    }

    case 'compact': {
      const r = await store.compact();
      return `Compacted: removed ${r.removed}, merged ${r.summarized} into summaries, ${r.remaining} remaining.`;
    }

    case 'clear': {
      if (flags.get('yes') !== true) throw new Error('This deletes every memory. Run "ghr memory clear --yes" to confirm.');
      return `Cleared ${store.clear()} memories.`;
    }

    case 'export':
      return store.export();

    case 'import': {
      const path = words[0];
      if (!path) throw new Error('Usage: ghr memory import <file.json>');
      const read = options.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
      const r = store.import(read(path));
      return `Imported ${r.imported} memories (${r.skipped} skipped as duplicates or invalid).`;
    }

    case 'help':
    case '--help':
      return USAGE;

    default:
      throw new Error(`Unknown memory action "${action}".\n\n${USAGE}`);
  }
}

/** Implements `ghr memory ...`. The output starts with the developer identity so it is clear whose memory this is. */
export async function memoryCommand(args: string[], options: MemoryCommandOptions): Promise<MemoryCommandResult> {
  const header = `Developer: ${options.store.developerId}`;
  try {
    return { output: `${header}\n${await run(args, options)}`, exitCode: 0 };
  } catch (error) {
    return { output: `${header}\nError: ${(error as Error).message}`, exitCode: 1 };
  }
}
