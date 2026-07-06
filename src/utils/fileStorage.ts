import fs from 'fs-extra';
import path from 'node:path';
import { storageDir } from '../config/env';

/**
 * Local file storage layout:
 *   storage/videos/      generated MP4s downloaded from ViewMax
 *   storage/thumbnails/  extracted or generated thumbnails
 *   storage/drafts/      per-draft metadata exports (JSON, for easy review)
 */

export function videosDir(): string {
  return path.join(storageDir(), 'videos');
}

export function thumbnailsDir(): string {
  return path.join(storageDir(), 'thumbnails');
}

export function draftsDir(): string {
  return path.join(storageDir(), 'drafts');
}

export async function ensureStorageDirs(): Promise<void> {
  await Promise.all([
    fs.ensureDir(videosDir()),
    fs.ensureDir(thumbnailsDir()),
    fs.ensureDir(draftsDir()),
  ]);
}

export function videoFilePath(jobId: number | string): string {
  return path.join(videosDir(), `video-job-${jobId}.mp4`);
}

export function thumbnailFilePath(draftKey: number | string, ext = 'svg'): string {
  return path.join(thumbnailsDir(), `draft-${draftKey}-thumb.${ext}`);
}

export function draftMetadataPath(draftId: number): string {
  return path.join(draftsDir(), `draft-${draftId}.json`);
}

export async function writeJson(filePath: string, data: unknown): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeJson(filePath, data, { spaces: 2 });
}

/**
 * Write a placeholder MP4 for mock mode: a minimal ISO-BMFF header (ftyp box)
 * followed by a `free` box containing readable JSON metadata. Clearly not a
 * playable video — mock mode only. Real videos come from ViewMax downloads.
 */
export async function writePlaceholderMp4(
  filePath: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await fs.ensureDir(path.dirname(filePath));

  const ftypPayload = Buffer.from('isom\x00\x00\x02\x00isomiso2mp41', 'latin1');
  const ftyp = Buffer.concat([
    uint32(8 + ftypPayload.length),
    Buffer.from('ftyp', 'ascii'),
    ftypPayload,
  ]);

  const metaText = Buffer.from(
    JSON.stringify({ placeholder: true, note: 'Mock-mode placeholder generated locally. Not a playable video.', ...meta }, null, 2),
    'utf8',
  );
  const freeBox = Buffer.concat([
    uint32(8 + metaText.length),
    Buffer.from('free', 'ascii'),
    metaText,
  ]);

  await fs.writeFile(filePath, Buffer.concat([ftyp, freeBox]));
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n, 0);
  return b;
}

export async function removeFileIfExists(filePath?: string): Promise<void> {
  if (!filePath) return;
  try {
    await fs.remove(filePath);
  } catch {
    // Best-effort cleanup.
  }
}
