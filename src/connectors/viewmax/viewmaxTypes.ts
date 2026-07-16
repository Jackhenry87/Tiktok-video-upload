/**
 * ViewMax connector types.
 *
 * TODO(real-api): Field names below are our best-guess contract. When the
 * official ViewMax API documentation is available, align these types (and the
 * endpoint paths in viewmaxClient.ts) with the real spec. The rest of the app
 * only depends on the ViewMaxConnector interface, so changes stay contained.
 */

export interface ViewMaxScene {
  index: number;
  durationSec: number;
  description: string;
  onScreenText: string;
  voiceover: string;
  brollInstruction: string;
  transition: string;
}

export interface ViewMaxVideoRequest {
  script: string;
  scenes: ViewMaxScene[];
  voiceoverText: string;
  onScreenText: string[];
  /** Always 9:16 vertical for TikTok. */
  format: '9:16';
  /** Always 1080x1920. */
  resolution: '1080x1920';
  durationTargetSec: number;
  stylePreset: string;
  voicePreset: string;
  backgroundMusic: {
    enabled: boolean;
    /** Mood/genre guidance; ViewMax must only use licensed/approved tracks. */
    mood: string;
  };
  captionsEnabled: boolean;
  branding: {
    handle?: string;
    primaryColor?: string;
    logoPath?: string;
  };
  watermark: {
    enabled: boolean;
    text?: string;
  };
  outputFormat: 'mp4';
}

export type ViewMaxJobStatusValue = 'queued' | 'processing' | 'completed' | 'failed';

export interface ViewMaxJobRef {
  jobId: string;
}

export interface ViewMaxJobStatus {
  jobId: string;
  status: ViewMaxJobStatusValue;
  /** 0-100 progress when the API reports it. */
  progress?: number;
  /** Download URL, present when status === 'completed'. */
  videoUrl?: string;
  error?: string;
}

export interface ViewMaxTemplate {
  id: string;
  name: string;
  description: string;
  aspectRatio: string;
}

export interface ViewMaxVoice {
  id: string;
  name: string;
  language: string;
  style: string;
}

export interface ViewMaxStyle {
  id: string;
  name: string;
  description: string;
}

/**
 * The single interface the rest of the app depends on. Both the real HTTP
 * client and the mock client implement this.
 */
export interface ViewMaxConnector {
  createVideoJob(request: ViewMaxVideoRequest): Promise<ViewMaxJobRef>;
  checkVideoStatus(jobId: string): Promise<ViewMaxJobStatus>;
  /** Downloads the finished MP4 to destPath and returns the path. */
  downloadGeneratedVideo(jobId: string, destPath: string): Promise<string>;
  getAvailableTemplates(): Promise<ViewMaxTemplate[]>;
  getAvailableVoices(): Promise<ViewMaxVoice[]>;
  getAvailableStyles(): Promise<ViewMaxStyle[]>;
}
