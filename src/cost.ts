import { MODEL_CATALOG } from './models';
import type { CostSummary, Stage, StageCost } from './types';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export function priceUsage(modelId: string, usage: Usage): number {
  const info = MODEL_CATALOG[modelId];
  if (!info) return 0;
  return (usage.inputTokens * info.inputPerMillion + usage.outputTokens * info.outputPerMillion) / 1_000_000;
}

export class CostTracker {
  private stages: Partial<Record<Stage, StageCost>> = {};

  record(stage: Stage, modelId: string, usage: Usage): void {
    const entry = (this.stages[stage] ??= { inputTokens: 0, outputTokens: 0, costUsd: 0, calls: 0 });
    entry.inputTokens += usage.inputTokens;
    entry.outputTokens += usage.outputTokens;
    entry.costUsd += priceUsage(modelId, usage);
    entry.calls += 1;
  }

  summary(): CostSummary {
    const byStage = structuredClone(this.stages);
    const totalUsd = Object.values(byStage).reduce((sum, s) => sum + (s?.costUsd ?? 0), 0);
    return { totalUsd, byStage };
  }
}
