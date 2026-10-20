export type Tier = 'budget' | 'value' | 'standard' | 'premium';
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
  kind: 'film' | 'ad';
  ad_brief: AdBrief | null;
  poster_url: string | null;
  poster_status: GenStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AdBrief {
  businessName: string;
  businessType: string;
  area: string | null;
  offer: string;
  occasion: string | null;
  language: string;
  contactLine: string | null;
  photoUrl: string | null;
}

export type OrderStatus = 'awaiting_advance' | 'new' | 'producing' | 'ready' | 'delivered' | 'paid' | 'cancelled';
export interface AdOrder {
  id: string;
  project_id: string | null;
  customer_name: string;
  customer_phone: string;
  business_name: string;
  business_type: string;
  area: string | null;
  offer: string;
  occasion: string | null;
  language: string;
  contact_line: string | null;
  photo_url: string | null;
  price_inr: number;
  advance_inr: number;
  advance_at: string | null;
  status: OrderStatus;
  notes: string | null;
  delivered_at: string | null;
  paid_at: string | null;
  created_at: string;
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
  video_model: string | null;
  prev_video_url: string | null;
  prev_video_model: string | null;
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
  markup: number;
  image: number;
  music: number;
  planPerDuration: Record<string, number>;
  renderPerMinute: number;
  tiers: Record<Tier, { label: string; videoPerShot: Record<'4' | '6' | '8', number> }>;
  packs: CreditPack[];
  director: { direct: number; reviewByShots: Record<string, number> };
}

export type CameraGroupId = 'size' | 'angle' | 'movement' | 'lens' | 'light';
export interface CameraOption {
  id: string;
  label: string;
  prompt: string;
  says: string;
  useFor: string;
}
export interface CameraGroup {
  id: CameraGroupId;
  title: string;
  options: CameraOption[];
}

export interface DirectorOption {
  title: string;
  camera: string;
  action: string;
  why: string;
}

export interface ReviewNote {
  shot: number;
  shotId: string;
  issue: string;
  suggestion: string;
  camera?: string;
  action?: string;
}
export interface FilmReview {
  summary: string;
  strengths: string[];
  notes: ReviewNote[];
  credits: number;
}

export const TIER_NAMES: Record<Tier, string> = { budget: 'Draft', value: 'HD Value', standard: 'Standard', premium: 'Premium' };
export const TIER_ORDER: Tier[] = ['budget', 'value', 'standard', 'premium'];
