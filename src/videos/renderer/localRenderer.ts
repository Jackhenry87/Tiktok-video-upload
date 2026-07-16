import fs from 'fs-extra';
import path from 'node:path';
import os from 'node:os';
import type { ViewMaxVideoRequest } from '../../connectors/viewmax/viewmaxTypes';
import {
  FONT_BOLD,
  FONT_REGULAR,
  logRenderStep,
  runFfmpeg,
  wrapForScreen,
  writeTextFile,
} from './ffmpegUtils';
import { fetchBrollClip } from './stockFootage';

/**
 * Built-in video renderer: turns a ViewMaxVideoRequest into a real
 * 1080x1920 H.264 MP4 with ffmpeg. Style: TikTok-native bold captions with
 * outline, animated gradient backgrounds (per-brand color), optional
 * licensed Pexels b-roll per scene, hard cuts every 2-4s, soft ambient
 * audio bed (or a user-provided licensed track from assets/music/).
 */

const W = 1080;
const H = 1920;
const FPS = 30;

/** Niche/brand palettes: [dark base, accent]. */
const DEFAULT_PALETTE: [string, string] = ['0x111827', '0x312e81'];
const PALETTES: Record<string, [string, string]> = {
  '#312e81': ['0x111827', '0x312e81'], // indigo (finance)
  '#065f46': ['0x022c22', '0x065f46'], // emerald (side hustles)
  '#7c2d12': ['0x1c0a00', '0x7c2d12'], // amber-brown (real estate)
  '#0e7490': ['0x083344', '0x0e7490'], // cyan (ai tools)
  '#9d174d': ['0x350015', '0x9d174d'], // pink (college life)
  '#b91c1c': ['0x2a0505', '0xb91c1c'], // red (fitness / sports)
};

function hashPickIndex(seed: string, mod: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h) % mod;
}

async function pickMusicTrack(): Promise<string | undefined> {
  const musicDir = path.resolve(process.cwd(), 'assets/music');
  try {
    const files = (await fs.readdir(musicDir)).filter((f) => /\.(mp3|m4a|wav|aac)$/i.test(f));
    if (!files.length) return undefined;
    return path.join(musicDir, files[hashPickIndex(String(Date.now()), files.length)]!);
  } catch {
    return undefined;
  }
}

interface SceneRender {
  segmentPath: string;
}

async function renderScene(
  workDir: string,
  index: number,
  durationSec: number,
  onScreenText: string,
  brollInstruction: string,
  palette: [string, string],
  isHook: boolean,
  isCta: boolean,
): Promise<SceneRender> {
  const segmentPath = path.join(workDir, `scene-${index}.mp4`);
  const dur = Math.min(6, Math.max(2, durationSec));

  const { wrapped, fontSize } = wrapForScreen(onScreenText || ' ');
  const textFile = await writeTextFile(workDir, `scene-${index}-text`, wrapped);

  // Text: bold, centered, black outline + drop shadow (TikTok caption look),
  // quick fade/pop-in as the scene's pattern interrupt.
  const textY = isHook ? '(h*0.40-text_h/2)' : isCta ? '(h*0.46-text_h/2)' : '(h*0.42-text_h/2)';
  const drawText =
    `drawtext=fontfile=${FONT_BOLD}:textfile='${textFile}':fontsize=${fontSize}` +
    `:fontcolor=white:borderw=${Math.max(4, Math.round(fontSize / 12))}:bordercolor=black@0.9` +
    `:shadowcolor=black@0.6:shadowx=3:shadowy=3` +
    `:line_spacing=${Math.round(fontSize * 0.25)}:x=(w-text_w)/2:y=${textY}` +
    `:alpha='min(1,t*5)'`;

  // CTA scenes get a small secondary line to drive the follow.
  const ctaBadge = isCta
    ? `,drawtext=fontfile=${FONT_REGULAR}:text='follow for more':fontsize=40:fontcolor=white@0.85` +
      `:borderw=3:bordercolor=black@0.8:x=(w-text_w)/2:y=(h*0.62):alpha='min(1,max(0,(t-0.5)*3))'`
    : '';

  const broll = await fetchBrollClip(brollInstruction);
  if (broll) {
    // Cover-crop the clip to 9:16, loop if shorter than the scene.
    const vf =
      `scale=${W}:${H}:force_original_aspect_ratio=increase,crop=${W}:${H},fps=${FPS},` +
      `eq=brightness=-0.15:saturation=0.9,` + // darken so captions pop
      `${drawText}${ctaBadge},format=yuv420p`;
    await runFfmpeg(
      ['-stream_loop', '-1', '-i', broll, '-t', String(dur), '-vf', vf, '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-r', String(FPS), segmentPath],
      `scene ${index} (b-roll)`,
    );
  } else {
    // Animated gradient background (slow drift keeps the frame alive).
    const [c0, c1] = palette;
    const src = `gradients=s=${W}x${H}:c0=${c0}:c1=${c1}:speed=0.03:d=${dur}:r=${FPS}`;
    await runFfmpeg(
      ['-f', 'lavfi', '-i', src, '-vf', `${drawText}${ctaBadge},format=yuv420p`, '-an',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-r', String(FPS), segmentPath],
      `scene ${index} (gradient)`,
    );
  }
  return { segmentPath };
}

/** Render the full request to destPath. Returns destPath. */
export async function renderVideo(
  request: ViewMaxVideoRequest,
  destPath: string,
): Promise<string> {
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ttrender-'));
  try {
    const palette =
      PALETTES[(request.branding.primaryColor ?? '').toLowerCase()] ?? DEFAULT_PALETTE;

    const scenes = request.scenes.length
      ? request.scenes
      : [{ index: 0, durationSec: 6, description: '', onScreenText: request.script.slice(0, 80), voiceover: '', brollInstruction: 'none', transition: '' }];

    logRenderStep(`rendering ${scenes.length} scene(s) -> ${path.basename(destPath)}`);
    const segments: string[] = [];
    for (const [i, scene] of scenes.entries()) {
      const seg = await renderScene(
        workDir,
        i,
        scene.durationSec,
        scene.onScreenText,
        scene.brollInstruction,
        palette,
        i === 0,
        i === scenes.length - 1,
      );
      segments.push(seg.segmentPath);
    }

    // Concat segments (identical encode params -> stream copy).
    const listFile = path.join(workDir, 'concat.txt');
    await fs.writeFile(
      listFile,
      segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'),
      'utf8',
    );
    const silentPath = path.join(workDir, 'video-noaudio.mp4');
    await runFfmpeg(
      ['-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', silentPath],
      'concat scenes',
    );

    // Audio bed: licensed track from assets/music/ if present, else a soft
    // generated ambient pad (very low volume, non-intrusive).
    const totalDur = scenes.reduce((s, sc) => s + Math.min(6, Math.max(2, sc.durationSec)), 0);
    const music = request.backgroundMusic.enabled ? await pickMusicTrack() : undefined;
    await fs.ensureDir(path.dirname(destPath));
    if (music) {
      await runFfmpeg(
        ['-i', silentPath, '-i', music, '-filter_complex',
          `[1:a]volume=0.22,afade=t=in:d=0.5,afade=t=out:st=${Math.max(0, totalDur - 1)}:d=1[a]`,
          '-map', '0:v', '-map', '[a]', '-t', String(totalDur),
          // TikTok-friendly: stereo 44.1kHz audio + faststart for mobile editor.
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
          '-movflags', '+faststart', destPath],
        'mux music',
      );
    } else {
      await runFfmpeg(
        ['-i', silentPath, '-f', 'lavfi',
          '-i', `sine=frequency=174:duration=${totalDur}`,
          '-f', 'lavfi', '-i', `sine=frequency=261:duration=${totalDur}`,
          '-filter_complex',
          `[1:a][2:a]amix=inputs=2,volume=0.05,tremolo=f=0.3:d=0.4,afade=t=in:d=1,afade=t=out:st=${Math.max(0, totalDur - 1.5)}:d=1.5[a]`,
          '-map', '0:v', '-map', '[a]',
          '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k', '-ar', '44100', '-ac', '2',
          '-movflags', '+faststart', '-shortest', destPath],
        'mux ambient audio',
      );
    }

    logRenderStep(`done: ${destPath}`);
    return destPath;
  } finally {
    await fs.remove(workDir).catch(() => undefined);
  }
}
