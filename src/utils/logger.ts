import pino from 'pino';
import pretty from 'pino-pretty';
import { env } from '../config/env';

/**
 * Application logger (pino). Pretty-printed for CLI usage.
 * The pretty stream runs SYNCHRONOUSLY (not the worker-thread transport) so
 * log lines interleave in chronological order with console output.
 * Significant business events are additionally persisted to the SQLite
 * `logs` table via audit() below.
 */
export const logger = pino(
  { level: env.LOG_LEVEL || 'info' },
  pretty({
    colorize: true,
    translateTime: 'SYS:HH:MM:ss',
    ignore: 'pid,hostname',
    sync: true,
  }),
);

/**
 * Log to pino AND persist to the logs table (audit trail).
 * Uses a lazy require to avoid a circular import with the db module.
 */
export function audit(
  level: 'info' | 'warn' | 'error',
  message: string,
  context?: Record<string, unknown>,
): void {
  logger[level](context ?? {}, message);
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { recordLog } = require('../db/database') as typeof import('../db/database');
    recordLog(level, message, context);
  } catch {
    // The audit trail must never take down the app.
  }
}
