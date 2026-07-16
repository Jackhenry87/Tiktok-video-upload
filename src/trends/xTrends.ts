import axios from 'axios';
import { env } from '../config/env';
import { withRetry } from '../utils/retry';

/**
 * Live trending topics from X (Twitter) API v2 — GET /2/trends/by/woeid/:id.
 * Used to pick the brainrot "opener" word/phrase for each video.
 *
 * WOEID (Where On Earth ID): 23424977 = United States, 1 = Worldwide.
 * Requires a paid tier Bearer token (Free tier is write-only). Returns
 * undefined when no token is configured so the caller falls back to
 * web-search trend scanning.
 */

const US_WOEID = 23424977;

export interface XTrend {
  name: string;
  /** Post volume when X reports it (higher = more viral); undefined otherwise. */
  postCount?: number;
}

export async function fetchXTrends(woeid: number = US_WOEID): Promise<XTrend[] | undefined> {
  if (!env.X_BEARER_TOKEN) return undefined;
  try {
    const res = await withRetry(
      () =>
        axios.get(`https://api.x.com/2/trends/by/woeid/${woeid}`, {
          headers: { Authorization: `Bearer ${env.X_BEARER_TOKEN}` },
          params: { max_trends: 50 },
          timeout: 20_000,
        }),
      { label: 'X trends', retries: 2 },
    );
    const raw: unknown[] = res.data?.data ?? [];
    const trends: XTrend[] = raw
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((t: any) => ({
        name: String(t.trend_name ?? t.name ?? '').trim(),
        postCount:
          typeof t.post_count === 'number'
            ? t.post_count
            : typeof t.tweet_volume === 'number'
              ? t.tweet_volume
              : undefined,
      }))
      .filter((t) => t.name);
    // Rank by reported volume (most viral first); volume-less trends after.
    return trends.sort((a, b) => (b.postCount ?? -1) - (a.postCount ?? -1));
  } catch (err) {
    // Never break the run — fall back to web-search scanning.
    // eslint-disable-next-line no-console
    console.error(`X trends fetch failed: ${(err as Error).message.slice(0, 200)}`);
    return undefined;
  }
}

/**
 * Pick the single strongest "opener" candidate — short, punchy trend names
 * make the best cold-open hooks (a word, a short phrase, or a name).
 */
export function pickOpenerTrend(trends: XTrend[]): XTrend | undefined {
  const scored = trends
    .filter((t) => {
      const words = t.name.replace(/^#/, '').split(/\s+/).length;
      return words <= 3 && t.name.length <= 30; // short = hook-friendly
    })
    .sort((a, b) => (b.postCount ?? -1) - (a.postCount ?? -1));
  return scored[0] ?? trends[0];
}
