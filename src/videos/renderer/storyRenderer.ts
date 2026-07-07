import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import { logRenderStep, probeDuration, runFfmpeg } from './ffmpegUtils';
import { fetchBrollClip } from './stockFootage';

/**
 * Story-format renderer: the proven "narrated story + word-pop captions
 * over high-motion background" TikTok format.
 *
 *  - Voiceover: local Piper TTS (assets/voices/en_US-ryan-high.onnx)
 *  - Captions: word-chunk pop-in, bold outlined, center screen (ASS subs)
 *  - Background: a random slice of a user-recorded gameplay clip from
 *    assets/backgrounds/ (Mojang/Epic/Rockstar permit sharing your own
 *    gameplay), or licensed Pexels b-roll, or an animated fractal zoom
 *    as the built-in fallback. Never other creators' videos.
 */

const W = 1080;
const H = 1920;
const VOICE_MODEL = 'assets/voices/en_US-ryan-high.onnx';

export function backgroundsDir(): string {
  return path.resolve(process.cwd(), 'assets/backgrounds');
}

/** Licensed Pexels queries that fit the story format (high motion). */
const STORY_BG_QUERIES = [
  'video game gaming screen',
  'satisfying slime',
  'kinetic sand cutting',
  'aerial city night driving',
  'pouring paint abstract',
  'ocean waves aerial',
];

/**
 * Background priority: user-recorded gameplay from assets/backgrounds/ →
 * licensed Pexels clip → undefined (renderer falls back to generated).
 */
export async function pickBackgroundClip(): Promise<string | undefined> {
  try {
    const files = (await fs.readdir(backgroundsDir())).filter((f) =>
      /\.(mp4|mov|mkv|webm)$/i.test(f),
    );
    if (files.length) {
      return path.join(backgroundsDir(), files[Math.floor(Math.random() * files.length)]!);
    }
  } catch {
    // fall through to Pexels
  }
  const query = STORY_BG_QUERIES[Math.floor(Math.random() * STORY_BG_QUERIES.length)]!;
  return fetchBrollClip(query, 10);
}

function runTtsProcess(cmd: string, args: string[], text: string, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    proc.stderr.on('data', (d) => {
      stderr += d.toString().slice(-2000);
    });
    proc.on('error', (e) => reject(new Error(`${label}: ${e.message}`)));
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited ${code}: ${stderr.slice(-500)}`));
    });
    proc.stdin.write(text);
    proc.stdin.end();
  });
}

/**
 * Voiceover synthesis. Prefers Kokoro (local neural TTS, natural prosody);
 * falls back to Piper when the Kokoro model isn't installed.
 */
export async function synthesizeVoice(text: string, wavPath: string): Promise<void> {
  const kokoroModel = path.resolve(process.cwd(), 'assets/voices/kokoro-v1.0.onnx');
  if (await fs.pathExists(kokoroModel)) {
    try {
      await runTtsProcess(
        'python3',
        [path.resolve(process.cwd(), 'scripts/tts_kokoro.py'), wavPath, 'am_michael', '1.06'],
        text,
        'kokoro-tts',
      );
      return;
    } catch (err) {
      logRenderStep(`kokoro failed (${(err as Error).message.slice(0, 120)}) — falling back to piper`);
    }
  }
  await runTtsProcess(
    'piper',
    ['-m', path.resolve(process.cwd(), VOICE_MODEL), '-f', wavPath],
    text,
    'piper',
  );
}

interface CaptionChunk {
  text: string;
  start: number;
  end: number;
}

/**
 * Estimate word timings across the spoken duration (weight ∝ characters),
 * then group into 1-2 word chunks for the pop-in caption style.
 */
export function buildCaptionChunks(text: string, speechDuration: number): CaptionChunk[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (!words.length) return [];
  const weights = words.map((w) => w.length + 2);
  const totalWeight = weights.reduce((a, b) => a + b, 0);

  const chunks: CaptionChunk[] = [];
  let t = 0;
  let i = 0;
  while (i < words.length) {
    // Short words pair up; long words stand alone (keeps pops readable).
    const take = words[i]!.length <= 5 && i + 1 < words.length && words[i + 1]!.length <= 6 ? 2 : 1;
    const group = words.slice(i, i + take);
    const w = weights.slice(i, i + take).reduce((a, b) => a + b, 0);
    const dur = (w / totalWeight) * speechDuration;
    chunks.push({ text: group.join(' '), start: t, end: t + dur });
    t += dur;
    i += take;
  }
  return chunks;
}

function assTime(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const cs = Math.floor((sec % 1) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')');
}

export async function writeAssCaptions(
  chunks: CaptionChunk[],
  assPath: string,
  badge?: { text: string; untilSec?: number },
): Promise<void> {
  const header = `[Script Info]
ScriptType: v4.00+
PlayResX: ${W}
PlayResY: ${H}
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Word,DejaVu Sans,120,&H00FFFFFF,&H00FFFFFF,&H00000000,&H80000000,-1,0,0,0,100,100,0,0,1,10,4,5,60,60,0,1
Style: Badge,DejaVu Sans,72,&H0000E5FF,&H0000E5FF,&H00000000,&H80000000,-1,0,0,0,100,100,2,0,1,7,3,8,60,60,120,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Text
`;
  const events = chunks
    .map((c) => {
      // Pop-in: quick scale bounce via \t transform.
      const fx = `{\\fscx82\\fscy82\\t(0,90,\\fscx105\\fscy105)\\t(90,160,\\fscx100\\fscy100)}`;
      return `Dialogue: 0,${assTime(c.start)},${assTime(c.end)},Word,,0,0,0,${fx}${escapeAss(c.text.toUpperCase())}`;
    })
    .join('\n');
  // Series badge ("PART 2") pinned top-center while the hook plays.
  const badgeEvent = badge
    ? `\nDialogue: 1,${assTime(0)},${assTime(badge.untilSec ?? 3)},Badge,,0,0,0,${escapeAss(badge.text.toUpperCase())}`
    : '';
  await fs.writeFile(assPath, header + events + badgeEvent + '\n', 'utf8');
}

export interface StoryRenderInput {
  /** Full narration text (hook first — it's spoken and captioned). */
  storyText: string;
  /** Optional background video (user gameplay / licensed clip). */
  backgroundPath?: string;
  /** Series badge shown at the top during the hook, e.g. "PART 2". */
  partLabel?: string;
  destPath: string;
}

export async function renderStoryVideo(input: StoryRenderInput): Promise<string> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ttstory-'));
  try {
    // 1. Voiceover.
    logRenderStep('story: synthesizing voiceover');
    const wavPath = path.join(workDir, 'voice.wav');
    await synthesizeVoice(input.storyText, wavPath);
    const speechDur = probeDuration(wavPath);
    if (!speechDur) throw new Error('TTS produced no audio');
    const totalDur = Math.min(90, speechDur + 0.8);

    // 2. Word-pop captions (+ optional PART badge).
    const assPath = path.join(workDir, 'captions.ass');
    await writeAssCaptions(
      buildCaptionChunks(input.storyText, speechDur),
      assPath,
      input.partLabel ? { text: input.partLabel, untilSec: 3.5 } : undefined,
    );

    // 3. Background + captions + voiceover in one pass.
    logRenderStep(`story: rendering ${Math.round(totalDur)}s video`);
    await fs.ensureDir(path.dirname(input.destPath));
    const subFilter = `subtitles='${assPath.replace(/'/g, "\\'")}':fontsdir=/usr/share/fonts/truetype/dejavu`;

    const background = input.backgroundPath ?? (await pickBackgroundClip());
    if (background) {
      const bgDur = probeDuration(background);
      // Skip the head/tail of the clip (menus, loading screens, ad/phone
      // moments usually live at the very start/end) and pull a random
      // window from the gameplay-dense middle. Game audio is never mapped,
      // so in-game radio/ads never reach the video.
      const HEAD_TRIM = 20;
      const TAIL_TRIM = 20;
      const usableStart = Math.min(HEAD_TRIM, Math.max(0, bgDur - totalDur - 1));
      const usableEnd = Math.max(usableStart, bgDur - totalDur - TAIL_TRIM);
      const start = usableEnd > usableStart
        ? usableStart + Math.random() * (usableEnd - usableStart)
        : Math.max(0, (bgDur - totalDur) / 2);
      await runFfmpeg(
        [
          '-ss', start.toFixed(2), '-stream_loop', '-1', '-i', background,
          '-i', wavPath,
          '-t', String(totalDur),
          '-vf',
          `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=30,eq=brightness=-0.06:saturation=1.05,${subFilter},format=yuv420p`,
          '-map', '0:v', '-map', '1:a',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21',
          '-c:a', 'aac', '-b:a', '128k', '-shortest',
          input.destPath,
        ],
        'story render (background clip)',
        10 * 60_000,
      );
    } else {
      // Built-in fallback: animated fractal zoom (hypnotic, fully generated).
      await runFfmpeg(
        [
          '-f', 'lavfi', '-i', `mandelbrot=s=540x960:rate=30:end_scale=0.00002`,
          '-i', wavPath,
          '-t', String(totalDur),
          '-vf', `scale=${W}:${H},eq=brightness=-0.05:saturation=1.2,${subFilter},format=yuv420p`,
          '-map', '0:v', '-map', '1:a',
          '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22',
          '-c:a', 'aac', '-b:a', '128k', '-shortest',
          input.destPath,
        ],
        'story render (generated background)',
        10 * 60_000,
      );
    }
    logRenderStep(`story: done -> ${input.destPath}`);
    return input.destPath;
  } finally {
    await fs.remove(workDir).catch(() => undefined);
  }
}
