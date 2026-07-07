import path from 'node:path';
import {
  insertDraft,
  insertIdea,
  insertTrend,
  insertVideoJob,
  updateVideoJob,
} from '../db/database';
import { audit } from '../utils/logger';
import { checkClaims, cleanHashtags, sanitizeText } from '../utils/validators';
import { videoFilePath } from '../utils/fileStorage';
import { previewNextSlot } from '../uploads/scheduleService';
import { generateThumbnail } from './thumbnailService';
import { renderStoryVideo } from './renderer/storyRenderer';

/**
 * Story pipeline entry: takes an ORIGINAL story (written per-run, never
 * scraped or copied), renders the narrated word-pop video, and files it as
 * a pending draft in the normal review/upload flow.
 */

export interface StoryInput {
  title: string;
  /** Full narration, hook first. Must be original writing. */
  story: string;
  caption: string;
  hashtags: string[];
  /** Optional specific background clip path (defaults to library random). */
  background?: string;
}

export interface StoryDraftResult {
  draftId: number;
  videoJobId: number;
  durationHint: string;
}

export async function createStoryDraft(input: StoryInput): Promise<StoryDraftResult> {
  // Compliance first: sanitize phrasing, hard-block disallowed claims.
  const pass = sanitizeText(input.story);
  const claims = checkClaims(pass.text);
  if (claims.length) {
    throw new Error(
      `Story blocked by compliance: ${claims.map((c) => c.detail).join('; ')}`,
    );
  }
  const captionPass = sanitizeText(input.caption);
  const tags = cleanHashtags(input.hashtags).hashtags;

  const trendId = insertTrend({
    topic: input.title,
    category: 'storytime',
    niche: 'storytime',
    suggestedHook: pass.text.split(/[.!?]/)[0] ?? input.title,
    suggestedCaption: captionPass.text,
    suggestedHashtags: tags,
    suggestedVideoLengthSec: 45,
    suggestedVisualStyle: 'narrated story over gameplay, word-pop captions',
    suggestedCta: 'follow for part 2',
    estimatedStrength: 75,
    sourceLabel: 'story-engine',
    dateFound: new Date().toISOString().slice(0, 10),
  });

  const ideaId = insertIdea({
    trendId,
    title: input.title,
    hook: pass.text.split(/[.!?]/)[0] ?? input.title,
    script: pass.text,
    scenes: [],
    onScreenText: [],
    voiceoverText: pass.text,
    brollInstructions: [input.background ?? 'random gameplay/background library clip'],
    musicGuidance: 'voiceover-led; no music',
    caption: captionPass.text,
    hashtags: tags,
    targetAudience: 'story-time scrollers',
    category: 'storytime',
    niche: 'storytime',
    estimatedDurationSec: Math.round(pass.text.split(/\s+/).length / 2.8),
    selectionReason: 'original story written for the story engine',
    complianceNotes: pass.issues.map((i) => `[${i.severity}] ${i.rule}: ${i.detail}`),
    status: 'video_created',
  });

  const videoJobId = insertVideoJob({ ideaId, status: 'queued' });
  const destPath = videoFilePath(videoJobId);
  try {
    await renderStoryVideo({
      storyText: pass.text,
      backgroundPath: input.background,
      destPath,
    });
    updateVideoJob(videoJobId, {
      status: 'completed',
      videoPath: destPath,
      viewmaxJobId: `story-${videoJobId}`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateVideoJob(videoJobId, { status: 'failed', error: message });
    throw err;
  }

  const draftId = insertDraft({
    videoJobId,
    ideaId,
    videoPath: destPath,
    script: pass.text,
    caption: captionPass.text,
    hashtags: tags,
    trendSource: 'story-engine (original writing)',
    viewmaxJobId: `story-${videoJobId}`,
    suggestedPostTime: previewNextSlot(),
    status: 'pending',
  });
  const thumbnailPath = await generateThumbnail(destPath, draftId, input.title);
  const { updateDraft } = await import('../db/database');
  updateDraft(draftId, { thumbnailPath });

  audit('info', 'Story draft created', {
    draftId,
    videoJobId,
    title: input.title,
    background: input.background ? path.basename(input.background) : 'library/fallback',
  });
  return {
    draftId,
    videoJobId,
    durationHint: `~${Math.round(pass.text.split(/\s+/).length / 2.8)}s narration`,
  };
}
