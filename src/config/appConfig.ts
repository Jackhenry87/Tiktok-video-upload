import fs from 'fs-extra';
import path from 'node:path';
import { env } from './env';
import type { TrendSignal } from '../types';

/**
 * Application configuration: niches, scoring weights, compliance lists,
 * video assembly rules, and optional user overrides from ./app.config.json.
 */

export interface NicheProfile {
  name: string;
  keywords: string[];
  audience: string;
  baseHashtags: string[];
  /** Disclaimer appended to captions for regulated niches ('' = none). */
  disclaimer: string;
  preferredCategories: string[];
}

export interface ScoringWeights {
  recency: number;
  nicheMatch: number;
  searchInterest: number;
  relevance: number;
  contentFit: number;
  competition: number;
  repeatability: number;
}

export interface VideoRules {
  format: '9:16';
  resolution: '1080x1920';
  minSceneSec: number;
  maxSceneSec: number;
  patternInterruptEverySecMin: number;
  patternInterruptEverySecMax: number;
  captionsEnabled: boolean;
  maxHashtags: number;
  minDurationSec: number;
  maxDurationSec: number;
}

export interface AppConfig {
  niches: NicheProfile[];
  defaultNiche: string;
  activeNiches: string[];
  scoringWeights: ScoringWeights;
  minTrendScore: number;
  videoRules: VideoRules;
  bannedPhrases: string[];
  phraseReplacements: Record<string, string>;
  spammyHashtags: string[];
  postingTimes: string[];
  maxDailyUploads: number;
  /** User-supplied manual trend input (approved source). */
  manualTrends: Partial<TrendSignal>[];
}

const NICHE_PROFILES: NicheProfile[] = [
  {
    name: 'sports betting',
    keywords: ['betting', 'odds', 'parlay', 'sportsbook', 'nfl', 'nba', 'mlb', 'wager', 'bankroll', 'underdog', 'spread'],
    audience: 'Sports fans 21+ interested in responsible betting strategy',
    baseHashtags: ['sportsbetting', 'bettingtips', 'sports'],
    disclaimer: '21+. Gamble responsibly. No outcome is ever guaranteed.',
    preferredCategories: ['sports', 'education', 'entertainment'],
  },
  {
    name: 'finance',
    keywords: ['money', 'invest', 'stocks', 'savings', 'budget', 'credit', 'compound', 'etf', 'retirement', 'dividend', 'inflation'],
    audience: 'Young adults learning personal finance basics',
    baseHashtags: ['personalfinance', 'moneytips', 'investing'],
    disclaimer: 'Not financial advice. Educational content only.',
    preferredCategories: ['finance', 'education'],
  },
  {
    name: 'side hustles',
    keywords: ['side hustle', 'freelance', 'gig', 'extra income', 'flipping', 'reselling', 'online business', 'passive'],
    audience: 'People looking for legitimate ways to earn extra income',
    baseHashtags: ['sidehustle', 'makemoneyonline', 'hustle'],
    disclaimer: 'Results vary. No income amount is typical or guaranteed.',
    preferredCategories: ['business', 'education', 'lifestyle'],
  },
  {
    name: 'real estate',
    keywords: ['real estate', 'mortgage', 'rental', 'property', 'house hacking', 'airbnb', 'landlord', 'closing costs', 'equity'],
    audience: 'First-time buyers and aspiring real-estate investors',
    baseHashtags: ['realestate', 'realestateinvesting', 'housingmarket'],
    disclaimer: 'Not financial advice. Do your own research.',
    preferredCategories: ['finance', 'education', 'lifestyle'],
  },
  {
    name: 'ai tools',
    keywords: ['ai', 'chatgpt', 'automation', 'prompt', 'machine learning', 'productivity', 'workflow', 'agent', 'llm'],
    audience: 'Tech-curious professionals and creators',
    baseHashtags: ['aitools', 'ai', 'productivity'],
    disclaimer: '',
    preferredCategories: ['technology', 'education', 'business'],
  },
  {
    name: 'college life',
    keywords: ['college', 'dorm', 'student', 'campus', 'study', 'exam', 'scholarship', 'roommate', 'semester'],
    audience: 'College students and incoming freshmen',
    baseHashtags: ['collegelife', 'studentlife', 'studytips'],
    disclaimer: '',
    preferredCategories: ['education', 'lifestyle', 'entertainment'],
  },
  {
    name: 'fitness',
    keywords: ['workout', 'gym', 'protein', 'training', 'cardio', 'strength', 'mobility', 'recovery', 'routine'],
    audience: 'Beginners and intermediate gym-goers',
    baseHashtags: ['fitness', 'gymtok', 'workout'],
    disclaimer: 'Not medical advice. Consult a professional before starting.',
    preferredCategories: ['fitness', 'lifestyle', 'education'],
  },
  {
    name: 'local business marketing',
    keywords: ['local business', 'small business', 'marketing', 'google reviews', 'foot traffic', 'storefront', 'seo', 'customers'],
    audience: 'Small business owners and local marketers',
    baseHashtags: ['smallbusiness', 'localbusiness', 'marketingtips'],
    disclaimer: '',
    preferredCategories: ['business', 'education'],
  },
];

const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  recency: 0.2,
  nicheMatch: 0.2,
  searchInterest: 0.2,
  relevance: 0.1,
  contentFit: 0.1,
  competition: 0.1,
  repeatability: 0.1,
};

const DEFAULT_VIDEO_RULES: VideoRules = {
  format: '9:16',
  resolution: '1080x1920',
  minSceneSec: 2,
  maxSceneSec: 4,
  patternInterruptEverySecMin: 2,
  patternInterruptEverySecMax: 4,
  captionsEnabled: true,
  maxHashtags: 5,
  minDurationSec: 12,
  maxDurationSec: 45,
};

/**
 * Phrases that are never allowed in scripts or captions
 * (misleading/guaranteed-outcome claims). Matched case-insensitively.
 */
const BANNED_PHRASES: string[] = [
  'guaranteed winner',
  'guaranteed win',
  'guaranteed profit',
  'guaranteed return',
  'guaranteed income',
  'risk-free',
  'risk free',
  "can't lose",
  'cannot lose',
  '100% win',
  '100% accurate',
  'sure thing',
  'lock of the day',
  'lock of the week',
  'get rich quick',
  'double your money',
  'never lose',
  'miracle cure',
  'cures',
];

const PHRASE_REPLACEMENTS: Record<string, string> = {
  'guaranteed winner': 'strong pick',
  'guaranteed win': 'strong opportunity',
  'guaranteed profit': 'potential upside',
  'guaranteed return': 'potential return',
  'guaranteed income': 'potential income',
  'risk-free': 'lower-risk',
  'risk free': 'lower-risk',
  "can't lose": 'worth researching',
  'cannot lose': 'worth researching',
  '100% win': 'high-conviction',
  '100% accurate': 'well-researched',
  'sure thing': 'interesting angle',
  'lock of the day': 'pick of the day',
  'lock of the week': 'pick of the week',
  'get rich quick': 'build income over time',
  'double your money': 'grow your money',
  'never lose': 'manage risk',
};

const SPAMMY_HASHTAGS: string[] = [
  'follow4follow',
  'f4f',
  'like4like',
  'l4l',
  'followme',
  'followback',
  'sub4sub',
  'likeforlike',
  'followforfollow',
  'fyp卐',
  'viralplease',
];

interface UserOverrides {
  manualTrends?: Partial<TrendSignal>[];
  minTrendScore?: number;
  postingTimes?: string[];
  scoringWeights?: Partial<ScoringWeights>;
  activeNiches?: string[];
}

/** Optional user override file at project root (see app.config.example.json). */
function loadUserOverrides(): UserOverrides {
  const configPath = path.resolve(process.cwd(), 'app.config.json');
  try {
    if (fs.pathExistsSync(configPath)) {
      return fs.readJsonSync(configPath) as UserOverrides;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`Could not parse app.config.json, ignoring it: ${(err as Error).message}`);
  }
  return {};
}

let cached: AppConfig | undefined;

export function getAppConfig(): AppConfig {
  if (cached) return cached;
  const overrides = loadUserOverrides();

  const activeNiches =
    overrides.activeNiches?.length
      ? overrides.activeNiches
      : env.NICHES.length
        ? env.NICHES
        : [env.DEFAULT_NICHE];

  cached = {
    niches: NICHE_PROFILES,
    defaultNiche: env.DEFAULT_NICHE,
    activeNiches: activeNiches.map((n) => n.toLowerCase().trim()),
    scoringWeights: { ...DEFAULT_SCORING_WEIGHTS, ...overrides.scoringWeights },
    minTrendScore: overrides.minTrendScore ?? env.MIN_TREND_SCORE,
    videoRules: DEFAULT_VIDEO_RULES,
    bannedPhrases: BANNED_PHRASES,
    phraseReplacements: PHRASE_REPLACEMENTS,
    spammyHashtags: SPAMMY_HASHTAGS,
    postingTimes:
      overrides.postingTimes ??
      env.POSTING_TIMES.split(',').map((s) => s.trim()).filter(Boolean),
    maxDailyUploads: env.MAX_DAILY_UPLOADS,
    manualTrends: overrides.manualTrends ?? [],
  };
  return cached;
}

export function getNicheProfile(name: string): NicheProfile {
  const found = NICHE_PROFILES.find(
    (n) => n.name.toLowerCase() === name.toLowerCase().trim(),
  );
  // Unknown niches get a generic profile so the app never crashes on config.
  return (
    found ?? {
      name,
      keywords: name.toLowerCase().split(/\s+/),
      audience: `People interested in ${name}`,
      baseHashtags: [name.toLowerCase().replace(/[^a-z0-9]/g, '')],
      disclaimer: '',
      preferredCategories: ['education', 'lifestyle'],
    }
  );
}
