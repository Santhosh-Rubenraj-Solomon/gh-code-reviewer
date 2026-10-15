import { describe, expect, test } from 'bun:test';
import { CostTracker, priceUsage } from '../src/cost';
import { toUsage } from '../src/llm';
import { createLanguageModel, missingKeys, parseModelId } from '../src/models';

describe('parseModelId', () => {
  test('splits provider and model', () => {
    expect(parseModelId('anthropic:claude-opus-5-5')).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5' });
    expect(parseModelId('google:gemini-3-flash-preview')).toEqual({ provider: 'google', model: 'gemini-3-flash-preview' });
  });

  test.each(['claude-opus-5-5', ':x', 'anthropic:', 'openai:gpt'])('rejects %p', id => {
    expect(() => parseModelId(id)).toThrow();
  });
});

test('missingKeys names only the providers that are actually used', () => {
  expect(missingKeys(['anthropic:claude-opus-5-5'], {})).toEqual(['ANTHROPIC_API_KEY']);
  expect(missingKeys(['anthropic:claude-opus-5-5', 'google:gemini-3-flash-preview'], { anthropicApiKey: 'k' })).toEqual([
    'GOOGLE_GENERATIVE_AI_API_KEY',
  ]);
  expect(missingKeys(['google:gemini-3-flash-preview'], { googleApiKey: 'k' })).toEqual([]);
});

test('createLanguageModel builds a model for each provider without calling the network', () => {
  const claude = createLanguageModel('anthropic:claude-haiku-5-5', { anthropicApiKey: 'k' });
  const gemini = createLanguageModel('google:gemini-3-flash-preview', { googleApiKey: 'k' });
  expect(claude.modelId).toBe('claude-haiku-5-5');
  expect(gemini.modelId).toBe('gemini-3-flash-preview');
});

describe('cost', () => {
  test('prices usage from the catalogue', () => {
    // Opus 5.5: $4 in / $20 out per million tokens.
    expect(priceUsage('anthropic:claude-opus-5-5', { inputTokens: 1_000_000, outputTokens: 100_000 })).toBeCloseTo(6);
  });

  test('unknown models cost zero rather than failing', () => {
    expect(priceUsage('anthropic:some-future-model', { inputTokens: 10, outputTokens: 10 })).toBe(0);
  });

  test('CostTracker aggregates per stage and in total', () => {
    const tracker = new CostTracker();
    tracker.record('review', 'anthropic:claude-opus-5-5', { inputTokens: 500_000, outputTokens: 0 });
    tracker.record('review', 'anthropic:claude-opus-5-5', { inputTokens: 500_000, outputTokens: 0 });
    tracker.record('triage', 'anthropic:claude-haiku-5-5', { inputTokens: 1_000_000, outputTokens: 0 });
    const summary = tracker.summary();
    expect(summary.byStage.review).toEqual({ inputTokens: 1_000_000, outputTokens: 0, costUsd: 4, calls: 2 });
    expect(summary.totalUsd).toBeCloseTo(4.1);
  });

  test('summary is a snapshot, not a live view', () => {
    const tracker = new CostTracker();
    tracker.record('critic', 'anthropic:claude-sonnet-5-5', { inputTokens: 1, outputTokens: 1 });
    const snapshot = tracker.summary();
    tracker.record('critic', 'anthropic:claude-sonnet-5-5', { inputTokens: 1, outputTokens: 1 });
    expect(snapshot.byStage.critic!.calls).toBe(1);
  });
});

test('toUsage tolerates missing fields', () => {
  expect(toUsage(undefined)).toEqual({ inputTokens: 0, outputTokens: 0 });
  expect(toUsage({ inputTokens: 3, outputTokens: 4, totalTokens: 7 })).toEqual({ inputTokens: 3, outputTokens: 4 });
});
