import type { Env } from '../env';

/** Verifies a Google Play one-time (consumable) purchase with the Play Developer API. */
export interface PlayProductPurchase {
  purchaseState?: number; // 0 purchased, 1 cancelled, 2 pending
  consumptionState?: number; // 0 not consumed, 1 consumed
  orderId?: string;
  obfuscatedExternalAccountId?: string;
  purchaseTimeMillis?: string;
  regionCode?: string;
}

let tokenCache: { token: string; exp: number } | null = null;

async function accessToken(env: Env): Promise<string> {
  if (tokenCache && tokenCache.exp > Date.now() + 60_000) return tokenCache.token;
  const sa = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const enc = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })}`;
  const pem = sa.private_key.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${b64url(sig)}` }),
  });
  const body = (await res.json()) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!body.access_token) throw new Error(`Google auth failed: ${body.error_description ?? res.status}`);
  tokenCache = { token: body.access_token, exp: Date.now() + (body.expires_in ?? 3600) * 1000 };
  return body.access_token;
}

export async function getProductPurchase(env: Env, productId: string, purchaseToken: string): Promise<PlayProductPurchase> {
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(env.GOOGLE_PLAY_PACKAGE)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${await accessToken(env)}` } });
  const body = (await res.json()) as PlayProductPurchase & { error?: { message: string } };
  if (!res.ok) throw new Error(`Play verification failed (${res.status}): ${body.error?.message ?? 'unknown'}`);
  return body;
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
