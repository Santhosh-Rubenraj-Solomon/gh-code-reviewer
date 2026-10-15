import type { CostTracker } from '../cost';
import type { LLMClient } from '../llm';

export interface StageDeps {
  llm: LLMClient;
  cost: CostTracker;
  log: (message: string) => void;
}

export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…[truncated ${text.length - maxChars} chars]`;
}
