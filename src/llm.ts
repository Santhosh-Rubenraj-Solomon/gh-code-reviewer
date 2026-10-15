import { Agent } from '@mastra/core/agent';
import type { z } from 'zod';
import { modelForStage, type Config } from './config';
import type { Usage } from './cost';
import { createLanguageModel } from './models';
import { STAGE_INSTRUCTIONS } from './prompts';
import type { Stage } from './types';
import { withRetry } from './utils/retry';

export interface TextResult {
  text: string;
  usage: Usage;
  model: string;
}

export interface ObjectResult<T> {
  object: T;
  usage: Usage;
  model: string;
}

/** The only surface the pipeline uses to talk to a model. Tests substitute a fake. */
export interface LLMClient {
  generateText(stage: Stage, prompt: string): Promise<TextResult>;
  generateObject<T>(stage: Stage, prompt: string, schema: z.ZodType<T>): Promise<ObjectResult<T>>;
}

export function toUsage(raw: unknown): Usage {
  const u = (raw ?? {}) as { inputTokens?: number; outputTokens?: number };
  return { inputTokens: u.inputTokens ?? 0, outputTokens: u.outputTokens ?? 0 };
}

/** One Mastra agent per pipeline stage, each bound to the model of that stage's tier. */
export class MastraLLM implements LLMClient {
  private agents = new Map<Stage, Agent>();

  constructor(private readonly config: Config) {}

  private agentFor(stage: Stage): Agent {
    let agent = this.agents.get(stage);
    if (!agent) {
      agent = new Agent({
        id: `ghr-${stage}`,
        name: `gh-code-reviewer ${stage}`,
        instructions: STAGE_INSTRUCTIONS[stage],
        model: createLanguageModel(modelForStage(this.config, stage), this.config),
      });
      this.agents.set(stage, agent);
    }
    return agent;
  }

  private retry<T>(fn: () => Promise<T>): Promise<T> {
    return withRetry(fn, {
      retries: this.config.maxRetries,
      baseDelayMs: this.config.retryBaseDelayMs,
    });
  }

  async generateText(stage: Stage, prompt: string): Promise<TextResult> {
    const agent = this.agentFor(stage);
    const result = await this.retry(() => agent.generate([{ role: 'user', content: prompt }]));
    return { text: result.text, usage: toUsage(result.usage), model: modelForStage(this.config, stage) };
  }

  async generateObject<T>(stage: Stage, prompt: string, schema: z.ZodType<T>): Promise<ObjectResult<T>> {
    const agent = this.agentFor(stage);
    const result = await this.retry(() =>
      agent.generate([{ role: 'user', content: prompt }], {
        // zod 4 schemas implement Standard Schema, which is what Mastra validates against.
        structuredOutput: { schema: schema as never },
      }),
    );
    return {
      object: schema.parse(result.object),
      usage: toUsage(result.usage),
      model: modelForStage(this.config, stage),
    };
  }
}
