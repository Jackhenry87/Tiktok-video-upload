import pRetry from 'p-retry';
import { logger } from './logger';

export interface RetryOptions {
  retries?: number;
  minTimeoutMs?: number;
  factor?: number;
  label?: string;
}

/**
 * Retry an async operation with exponential backoff (p-retry).
 * Throw a NonRetryableError inside `fn` to abort immediately
 * (e.g. on 4xx responses where retrying cannot help).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  const { retries = 3, minTimeoutMs = 1000, factor = 2, label = 'operation' } = options;
  return pRetry(fn, {
    retries,
    minTimeout: minTimeoutMs,
    factor,
    onFailedAttempt: (error) => {
      logger.warn(
        `${label} failed (attempt ${error.attemptNumber}/${retries + 1}, ` +
          `${error.retriesLeft} retries left): ${error.message}`,
      );
    },
  });
}

/** Errors that should never be retried (bad request, auth, validation). */
export class NonRetryableError extends pRetry.AbortError {}

/** Simple promise-based delay used by polling loops. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Poll `check` until it returns a value, with fixed interval and timeout.
 * `check` returns undefined to keep polling.
 */
export async function pollUntil<T>(
  check: () => Promise<T | undefined>,
  opts: { intervalMs?: number; timeoutMs?: number; label?: string } = {},
): Promise<T> {
  const { intervalMs = 5000, timeoutMs = 10 * 60 * 1000, label = 'poll' } = opts;
  const start = Date.now();
  for (;;) {
    const result = await check();
    if (result !== undefined) return result;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`${label} timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    await sleep(intervalMs);
  }
}
