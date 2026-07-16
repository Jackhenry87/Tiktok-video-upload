import { getAppConfig, getNicheProfile } from '../config/appConfig';
import { cleanHashtags, ensureDisclaimer } from '../utils/validators';
import type { TrendSignal } from '../types';
import { hashPick } from './scriptGenerator';

/**
 * Original caption + hashtag generation. Captions are template-built from the
 * trend TOPIC only — never copied from other creators' captions.
 */

const CAPTION_TEMPLATES = [
  '{topic} — the short version. Save this for later 📌',
  'Everything you need to know about {topic} in one video.',
  'POV: someone finally explains {topic} without the fluff.',
  'The beginner-friendly take on {topic}. Which part surprised you?',
  '{topic}, explained in plain English. More every week.',
] as const;

export interface GeneratedCaption {
  caption: string;
  hashtags: string[];
}

export function generateCaption(trend: TrendSignal): GeneratedCaption {
  const config = getAppConfig();
  const profile = getNicheProfile(trend.niche);

  const base = hashPick(CAPTION_TEMPLATES, trend.topic, 3).replace(
    '{topic}',
    trend.topic,
  );

  // Hashtags: niche base tags + a slug of the topic + any source suggestions.
  const topicSlug = trend.topic
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 3)
    .join('');
  const rawTags = [
    ...profile.baseHashtags,
    topicSlug,
    ...trend.suggestedHashtags,
  ].filter(Boolean);

  const { hashtags } = cleanHashtags(rawTags);
  const { caption } = ensureDisclaimer(base, trend.niche);

  return { caption, hashtags: hashtags.slice(0, config.videoRules.maxHashtags) };
}
