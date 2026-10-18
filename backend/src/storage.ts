import type { Env } from './env';

/** Media lives in R2 under u/<user>/<project>/..., served from a public bucket domain with unguessable keys. */
export function mediaKey(userId: string, projectId: string, kind: string, id: string, ext: string): string {
  const stamp = Date.now().toString(36);
  const rand = crypto.randomUUID().slice(0, 8);
  return `u/${userId}/${projectId}/${kind}/${id}-${stamp}${rand}.${ext}`;
}

export function publicUrl(env: Env, key: string): string {
  return `${env.MEDIA_PUBLIC_BASE.replace(/\/$/, '')}/${key}`;
}

export function keyFromUrl(env: Env, url: string): string | null {
  const base = env.MEDIA_PUBLIC_BASE.replace(/\/$/, '') + '/';
  return url.startsWith(base) ? url.slice(base.length) : null;
}

export async function putBytes(env: Env, key: string, bytes: ArrayBuffer | Uint8Array, contentType: string): Promise<string> {
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' } });
  return publicUrl(env, key);
}

/** Copies a provider result (fal.ai CDN URLs expire) into our bucket. */
export async function copyFromUrl(env: Env, sourceUrl: string, key: string, fallbackType: string): Promise<string> {
  const res = await fetch(sourceUrl);
  if (!res.ok || !res.body) throw new Error(`download failed (${res.status}) for ${sourceUrl}`);
  const type = res.headers.get('content-type') || fallbackType;
  const len = res.headers.get('content-length');
  if (len) {
    await env.MEDIA.put(key, res.body, { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
  } else {
    await env.MEDIA.put(key, await res.arrayBuffer(), { httpMetadata: { contentType: type, cacheControl: 'public, max-age=31536000, immutable' } });
  }
  return publicUrl(env, key);
}

export async function readAsBase64(env: Env, url: string): Promise<{ mimeType: string; data: string } | null> {
  const key = keyFromUrl(env, url);
  if (!key) return null;
  const obj = await env.MEDIA.get(key);
  if (!obj) return null;
  const buf = new Uint8Array(await obj.arrayBuffer());
  return { mimeType: obj.httpMetadata?.contentType || 'image/png', data: toBase64(buf) };
}

export async function deletePrefix(env: Env, prefix: string): Promise<number> {
  let cursor: string | undefined;
  let n = 0;
  do {
    const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    const keys = page.objects.map((o) => o.key);
    if (keys.length) await env.MEDIA.delete(keys);
    n += keys.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return n;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
