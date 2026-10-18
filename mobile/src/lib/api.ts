import { config } from './config';
import { supabase } from './supabase';
import type { Catalog, Character, Project, Shot, Tier } from './types';

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

export const api = {
  catalog: () => call<Catalog>('GET', '/v1/catalog'),
  me: () => call<{ balance: number }>('GET', '/v1/me'),
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

  verifyPlayPurchase: (productId: string, purchaseToken: string) =>
    call<{ ok: true; balance: number; credits: number }>('POST', '/v1/billing/google-play/verify', { productId, purchaseToken }),
};
