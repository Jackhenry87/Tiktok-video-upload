import type { PrivacyStatus } from '../../types';

/**
 * TikTok Content Posting API types (official API only).
 * Docs: https://developers.tiktok.com/doc/content-posting-api-get-started/
 *
 * This app never automates the TikTok website or bypasses logins, CAPTCHAs,
 * rate limits, or other protections. Uploads go exclusively through the
 * documented Content Posting API with a user-authorized OAuth token.
 */

export interface TikTokUploadParams {
  videoFilePath: string;
  /** Caption text; hashtags are appended to this as #tag tokens. */
  caption: string;
  hashtags: string[];
  privacyStatus: PrivacyStatus;
  disableComment?: boolean;
  disableDuet?: boolean;
  disableStitch?: boolean;
  /**
   * Desired publish time (ISO). NOTE: the Content Posting API does not
   * currently accept a schedule time for direct posts — scheduling is
   * handled locally by this app (upload happens when the slot is due).
   * TODO(real-api): if TikTok adds native scheduling, pass it through here.
   */
  scheduledPublishTime?: string;
}

export interface TikTokUploadResult {
  publishId: string;
  /** Video id once TikTok finishes processing (may be filled in later). */
  videoId?: string;
  status: 'PROCESSING_UPLOAD' | 'PUBLISH_COMPLETE' | 'FAILED' | string;
}

export interface TikTokPublishStatus {
  publishId: string;
  status: string;
  failReason?: string;
  publiclyAvailablePostId?: string[];
}

/** POST /v2/post/publish/video/init/ request body. */
export interface TikTokInitRequest {
  post_info: {
    title: string;
    privacy_level: PrivacyStatus;
    disable_duet: boolean;
    disable_comment: boolean;
    disable_stitch: boolean;
    video_cover_timestamp_ms: number;
  };
  source_info: {
    source: 'FILE_UPLOAD';
    video_size: number;
    chunk_size: number;
    total_chunk_count: number;
  };
}

export interface TikTokInitResponse {
  data: {
    publish_id: string;
    upload_url: string;
  };
  error: {
    code: string;
    message: string;
    log_id: string;
  };
}

export interface TikTokConnector {
  /** Direct post: init -> chunked PUT -> publish handle. */
  uploadVideo(params: TikTokUploadParams): Promise<TikTokUploadResult>;
  /**
   * Inbox upload: the video lands in the user's TikTok app drafts; the user
   * finishes the post in-app (public distribution, no app audit needed).
   * `title` pre-fills the caption when TikTok honors it.
   */
  uploadToInbox(videoFilePath: string, title?: string): Promise<TikTokUploadResult>;
  checkPublishStatus(publishId: string): Promise<TikTokPublishStatus>;
}
