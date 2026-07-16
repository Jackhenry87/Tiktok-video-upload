/**
 * SQLite DDL. Every table carries created_at / updated_at; updated_at is
 * maintained by AFTER UPDATE triggers so repository code can't forget it.
 */

const timestampCols = `
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

function updatedAtTrigger(table: string, pk = 'id'): string {
  return `
CREATE TRIGGER IF NOT EXISTS ${table}_updated_at
AFTER UPDATE ON ${table}
FOR EACH ROW
BEGIN
  UPDATE ${table} SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
  WHERE ${pk} = NEW.${pk};
END;`;
}

export const SCHEMA_STATEMENTS: string[] = [
  `CREATE TABLE IF NOT EXISTS trends (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    niche TEXT NOT NULL DEFAULT '',
    suggested_hook TEXT NOT NULL DEFAULT '',
    suggested_caption TEXT NOT NULL DEFAULT '',
    suggested_hashtags TEXT NOT NULL DEFAULT '[]',
    suggested_video_length_sec INTEGER NOT NULL DEFAULT 20,
    suggested_visual_style TEXT NOT NULL DEFAULT '',
    suggested_cta TEXT NOT NULL DEFAULT '',
    estimated_strength INTEGER NOT NULL DEFAULT 50,
    competition_level INTEGER,
    score INTEGER,
    score_breakdown TEXT,
    source_label TEXT NOT NULL,
    source_url TEXT,
    date_found TEXT NOT NULL,
    ${timestampCols}
  );`,
  `CREATE INDEX IF NOT EXISTS idx_trends_topic ON trends (topic COLLATE NOCASE);`,
  `CREATE INDEX IF NOT EXISTS idx_trends_score ON trends (score);`,
  updatedAtTrigger('trends'),

  `CREATE TABLE IF NOT EXISTS ideas (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trend_id INTEGER NOT NULL REFERENCES trends(id),
    title TEXT NOT NULL,
    hook TEXT NOT NULL,
    script TEXT NOT NULL,
    scenes TEXT NOT NULL DEFAULT '[]',
    on_screen_text TEXT NOT NULL DEFAULT '[]',
    voiceover_text TEXT NOT NULL DEFAULT '',
    broll_instructions TEXT NOT NULL DEFAULT '[]',
    music_guidance TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL DEFAULT '',
    hashtags TEXT NOT NULL DEFAULT '[]',
    target_audience TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    niche TEXT NOT NULL DEFAULT '',
    estimated_duration_sec INTEGER NOT NULL DEFAULT 20,
    selection_reason TEXT NOT NULL DEFAULT '',
    compliance_notes TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'ready',
    ${timestampCols}
  );`,
  `CREATE INDEX IF NOT EXISTS idx_ideas_status ON ideas (status);`,
  `CREATE INDEX IF NOT EXISTS idx_ideas_trend ON ideas (trend_id);`,
  updatedAtTrigger('ideas'),

  `CREATE TABLE IF NOT EXISTS video_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idea_id INTEGER NOT NULL REFERENCES ideas(id),
    viewmax_job_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    attempts INTEGER NOT NULL DEFAULT 0,
    request_payload TEXT,
    video_path TEXT,
    error TEXT,
    ${timestampCols}
  );`,
  `CREATE INDEX IF NOT EXISTS idx_video_jobs_status ON video_jobs (status);`,
  updatedAtTrigger('video_jobs'),

  `CREATE TABLE IF NOT EXISTS drafts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_job_id INTEGER NOT NULL REFERENCES video_jobs(id),
    idea_id INTEGER NOT NULL REFERENCES ideas(id),
    video_path TEXT NOT NULL,
    thumbnail_path TEXT,
    script TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL DEFAULT '',
    hashtags TEXT NOT NULL DEFAULT '[]',
    trend_source TEXT NOT NULL DEFAULT '',
    viewmax_job_id TEXT,
    suggested_post_time TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    review_note TEXT,
    ${timestampCols}
  );`,
  `CREATE INDEX IF NOT EXISTS idx_drafts_status ON drafts (status);`,
  updatedAtTrigger('drafts'),

  `CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    draft_id INTEGER NOT NULL REFERENCES drafts(id),
    tiktok_publish_id TEXT,
    tiktok_video_id TEXT,
    privacy_status TEXT NOT NULL DEFAULT 'SELF_ONLY',
    status TEXT NOT NULL DEFAULT 'scheduled',
    scheduled_at TEXT,
    uploaded_at TEXT,
    error TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    ${timestampCols}
  );`,
  `CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads (status);`,
  `CREATE INDEX IF NOT EXISTS idx_uploads_uploaded_at ON uploads (uploaded_at);`,
  updatedAtTrigger('uploads'),

  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT '',
    ${timestampCols}
  );`,
  updatedAtTrigger('settings', 'key'),

  `CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    level TEXT NOT NULL DEFAULT 'info',
    message TEXT NOT NULL,
    context TEXT,
    ${timestampCols}
  );`,
  updatedAtTrigger('logs'),
];
