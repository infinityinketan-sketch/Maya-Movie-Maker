import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizePlan, planPrompt, type FilmPlan } from '../src/providers/anthropic';
import { resultUrl, verifyFalWebhook } from '../src/providers/fal';
import { renderTracks, videoPrompt } from '../src/worker';

describe('plan normalisation', () => {
  it('snaps durations, trims fields and drops empty shots', () => {
    const raw = {
      title: '  Chai at Dawn ',
      logline: 'x',
      synopsis: 'y',
      music_prompt: '',
      characters: [{ name: 'Asha', description: 'woman, 30' }, { name: '', description: 'nameless' }],
      scenes: [
        { heading: 'EXT. ROOF - DAWN', summary: 's', shots: [{ duration_sec: 7, camera: 'wide', action: 'Asha pours chai' }, { duration_sec: 4, camera: '', action: '' }] },
        { heading: 'EMPTY', summary: '', shots: [] },
      ],
    } as unknown as FilmPlan;
    const plan = normalizePlan(raw);
    expect(plan.title).toBe('Chai at Dawn');
    expect(plan.characters).toHaveLength(1);
    expect(plan.scenes).toHaveLength(1);
    expect(plan.scenes[0].shots).toHaveLength(1);
    expect(plan.scenes[0].shots[0].duration_sec).toBe(6);
    expect(plan.music_prompt.length).toBeGreaterThan(0);
  });

  it('rejects a plan with no shots', () => {
    expect(() => normalizePlan({ scenes: [] } as unknown as FilmPlan)).toThrow();
  });

  it('asks for the right shot count and language', () => {
    const prompt = planPrompt({ idea: 'A kite festival in Ahmedabad', genre: 'drama', language: 'Hindi', style: null, aspectRatio: '9:16', targetSec: 60 });
    expect(prompt).toContain('about 10 shots');
    expect(prompt).toContain('Dialogue language: Hindi');
    expect(prompt).toContain('vertical 9:16');
  });
});

describe('video + render', () => {
  it('puts dialogue, speaker and language in the video prompt', () => {
    const p = videoPrompt({ language: 'Hindi', style: null }, { camera: 'close-up', action: 'Asha smiles', dialogue: 'Chalo!', speaker: 'Asha' }, 'warm voice');
    expect(p).toContain('Asha says in Hindi: "Chalo!"');
    expect(p).toContain('warm voice');
    expect(p).toContain('No background music');
  });

  it('lays shots back to back and loops music to the film length', () => {
    const { tracks, totalMs } = renderTracks(
      [
        { video_url: 'a.mp4', duration_sec: 8 },
        { video_url: 'b.mp4', duration_sec: 6 },
        { video_url: 'c.mp4', duration_sec: 8 },
        { video_url: 'd.mp4', duration_sec: 8 },
        { video_url: 'e.mp4', duration_sec: 8 },
      ],
      'm.wav',
    );
    expect(totalMs).toBe(38000);
    expect(tracks[0].keyframes.map((k) => k.timestamp)).toEqual([0, 8000, 14000, 22000, 30000]);
    expect(tracks[1].keyframes).toEqual([
      { url: 'm.wav', timestamp: 0, duration: 30000 },
      { url: 'm.wav', timestamp: 30000, duration: 8000 },
    ]);
  });

  it('renders without music when none was made', () => {
    expect(renderTracks([{ video_url: 'a.mp4', duration_sec: 4 }], null).tracks).toHaveLength(1);
  });

  it('extracts media URLs from fal results', () => {
    expect(resultUrl('video', { video: { url: 'v' } })).toEqual({ url: 'v' });
    expect(resultUrl('music', { audio: { url: 'm' } })).toEqual({ url: 'm' });
    expect(resultUrl('render', { video_url: 'f', thumbnail_url: 't' })).toEqual({ url: 'f', thumbnail: 't' });
    expect(resultUrl('video', {})).toBeNull();
  });
});

describe('fal webhook signature', () => {
  afterEach(() => vi.unstubAllGlobals());

  async function setup() {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
    const raw = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
    const x = btoa(String.fromCharCode(...raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ keys: [{ x }] }))));
    return pair;
  }

  async function sign(pair: CryptoKeyPair, body: string, ts: number) {
    const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body)));
    const hex = [...hash].map((b) => b.toString(16).padStart(2, '0')).join('');
    const msg = new TextEncoder().encode(['req-1', 'user-1', String(ts), hex].join('\n'));
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'Ed25519' }, pair.privateKey, msg));
    return new Headers({
      'x-fal-webhook-request-id': 'req-1',
      'x-fal-webhook-user-id': 'user-1',
      'x-fal-webhook-timestamp': String(ts),
      'x-fal-webhook-signature': [...sig].map((b) => b.toString(16).padStart(2, '0')).join(''),
    });
  }

  it('accepts a valid signature and rejects tampering or old timestamps', async () => {
    const pair = await setup();
    const now = Math.floor(Date.now() / 1000);
    const body = '{"request_id":"req-1","status":"OK"}';
    const headers = await sign(pair, body, now);
    const buf = new TextEncoder().encode(body).buffer as ArrayBuffer;
    expect(await verifyFalWebhook(headers, buf, now)).toBe(true);
    expect(await verifyFalWebhook(headers, new TextEncoder().encode(body + ' ').buffer as ArrayBuffer, now)).toBe(false);
    expect(await verifyFalWebhook(headers, buf, now + 1000)).toBe(false);
    expect(await verifyFalWebhook(new Headers(), buf, now)).toBe(false);
  });
});
