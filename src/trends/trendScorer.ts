import { differenceInCalendarDays } from 'date-fns';
import { getAppConfig, getNicheProfile } from '../config/appConfig';
import type { TrendScoreBreakdown, TrendSignal } from '../types';

/**
 * Trend scoring: 0-100 composite from weighted components.
 *
 * Components (each normalized to 0-100 before weighting):
 *  - recency:        fresher trends score higher (linear decay over 14 days)
 *  - nicheMatch:     keyword overlap between topic and the niche profile
 *  - searchInterest: the source-reported strength signal
 *  - relevance:      topic quality heuristics (length, specificity)
 *  - contentFit:     category fits what the niche audience expects
 *  - competition:    inverted competition level (less crowded = better);
 *                    neutral 50 when the source didn't report it
 *  - repeatability:  evergreen categories can be re-used as formats
 */

const EVERGREEN_CATEGORIES = new Set(['education', 'fitness', 'business', 'finance', 'lifestyle']);

export function scoreTrend(trend: TrendSignal): TrendScoreBreakdown {
  const config = getAppConfig();
  const weights = config.scoringWeights;

  // Recency: 100 today, linearly down to 0 at 14 days old.
  const ageDays = Math.max(0, differenceInCalendarDays(new Date(), new Date(trend.dateFound)));
  const recency = Math.max(0, 100 - (ageDays / 14) * 100);

  // Niche match: fraction of niche keywords appearing in the topic.
  const profile = getNicheProfile(trend.niche);
  const topicLower = trend.topic.toLowerCase();
  const hits = profile.keywords.filter((k) => topicLower.includes(k)).length;
  const nicheMatch = Math.min(100, hits * 34 + (trend.niche === config.defaultNiche ? 10 : 0));

  // Search interest straight from the source signal.
  const searchInterest = clamp(trend.estimatedStrength);

  // Relevance heuristics: specific, medium-length topics beat vague ones.
  const wordCount = trend.topic.trim().split(/\s+/).length;
  const hasNumber = /\d/.test(trend.topic);
  const relevance = clamp(40 + Math.min(30, wordCount * 5) + (hasNumber ? 20 : 0));

  // Content fit: does the category match the niche's preferred categories?
  const contentFit = profile.preferredCategories.includes(trend.category.toLowerCase())
    ? 90
    : 45;

  // Competition: invert when reported, neutral otherwise.
  const competition =
    trend.competitionLevel === undefined ? 50 : clamp(100 - trend.competitionLevel);

  // Repeatability: evergreen categories can become repeatable series.
  const repeatability = EVERGREEN_CATEGORIES.has(trend.category.toLowerCase()) ? 85 : 50;

  const total = Math.round(
    recency * weights.recency +
      nicheMatch * weights.nicheMatch +
      searchInterest * weights.searchInterest +
      relevance * weights.relevance +
      contentFit * weights.contentFit +
      competition * weights.competition +
      repeatability * weights.repeatability,
  );

  return {
    recency: Math.round(recency),
    nicheMatch: Math.round(nicheMatch),
    searchInterest: Math.round(searchInterest),
    relevance: Math.round(relevance),
    contentFit: Math.round(contentFit),
    competition: Math.round(competition),
    repeatability: Math.round(repeatability),
    total: clamp(total),
  };
}

export function describeScore(breakdown: TrendScoreBreakdown): string {
  const parts: string[] = [];
  if (breakdown.recency >= 70) parts.push('very recent');
  if (breakdown.nicheMatch >= 60) parts.push('strong niche match');
  if (breakdown.searchInterest >= 70) parts.push('high search interest');
  if (breakdown.competition >= 60) parts.push('low competition');
  if (breakdown.repeatability >= 70) parts.push('repeatable format');
  return parts.length ? parts.join(', ') : 'moderate overall signal';
}

function clamp(n: number): number {
  return Math.min(100, Math.max(0, n));
}
