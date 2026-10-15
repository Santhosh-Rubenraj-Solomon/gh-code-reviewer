export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  factor?: number;
  maxDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/** Messages that mean "try again later": throttling, slow or dropped connections, and server-side failures. */
const RETRYABLE_MESSAGE = new RegExp(
  [
    'rate.?limit',
    'too many requests',
    'quota exceeded',
    'overloaded',
    'timed? ?out',
    'timeout',
    'deadline exceeded',
    'no data received',
    'server error',
    'bad gateway',
    'service unavailable',
    'gateway timeout',
    'connection reset',
    'socket hang up',
    'network error',
    'ECONNRESET',
    'ECONNREFUSED',
    'ETIMEDOUT',
    '\\b(?:408|429|500|502|503|504)\\b',
  ].join('|'),
  'i',
);

const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']);

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

/** Rate limits, server errors, and transient network failures are worth retrying; other 4xx are not. */
export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { name?: unknown; status?: unknown; statusCode?: unknown; code?: unknown; message?: unknown };
  // A critical failure already exhausted every model; retrying it would repeat the whole chain.
  if (e.name === 'CriticalFailureError') return false;
  const status = typeof e.status === 'number' ? e.status : e.statusCode;
  if (typeof status === 'number') return isRetryableStatus(status);
  if (typeof e.code === 'string' && RETRYABLE_CODES.has(e.code)) return true;
  return typeof e.message === 'string' && RETRYABLE_MESSAGE.test(e.message);
}

const defaultSleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions): Promise<T> {
  const factor = options.factor ?? 2;
  const maxDelay = options.maxDelayMs ?? 60_000;
  const isRetryable = options.isRetryable ?? isRetryableError;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      // Checked before sleeping so the final failure surfaces immediately.
      if (attempt >= options.retries || !isRetryable(error)) throw error;
      const delay = Math.min(options.baseDelayMs * factor ** attempt, maxDelay);
      options.onRetry?.(error, attempt + 1, delay);
      await sleep(delay);
    }
  }
}
