import { spawnSync } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import { logger } from '../utils/logger';
import { thumbnailFilePath } from '../utils/fileStorage';

/**
 * Thumbnail generation for draft review.
 * Prefers a real frame grab via ffmpeg when it is installed; otherwise
 * falls back to a generated SVG title card (always works, no dependencies).
 */

let ffmpegAvailable: boolean | undefined;

function hasFfmpeg(): boolean {
  if (ffmpegAvailable !== undefined) return ffmpegAvailable;
  try {
    const res = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 });
    ffmpegAvailable = res.status === 0;
  } catch {
    ffmpegAvailable = false;
  }
  return ffmpegAvailable;
}

export async function generateThumbnail(
  videoPath: string,
  draftKey: number | string,
  hookText: string,
): Promise<string> {
  if (hasFfmpeg() && (await fs.pathExists(videoPath))) {
    const jpgPath = thumbnailFilePath(draftKey, 'jpg');
    await fs.ensureDir(path.dirname(jpgPath));
    const res = spawnSync(
      'ffmpeg',
      ['-y', '-i', videoPath, '-ss', '0.5', '-frames:v', '1', '-q:v', '3', jpgPath],
      { stdio: 'ignore', timeout: 30_000 },
    );
    if (res.status === 0 && (await fs.pathExists(jpgPath))) {
      return jpgPath;
    }
    logger.warn('ffmpeg frame grab failed (placeholder video?) — using SVG title card.');
  }
  return writeSvgThumbnail(draftKey, hookText);
}

async function writeSvgThumbnail(
  draftKey: number | string,
  hookText: string,
): Promise<string> {
  const svgPath = thumbnailFilePath(draftKey, 'svg');
  await fs.ensureDir(path.dirname(svgPath));
  const lines = wrapText(hookText, 18).slice(0, 5);
  const textEls = lines
    .map(
      (line, i) =>
        `<text x="540" y="${760 + i * 90}" font-size="64" font-family="Arial, sans-serif" ` +
        `font-weight="bold" fill="#ffffff" text-anchor="middle">${escapeXml(line)}</text>`,
    )
    .join('\n  ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1920" viewBox="0 0 1080 1920">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#111827"/>
      <stop offset="100%" stop-color="#312e81"/>
    </linearGradient>
  </defs>
  <rect width="1080" height="1920" fill="url(#bg)"/>
  ${textEls}
  <text x="540" y="1800" font-size="40" font-family="Arial, sans-serif" fill="#9ca3af" text-anchor="middle">DRAFT — pending review</text>
</svg>`;
  await fs.writeFile(svgPath, svg, 'utf8');
  return svgPath;
}

function wrapText(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxChars) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = `${current} ${word}`;
    }
  }
  if (current.trim()) lines.push(current.trim());
  return lines;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
