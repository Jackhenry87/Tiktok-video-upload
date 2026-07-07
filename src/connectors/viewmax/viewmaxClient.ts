import axios, { AxiosError, AxiosInstance } from 'axios';
import fs from 'fs-extra';
import path from 'node:path';
import { env, setupMessage, viewMaxMode } from '../../config/env';
import { logger } from '../../utils/logger';
import { NonRetryableError, withRetry } from '../../utils/retry';
import { writePlaceholderMp4 } from '../../utils/fileStorage';
import type {
  ViewMaxConnector,
  ViewMaxJobRef,
  ViewMaxJobStatus,
  ViewMaxStyle,
  ViewMaxTemplate,
  ViewMaxVideoRequest,
  ViewMaxVoice,
} from './viewmaxTypes';

// ---------------------------------------------------------------------------
// Real HTTP client
// ---------------------------------------------------------------------------

/**
 * HTTP client for the ViewMax video-generation API.
 *
 * TODO(real-api): The endpoint paths below (/videos, /videos/:id, etc.) are
 * placeholders modeled on typical REST video-generation APIs. Replace them
 * with the real paths from the official ViewMax documentation once available.
 * Auth is assumed to be a Bearer token; adjust if ViewMax uses another scheme.
 */
export class HttpViewMaxClient implements ViewMaxConnector {
  private readonly http: AxiosInstance;

  constructor(baseUrl: string, apiKey: string) {
    this.http = axios.create({
      baseURL: baseUrl,
      timeout: 60_000,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });
  }

  private static rethrow(error: unknown, label: string): never {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const body = JSON.stringify(error.response?.data ?? {}).slice(0, 500);
      const message = `ViewMax ${label} failed (HTTP ${status ?? 'n/a'}): ${body}`;
      // 4xx (except 408/429) will not succeed on retry.
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        throw new NonRetryableError(message);
      }
      throw new Error(message);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  async createVideoJob(request: ViewMaxVideoRequest): Promise<ViewMaxJobRef> {
    return withRetry(
      async () => {
        try {
          // TODO(real-api): confirm endpoint + payload envelope with ViewMax docs.
          const res = await this.http.post('/videos', request);
          const jobId: string | undefined = res.data?.jobId ?? res.data?.id;
          if (!jobId) throw new NonRetryableError('ViewMax response missing job id');
          return { jobId };
        } catch (err) {
          HttpViewMaxClient.rethrow(err, 'createVideoJob');
        }
      },
      { label: 'ViewMax createVideoJob' },
    );
  }

  async checkVideoStatus(jobId: string): Promise<ViewMaxJobStatus> {
    return withRetry(
      async () => {
        try {
          // TODO(real-api): confirm endpoint with ViewMax docs.
          const res = await this.http.get(`/videos/${encodeURIComponent(jobId)}`);
          return {
            jobId,
            status: res.data?.status ?? 'processing',
            progress: res.data?.progress,
            videoUrl: res.data?.videoUrl ?? res.data?.downloadUrl,
            error: res.data?.error,
          };
        } catch (err) {
          HttpViewMaxClient.rethrow(err, 'checkVideoStatus');
        }
      },
      { label: 'ViewMax checkVideoStatus' },
    );
  }

  async downloadGeneratedVideo(jobId: string, destPath: string): Promise<string> {
    const status = await this.checkVideoStatus(jobId);
    if (status.status !== 'completed' || !status.videoUrl) {
      throw new Error(`ViewMax job ${jobId} is not completed (status: ${status.status})`);
    }
    return withRetry(
      async () => {
        await fs.ensureDir(path.dirname(destPath));
        const res = await axios.get<NodeJS.ReadableStream>(status.videoUrl!, {
          responseType: 'stream',
          timeout: 5 * 60_000,
        });
        await new Promise<void>((resolve, reject) => {
          const out = fs.createWriteStream(destPath);
          res.data.pipe(out);
          out.on('finish', resolve);
          out.on('error', reject);
          res.data.on('error', reject);
        });
        return destPath;
      },
      { label: 'ViewMax download' },
    );
  }

  async getAvailableTemplates(): Promise<ViewMaxTemplate[]> {
    // TODO(real-api): confirm endpoint with ViewMax docs.
    return withRetry(
      async () => {
        try {
          const res = await this.http.get('/templates');
          return res.data?.templates ?? res.data ?? [];
        } catch (err) {
          HttpViewMaxClient.rethrow(err, 'getAvailableTemplates');
        }
      },
      { label: 'ViewMax getAvailableTemplates' },
    );
  }

  async getAvailableVoices(): Promise<ViewMaxVoice[]> {
    // TODO(real-api): confirm endpoint with ViewMax docs.
    return withRetry(
      async () => {
        try {
          const res = await this.http.get('/voices');
          return res.data?.voices ?? res.data ?? [];
        } catch (err) {
          HttpViewMaxClient.rethrow(err, 'getAvailableVoices');
        }
      },
      { label: 'ViewMax getAvailableVoices' },
    );
  }

  async getAvailableStyles(): Promise<ViewMaxStyle[]> {
    // TODO(real-api): confirm endpoint with ViewMax docs.
    return withRetry(
      async () => {
        try {
          const res = await this.http.get('/styles');
          return res.data?.styles ?? res.data ?? [];
        } catch (err) {
          HttpViewMaxClient.rethrow(err, 'getAvailableStyles');
        }
      },
      { label: 'ViewMax getAvailableStyles' },
    );
  }
}

// ---------------------------------------------------------------------------
// Mock client (MOCK_MODE=true, or credentials not yet configured)
// ---------------------------------------------------------------------------

export class MockViewMaxClient implements ViewMaxConnector {
  /** Poll counts per job so status advances deterministically per process. */
  private readonly pollCounts = new Map<string, number>();
  private readonly requests = new Map<string, ViewMaxVideoRequest>();
  private counter = 0;

  async createVideoJob(request: ViewMaxVideoRequest): Promise<ViewMaxJobRef> {
    this.counter += 1;
    const jobId = `mock-vmx-${Date.now()}-${this.counter}`;
    this.requests.set(jobId, request);
    logger.info(
      `[mock] ViewMax job ${jobId} created (${request.scenes.length} scenes, ` +
        `${request.durationTargetSec}s target, style "${request.stylePreset}")`,
    );
    return { jobId };
  }

  async checkVideoStatus(jobId: string): Promise<ViewMaxJobStatus> {
    const polls = (this.pollCounts.get(jobId) ?? 0) + 1;
    this.pollCounts.set(jobId, polls);
    // First poll: processing. Second and later: completed. Jobs from a
    // previous process run (unknown here) report completed immediately.
    if (this.requests.has(jobId) && polls < 2) {
      return { jobId, status: 'processing', progress: 55 };
    }
    return {
      jobId,
      status: 'completed',
      progress: 100,
      videoUrl: `mock://viewmax/videos/${jobId}.mp4`,
    };
  }

  async downloadGeneratedVideo(jobId: string, destPath: string): Promise<string> {
    const request = this.requests.get(jobId);
    await writePlaceholderMp4(destPath, {
      viewmaxJobId: jobId,
      scenes: request?.scenes.length ?? 0,
      durationTargetSec: request?.durationTargetSec ?? 0,
    });
    logger.info(`[mock] Wrote placeholder MP4 for job ${jobId} -> ${destPath}`);
    return destPath;
  }

  async getAvailableTemplates(): Promise<ViewMaxTemplate[]> {
    return [
      { id: 'tpl-talking-head', name: 'Talking Head + Captions', description: 'AI presenter with bold captions', aspectRatio: '9:16' },
      { id: 'tpl-broll-story', name: 'B-roll Story', description: 'Stock b-roll with voiceover and text overlays', aspectRatio: '9:16' },
      { id: 'tpl-list-cards', name: 'List Cards', description: 'Animated list-style cards, one point per scene', aspectRatio: '9:16' },
    ];
  }

  async getAvailableVoices(): Promise<ViewMaxVoice[]> {
    return [
      { id: 'voice-alex', name: 'Alex', language: 'en-US', style: 'energetic' },
      { id: 'voice-morgan', name: 'Morgan', language: 'en-US', style: 'calm-authoritative' },
      { id: 'voice-riley', name: 'Riley', language: 'en-US', style: 'conversational' },
    ];
  }

  async getAvailableStyles(): Promise<ViewMaxStyle[]> {
    return [
      { id: 'style-bold-captions', name: 'Bold Captions', description: 'High-contrast text slams with punch-in zooms' },
      { id: 'style-clean-minimal', name: 'Clean Minimal', description: 'Soft backgrounds, simple lower-thirds' },
      { id: 'style-fast-cuts', name: 'Fast Cuts', description: 'Quick scene changes with motion transitions' },
    ];
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let instance: ViewMaxConnector | undefined;

/**
 * Video engine selection:
 *   MOCK_MODE=true          -> mock (placeholder files, no real render)
 *   VIDEO_ENGINE=viewmax    -> ViewMax HTTP API (errors if unconfigured)
 *   VIDEO_ENGINE=local      -> built-in ffmpeg renderer
 *   auto (default)          -> ViewMax when configured, else the built-in
 *                              ffmpeg renderer, else mock
 */
export function getViewMaxClient(): ViewMaxConnector {
  if (instance) return instance;

  // Lazy require avoids a circular import (renderer -> types only).
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { LocalRendererClient } = require('./localRendererClient') as typeof import('./localRendererClient');

  if (env.MOCK_MODE === true) {
    instance = new MockViewMaxClient();
    return instance;
  }
  if (env.VIDEO_ENGINE === 'local') {
    if (!LocalRendererClient.available()) {
      throw new Error('VIDEO_ENGINE=local requires ffmpeg on PATH.');
    }
    instance = new LocalRendererClient();
    return instance;
  }
  if (env.VIDEO_ENGINE === 'viewmax' || viewMaxMode() === 'real') {
    if (!env.VIEWMAX_API_KEY || !env.VIEWMAX_BASE_URL) {
      throw new Error(setupMessage('viewmax'));
    }
    instance = new HttpViewMaxClient(env.VIEWMAX_BASE_URL, env.VIEWMAX_API_KEY);
    return instance;
  }
  if (LocalRendererClient.available()) {
    logger.info('Using the built-in ffmpeg video engine (no ViewMax credentials set).');
    instance = new LocalRendererClient();
    return instance;
  }
  logger.warn('No video engine available (no ViewMax creds, no ffmpeg) — using mock client.');
  instance = new MockViewMaxClient();
  return instance;
}
