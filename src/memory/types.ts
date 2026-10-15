export const MEMORY_TYPES = [
  'preference',
  'pattern',
  'decision',
  'feedback',
  'context',
  'discussion',
  'summarized',
] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export type MemorySource = 'cli' | 'chat' | 'review';

export interface MemoryItem {
  id: string;
  type: MemoryType;
  content: string;
  tags: string[];
  source: MemorySource;
  /** Repository slug (owner/repo) the memory applies to, or null for memories that apply everywhere. */
  project: string | null;
  filePatterns: string[];
  createdAt: string;
  lastAccessedAt: string;
  accessCount: number;
  /** 1 (trivia) to 10 (must never be forgotten). */
  importance: number;
}

export interface MemorySettings {
  maxItems: number;
  autoCompactAt: number;
  retentionDays: number;
  staleAfterDays: number;
}

export const DEFAULT_MEMORY_SETTINGS: MemorySettings = {
  maxItems: 500,
  autoCompactAt: 400,
  retentionDays: 90,
  staleAfterDays: 30,
};

export interface MemoryFile {
  version: 1;
  developerId: string;
  memories: MemoryItem[];
}

export interface NewMemory {
  type?: MemoryType;
  content: string;
  tags?: string[];
  source?: MemorySource;
  project?: string | null;
  filePatterns?: string[];
  importance?: number;
}

export interface MemoryQuery {
  types?: MemoryType[];
  tags?: string[];
  /** Project memories to include; global (null-project) memories are always included. */
  project?: string | null;
  minImportance?: number;
  includeStale?: boolean;
  limit?: number;
  /** Case-insensitive substring filter on content and tags. */
  text?: string;
}

export interface ChatTurn {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface CompactResult {
  removed: number;
  summarized: number;
  remaining: number;
}

export interface MemoryStats {
  total: number;
  stale: number;
  byType: Partial<Record<MemoryType, number>>;
  byProject: Record<string, number>;
  oldest?: string;
  newest?: string;
}

export function isMemoryType(value: string): value is MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(value);
}
