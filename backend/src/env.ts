export interface Env {
  // Supabase
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  // AI providers
  ANTHROPIC_API_KEY: string;
  ANTHROPIC_MODEL: string;
  GEMINI_API_KEY: string;
  GEMINI_IMAGE_MODEL: string;
  FAL_KEY: string;
  // Storage + queue
  MEDIA: R2Bucket;
  MEDIA_PUBLIC_BASE: string; // public URL of the R2 bucket, no trailing slash
  JOBS: Queue<JobMessage>;
  PUBLIC_API_BASE: string; // public URL of this worker, used for fal.ai webhooks
  // Pricing + limits
  USD_INR: string;
  CREDIT_MARKUP: string;
  DAILY_CREDIT_LIMIT: string;
  // Google Play billing
  GOOGLE_PLAY_PACKAGE: string;
  GOOGLE_SERVICE_ACCOUNT_JSON: string;
  // Mixing server (optional): without it only simple cuts (whole clips + looped score) can be made
  RENDER_SERVICE_URL?: string;
  RENDER_SECRET?: string;
}

export type JobMessage =
  | { type: 'start'; jobId: string; attempt?: number }
  | { type: 'finalize'; jobId: string; ok: boolean; result?: unknown; error?: string; attempt?: number };

export type JobKind = 'plan' | 'portrait' | 'keyframe' | 'video' | 'music' | 'render' | 'director' | 'poster' | 'sfx' | 'voice';

export interface AppUser {
  id: string;
  email?: string;
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}
