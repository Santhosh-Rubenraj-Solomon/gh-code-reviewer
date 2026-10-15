import { describe, expect, test } from 'bun:test';
import { breachesThreshold, parseSeverity } from '../src/gate';
import { truncate } from '../src/pipeline/deps';
import { loadRules } from '../src/rules';
import { mapLimit } from '../src/utils/pool';
import { isRetryableError, withRetry } from '../src/utils/retry';
import { estimateTokens } from '../src/utils/tokens';
import { finding } from './helpers';

describe('withRetry', () => {
  const noSleep = async () => {};

  test('retries retryable errors with exponential backoff, then succeeds', async () => {
    const delays: number[] = [];
    let attempts = 0;
    const result = await withRetry(
      async () => {
        if (++attempts < 3) throw Object.assign(new Error('busy'), { status: 429 });
        return 'ok';
      },
      { retries: 3, baseDelayMs: 100, sleep: async ms => void delays.push(ms) },
    );
    expect(result).toBe('ok');
    expect(delays).toEqual([100, 200]);
  });

  test('gives up after the retry budget', async () => {
    let attempts = 0;
    const failing = () => {
      attempts++;
      return Promise.reject(Object.assign(new Error('down'), { status: 503 }));
    };
    await expect(withRetry(failing, { retries: 2, baseDelayMs: 1, sleep: noSleep })).rejects.toThrow('down');
    expect(attempts).toBe(3);
  });

  test('does not retry client errors', async () => {
    let attempts = 0;
    const failing = () => {
      attempts++;
      return Promise.reject(Object.assign(new Error('bad request'), { status: 400 }));
    };
    await expect(withRetry(failing, { retries: 5, baseDelayMs: 1, sleep: noSleep })).rejects.toThrow();
    expect(attempts).toBe(1);
  });

  test('caps the delay', async () => {
    const delays: number[] = [];
    await withRetry(
      (() => {
        let n = 0;
        return async () => {
          if (n++ < 3) throw Object.assign(new Error('x'), { status: 500 });
        };
      })(),
      { retries: 3, baseDelayMs: 1_000, factor: 10, maxDelayMs: 5_000, sleep: async ms => void delays.push(ms) },
    );
    expect(delays).toEqual([1_000, 5_000, 5_000]);
  });
});

test.each([
  [{ status: 429 }, true],
  [{ statusCode: 502 }, true],
  [{ status: 408 }, true],
  [{ status: 401 }, false],
  [new Error('Rate limit exceeded'), true],
  [new Error('socket hang up'), true],
  [new Error('invalid schema'), false],
  ['string error', false],
])('isRetryableError(%p) = %p', (error, expected) => {
  expect(isRetryableError(error)).toBe(expected);
});

test('mapLimit keeps order and never exceeds the limit', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapLimit([5, 1, 4, 2, 3], 2, async (n, i) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, n));
    active--;
    return n * 10 + i;
  });
  expect(result).toEqual([50, 11, 42, 23, 34]);
  expect(peak).toBe(2);
  expect(await mapLimit([], 3, async () => 1)).toEqual([]);
});

test('estimateTokens is zero for empty text and grows with length', () => {
  expect(estimateTokens('')).toBe(0);
  expect(estimateTokens('hello world')).toBeGreaterThan(0);
  expect(estimateTokens('word '.repeat(1_000))).toBeGreaterThan(estimateTokens('word '.repeat(10)));
});

test('truncate leaves short text alone and marks cut text', () => {
  expect(truncate('abc', 5)).toBe('abc');
  expect(truncate('abcdef', 3)).toBe('abc\n…[truncated 3 chars]');
});

describe('severity gate', () => {
  test('parseSeverity accepts any case and rejects unknown values', () => {
    expect(parseSeverity('HIGH')).toBe('high');
    expect(() => parseSeverity('urgent')).toThrow(/--fail-on/);
  });

  test('breachesThreshold compares by rank', () => {
    const findings = [finding({ severity: 'medium' })];
    expect(breachesThreshold(findings, 'low')).toBe(true);
    expect(breachesThreshold(findings, 'medium')).toBe(true);
    expect(breachesThreshold(findings, 'high')).toBe(false);
    expect(breachesThreshold([], 'low')).toBe(false);
  });
});

test('loadRules joins existing rule files and skips missing ones', () => {
  const files: Record<string, string> = { '/repo/.github/code-review.md': 'Use parameterised SQL.\n' };
  const rules = loadRules(['.github/code-review.md', 'CODE_REVIEW.md'], '/repo', p => files[p] ?? null);
  expect(rules).toBe('<!-- from .github/code-review.md -->\nUse parameterised SQL.');
  expect(loadRules(['missing.md'], '/repo', () => null)).toBeUndefined();
});
