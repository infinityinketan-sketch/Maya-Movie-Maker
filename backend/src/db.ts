import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { HttpError, type Env, type JobKind } from './env';

export type Db = SupabaseClient;

export function db(env: Env): Db {
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function must<T>(res: { data: T | null; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  if (res.data === null) throw new HttpError(404, 'not_found', `${what} not found`);
  return res.data;
}

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
  tier: 'budget' | 'value' | 'standard' | 'premium';
  status: string;
  logline: string | null;
  synopsis: string | null;
  music_prompt: string | null;
  music_url: string | null;
  final_video_url: string | null;
  kind: 'film' | 'ad';
  ad_brief: import('./ads').AdBrief | null;
  poster_url: string | null;
  edit: unknown;
  render_status?: string;
  music_status?: string;
  poster_status?: string;
}

export interface AdOrder {
  id: string;
  user_id: string;
  project_id: string | null;
  customer_name: string;
  customer_phone: string;
  business_name: string;
  price_inr: number;
  advance_inr: number;
  advance_at: string | null;
  status: string;
  delivered_at: string | null;
  paid_at: string | null;
}

export interface Character {
  id: string;
  project_id: string;
  user_id: string;
  idx: number;
  name: string;
  description: string;
  voice: string | null;
  portrait_url: string | null;
  portrait_status: string;
}

export interface Shot {
  id: string;
  project_id: string;
  scene_id: string;
  user_id: string;
  idx: number;
  duration_sec: 4 | 6 | 8;
  camera: string | null;
  action: string;
  dialogue: string | null;
  speaker: string | null;
  character_ids: string[];
  keyframe_url: string | null;
  keyframe_status: string;
  approved: boolean;
  video_url: string | null;
  video_status: string;
  takes: number;
}

export interface Job {
  id: string;
  user_id: string;
  project_id: string | null;
  target_id: string | null;
  kind: JobKind;
  status: 'queued' | 'running' | 'succeeded' | 'failed';
  credits: number;
  cost_usd: number;
  provider: string | null;
  model: string | null;
  provider_request_id: string | null;
  provider_status_url: string | null;
  provider_response_url: string | null;
  attempts: number;
  input: Record<string, unknown>;
  refunded: boolean;
}

export async function getOwnedProject(d: Db, userId: string, id: string): Promise<Project> {
  return must(await d.from('projects').select('*').eq('id', id).eq('user_id', userId).maybeSingle(), 'project');
}
export async function getOwnedShot(d: Db, userId: string, id: string): Promise<Shot> {
  return must(await d.from('shots').select('*').eq('id', id).eq('user_id', userId).maybeSingle(), 'shot');
}
export async function getOwnedCharacter(d: Db, userId: string, id: string): Promise<Character> {
  return must(await d.from('characters').select('*').eq('id', id).eq('user_id', userId).maybeSingle(), 'character');
}
export async function balanceOf(d: Db, userId: string): Promise<number> {
  const res = await d.from('wallets').select('balance').eq('user_id', userId).maybeSingle();
  if (res.error) throw new Error(res.error.message);
  return res.data?.balance ?? 0;
}
