import { env } from '../config/env';
import { getAppConfig } from '../config/appConfig';
import { insertTrend, trendExists, updateTrendScore } from '../db/database';
import { audit, logger } from '../utils/logger';
import type { TrendSignal } from '../types';
import { buildSources } from './trendSources';
import { scoreTrend } from './trendScorer';

export interface CollectResult {
  collected: number;
  saved: number;
  skippedDuplicates: number;
  aboveMinScore: number;
  trends: TrendSignal[];
}

/**
 * Collect trend signals from all configured sources, score them, and persist
 * new ones. Duplicate (topic, source) pairs are skipped.
 */
export async function collectTrends(): Promise<CollectResult> {
  const config = getAppConfig();
  const mock = env.MOCK_MODE === true || (env.MOCK_MODE === undefined && !hasRealSources());
  if (mock && env.MOCK_MODE !== true) {
    logger.info(
      'No trend sources configured (TREND_CSV_PATH / RSS_FEEDS / GOOGLE_TRENDS_CSV_PATH ' +
        '/ app.config.json manualTrends) — using mock trends. Configure a source or set MOCK_MODE=false.',
    );
  }

  const sources = buildSources(mock);
  const all: TrendSignal[] = [];
  for (const source of sources) {
    try {
      const signals = await source.collect();
      logger.info(`Source "${source.label}": ${signals.length} signal(s)`);
      all.push(...signals);
    } catch (err) {
      logger.error(`Source "${source.label}" failed: ${(err as Error).message}`);
    }
  }

  let saved = 0;
  let skipped = 0;
  let aboveMin = 0;
  const persisted: TrendSignal[] = [];

  for (const trend of all) {
    if (trendExists(trend.topic, trend.sourceLabel)) {
      skipped += 1;
      continue;
    }
    const breakdown = scoreTrend(trend);
    trend.score = breakdown.total;
    trend.scoreBreakdown = breakdown;
    const id = insertTrend(trend);
    updateTrendScore(id, breakdown.total, breakdown);
    trend.id = id;
    persisted.push(trend);
    saved += 1;
    if (breakdown.total >= config.minTrendScore) aboveMin += 1;
  }

  audit('info', 'Trend collection finished', {
    collected: all.length,
    saved,
    skippedDuplicates: skipped,
    aboveMinScore: aboveMin,
    minTrendScore: config.minTrendScore,
    sources: sources.map((s) => s.label),
  });

  return {
    collected: all.length,
    saved,
    skippedDuplicates: skipped,
    aboveMinScore: aboveMin,
    trends: persisted,
  };
}

function hasRealSources(): boolean {
  const config = getAppConfig();
  return Boolean(
    env.TREND_CSV_PATH ||
      env.RSS_FEEDS.length ||
      env.GOOGLE_TRENDS_CSV_PATH ||
      config.manualTrends.length,
  );
}
