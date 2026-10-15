import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

export type Provider = 'anthropic' | 'google';

export interface ModelInfo {
  provider: Provider;
  label: string;
  /** USD per million input tokens. */
  inputPerMillion: number;
  /** USD per million output tokens. */
  outputPerMillion: number;
}

/**
 * Known models and their list prices. Anthropic prices are first-party API rates.
 * Gemini prices change often: check https://ai.google.dev/pricing before relying on them.
 * Models not listed here still work; they are just reported at $0 cost.
 */
export const MODEL_CATALOG: Record<string, ModelInfo> = {
  'anthropic:claude-opus-5-5': {
    provider: 'anthropic',
    label: 'Claude Opus 5.5',
    inputPerMillion: 4,
    outputPerMillion: 20,
  },
  'anthropic:claude-sonnet-5-5': {
    provider: 'anthropic',
    label: 'Claude Sonnet 5.5',
    inputPerMillion: 2,
    outputPerMillion: 10,
  },
  'anthropic:claude-haiku-5-5': {
    provider: 'anthropic',
    label: 'Claude Haiku 5.5',
    inputPerMillion: 0.1,
    outputPerMillion: 0.5,
  },
  'google:gemini-3.1-pro-preview': {
    provider: 'google',
    label: 'Gemini 3.1 Pro (preview)',
    inputPerMillion: 1.25,
    outputPerMillion: 10,
  },
  'google:gemini-3-flash-preview': {
    provider: 'google',
    label: 'Gemini 3 Flash (preview)',
    inputPerMillion: 0.15,
    outputPerMillion: 0.6,
  },
  'google:gemini-3.1-flash-lite-preview': {
    provider: 'google',
    label: 'Gemini 3.1 Flash Lite (preview)',
    inputPerMillion: 0.075,
    outputPerMillion: 0.3,
  },
};

/** Model ids are written as `provider:model`, e.g. `anthropic:claude-opus-5-5`. */
export function parseModelId(id: string): { provider: Provider; model: string } {
  const sep = id.indexOf(':');
  if (sep <= 0 || sep === id.length - 1) {
    throw new Error(`Model id "${id}" must look like "provider:model" (e.g. anthropic:claude-opus-5-5)`);
  }
  const provider = id.slice(0, sep);
  if (provider !== 'anthropic' && provider !== 'google') {
    throw new Error(`Unsupported provider "${provider}" in model id "${id}"; use anthropic or google`);
  }
  return { provider, model: id.slice(sep + 1) };
}

export interface ProviderKeys {
  anthropicApiKey?: string;
  googleApiKey?: string;
}

/** Returns the environment variable names that must be set for these models to run. */
export function missingKeys(modelIds: string[], keys: ProviderKeys): string[] {
  const providers = new Set(modelIds.map(id => parseModelId(id).provider));
  const missing: string[] = [];
  if (providers.has('anthropic') && !keys.anthropicApiKey) missing.push('ANTHROPIC_API_KEY');
  if (providers.has('google') && !keys.googleApiKey) missing.push('GOOGLE_GENERATIVE_AI_API_KEY');
  return missing;
}

export function createLanguageModel(id: string, keys: ProviderKeys) {
  const { provider, model } = parseModelId(id);
  if (provider === 'anthropic') {
    return createAnthropic({ apiKey: keys.anthropicApiKey })(model);
  }
  return createGoogleGenerativeAI({ apiKey: keys.googleApiKey })(model);
}
