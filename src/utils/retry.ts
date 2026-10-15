export interface RetryOptions {
  retries: number;
  baseDelayMs: number;
  factor?: number;
  maxDelayMs?: number;
  isRetryable?: (error: unknown) => boolean;
  sleep?: (ms: number) => Promise<void>;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

const RETRYABLE_MESSAGE = /rate.?limit|overloaded|timed? ?out|ECONNRESET|ETIMEDOUT|socket hang up/i;

/** Rate limits, server errors, and transient network failures are worth retrying; 4xx are not. */
export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const e = error as { status?: number; statusCode?: number; message?: string };
  const status = e.status ?? e.statusCode;
  if (typeof status === 'number') return status === 408 || status === 429 || status >= 500;
  return RETRYABLE_MESSAGE.test(e.message ?? '');
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
      if (attempt >= options.retries || !isRetryable(error)) throw error;
      const delay = Math.min(options.baseDelayMs * factor ** attempt, maxDelay);
      options.onRetry?.(error, attempt + 1, delay);
      await sleep(delay);
    }
  }
}
