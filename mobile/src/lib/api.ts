import { config } from './config';
import { supabase } from './supabase';
import type { AdOrder, OrderStatus, CameraGroup, Catalog, Character, DirectorOption, FilmReview, Project, Shot, Tier } from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  let res: Response;
  try {
    res = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'offline', 'No internet connection. Check your network and try again.');
  }
  const json = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? 'error', json.message ?? 'Something went wrong.');
  return json as T;
}

/** Uploads a picked photo (local file uri) and returns its public URL. */
async function uploadPhoto(uri: string, mimeType: string): Promise<{ url: string }> {
  const { data } = await supabase.auth.getSession();
  const blob = await (await fetch(uri)).blob();
  const res = await fetch(`${config.apiUrl}/v1/uploads/photo`, {
    method: 'POST',
    headers: { 'content-type': mimeType, authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: blob,
  });
  const json = (await res.json().catch(() => ({}))) as { url?: string; error?: string; message?: string };
  if (!res.ok || !json.url) throw new ApiError(res.status, json.error ?? 'upload', json.message ?? 'Photo upload failed.');
  return { url: json.url };
}

/** Uploads a clip the user made elsewhere (e.g. Google Flow) as the shot's newest take. No credits. */
async function uploadClip(shotId: string, uri: string, mimeType: string): Promise<Shot> {
  const { data } = await supabase.auth.getSession();
  const blob = await (await fetch(uri)).blob();
  const res = await fetch(`${config.apiUrl}/v1/shots/${shotId}/clip`, {
    method: 'POST',
    headers: { 'content-type': mimeType || 'video/mp4', authorization: `Bearer ${data.session?.access_token ?? ''}` },
    body: blob,
  });
  const json = (await res.json().catch(() => ({}))) as Shot & { error?: string; message?: string };
  if (!res.ok) throw new ApiError(res.status, json.error ?? 'upload', json.message ?? 'Clip upload failed.');
  return json;
}

export const api = {
  catalog: () => call<Catalog>('GET', '/v1/catalog'),
  me: () => call<{ balance: number; director: boolean; role: 'user' | 'operator' }>('GET', '/v1/me'),
  deleteAccount: () => call<{ ok: true }>('DELETE', '/v1/me'),

  createProject: (input: {
    idea: string;
    genre?: string;
    language: string;
    style?: string;
    aspect_ratio: '16:9' | '9:16';
    target_duration_sec: number;
    tier: Tier;
  }) => call<Project>('POST', '/v1/projects', input),
  updateProject: (id: string, patch: Partial<Pick<Project, 'title' | 'music_prompt' | 'style' | 'tier'>>) =>
    call<Project>('PATCH', `/v1/projects/${id}`, patch),
  deleteProject: (id: string) => call<{ ok: true }>('DELETE', `/v1/projects/${id}`),

  plan: (id: string) => call('POST', `/v1/projects/${id}/plan`),
  portraits: (projectId: string) => call('POST', `/v1/projects/${projectId}/portraits`),
  portrait: (characterId: string) => call('POST', `/v1/characters/${characterId}/portrait`),
  updateCharacter: (id: string, patch: Partial<Pick<Character, 'name' | 'description' | 'voice'>>) =>
    call<Character>('PATCH', `/v1/characters/${id}`, patch),

  storyboard: (projectId: string) => call('POST', `/v1/projects/${projectId}/storyboard`),
  keyframe: (shotId: string) => call('POST', `/v1/shots/${shotId}/keyframe`),
  approve: (shotId: string, approved: boolean) => call<Shot>('POST', `/v1/shots/${shotId}/approve`, { approved }),
  updateShot: (id: string, patch: Partial<Pick<Shot, 'action' | 'dialogue' | 'speaker' | 'camera' | 'duration_sec'>>) =>
    call<Shot>('PATCH', `/v1/shots/${id}`, patch),

  videos: (projectId: string) => call('POST', `/v1/projects/${projectId}/videos`),
  video: (shotId: string) => call('POST', `/v1/shots/${shotId}/video`),
  music: (projectId: string) => call('POST', `/v1/projects/${projectId}/music`),
  render: (projectId: string) => call('POST', `/v1/projects/${projectId}/render`),

  cameraLibrary: () => call<{ groups: CameraGroup[] }>('GET', '/v1/director/library'),
  direct: (shotId: string) => call<{ options: DirectorOption[]; credits: number }>('POST', `/v1/shots/${shotId}/direct`),
  review: (projectId: string) => call<FilmReview>('POST', `/v1/projects/${projectId}/review`),

  orderOptions: () => call<{ businessTypes: string[]; occasions: string[]; lengths: number[] }>('GET', '/v1/orders/options'),
  createOrder: (input: {
    customer_name: string;
    customer_phone: string;
    business_name: string;
    business_type: string;
    area?: string;
    offer: string;
    occasion?: string;
    language: string;
    contact_line?: string;
    photo_url?: string;
    price_inr: number;
    advance_inr: number;
    target_duration_sec: number;
    tier: Tier;
    notes?: string;
  }) => call<{ order: AdOrder; project: Project }>('POST', '/v1/orders', input),
  updateOrder: (id: string, patch: { status?: OrderStatus; price_inr?: number; advance_inr?: number; notes?: string }) => call<AdOrder>('PATCH', `/v1/orders/${id}`, patch),
  orderWhatsapp: (id: string) => call<{ link: string; message: string }>('GET', `/v1/orders/${id}/whatsapp`),
  poster: (projectId: string) => call('POST', `/v1/projects/${projectId}/poster`),
  uploadPhoto,
  uploadClip,

  verifyPlayPurchase: (productId: string, purchaseToken: string) =>
    call<{ ok: true; balance: number; credits: number }>('POST', '/v1/billing/google-play/verify', { productId, purchaseToken }),
};
