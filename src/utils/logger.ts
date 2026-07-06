import pino from 'pino';
import { env } from '../config/env';

/**
 * Application logger (pino). Pretty-printed for CLI usage.
 * Significant business events are additionally persisted to the SQLite
 * `logs` table via audit() below.
 */
export const logger = pino({
  level: env.LOG_LEVEL || 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss',
      ignore: 'pid,hostname',
    },
  },
});

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
