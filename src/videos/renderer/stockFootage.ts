import axios from 'axios';
import fs from 'fs-extra';
import path from 'node:path';
import { env, storageDir } from '../../config/env';
import { logger } from '../../utils/logger';
import { withRetry } from '../../utils/retry';

/**
 * Licensed stock b-roll via the official Pexels API (free key, license
 * permits commercial use without attribution). Only used when
 * PEXELS_API_KEY is set; the renderer falls back to animated gradient
 * backgrounds otherwise. Downloads are cached and reused.
 */

interface PexelsVideoFile {
  id: number;
  quality: string;
  width: number;
  height: number;
  link: string;
}

interface PexelsVideo {
  id: number;
  duration: number;
  video_files: PexelsVideoFile[];
}

function cacheDir(): string {
  return path.join(storageDir(), 'broll-cache');
}

/** Reduce a b-roll instruction to a short search query. */
export function brollQuery(instruction: string): string {
  return instruction
    .toLowerCase()
    .replace(/scene \d+:/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(none|face to camera|bold title card|end card|with|and|the|a|of|on|shot|close-up|showing)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .slice(0, 4)
    .join(' ');
}

/**
 * Find + download a vertical clip for a query. Returns the local path, or
 * undefined when no key is set / nothing suitable found / any error occurs.
 * Never throws — b-roll is an enhancement, not a dependency.
 */
export async function fetchBrollClip(instruction: string): Promise<string | undefined> {
  if (!env.PEXELS_API_KEY) return undefined;
  const query = brollQuery(instruction);
  if (!query || query === 'none') return undefined;

  try {
    const res = await withRetry(
      () =>
        axios.get('https://api.pexels.com/videos/search', {
          params: { query, orientation: 'portrait', size: 'medium', per_page: 5 },
          headers: { Authorization: env.PEXELS_API_KEY },
          timeout: 20_000,
        }),
      { label: `Pexels search "${query}"`, retries: 2 },
    );

    const videos: PexelsVideo[] = res.data?.videos ?? [];
    // Prefer clips at least 4s long with a portrait HD file.
    for (const video of videos) {
      if (video.duration < 4) continue;
      const file = [...video.video_files]
        .filter((f) => f.height >= f.width && f.height >= 1280)
        .sort((a, b) => Math.abs(a.height - 1920) - Math.abs(b.height - 1920))[0];
      if (!file) continue;

      const cached = path.join(cacheDir(), `pexels-${video.id}-${file.id}.mp4`);
      if (await fs.pathExists(cached)) return cached;

      await fs.ensureDir(cacheDir());
      const download = await axios.get<NodeJS.ReadableStream>(file.link, {
        responseType: 'stream',
        timeout: 60_000,
      });
      await new Promise<void>((resolve, reject) => {
        const out = fs.createWriteStream(cached);
        download.data.pipe(out);
        out.on('finish', resolve);
        out.on('error', reject);
        download.data.on('error', reject);
      });
      logger.info(`[renderer] Downloaded b-roll for "${query}" (pexels ${video.id})`);
      return cached;
    }
  } catch (err) {
    logger.warn(`[renderer] Pexels lookup failed for "${query}": ${(err as Error).message}`);
  }
  return undefined;
}
