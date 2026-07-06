import Database from 'better-sqlite3';
import type { Database as DatabaseType } from 'better-sqlite3';
import fs from 'fs-extra';
import path from 'node:path';
import { databaseFilePath } from '../config/env';
import { runMigrations } from './migrations';
import type {
  Draft,
  DraftStatus,
  TrendSignal,
  UploadRecord,
  UploadStatus,
  VideoIdea,
  VideoJob,
  VideoJobStatus,
} from '../types';

let db: DatabaseType | undefined;

export function getDb(): DatabaseType {
  if (db) return db;
  const filePath = databaseFilePath();
  fs.ensureDirSync(path.dirname(filePath));
  db = new Database(filePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value === '') return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

const json = (value: unknown): string => JSON.stringify(value ?? null);

// ---------------------------------------------------------------------------
// Trends
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
function rowToTrend(row: any): TrendSignal {
  return {
    id: row.id,
    topic: row.topic,
    category: row.category,
    niche: row.niche,
    suggestedHook: row.suggested_hook,
    suggestedCaption: row.suggested_caption,
    suggestedHashtags: parseJson<string[]>(row.suggested_hashtags, []),
    suggestedVideoLengthSec: row.suggested_video_length_sec,
    suggestedVisualStyle: row.suggested_visual_style,
    suggestedCta: row.suggested_cta,
    estimatedStrength: row.estimated_strength,
    competitionLevel: row.competition_level ?? undefined,
    score: row.score ?? undefined,
    scoreBreakdown: parseJson(row.score_breakdown, undefined),
    sourceLabel: row.source_label,
    sourceUrl: row.source_url ?? undefined,
    dateFound: row.date_found,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertTrend(trend: TrendSignal): number {
  const stmt = getDb().prepare(`INSERT INTO trends
    (topic, category, niche, suggested_hook, suggested_caption, suggested_hashtags,
     suggested_video_length_sec, suggested_visual_style, suggested_cta,
     estimated_strength, competition_level, score, score_breakdown,
     source_label, source_url, date_found)
    VALUES (@topic, @category, @niche, @hook, @caption, @hashtags,
            @lengthSec, @visualStyle, @cta, @strength, @competition, @score,
            @scoreBreakdown, @sourceLabel, @sourceUrl, @dateFound)`);
  const result = stmt.run({
    topic: trend.topic,
    category: trend.category,
    niche: trend.niche,
    hook: trend.suggestedHook,
    caption: trend.suggestedCaption,
    hashtags: json(trend.suggestedHashtags),
    lengthSec: trend.suggestedVideoLengthSec,
    visualStyle: trend.suggestedVisualStyle,
    cta: trend.suggestedCta,
    strength: trend.estimatedStrength,
    competition: trend.competitionLevel ?? null,
    score: trend.score ?? null,
    scoreBreakdown: trend.scoreBreakdown ? json(trend.scoreBreakdown) : null,
    sourceLabel: trend.sourceLabel,
    sourceUrl: trend.sourceUrl ?? null,
    dateFound: trend.dateFound,
  });
  return Number(result.lastInsertRowid);
}

export function trendExists(topic: string, sourceLabel: string): boolean {
  const row = getDb()
    .prepare(
      'SELECT id FROM trends WHERE topic = ? COLLATE NOCASE AND source_label = ? LIMIT 1',
    )
    .get(topic, sourceLabel);
  return Boolean(row);
}

export function listTrends(opts: { minScore?: number; limit?: number } = {}): TrendSignal[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM trends
       WHERE (@minScore IS NULL OR score >= @minScore)
       ORDER BY score DESC, date_found DESC
       LIMIT @limit`,
    )
    .all({ minScore: opts.minScore ?? null, limit: opts.limit ?? 100 });
  return rows.map(rowToTrend);
}

export function getTrend(id: number): TrendSignal | undefined {
  const row = getDb().prepare('SELECT * FROM trends WHERE id = ?').get(id);
  return row ? rowToTrend(row) : undefined;
}

export function updateTrendScore(
  id: number,
  score: number,
  breakdown: unknown,
): void {
  getDb()
    .prepare('UPDATE trends SET score = ?, score_breakdown = ? WHERE id = ?')
    .run(score, json(breakdown), id);
}

// ---------------------------------------------------------------------------
// Ideas
// ---------------------------------------------------------------------------

function rowToIdea(row: any): VideoIdea {
  return {
    id: row.id,
    trendId: row.trend_id,
    title: row.title,
    hook: row.hook,
    script: row.script,
    scenes: parseJson(row.scenes, []),
    onScreenText: parseJson<string[]>(row.on_screen_text, []),
    voiceoverText: row.voiceover_text,
    brollInstructions: parseJson<string[]>(row.broll_instructions, []),
    musicGuidance: row.music_guidance,
    caption: row.caption,
    hashtags: parseJson<string[]>(row.hashtags, []),
    targetAudience: row.target_audience,
    category: row.category,
    niche: row.niche,
    estimatedDurationSec: row.estimated_duration_sec,
    selectionReason: row.selection_reason,
    complianceNotes: parseJson<string[]>(row.compliance_notes, []),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertIdea(idea: VideoIdea): number {
  const stmt = getDb().prepare(`INSERT INTO ideas
    (trend_id, title, hook, script, scenes, on_screen_text, voiceover_text,
     broll_instructions, music_guidance, caption, hashtags, target_audience,
     category, niche, estimated_duration_sec, selection_reason,
     compliance_notes, status)
    VALUES (@trendId, @title, @hook, @script, @scenes, @onScreenText,
            @voiceoverText, @broll, @music, @caption, @hashtags, @audience,
            @category, @niche, @durationSec, @reason, @compliance, @status)`);
  const result = stmt.run({
    trendId: idea.trendId,
    title: idea.title,
    hook: idea.hook,
    script: idea.script,
    scenes: json(idea.scenes),
    onScreenText: json(idea.onScreenText),
    voiceoverText: idea.voiceoverText,
    broll: json(idea.brollInstructions),
    music: idea.musicGuidance,
    caption: idea.caption,
    hashtags: json(idea.hashtags),
    audience: idea.targetAudience,
    category: idea.category,
    niche: idea.niche,
    durationSec: idea.estimatedDurationSec,
    reason: idea.selectionReason,
    compliance: json(idea.complianceNotes),
    status: idea.status,
  });
  return Number(result.lastInsertRowid);
}

export function listIdeas(opts: { status?: string; limit?: number } = {}): VideoIdea[] {
  const rows = getDb()
    .prepare(
      `SELECT ideas.* FROM ideas
       LEFT JOIN trends ON trends.id = ideas.trend_id
       WHERE (@status IS NULL OR ideas.status = @status)
       ORDER BY trends.score DESC, ideas.id DESC
       LIMIT @limit`,
    )
    .all({ status: opts.status ?? null, limit: opts.limit ?? 100 });
  return rows.map(rowToIdea);
}

export function getIdea(id: number): VideoIdea | undefined {
  const row = getDb().prepare('SELECT * FROM ideas WHERE id = ?').get(id);
  return row ? rowToIdea(row) : undefined;
}

export function ideaExistsForTrend(trendId: number): boolean {
  const row = getDb()
    .prepare('SELECT id FROM ideas WHERE trend_id = ? LIMIT 1')
    .get(trendId);
  return Boolean(row);
}

export function updateIdeaStatus(id: number, status: string): void {
  getDb().prepare('UPDATE ideas SET status = ? WHERE id = ?').run(status, id);
}

// ---------------------------------------------------------------------------
// Video jobs
// ---------------------------------------------------------------------------

function rowToVideoJob(row: any): VideoJob {
  return {
    id: row.id,
    ideaId: row.idea_id,
    viewmaxJobId: row.viewmax_job_id ?? undefined,
    status: row.status,
    attempts: row.attempts,
    requestPayload: row.request_payload ?? undefined,
    videoPath: row.video_path ?? undefined,
    error: row.error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertVideoJob(job: {
  ideaId: number;
  status?: VideoJobStatus;
  requestPayload?: string;
}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO video_jobs (idea_id, status, request_payload)
       VALUES (?, ?, ?)`,
    )
    .run(job.ideaId, job.status ?? 'queued', job.requestPayload ?? null);
  return Number(result.lastInsertRowid);
}

export function updateVideoJob(
  id: number,
  patch: Partial<Pick<VideoJob, 'viewmaxJobId' | 'status' | 'attempts' | 'videoPath' | 'requestPayload'>> & {
    /** Pass null to clear a previous error. */
    error?: string | null;
  },
): void {
  const existing = getDb().prepare('SELECT * FROM video_jobs WHERE id = ?').get(id) as any;
  if (!existing) throw new Error(`video_job ${id} not found`);
  getDb()
    .prepare(
      `UPDATE video_jobs SET
         viewmax_job_id = @viewmaxJobId,
         status = @status,
         attempts = @attempts,
         request_payload = @requestPayload,
         video_path = @videoPath,
         error = @error
       WHERE id = @id`,
    )
    .run({
      id,
      viewmaxJobId: patch.viewmaxJobId ?? existing.viewmax_job_id,
      status: patch.status ?? existing.status,
      attempts: patch.attempts ?? existing.attempts,
      requestPayload: patch.requestPayload ?? existing.request_payload,
      videoPath: patch.videoPath ?? existing.video_path,
      error: patch.error === undefined ? existing.error : patch.error,
    });
}

export function getVideoJob(id: number): VideoJob | undefined {
  const row = getDb().prepare('SELECT * FROM video_jobs WHERE id = ?').get(id);
  return row ? rowToVideoJob(row) : undefined;
}

export function listVideoJobs(opts: { status?: VideoJobStatus; limit?: number } = {}): VideoJob[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM video_jobs
       WHERE (@status IS NULL OR status = @status)
       ORDER BY id DESC LIMIT @limit`,
    )
    .all({ status: opts.status ?? null, limit: opts.limit ?? 100 });
  return rows.map(rowToVideoJob);
}

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

function rowToDraft(row: any): Draft {
  return {
    id: row.id,
    videoJobId: row.video_job_id,
    ideaId: row.idea_id,
    videoPath: row.video_path,
    thumbnailPath: row.thumbnail_path ?? undefined,
    script: row.script,
    caption: row.caption,
    hashtags: parseJson<string[]>(row.hashtags, []),
    trendSource: row.trend_source,
    viewmaxJobId: row.viewmax_job_id ?? undefined,
    suggestedPostTime: row.suggested_post_time ?? undefined,
    status: row.status,
    reviewNote: row.review_note ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertDraft(draft: Draft): number {
  const result = getDb()
    .prepare(
      `INSERT INTO drafts
       (video_job_id, idea_id, video_path, thumbnail_path, script, caption,
        hashtags, trend_source, viewmax_job_id, suggested_post_time, status, review_note)
       VALUES (@videoJobId, @ideaId, @videoPath, @thumbnailPath, @script,
               @caption, @hashtags, @trendSource, @viewmaxJobId,
               @suggestedPostTime, @status, @reviewNote)`,
    )
    .run({
      videoJobId: draft.videoJobId,
      ideaId: draft.ideaId,
      videoPath: draft.videoPath,
      thumbnailPath: draft.thumbnailPath ?? null,
      script: draft.script,
      caption: draft.caption,
      hashtags: json(draft.hashtags),
      trendSource: draft.trendSource,
      viewmaxJobId: draft.viewmaxJobId ?? null,
      suggestedPostTime: draft.suggestedPostTime ?? null,
      status: draft.status,
      reviewNote: draft.reviewNote ?? null,
    });
  return Number(result.lastInsertRowid);
}

export function getDraft(id: number): Draft | undefined {
  const row = getDb().prepare('SELECT * FROM drafts WHERE id = ?').get(id);
  return row ? rowToDraft(row) : undefined;
}

export function listDrafts(opts: { status?: DraftStatus; limit?: number } = {}): Draft[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM drafts
       WHERE (@status IS NULL OR status = @status)
       ORDER BY id DESC LIMIT @limit`,
    )
    .all({ status: opts.status ?? null, limit: opts.limit ?? 100 });
  return rows.map(rowToDraft);
}

export function updateDraft(
  id: number,
  patch: Partial<Pick<Draft, 'status' | 'caption' | 'hashtags' | 'reviewNote' | 'suggestedPostTime' | 'thumbnailPath'>>,
): void {
  const existing = getDb().prepare('SELECT * FROM drafts WHERE id = ?').get(id) as any;
  if (!existing) throw new Error(`draft ${id} not found`);
  getDb()
    .prepare(
      `UPDATE drafts SET
         status = @status,
         caption = @caption,
         hashtags = @hashtags,
         review_note = @reviewNote,
         suggested_post_time = @suggestedPostTime,
         thumbnail_path = @thumbnailPath
       WHERE id = @id`,
    )
    .run({
      id,
      status: patch.status ?? existing.status,
      caption: patch.caption ?? existing.caption,
      hashtags: patch.hashtags ? json(patch.hashtags) : existing.hashtags,
      reviewNote: patch.reviewNote ?? existing.review_note,
      suggestedPostTime: patch.suggestedPostTime ?? existing.suggested_post_time,
      thumbnailPath: patch.thumbnailPath ?? existing.thumbnail_path,
    });
}

export function deleteDraft(id: number): void {
  getDb().prepare('DELETE FROM uploads WHERE draft_id = ?').run(id);
  getDb().prepare('DELETE FROM drafts WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Uploads
// ---------------------------------------------------------------------------

function rowToUpload(row: any): UploadRecord {
  return {
    id: row.id,
    draftId: row.draft_id,
    tiktokPublishId: row.tiktok_publish_id ?? undefined,
    tiktokVideoId: row.tiktok_video_id ?? undefined,
    privacyStatus: row.privacy_status,
    status: row.status,
    scheduledAt: row.scheduled_at ?? undefined,
    uploadedAt: row.uploaded_at ?? undefined,
    error: row.error ?? undefined,
    attempts: row.attempts,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function insertUpload(upload: {
  draftId: number;
  privacyStatus: string;
  status?: UploadStatus;
  scheduledAt?: string;
}): number {
  const result = getDb()
    .prepare(
      `INSERT INTO uploads (draft_id, privacy_status, status, scheduled_at)
       VALUES (?, ?, ?, ?)`,
    )
    .run(
      upload.draftId,
      upload.privacyStatus,
      upload.status ?? 'scheduled',
      upload.scheduledAt ?? null,
    );
  return Number(result.lastInsertRowid);
}

export function updateUpload(
  id: number,
  patch: Partial<Pick<UploadRecord, 'tiktokPublishId' | 'tiktokVideoId' | 'status' | 'scheduledAt' | 'uploadedAt' | 'attempts'>> & {
    /** Pass null to clear a previous error. */
    error?: string | null;
  },
): void {
  const existing = getDb().prepare('SELECT * FROM uploads WHERE id = ?').get(id) as any;
  if (!existing) throw new Error(`upload ${id} not found`);
  getDb()
    .prepare(
      `UPDATE uploads SET
         tiktok_publish_id = @publishId,
         tiktok_video_id = @videoId,
         status = @status,
         scheduled_at = @scheduledAt,
         uploaded_at = @uploadedAt,
         error = @error,
         attempts = @attempts
       WHERE id = @id`,
    )
    .run({
      id,
      publishId: patch.tiktokPublishId ?? existing.tiktok_publish_id,
      videoId: patch.tiktokVideoId ?? existing.tiktok_video_id,
      status: patch.status ?? existing.status,
      scheduledAt: patch.scheduledAt ?? existing.scheduled_at,
      uploadedAt: patch.uploadedAt ?? existing.uploaded_at,
      error: patch.error === undefined ? existing.error : patch.error,
      attempts: patch.attempts ?? existing.attempts,
    });
}

export function listUploads(opts: { status?: UploadStatus; limit?: number } = {}): UploadRecord[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM uploads
       WHERE (@status IS NULL OR status = @status)
       ORDER BY id DESC LIMIT @limit`,
    )
    .all({ status: opts.status ?? null, limit: opts.limit ?? 100 });
  return rows.map(rowToUpload);
}

export function getUploadForDraft(draftId: number): UploadRecord | undefined {
  const row = getDb()
    .prepare('SELECT * FROM uploads WHERE draft_id = ? ORDER BY id DESC LIMIT 1')
    .get(draftId);
  return row ? rowToUpload(row) : undefined;
}

/** Count successful uploads whose uploaded_at falls on the given UTC day. */
export function countUploadsOnDay(isoDay: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM uploads
       WHERE status = 'uploaded' AND uploaded_at LIKE ? || '%'`,
    )
    .get(isoDay) as { c: number };
  return row.c;
}

export function countScheduledOnDay(isoDay: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS c FROM uploads
       WHERE status = 'scheduled' AND scheduled_at LIKE ? || '%'`,
    )
    .get(isoDay) as { c: number };
  return row.c;
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function getSetting(key: string): string | undefined {
  const row = getDb()
    .prepare('SELECT value FROM settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    )
    .run(key, value);
}

// ---------------------------------------------------------------------------
// Logs (audit trail persisted alongside pino output)
// ---------------------------------------------------------------------------

export function recordLog(level: string, message: string, context?: unknown): void {
  try {
    getDb()
      .prepare('INSERT INTO logs (level, message, context) VALUES (?, ?, ?)')
      .run(level, message, context ? JSON.stringify(context) : null);
  } catch {
    // Audit logging must never break the main flow.
  }
}

export function countRows(table: string): number {
  const allowed = new Set(['trends', 'ideas', 'video_jobs', 'drafts', 'uploads', 'settings', 'logs']);
  if (!allowed.has(table)) throw new Error(`unknown table: ${table}`);
  const row = getDb().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
  return row.c;
}
/* eslint-enable @typescript-eslint/no-explicit-any */
