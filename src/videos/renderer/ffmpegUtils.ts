import { spawn, spawnSync } from 'node:child_process';
import fs from 'fs-extra';
import path from 'node:path';
import { logger } from '../../utils/logger';

/** Shared ffmpeg helpers for the built-in local video renderer. */

export const FONT_BOLD = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';
export const FONT_REGULAR = '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf';

let ffmpegChecked: boolean | undefined;

export function hasFfmpeg(): boolean {
  if (ffmpegChecked !== undefined) return ffmpegChecked;
  try {
    ffmpegChecked = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    ffmpegChecked = false;
  }
  return ffmpegChecked;
}

/** Run ffmpeg, rejecting with the tail of stderr on failure. */
export function runFfmpeg(args: string[], label: string, timeoutMs = 5 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`${label}: ffmpeg timed out after ${timeoutMs / 1000}s`));
    }, timeoutMs);
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`${label}: ${err.message}`));
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${label}: ffmpeg exited ${code}: ${stderr.slice(-1500)}`));
    });
  });
}

/**
 * Word-wrap text for on-screen captions. Returns wrapped text plus a font
 * size that fits the amount of text (big hooks, smaller paragraphs).
 */
export function wrapForScreen(text: string): { wrapped: string; fontSize: number } {
  const clean = text.replace(/\s+/g, ' ').trim();
  const fontSize = clean.length <= 40 ? 88 : clean.length <= 80 ? 68 : 54;
  const maxChars = fontSize >= 88 ? 16 : fontSize >= 68 ? 22 : 28;

  const lines: string[] = [];
  let current = '';
  for (const word of clean.split(' ')) {
    if ((current + ' ' + word).trim().length > maxChars && current) {
      lines.push(current.trim());
      current = word;
    } else {
      current = `${current} ${word}`.trim();
    }
  }
  if (current) lines.push(current);
  return { wrapped: lines.slice(0, 6).join('\n'), fontSize };
}

/**
 * Write drawtext content to a file (avoids ffmpeg's escaping minefield for
 * quotes/colons/percent signs in user text). Returns the file path.
 */
export async function writeTextFile(dir: string, name: string, text: string): Promise<string> {
  const filePath = path.join(dir, `${name}.txt`);
  await fs.ensureDir(dir);
  await fs.writeFile(filePath, text, 'utf8');
  return filePath;
}

/** ffprobe duration in seconds (0 on failure). */
export function probeDuration(filePath: string): number {
  try {
    const res = spawnSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filePath],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const n = parseFloat((res.stdout || '').trim());
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

export function logRenderStep(step: string): void {
  logger.info(`[renderer] ${step}`);
}
