import path from 'node:path';
import dotenv from 'dotenv';
import { z } from 'zod';
import type { PrivacyStatus, RuntimeMode } from '../types';

// Load .env from the project root regardless of the cwd the CLI runs from.
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const booleanish = z
  .string()
  .optional()
  .transform((v) => {
    if (v === undefined || v.trim() === '') return undefined;
    return ['true', '1', 'yes', 'on'].includes(v.trim().toLowerCase());
  });

const numberish = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number(v);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    });

const csvList = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const PRIVACY_VALUES: PrivacyStatus[] = [
  'SELF_ONLY',
  'MUTUAL_FOLLOW_FRIENDS',
  'FOLLOWER_OF_CREATOR',
  'PUBLIC_TO_EVERYONE',
];

const envSchema = z.object({
  // ViewMax
  VIEWMAX_API_KEY: z.string().optional().default(''),
  VIEWMAX_BASE_URL: z.string().optional().default(''),

  // TikTok
  TIKTOK_CLIENT_KEY: z.string().optional().default(''),
  TIKTOK_CLIENT_SECRET: z.string().optional().default(''),
  TIKTOK_REDIRECT_URI: z.string().optional().default(''),
  TIKTOK_ACCESS_TOKEN: z.string().optional().default(''),

  // Storage
  DATABASE_URL: z.string().optional().default('file:./data/app.db'),
  STORAGE_DIR: z.string().optional().default('./storage'),

  // Content
  DEFAULT_NICHE: z.string().optional().default('finance'),
  NICHES: csvList,
  DEFAULT_PRIVACY_STATUS: z
    .string()
    .optional()
    .default('SELF_ONLY')
    .transform((v): PrivacyStatus => {
      const upper = v.trim().toUpperCase() as PrivacyStatus;
      return PRIVACY_VALUES.includes(upper) ? upper : 'SELF_ONLY';
    }),

  // Safety
  MAX_DAILY_UPLOADS: numberish(3, 1, 50),
  REVIEW_REQUIRED: booleanish,
  MIN_TREND_SCORE: numberish(55, 0, 100),

  // Scheduling
  TIMEZONE: z.string().optional().default('America/Chicago'),
  POSTING_TIMES: z.string().optional().default('09:00,13:00,19:00'),

  // Trend sources
  TREND_CSV_PATH: z.string().optional().default(''),
  RSS_FEEDS: csvList,
  GOOGLE_TRENDS_CSV_PATH: z.string().optional().default(''),

  // Runtime
  MOCK_MODE: booleanish,
  LOG_LEVEL: z.string().optional().default('info'),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    // Never crash on bad env — report clearly and fall back to defaults.
    // eslint-disable-next-line no-console
    console.error(
      'Invalid environment configuration, using defaults where possible:',
      parsed.error.flatten().fieldErrors,
    );
    return envSchema.parse({});
  }
  return parsed.data;
}

export const env: Env = loadEnv();

// ---------------------------------------------------------------------------
// Credential / mode helpers
// ---------------------------------------------------------------------------

export function isViewMaxConfigured(): boolean {
  return Boolean(env.VIEWMAX_API_KEY && env.VIEWMAX_BASE_URL);
}

export function isTikTokConfigured(): boolean {
  return Boolean(env.TIKTOK_ACCESS_TOKEN);
}

/**
 * Resolve runtime mode for a given integration.
 * - MOCK_MODE=true  -> always mock
 * - MOCK_MODE=false -> always real (caller shows a setup message if unconfigured)
 * - unset           -> real when configured, otherwise mock (with a notice)
 */
export function resolveMode(configured: boolean): RuntimeMode {
  if (env.MOCK_MODE === true) return 'mock';
  if (env.MOCK_MODE === false) return 'real';
  return configured ? 'real' : 'mock';
}

export function viewMaxMode(): RuntimeMode {
  return resolveMode(isViewMaxConfigured());
}

export function tikTokMode(): RuntimeMode {
  return resolveMode(isTikTokConfigured());
}

/** Human-readable setup hints shown instead of crashes. */
export function setupMessage(target: 'viewmax' | 'tiktok'): string {
  if (target === 'viewmax') {
    return [
      'ViewMax is not configured.',
      '  1. Add VIEWMAX_API_KEY and VIEWMAX_BASE_URL to your .env file.',
      '  2. Or set MOCK_MODE=true to simulate video creation locally.',
    ].join('\n');
  }
  return [
    'TikTok is not configured.',
    '  1. Create an app at https://developers.tiktok.com and request the video.publish scope.',
    '  2. Complete OAuth and put TIKTOK_ACCESS_TOKEN (plus client key/secret) in .env.',
    '  3. Or set MOCK_MODE=true to simulate uploads locally.',
  ].join('\n');
}

/** Absolute path to the SQLite database file derived from DATABASE_URL. */
export function databaseFilePath(): string {
  const raw = env.DATABASE_URL.replace(/^file:/, '');
  return path.resolve(process.cwd(), raw);
}

export function storageDir(): string {
  return path.resolve(process.cwd(), env.STORAGE_DIR);
}

/** REVIEW_REQUIRED defaults to true — uploads need manual approval. */
export function reviewRequired(): boolean {
  return env.REVIEW_REQUIRED !== false;
}
