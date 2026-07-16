import { logger } from './logger';

export interface QueueResult<T> {
  succeeded: T[];
  failed: { item: T; error: string }[];
}

/**
 * Small in-process worker pool used to drain the persistent job queue
 * (video_jobs rows with status 'queued'). Persistence lives in SQLite, so a
 * crashed run simply leaves rows queued for the next invocation.
 */
export async function runWithConcurrency<T>(
  items: T[],
  worker: (item: T, index: number) => Promise<void>,
  concurrency = 2,
): Promise<QueueResult<T>> {
  const result: QueueResult<T> = { succeeded: [], failed: [] };
  let cursor = 0;

  async function runNext(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index]!;
      try {
        await worker(item, index);
        result.succeeded.push(item);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        logger.error(`Queue item ${index + 1}/${items.length} failed: ${message}`);
        result.failed.push({ item, error: message });
      }
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length)) },
    () => runNext(),
  );
  await Promise.all(workers);
  return result;
}
