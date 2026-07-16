import fs from 'fs-extra';
import path from 'node:path';
import { logger } from '../../utils/logger';
import { renderVideo } from '../../videos/renderer/localRenderer';
import { hasFfmpeg } from '../../videos/renderer/ffmpegUtils';
import type {
  ViewMaxConnector,
  ViewMaxJobRef,
  ViewMaxJobStatus,
  ViewMaxStyle,
  ViewMaxTemplate,
  ViewMaxVideoRequest,
  ViewMaxVoice,
} from './viewmaxTypes';

/**
 * Built-in video engine exposed through the ViewMaxConnector interface, so
 * the rest of the pipeline is agnostic about where videos come from.
 * Renders REAL uploadable MP4s locally with ffmpeg — used automatically
 * when ViewMax credentials are absent and ffmpeg is available.
 */
export class LocalRendererClient implements ViewMaxConnector {
  private readonly jobs = new Map<
    string,
    { promise: Promise<string>; done: boolean; error?: string; outputPath: string }
  >();
  private counter = 0;

  static available(): boolean {
    return hasFfmpeg();
  }

  async createVideoJob(request: ViewMaxVideoRequest): Promise<ViewMaxJobRef> {
    this.counter += 1;
    const jobId = `local-${Date.now()}-${this.counter}`;
    const outputPath = `${process.cwd()}/storage/videos/render-${jobId}.mp4`;
    const entry = {
      promise: renderVideo(request, outputPath),
      done: false,
      error: undefined as string | undefined,
      outputPath,
    };
    entry.promise
      .then(() => {
        entry.done = true;
      })
      .catch((err) => {
        entry.done = true;
        entry.error = err instanceof Error ? err.message : String(err);
      });
    this.jobs.set(jobId, entry);
    logger.info(`[local-engine] render job ${jobId} started (${request.scenes.length} scenes)`);
    return { jobId };
  }

  async checkVideoStatus(jobId: string): Promise<ViewMaxJobStatus> {
    const entry = this.jobs.get(jobId);
    if (!entry) {
      return { jobId, status: 'failed', error: 'unknown local render job (process restarted?)' };
    }
    if (!entry.done) return { jobId, status: 'processing', progress: 50 };
    if (entry.error) return { jobId, status: 'failed', error: entry.error };
    return { jobId, status: 'completed', progress: 100, videoUrl: `file://${entry.outputPath}` };
  }

  async downloadGeneratedVideo(jobId: string, destPath: string): Promise<string> {
    const entry = this.jobs.get(jobId);
    if (!entry) throw new Error(`unknown local render job ${jobId}`);
    await entry.promise; // ensure finished
    await fs.ensureDir(path.dirname(destPath));
    await fs.copy(entry.outputPath, destPath);
    await fs.remove(entry.outputPath).catch(() => undefined);
    return destPath;
  }

  async getAvailableTemplates(): Promise<ViewMaxTemplate[]> {
    return [
      { id: 'local-kinetic-text', name: 'Kinetic Text', description: 'Bold animated captions on branded gradient or licensed b-roll', aspectRatio: '9:16' },
    ];
  }

  async getAvailableVoices(): Promise<ViewMaxVoice[]> {
    // TODO(tts): add TTS voiceover once a TTS provider key is configured.
    return [];
  }

  async getAvailableStyles(): Promise<ViewMaxStyle[]> {
    return [
      { id: 'style-bold-captions', name: 'Bold Captions', description: 'High-contrast outlined text, fade-in per scene' },
    ];
  }
}
