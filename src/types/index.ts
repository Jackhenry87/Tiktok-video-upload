/**
 * Core domain types shared across the application.
 */

// ---------------------------------------------------------------------------
// Niches
// ---------------------------------------------------------------------------

export const SUPPORTED_NICHES = [
  'sports betting',
  'finance',
  'side hustles',
  'real estate',
  'ai tools',
  'college life',
  'fitness',
  'local business marketing',
] as const;

export type Niche = (typeof SUPPORTED_NICHES)[number];

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

export type TrendSourceLabel =
  | 'manual-config'
  | 'csv-file'
  | 'rss-feed'
  | 'google-trends-csv'
  | 'tiktok-creative-center'
  | 'mock'
  | string;

export interface TrendScoreBreakdown {
  recency: number;
  nicheMatch: number;
  searchInterest: number;
  relevance: number;
  contentFit: number;
  competition: number;
  repeatability: number;
  total: number;
}

export interface TrendSignal {
  id?: number;
  topic: string;
  category: string;
  niche: string;
  suggestedHook: string;
  suggestedCaption: string;
  suggestedHashtags: string[];
  suggestedVideoLengthSec: number;
  suggestedVisualStyle: string;
  suggestedCta: string;
  /** Raw signal strength from the source, 0-100. */
  estimatedStrength: number;
  /** Optional competition level from the source, 0-100 (higher = more crowded). */
  competitionLevel?: number;
  /** Computed score 0-100 (see trendScorer). */
  score?: number;
  scoreBreakdown?: TrendScoreBreakdown;
  sourceLabel: TrendSourceLabel;
  sourceUrl?: string;
  /** ISO date the trend was found. */
  dateFound: string;
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Ideas
// ---------------------------------------------------------------------------

export interface SceneBreakdown {
  index: number;
  durationSec: number;
  description: string;
  onScreenText: string;
  voiceover: string;
  broll: string;
  /** Visual pattern interrupt used to keep attention (every 2-4s). */
  patternInterrupt: string;
}

export type IdeaStatus = 'ready' | 'video_created' | 'archived';

export interface VideoIdea {
  id?: number;
  trendId: number;
  title: string;
  /** First-2-seconds hook. */
  hook: string;
  script: string;
  scenes: SceneBreakdown[];
  onScreenText: string[];
  voiceoverText: string;
  brollInstructions: string[];
  musicGuidance: string;
  caption: string;
  hashtags: string[];
  targetAudience: string;
  category: string;
  niche: string;
  estimatedDurationSec: number;
  /** Why this trend was selected (score + reasoning). */
  selectionReason: string;
  complianceNotes: string[];
  status: IdeaStatus;
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Video jobs (queue)
// ---------------------------------------------------------------------------

export type VideoJobStatus =
  | 'queued'
  | 'submitted'
  | 'processing'
  | 'completed'
  | 'failed';

export interface VideoJob {
  id?: number;
  ideaId: number;
  viewmaxJobId?: string;
  status: VideoJobStatus;
  attempts: number;
  /** Serialized ViewMax request payload for audit/debugging. */
  requestPayload?: string;
  videoPath?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Drafts (manual review)
// ---------------------------------------------------------------------------

export type DraftStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'regenerating'
  | 'uploaded';

export interface Draft {
  id?: number;
  videoJobId: number;
  ideaId: number;
  videoPath: string;
  thumbnailPath?: string;
  script: string;
  caption: string;
  hashtags: string[];
  /** Source attribution kept internally (label + URL when available). */
  trendSource: string;
  viewmaxJobId?: string;
  /** ISO timestamp suggestion for when to post. */
  suggestedPostTime?: string;
  status: DraftStatus;
  reviewNote?: string;
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

export type UploadStatus =
  | 'scheduled'
  | 'uploading'
  | 'uploaded'
  | 'failed'
  | 'skipped';

export type PrivacyStatus =
  | 'SELF_ONLY'
  | 'MUTUAL_FOLLOW_FRIENDS'
  | 'FOLLOWER_OF_CREATOR'
  | 'PUBLIC_TO_EVERYONE';

export interface UploadRecord {
  id?: number;
  draftId: number;
  tiktokPublishId?: string;
  tiktokVideoId?: string;
  privacyStatus: PrivacyStatus;
  status: UploadStatus;
  /** ISO timestamp (UTC) the upload is scheduled for. */
  scheduledAt?: string;
  /** ISO timestamp (UTC) the upload completed. */
  uploadedAt?: string;
  error?: string;
  attempts: number;
  createdAt?: string;
  updatedAt?: string;
}

// ---------------------------------------------------------------------------
// Compliance
// ---------------------------------------------------------------------------

export interface ComplianceIssue {
  severity: 'block' | 'fix' | 'warn';
  rule: string;
  detail: string;
}

export interface ComplianceResult {
  ok: boolean;
  issues: ComplianceIssue[];
  /** Text after automatic sanitization (banned phrases replaced). */
  sanitizedText?: string;
}

// ---------------------------------------------------------------------------
// Runtime mode
// ---------------------------------------------------------------------------

export type RuntimeMode = 'real' | 'mock';
