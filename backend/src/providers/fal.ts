import type { Env } from '../env';
import { providerFetch } from '../reliability';

export interface FalSubmission {
  requestId: string;
  statusUrl: string | null;
  responseUrl: string | null;
}

/** Submits to the fal.ai queue; the result arrives later at /v1/webhooks/fal. Busy errors are retried by the caller. */
export async function falSubmit(env: Env, endpoint: string, input: Record<string, unknown>): Promise<FalSubmission> {
  const webhook = `${env.PUBLIC_API_BASE.replace(/\/$/, '')}/v1/webhooks/fal`;
  const res = await providerFetch('fal.ai', `https://queue.fal.run/${endpoint}?fal_webhook=${encodeURIComponent(webhook)}`, {
    method: 'POST',
    headers: { Authorization: `Key ${env.FAL_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify(input),
  }, 30_000);
  const body = (await res.json().catch(() => ({}))) as { request_id?: string; status_url?: string; response_url?: string; detail?: unknown };
  if (!res.ok || !body.request_id) throw new Error(`fal.ai refused the request (${res.status}): ${JSON.stringify(body.detail ?? body).slice(0, 300)}`);
  return { requestId: body.request_id, statusUrl: body.status_url ?? null, responseUrl: body.response_url ?? null };
}

export type FalLookup = { state: 'pending' } | { state: 'done'; ok: boolean; payload: unknown; error?: string };

/** Asks fal.ai directly what happened to a request whose webhook never arrived. */
export async function falLookup(env: Env, statusUrl: string, responseUrl: string): Promise<FalLookup> {
  const headers = { Authorization: `Key ${env.FAL_KEY}` };
  const st = (await (await providerFetch('fal.ai', statusUrl, { headers }, 20_000)).json().catch(() => ({}))) as { status?: string };
  if (st.status === 'IN_QUEUE' || st.status === 'IN_PROGRESS') return { state: 'pending' };
  const res = await providerFetch('fal.ai', responseUrl, { headers }, 20_000);
  const payload = await res.json().catch(() => null);
  if (!res.ok) return { state: 'done', ok: false, payload, error: `fal.ai reported an error (${res.status})` };
  return { state: 'done', ok: true, payload };
}

export interface FalWebhook {
  request_id: string;
  gateway_request_id?: string;
  status: 'OK' | 'ERROR';
  payload: unknown;
  error?: string;
  payload_error?: string;
}

const JWKS_URL = 'https://rest.fal.ai/.well-known/jwks.json';
let jwksCache: { keys: CryptoKey[]; at: number } | null = null;

async function falKeys(): Promise<CryptoKey[]> {
  if (jwksCache && Date.now() - jwksCache.at < 12 * 3600_000) return jwksCache.keys;
  const res = await fetch(JWKS_URL);
  const { keys = [] } = (await res.json()) as { keys?: { x?: string }[] };
  const out: CryptoKey[] = [];
  for (const k of keys) {
    if (typeof k.x !== 'string') continue;
    const raw = b64urlDecode(k.x);
    out.push(await crypto.subtle.importKey('raw', raw, { name: 'Ed25519' }, false, ['verify']));
  }
  jwksCache = { keys: out, at: Date.now() };
  return out;
}

/** ED25519 verification as documented by fal.ai (request id, user id, timestamp, sha256(body) joined by newlines). */
export async function verifyFalWebhook(headers: Headers, rawBody: ArrayBuffer, nowSec = Date.now() / 1000): Promise<boolean> {
  const reqId = headers.get('x-fal-webhook-request-id');
  const userId = headers.get('x-fal-webhook-user-id');
  const ts = headers.get('x-fal-webhook-timestamp');
  const sigHex = headers.get('x-fal-webhook-signature');
  if (!reqId || !userId || !ts || !sigHex) return false;
  if (!/^\d+$/.test(ts) || Math.abs(nowSec - Number(ts)) > 300) return false;
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', rawBody));
  const bodyHash = [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
  const message = new TextEncoder().encode([reqId, userId, ts, bodyHash].join('\n'));
  const sig = hexDecode(sigHex);
  if (!sig) return false;
  for (const key of await falKeys()) {
    if (await crypto.subtle.verify({ name: 'Ed25519' }, key, sig, message)) return true;
  }
  return false;
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
function hexDecode(hex: string): Uint8Array | null {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Pulls the media URL out of a fal.ai result for each job kind. */
export function resultUrl(kind: string, payload: unknown): { url: string; thumbnail?: string } | null {
  const p = payload as Record<string, any> | null;
  if (!p) return null;
  if (kind === 'video') return p.video?.url ? { url: p.video.url } : null;
  if (kind === 'music' || kind === 'sfx' || kind === 'voice') return p.audio?.url ? { url: p.audio.url } : null;
  if (kind === 'render') return p.video_url ? { url: p.video_url, thumbnail: p.thumbnail_url } : null;
  return null;
}
