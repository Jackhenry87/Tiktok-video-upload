import { env, viewMaxMode } from '../config/env';
import { getAppConfig } from '../config/appConfig';
import { getViewMaxClient } from '../connectors/viewmax/viewmaxClient';
import type {
  ViewMaxScene,
  ViewMaxVideoRequest,
} from '../connectors/viewmax/viewmaxTypes';
import {
  countRows,
  getIdea,
  getVideoJob,
  insertVideoJob,
  listDrafts,
  listIdeas,
  listUploads,
  listVideoJobs,
  updateIdeaStatus,
  updateVideoJob,
} from '../db/database';
import { audit, logger } from '../utils/logger';
import { ensureStorageDirs, videoFilePath } from '../utils/fileStorage';
import { runWithConcurrency } from '../utils/queue';
import { pollUntil } from '../utils/retry';
import type { VideoIdea, VideoJob } from '../types';
import { createDraftFromJob } from './draftService';

/**
 * Video job pipeline: idea -> ViewMax request -> poll -> download -> draft.
 * Jobs are persisted in the video_jobs table, which doubles as a durable
 * queue: rows left in 'queued' after a crash are picked up on the next run.
 */

export function buildViewMaxRequest(idea: VideoIdea): ViewMaxVideoRequest {
  const rules = getAppConfig().videoRules;
  const scenes: ViewMaxScene[] = idea.scenes.map((s) => ({
    index: s.index,
    durationSec: s.durationSec,
    description: s.description,
    onScreenText: s.onScreenText,
    voiceover: s.voiceover,
    brollInstruction: s.broll,
    transition: s.patternInterrupt,
  }));

  return {
    script: idea.script,
    scenes,
    voiceoverText: idea.voiceoverText,
    onScreenText: idea.onScreenText,
    format: rules.format,
    resolution: rules.resolution,
    durationTargetSec: idea.estimatedDurationSec,
    stylePreset: 'style-bold-captions',
    voicePreset: 'voice-alex',
    backgroundMusic: { enabled: true, mood: idea.musicGuidance },
    captionsEnabled: rules.captionsEnabled,
    branding: {},
    watermark: { enabled: false },
    outputFormat: 'mp4',
  };
}

/** Create + fully process a video job for one idea. Returns the job id. */
export async function processIdea(ideaId: number): Promise<number> {
  const idea = getIdea(ideaId);
  if (!idea) throw new Error(`Idea ${ideaId} not found`);
  await ensureStorageDirs();

  const request = buildViewMaxRequest(idea);
  const jobId = insertVideoJob({
    ideaId,
    status: 'queued',
    requestPayload: JSON.stringify(request),
  });
  await runJob(jobId);
  return jobId;
}

/** Process an existing queued job row end-to-end. */
export async function runJob(jobId: number): Promise<void> {
  const job = getVideoJob(jobId);
  if (!job) throw new Error(`Video job ${jobId} not found`);
  const idea = getIdea(job.ideaId);
  if (!idea) throw new Error(`Idea ${job.ideaId} for job ${jobId} not found`);

  const client = getViewMaxClient();
  const request: ViewMaxVideoRequest = job.requestPayload
    ? (JSON.parse(job.requestPayload) as ViewMaxVideoRequest)
    : buildViewMaxRequest(idea);

  try {
    updateVideoJob(jobId, { attempts: job.attempts + 1, error: null });

    // 1. Submit to ViewMax (client handles its own HTTP retry).
    const ref = await client.createVideoJob(request);
    updateVideoJob(jobId, { viewmaxJobId: ref.jobId, status: 'submitted' });
    logger.info(`Job ${jobId}: submitted to ViewMax as ${ref.jobId}`);

    // 2. Poll until completed/failed.
    updateVideoJob(jobId, { status: 'processing' });
    const intervalMs = viewMaxMode() === 'mock' ? 300 : 6000;
    const finalStatus = await pollUntil(
      async () => {
        const status = await client.checkVideoStatus(ref.jobId);
        if (status.status === 'completed') return status;
        if (status.status === 'failed') {
          throw new Error(`ViewMax job failed: ${status.error ?? 'unknown error'}`);
        }
        logger.debug(
          `Job ${jobId}: ViewMax ${status.status}` +
            (status.progress !== undefined ? ` (${status.progress}%)` : ''),
        );
        return undefined;
      },
      { intervalMs, timeoutMs: 15 * 60 * 1000, label: `ViewMax job ${ref.jobId}` },
    );

    // 3. Download the finished MP4.
    const destPath = videoFilePath(jobId);
    await client.downloadGeneratedVideo(finalStatus.jobId, destPath);
    updateVideoJob(jobId, { status: 'completed', videoPath: destPath });
    updateIdeaStatus(idea.id!, 'video_created');
    audit('info', 'Video job completed', { jobId, viewmaxJobId: ref.jobId, videoPath: destPath });

    // 4. Save a draft for manual review.
    const draftId = await createDraftFromJob(jobId);
    logger.info(`Job ${jobId}: draft #${draftId} saved for review (npm run review)`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateVideoJob(jobId, { status: 'failed', error: message });
    audit('error', 'Video job failed', { jobId, error: message });
    throw err;
  }
}

/** Create a video for the next best 'ready' idea (or a specific one). */
export async function createVideo(ideaId?: number): Promise<number | undefined> {
  if (ideaId) return processIdea(ideaId);
  const ready = listIdeas({ status: 'ready', limit: 1 });
  const idea = ready[0];
  if (!idea) {
    logger.warn('No ideas ready for video creation. Run "npm run ideas" first.');
    return undefined;
  }
  return processIdea(idea.id!);
}

/**
 * Batch creation through the durable queue:
 * 1) resume any jobs left 'queued' from previous runs,
 * 2) enqueue jobs for the next N ready ideas,
 * 3) drain with bounded concurrency.
 */
export async function createBatch(count: number, concurrency = 2): Promise<{
  processed: number;
  failed: number;
}> {
  await ensureStorageDirs();
  const resumed = listVideoJobs({ status: 'queued' });
  const ideas = listIdeas({ status: 'ready', limit: count });

  const jobIds: number[] = resumed.map((j) => j.id!);
  for (const idea of ideas) {
    if (jobIds.length >= Math.max(count, resumed.length)) break;
    const request = buildViewMaxRequest(idea);
    jobIds.push(
      insertVideoJob({
        ideaId: idea.id!,
        status: 'queued',
        requestPayload: JSON.stringify(request),
      }),
    );
  }

  if (!jobIds.length) {
    logger.warn('Nothing to process: no queued jobs and no ready ideas.');
    return { processed: 0, failed: 0 };
  }

  logger.info(
    `Processing ${jobIds.length} video job(s) with concurrency ${concurrency} ` +
      `(${resumed.length} resumed from queue)…`,
  );
  const result = await runWithConcurrency(jobIds, (id) => runJob(id), concurrency);
  return { processed: result.succeeded.length, failed: result.failed.length };
}

// ---------------------------------------------------------------------------
// Status overview (used by `npm run status`)
// ---------------------------------------------------------------------------

export interface StatusSummary {
  tables: Record<string, number>;
  jobs: VideoJob[];
  jobCounts: Record<string, number>;
  draftCounts: Record<string, number>;
  uploadCounts: Record<string, number>;
}

export function getStatusSummary(): StatusSummary {
  const tables: Record<string, number> = {};
  for (const t of ['trends', 'ideas', 'video_jobs', 'drafts', 'uploads', 'logs']) {
    tables[t] = countRows(t);
  }
  const jobs = listVideoJobs({ limit: 10 });

  const jobCounts: Record<string, number> = {};
  for (const j of listVideoJobs({ limit: 1000 })) {
    jobCounts[j.status] = (jobCounts[j.status] ?? 0) + 1;
  }
  const draftCounts: Record<string, number> = {};
  for (const d of listDrafts({ limit: 1000 })) {
    draftCounts[d.status] = (draftCounts[d.status] ?? 0) + 1;
  }
  const uploadCounts: Record<string, number> = {};
  for (const u of listUploads({ limit: 1000 })) {
    uploadCounts[u.status] = (uploadCounts[u.status] ?? 0) + 1;
  }
  return { tables, jobs, jobCounts, draftCounts, uploadCounts };
}
