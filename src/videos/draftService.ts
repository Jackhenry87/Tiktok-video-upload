import fs from 'fs-extra';
import {
  deleteDraft,
  getDraft,
  getIdea,
  getTrend,
  getVideoJob,
  listDrafts,
  insertDraft,
  updateDraft,
  updateIdeaStatus,
  listVideoJobs,
  getUploadForDraft,
  updateUpload,
} from '../db/database';
import { audit, logger } from '../utils/logger';
import { checkClaims, cleanHashtags, ensureDisclaimer, sanitizeText } from '../utils/validators';
import { draftMetadataPath, removeFileIfExists, writeJson } from '../utils/fileStorage';
import { previewNextSlot } from '../uploads/scheduleService';
import { generateThumbnail } from './thumbnailService';
import type { Draft } from '../types';

/**
 * Draft service — the manual review gate. Every generated video becomes a
 * draft that must be approved before any upload can happen (unless
 * REVIEW_REQUIRED=false is set explicitly).
 */

export async function createDraftFromJob(videoJobId: number): Promise<number> {
  const job = getVideoJob(videoJobId);
  if (!job) throw new Error(`Video job ${videoJobId} not found`);
  if (job.status !== 'completed' || !job.videoPath) {
    throw new Error(`Video job ${videoJobId} is not completed yet`);
  }
  const idea = getIdea(job.ideaId);
  if (!idea) throw new Error(`Idea ${job.ideaId} not found`);
  const trend = getTrend(idea.trendId);

  const suggestedPostTime = previewNextSlot();

  const draft: Draft = {
    videoJobId,
    ideaId: idea.id!,
    videoPath: job.videoPath,
    script: idea.script,
    caption: idea.caption,
    hashtags: idea.hashtags,
    trendSource: trend
      ? `${trend.sourceLabel}${trend.sourceUrl ? ` (${trend.sourceUrl})` : ''}`
      : 'unknown',
    viewmaxJobId: job.viewmaxJobId,
    suggestedPostTime,
    status: 'pending',
  };
  const draftId = insertDraft(draft);

  // Thumbnail is keyed by the draft id, so generate it after the insert.
  const thumbnailPath = await generateThumbnail(job.videoPath, draftId, idea.hook);
  updateDraft(draftId, { thumbnailPath });
  draft.thumbnailPath = thumbnailPath;

  // Export a JSON copy for easy inspection outside the CLI.
  await writeJson(draftMetadataPath(draftId), {
    ...draft,
    id: draftId,
    ideaTitle: idea.title,
    niche: idea.niche,
    selectionReason: idea.selectionReason,
  });

  audit('info', 'Draft created, awaiting review', { draftId, videoJobId });
  return draftId;
}

export function listPendingDrafts(): Draft[] {
  return listDrafts({ status: 'pending' });
}

export function approveDraft(id: number, note?: string): Draft {
  const draft = mustGet(id);
  if (draft.status !== 'pending') {
    throw new Error(`Draft ${id} is "${draft.status}" — only pending drafts can be approved.`);
  }
  updateDraft(id, { status: 'approved', reviewNote: note });
  audit('info', 'Draft approved', { draftId: id, note });
  return mustGet(id);
}

export function rejectDraft(id: number, note?: string): Draft {
  const draft = mustGet(id);
  if (draft.status === 'uploaded') {
    throw new Error(`Draft ${id} was already uploaded and cannot be rejected.`);
  }
  updateDraft(id, { status: 'rejected', reviewNote: note });
  releaseScheduledSlot(id);
  audit('info', 'Draft rejected', { draftId: id, note });
  return mustGet(id);
}

/** Free the daily-cap slot held by a draft that will no longer upload. */
function releaseScheduledSlot(draftId: number): void {
  const upload = getUploadForDraft(draftId);
  if (upload && (upload.status === 'scheduled' || upload.status === 'failed')) {
    updateUpload(upload.id!, { status: 'skipped', error: 'draft rejected/regenerating' });
  }
}

/**
 * Regenerate: reject the current draft and re-open its idea so the next
 * `create-video` run produces a fresh video for it.
 */
export function regenerateDraft(id: number, note?: string): Draft {
  const draft = mustGet(id);
  if (draft.status === 'uploaded') {
    throw new Error(`Draft ${id} was already uploaded and cannot be regenerated.`);
  }
  updateDraft(id, { status: 'regenerating', reviewNote: note ?? 'regenerate requested' });
  releaseScheduledSlot(id);
  updateIdeaStatus(draft.ideaId, 'ready');
  audit('info', 'Draft flagged for regeneration; idea re-opened', { draftId: id });
  return mustGet(id);
}

export function editDraft(
  id: number,
  patch: { caption?: string; hashtags?: string[] },
): Draft {
  const draft = mustGet(id);
  if (draft.status === 'uploaded') {
    throw new Error(`Draft ${id} was already uploaded and cannot be edited.`);
  }

  // Edits go through the same compliance pipeline as generated content:
  // banned phrases sanitized, disclaimer re-applied, hard claims rejected,
  // hashtags cleaned/capped.
  const idea = getIdea(draft.ideaId);
  const niche = idea?.niche ?? '';

  let caption = patch.caption;
  if (caption !== undefined) {
    const pass = sanitizeText(caption);
    caption = ensureDisclaimer(pass.text, niche).caption;
    const claims = checkClaims(caption);
    if (claims.length) {
      throw new Error(
        `Edited caption blocked by compliance: ${claims.map((i) => i.detail).join('; ')}`,
      );
    }
    if (pass.issues.length) {
      audit('warn', 'Edited caption sanitized', {
        draftId: id,
        issues: pass.issues.map((i) => i.detail),
      });
    }
  }

  let hashtags = patch.hashtags;
  if (hashtags !== undefined) {
    const cleaned = cleanHashtags(hashtags);
    hashtags = cleaned.hashtags;
    if (cleaned.issues.length) {
      audit('warn', 'Edited hashtags cleaned', {
        draftId: id,
        issues: cleaned.issues.map((i) => i.detail),
      });
    }
  }

  updateDraft(id, { caption, hashtags });
  audit('info', 'Draft edited', { draftId: id, fields: Object.keys(patch) });
  return mustGet(id);
}

/**
 * Clean old/failed items:
 *  - rejected/regenerating drafts older than `days`
 *  - failed video jobs older than `days`
 * Removes associated video/thumbnail files as well.
 */
export async function cleanOldDrafts(days: number, dryRun = false): Promise<{
  draftsRemoved: number;
  jobsMarked: number;
}> {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  let draftsRemoved = 0;

  for (const draft of listDrafts({ limit: 1000 })) {
    const isStale =
      (draft.status === 'rejected' || draft.status === 'regenerating') &&
      (draft.updatedAt ?? draft.createdAt ?? '') < cutoff;
    if (!isStale) continue;
    const upload = getUploadForDraft(draft.id!);
    if (upload?.status === 'uploaded') continue;
    if (dryRun) {
      logger.info(`[dry-run] would remove draft #${draft.id} (${draft.status})`);
      draftsRemoved += 1;
      continue;
    }
    await removeFileIfExists(draft.videoPath);
    await removeFileIfExists(draft.thumbnailPath);
    await removeFileIfExists(draftMetadataPath(draft.id!));
    deleteDraft(draft.id!);
    draftsRemoved += 1;
    logger.info(`Removed draft #${draft.id} (${draft.status})`);
  }

  // Failed jobs: keep the rows for audit, but clear orphaned files.
  let jobsMarked = 0;
  for (const job of listVideoJobs({ status: 'failed', limit: 1000 })) {
    if ((job.updatedAt ?? '') >= cutoff) continue;
    if (!dryRun && job.videoPath && (await fs.pathExists(job.videoPath))) {
      await removeFileIfExists(job.videoPath);
    }
    jobsMarked += 1;
  }

  audit('info', 'Clean finished', { days, draftsRemoved, jobsMarked, dryRun });
  return { draftsRemoved, jobsMarked };
}

function mustGet(id: number): Draft {
  const draft = getDraft(id);
  if (!draft) throw new Error(`Draft ${id} not found`);
  return draft;
}
