export type Tier = 'budget' | 'standard' | 'premium';
export type GenStatus = 'none' | 'queued' | 'running' | 'done' | 'failed';

export interface Project {
  id: string;
  user_id: string;
  title: string;
  idea: string;
  genre: string | null;
  language: string;
  style: string | null;
  aspect_ratio: '16:9' | '9:16';
  target_duration_sec: number;
  tier: Tier;
  status: 'draft' | 'planning' | 'planned' | 'producing' | 'rendering' | 'done' | 'failed';
  logline: string | null;
  synopsis: string | null;
  music_prompt: string | null;
  music_url: string | null;
  music_status: GenStatus;
  final_video_url: string | null;
  thumbnail_url: string | null;
  render_status: GenStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface Character {
  id: string;
  project_id: string;
  idx: number;
  name: string;
  description: string;
  voice: string | null;
  portrait_url: string | null;
  portrait_status: GenStatus;
}

export interface Scene {
  id: string;
  project_id: string;
  idx: number;
  heading: string;
  summary: string | null;
}

export interface Shot {
  id: string;
  project_id: string;
  scene_id: string;
  idx: number;
  duration_sec: 4 | 6 | 8;
  camera: string | null;
  action: string;
  dialogue: string | null;
  speaker: string | null;
  character_ids: string[];
  keyframe_url: string | null;
  keyframe_status: GenStatus;
  approved: boolean;
  video_url: string | null;
  video_status: GenStatus;
  takes: number;
  error: string | null;
}

export interface LedgerRow {
  id: number;
  delta: number;
  kind: 'purchase' | 'charge' | 'refund' | 'grant' | 'expire' | 'adjust';
  note: string | null;
  balance_after: number;
  created_at: string;
}

export interface CreditPack {
  productId: string;
  credits: number;
  priceInr: number;
  validDays: number;
  label: string;
}

export interface Catalog {
  creditValueInr: number;
  image: number;
  music: number;
  planPerDuration: Record<string, number>;
  renderPerMinute: number;
  tiers: Record<Tier, { label: string; videoPerShot: Record<'4' | '6' | '8', number> }>;
  packs: CreditPack[];
}
