import { expect, test } from 'bun:test';
import { CriticalFailureError } from '../../src/llm';
import { isRetryableError, withRetry } from '../../src/utils/retry';

test.each([
  'Rate limit reached',
  'Too Many Requests',
  'Quota exceeded for project',
  'request timed out',
  'Timeout while waiting',
  'deadline exceeded',
  'no data received from model',
  'Internal server error',
  'Bad Gateway',
  'Service Unavailable',
  'Gateway Timeout',
  'connection reset by peer',
  'connect ECONNREFUSED 127.0.0.1',
  'network error',
  'upstream returned 503',
  'HTTP 429',
])('retryable message: %s', message => {
  expect(isRetryableError(new Error(message))).toBe(true);
});

test.each(['invalid api key', 'schema mismatch', 'not found'])('not retryable: %s', message => {
  expect(isRetryableError(new Error(message))).toBe(false);
});

test('status codes win over message text, and error codes are recognised', () => {
  expect(isRetryableError({ status: 400, message: 'timeout' })).toBe(false);
  expect(isRetryableError({ statusCode: 504 })).toBe(true);
  expect(isRetryableError({ status: 408 })).toBe(true);
  expect(isRetryableError({ code: 'ECONNREFUSED', message: '' })).toBe(true);
  expect(isRetryableError(null)).toBe(false);
});

test('a CriticalFailureError is never retried even if its message mentions a timeout', () => {
  const error = new CriticalFailureError('review', ['a'], ['a: timed out']);
  expect(error.message).toContain('timed out');
  expect(isRetryableError(error)).toBe(false);
});

test('no sleep after the final failure', async () => {
  const delays: number[] = [];
  let calls = 0;
  const failing = () => {
    calls++;
    return Promise.reject(Object.assign(new Error('busy'), { status: 429 }));
  };
  await expect(withRetry(failing, { retries: 2, baseDelayMs: 5, sleep: async ms => void delays.push(ms) })).rejects.toThrow(
    'busy',
  );
  expect(calls).toBe(3);
  expect(delays).toEqual([5, 10]);
});
