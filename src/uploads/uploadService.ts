import fs from 'fs-extra';
import { env, resolveMode, reviewRequired } from '../config/env';
import { hasTikTokAuth } from '../connectors/tiktok/tiktokAuth';
import { getAppConfig } from '../config/appConfig';
import { getTikTokClient } from '../connectors/tiktok/tiktokClient';
import {
  getIdea,
  getUploadForDraft,
  insertUpload,
  listDrafts,
  listUploads,
  updateDraft,
  updateUpload,
} from '../db/database';
import { audit, logger } from '../utils/logger';
import { cleanHashtags, validateUploadText } from '../utils/validators';
import { localDayKey } from './scheduleService';
import type { Draft, UploadRecord } from '../types';

/**
 * Upload service — the only code path that publishes anything, guarded by:
 *  1. Manual approval (REVIEW_REQUIRED=true by default).
 *  2. A final compliance validation on the caption.
 *  3. The MAX_DAILY_UPLOADS cap.
 *  4. Official TikTok API only (mock adapter when unconfigured).
 */

export interface UploadRunResult {
  uploaded: { draftId: number; publishId: string; videoId?: string }[];
  skipped: { draftId: number; reason: string }[];
  failed: { draftId: number; error: string }[];
}

export async function uploadApprovedDrafts(opts: {
  draftId?: number;
  /** Upload even if the scheduled slot hasn't arrived yet. */
  now?: boolean;
  /**
   * Inbox mode: send to the user's TikTok app drafts for one-tap public
   * posting (no app audit required). Caption/hashtags are added in-app.
   */
  inbox?: boolean;
} = {}): Promise<UploadRunResult> {
  const result: UploadRunResult = { uploaded: [], skipped: [], failed: [] };
  const config = getAppConfig();

  let candidates: Draft[];
  if (opts.draftId) {
    candidates = listDrafts({ limit: 1000 }).filter((d) => d.id === opts.draftId);
    if (!candidates.length) {
      result.skipped.push({ draftId: opts.draftId, reason: 'draft not found' });
      return result;
    }
  } else {
    candidates = listDrafts({ status: 'approved' });
    if (!reviewRequired()) {
      // Explicit REVIEW_REQUIRED=false: pending drafts are auto-approved.
      const pending = listDrafts({ status: 'pending' });
      for (const d of pending) {
        updateDraft(d.id!, { status: 'approved', reviewNote: 'auto-approved (REVIEW_REQUIRED=false)' });
        audit('warn', 'Draft auto-approved because REVIEW_REQUIRED=false', { draftId: d.id });
      }
      candidates = listDrafts({ status: 'approved' });
    }
  }

  if (!candidates.length) {
    logger.warn(
      'No approved drafts to upload. Approve pending drafts first: npm run review -- --approve <id>',
    );
    return result;
  }

  const client = getTikTokClient();
  const nowIso = new Date().toISOString();

  for (const draft of candidates) {
    const draftId = draft.id!;

    // Gate 1: approval status (also covers the explicit --draft path).
    if (draft.status !== 'approved') {
      result.skipped.push({ draftId, reason: `status is "${draft.status}", not approved` });
      continue;
    }

    // Gate 2: scheduling — respect the assigned slot unless --now.
    const existing = getUploadForDraft(draftId);
    if (
      existing?.status === 'scheduled' &&
      existing.scheduledAt &&
      existing.scheduledAt > nowIso &&
      !opts.now
    ) {
      result.skipped.push({
        draftId,
        reason: `scheduled for ${existing.scheduledAt} (use --now to force)`,
      });
      continue;
    }
    if (existing?.status === 'uploaded') {
      result.skipped.push({ draftId, reason: 'already uploaded' });
      continue;
    }

    // Gate 3: daily cap — counted per LOCAL calendar day (TIMEZONE),
    // re-checked every iteration so one run can't blow past the limit.
    const today = localDayKey(new Date());
    const uploadedToday = listUploads({ status: 'uploaded', limit: 5000 }).filter(
      (u) => u.uploadedAt && localDayKey(u.uploadedAt) === today,
    ).length;
    if (uploadedToday >= config.maxDailyUploads) {
      result.skipped.push({
        draftId,
        reason: `daily upload limit reached (${config.maxDailyUploads})`,
      });
      continue;
    }

    // Gate 4: final compliance check — fails CLOSED: without the idea row
    // we cannot verify niche disclaimers, so the draft does not upload.
    const idea = getIdea(draft.ideaId);
    if (!idea) {
      result.skipped.push({
        draftId,
        reason: 'idea record missing — cannot verify compliance, refusing to upload',
      });
      audit('warn', 'Upload blocked: idea record missing', { draftId });
      continue;
    }
    const compliance = validateUploadText(draft.caption, idea.niche);
    if (!compliance.ok) {
      const reasons = compliance.issues.map((i) => i.detail).join('; ');
      result.skipped.push({ draftId, reason: `compliance: ${reasons}` });
      audit('warn', 'Upload blocked by compliance', { draftId, reasons });
      continue;
    }

    // 'uploaded' rows were skipped above, so any existing row can be reused.
    const uploadId = existing
      ? existing.id!
      : insertUpload({
            draftId,
            privacyStatus: env.DEFAULT_PRIVACY_STATUS,
            status: 'scheduled',
          });

    // Gate 5: the video file must exist. Persist the failure so
    // `upload --retry-failed` can pick it up once the file is restored.
    if (!(await fs.pathExists(draft.videoPath))) {
      const error = `video file missing: ${draft.videoPath}`;
      updateUpload(uploadId, { status: 'failed', error });
      result.failed.push({ draftId, error });
      audit('error', 'Upload failed: video file missing', { draftId, videoPath: draft.videoPath });
      continue;
    }

    try {
      updateUpload(uploadId, { status: 'uploading', attempts: (existing?.attempts ?? 0) + 1 });
      // No outer retry wrapper here: the client already retries each step
      // (init / chunk PUT / status) with backoff, and an outer retry would
      // re-send the whole video even for non-retryable 4xx errors. Failed
      // uploads stay retryable via `npm run upload -- --retry-failed`.
      // Re-clean hashtags at the last gate (dedupe, spam filter, cap) so
      // nothing that bypassed idea-time cleaning reaches the post title.
      const finalTags = cleanHashtags(draft.hashtags);
      if (finalTags.issues.length) {
        audit('warn', 'Hashtags cleaned at upload time', {
          draftId,
          issues: finalTags.issues.map((i) => i.detail),
        });
      }
      const uploadResult = opts.inbox
        ? await client.uploadToInbox(draft.videoPath)
        : await client.uploadVideo({
            videoFilePath: draft.videoPath,
            caption: draft.caption,
            hashtags: finalTags.hashtags,
            privacyStatus: env.DEFAULT_PRIVACY_STATUS,
          });

      updateUpload(uploadId, {
        status: 'uploaded',
        tiktokPublishId: uploadResult.publishId,
        tiktokVideoId: uploadResult.videoId,
        uploadedAt: new Date().toISOString(),
        error: null,
      });
      updateDraft(draftId, { status: 'uploaded' });
      result.uploaded.push({
        draftId,
        publishId: uploadResult.publishId,
        videoId: uploadResult.videoId,
      });
      audit('info', 'Draft uploaded to TikTok', {
        draftId,
        publishId: uploadResult.publishId,
        videoId: uploadResult.videoId,
        // Stored OAuth tokens count as configured, same as getTikTokClient().
        mode: resolveMode(hasTikTokAuth()),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateUpload(uploadId, { status: 'failed', error: message });
      result.failed.push({ draftId, error: message });
      audit('error', 'TikTok upload failed', { draftId, error: message });
    }
  }

  return result;
}

/** Retry uploads that previously failed (keeps their upload rows). */
export async function retryFailedUploads(): Promise<UploadRunResult> {
  const failed = listUploads({ status: 'failed' });
  const result: UploadRunResult = { uploaded: [], skipped: [], failed: [] };
  for (const upload of failed) {
    updateUpload(upload.id!, { status: 'scheduled' });
    const single = await uploadApprovedDrafts({ draftId: upload.draftId, now: true });
    result.uploaded.push(...single.uploaded);
    result.skipped.push(...single.skipped);
    result.failed.push(...single.failed);
  }
  return result;
}

export function listScheduledUploads(): UploadRecord[] {
  return listUploads({ status: 'scheduled' });
}
