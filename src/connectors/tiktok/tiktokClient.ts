import axios, { AxiosError } from 'axios';
import fs from 'fs-extra';
import { env, setupMessage, tikTokMode } from '../../config/env';
import { logger } from '../../utils/logger';
import { NonRetryableError, sleep, withRetry } from '../../utils/retry';
import type {
  TikTokConnector,
  TikTokInitRequest,
  TikTokInitResponse,
  TikTokPublishStatus,
  TikTokUploadParams,
  TikTokUploadResult,
} from './tiktokTypes';

const TIKTOK_API_BASE = 'https://open.tiktokapis.com';
/** TikTok requires chunks between 5MB and 64MB; whole file if smaller. */
const CHUNK_SIZE = 10 * 1024 * 1024;
const MAX_SINGLE_CHUNK = 64 * 1024 * 1024;

/**
 * Official TikTok Content Posting API client (direct post flow).
 *
 * Requirements on the TikTok side:
 *  - App registered at https://developers.tiktok.com with Content Posting API
 *    product enabled and the video.publish scope approved.
 *  - Unaudited apps may only post with privacy_level SELF_ONLY (private).
 *    TODO(real-api): after your app passes TikTok's audit, other privacy
 *    levels become available.
 *
 * This client uses only documented endpoints. It never scrapes tiktok.com,
 * never automates the browser UI, and never bypasses rate limits — 429s are
 * retried politely with exponential backoff.
 */
export class HttpTikTokClient implements TikTokConnector {
  constructor(private readonly accessToken: string) {}

  private authHeaders() {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      'Content-Type': 'application/json; charset=UTF-8',
    };
  }

  private static rethrow(error: unknown, label: string): never {
    if (error instanceof AxiosError) {
      const status = error.response?.status;
      const body = JSON.stringify(error.response?.data ?? {}).slice(0, 500);
      const message = `TikTok ${label} failed (HTTP ${status ?? 'n/a'}): ${body}`;
      if (status && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        throw new NonRetryableError(message);
      }
      throw new Error(message);
    }
    throw error instanceof Error ? error : new Error(String(error));
  }

  /** Compose the post title: caption + hashtags (TikTok parses #tags in title). */
  static buildTitle(caption: string, hashtags: string[]): string {
    const tags = hashtags.map((t) => `#${t.replace(/^#/, '')}`).join(' ');
    // TikTok title limit is 2200 characters.
    return `${caption} ${tags}`.trim().slice(0, 2200);
  }

  async uploadVideo(params: TikTokUploadParams): Promise<TikTokUploadResult> {
    const stat = await fs.stat(params.videoFilePath);
    const videoSize = stat.size;
    const useSingleChunk = videoSize <= MAX_SINGLE_CHUNK;
    const chunkSize = useSingleChunk ? videoSize : CHUNK_SIZE;
    const totalChunks = useSingleChunk ? 1 : Math.floor(videoSize / chunkSize);

    const initBody: TikTokInitRequest = {
      post_info: {
        title: HttpTikTokClient.buildTitle(params.caption, params.hashtags),
        privacy_level: params.privacyStatus,
        disable_duet: params.disableDuet ?? false,
        disable_comment: params.disableComment ?? false,
        disable_stitch: params.disableStitch ?? false,
        video_cover_timestamp_ms: 1000,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: videoSize,
        chunk_size: chunkSize,
        total_chunk_count: totalChunks,
      },
    };

    // Step 1: initialize the upload.
    const init = await withRetry(
      async () => {
        try {
          const res = await axios.post<TikTokInitResponse>(
            `${TIKTOK_API_BASE}/v2/post/publish/video/init/`,
            initBody,
            { headers: this.authHeaders(), timeout: 30_000 },
          );
          if (res.data.error?.code && res.data.error.code !== 'ok') {
            throw new NonRetryableError(
              `TikTok init error: ${res.data.error.code} ${res.data.error.message}`,
            );
          }
          return res.data.data;
        } catch (err) {
          HttpTikTokClient.rethrow(err, 'init upload');
        }
      },
      { label: 'TikTok init upload' },
    );

    // Step 2: upload the file bytes with Content-Range headers.
    const buffer = await fs.readFile(params.videoFilePath);
    for (let chunk = 0; chunk < totalChunks; chunk += 1) {
      const start = chunk * chunkSize;
      // The last chunk absorbs the remainder.
      const end = chunk === totalChunks - 1 ? videoSize - 1 : start + chunkSize - 1;
      const slice = buffer.subarray(start, end + 1);
      await withRetry(
        async () => {
          try {
            await axios.put(init.upload_url, slice, {
              headers: {
                'Content-Type': 'video/mp4',
                'Content-Length': String(slice.length),
                'Content-Range': `bytes ${start}-${end}/${videoSize}`,
              },
              timeout: 5 * 60_000,
              maxBodyLength: Infinity,
            });
          } catch (err) {
            HttpTikTokClient.rethrow(err, `upload chunk ${chunk + 1}/${totalChunks}`);
          }
        },
        { label: `TikTok upload chunk ${chunk + 1}/${totalChunks}` },
      );
    }

    logger.info(`TikTok upload initialized: publish_id=${init.publish_id}`);

    // Step 3: poll briefly for a terminal status (processing continues async).
    let last: TikTokPublishStatus = { publishId: init.publish_id, status: 'PROCESSING_UPLOAD' };
    for (let i = 0; i < 10; i += 1) {
      last = await this.checkPublishStatus(init.publish_id);
      if (last.status === 'PUBLISH_COMPLETE' || last.status === 'FAILED') break;
      await sleep(6_000);
    }
    if (last.status === 'FAILED') {
      throw new Error(`TikTok publish failed: ${last.failReason ?? 'unknown reason'}`);
    }

    return {
      publishId: init.publish_id,
      videoId: last.publiclyAvailablePostId?.[0],
      status: last.status,
    };
  }

  async checkPublishStatus(publishId: string): Promise<TikTokPublishStatus> {
    return withRetry(
      async () => {
        try {
          const res = await axios.post(
            `${TIKTOK_API_BASE}/v2/post/publish/status/fetch/`,
            { publish_id: publishId },
            { headers: this.authHeaders(), timeout: 30_000 },
          );
          const data = res.data?.data ?? {};
          return {
            publishId,
            status: data.status ?? 'UNKNOWN',
            failReason: data.fail_reason,
            publiclyAvailablePostId: data.publicaly_available_post_id ?? data.publicly_available_post_id,
          };
        } catch (err) {
          HttpTikTokClient.rethrow(err, 'status fetch');
        }
      },
      { label: 'TikTok status fetch' },
    );
  }
}

// ---------------------------------------------------------------------------
// Mock client — clearly separated placeholder adapter
// ---------------------------------------------------------------------------

export class MockTikTokClient implements TikTokConnector {
  private counter = 0;

  async uploadVideo(params: TikTokUploadParams): Promise<TikTokUploadResult> {
    this.counter += 1;
    const publishId = `mock-publish-${Date.now()}-${this.counter}`;
    const title = HttpTikTokClient.buildTitle(params.caption, params.hashtags);
    logger.info('[mock] TikTok upload — what WOULD happen with real credentials:');
    logger.info(`[mock]   POST /v2/post/publish/video/init/ (privacy=${params.privacyStatus})`);
    logger.info(`[mock]   title: ${title.slice(0, 120)}${title.length > 120 ? '…' : ''}`);
    logger.info(`[mock]   PUT video bytes from ${params.videoFilePath}`);
    logger.info(`[mock]   poll /v2/post/publish/status/fetch/ until PUBLISH_COMPLETE`);
    return {
      publishId,
      videoId: `mock-video-${this.counter}`,
      status: 'PUBLISH_COMPLETE',
    };
  }

  async checkPublishStatus(publishId: string): Promise<TikTokPublishStatus> {
    return { publishId, status: 'PUBLISH_COMPLETE' };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let instance: TikTokConnector | undefined;

export function getTikTokClient(): TikTokConnector {
  if (instance) return instance;
  const mode = tikTokMode();
  if (mode === 'mock') {
    if (env.MOCK_MODE !== true) {
      logger.warn(
        'TikTok credentials not set — using mock TikTok client (no real uploads). ' +
          'Set TIKTOK_ACCESS_TOKEN for real uploads.',
      );
    }
    instance = new MockTikTokClient();
    return instance;
  }
  if (!env.TIKTOK_ACCESS_TOKEN) {
    throw new Error(setupMessage('tiktok'));
  }
  instance = new HttpTikTokClient(env.TIKTOK_ACCESS_TOKEN);
  return instance;
}
