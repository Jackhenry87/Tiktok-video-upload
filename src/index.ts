import { runCli } from './cli/commands';
import { getDb } from './db/database';
import { ensureStorageDirs } from './utils/fileStorage';
import { logger } from './utils/logger';

/**
 * Entry point. Initializes storage + database (running migrations), then
 * dispatches to the CLI. Missing API credentials never crash the app —
 * commands print setup guidance and mock mode keeps everything runnable.
 */
async function main(): Promise<void> {
  try {
    await ensureStorageDirs();
    getDb(); // opens SQLite and applies migrations
  } catch (err) {
    logger.error(`Startup failed: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }
  await runCli(process.argv);
}

main().catch((err) => {
  // Last-resort handler: report cleanly instead of a raw stack crash.
  logger.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
