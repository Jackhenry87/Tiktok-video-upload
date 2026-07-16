import { getAppConfig, getNicheProfile } from '../config/appConfig';
import {
  ideaExistsForTrend,
  insertIdea,
  listTrends,
} from '../db/database';
import { audit, logger } from '../utils/logger';
import { validateIdea } from '../utils/validators';
import { describeScore } from '../trends/trendScorer';
import type { VideoIdea } from '../types';
import { generateCaption } from './captionGenerator';
import { generateScript, musicGuidanceFor } from './scriptGenerator';

export interface IdeaGenerationResult {
  generated: number;
  blocked: number;
  ideas: VideoIdea[];
}

/**
 * Turn saved, scored trend signals into original video concepts.
 * Only trends at/above the configured minimum score are used, and every idea
 * passes the compliance validator before being saved.
 */
export async function generateIdeas(limit = 5): Promise<IdeaGenerationResult> {
  const config = getAppConfig();
  const trends = listTrends({ minScore: config.minTrendScore, limit: 50 });

  if (!trends.length) {
    logger.warn(
      `No trends at/above score ${config.minTrendScore} found. ` +
        'Run "npm run trends" first, or lower MIN_TREND_SCORE.',
    );
    return { generated: 0, blocked: 0, ideas: [] };
  }

  const ideas: VideoIdea[] = [];
  let blocked = 0;

  for (const trend of trends) {
    if (ideas.length >= limit) break;
    if (!trend.id || ideaExistsForTrend(trend.id)) continue;

    const script = generateScript(trend);
    const captionData = generateCaption(trend);
    const profile = getNicheProfile(trend.niche);

    const rawIdea: VideoIdea = {
      trendId: trend.id,
      title: trend.topic,
      hook: script.hook,
      script: script.script,
      scenes: script.scenes,
      onScreenText: script.onScreenText,
      voiceoverText: script.voiceoverText,
      brollInstructions: script.brollInstructions,
      musicGuidance: musicGuidanceFor(trend),
      caption: captionData.caption,
      hashtags: captionData.hashtags,
      targetAudience: profile.audience,
      category: trend.category,
      niche: trend.niche,
      estimatedDurationSec: script.estimatedDurationSec,
      selectionReason:
        `Trend score ${trend.score ?? '?'} / 100 (min ${config.minTrendScore}): ` +
        (trend.scoreBreakdown ? describeScore(trend.scoreBreakdown) : 'scored signal') +
        `. Source: ${trend.sourceLabel}${trend.sourceUrl ? ` (${trend.sourceUrl})` : ''}.`,
      complianceNotes: [],
      status: 'ready',
    };

    const { idea, result } = validateIdea(rawIdea);
    if (!result.ok) {
      blocked += 1;
      audit('warn', 'Idea blocked by compliance rules', {
        trendId: trend.id,
        topic: trend.topic,
        issues: result.issues.filter((i) => i.severity === 'block'),
      });
      continue;
    }

    idea.id = insertIdea(idea);
    ideas.push(idea);
    logger.info(`Idea #${idea.id}: "${idea.title}" (${idea.niche}, ~${idea.estimatedDurationSec}s)`);
  }

  audit('info', 'Idea generation finished', {
    generated: ideas.length,
    blocked,
    fromTrends: trends.length,
  });
  return { generated: ideas.length, blocked, ideas };
}
