import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkMedia, inspectMp4, providerFetch, ProviderBusyError, retryDelay, withQuickRetries } from '../src/reliability';

// ---- tiny MP4 builder: just the boxes inspectMp4 reads
function box(type: string, ...parts: Uint8Array[]): Uint8Array {
  const len = 8 + parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  new DataView(out.buffer).setUint32(0, len);
  out.set(new TextEncoder().encode(type), 4);
  let o = 8;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
function u32s(...xs: number[]): Uint8Array {
  const b = new Uint8Array(xs.length * 4);
  xs.forEach((x, i) => new DataView(b.buffer).setUint32(i * 4, x));
  return b;
}
function mvhd(timescale: number, duration: number) {
  return box('mvhd', u32s(0, 0, 0, timescale, duration), new Uint8Array(80));
}
function track(handler: 'vide' | 'soun', w = 0, h = 0) {
  const tkhd = box('tkhd', new Uint8Array(76), u32s(w << 16, h << 16));
  const hdlr = box('hdlr', u32s(0, 0), new TextEncoder().encode(handler), new Uint8Array(12));
  return box('trak', tkhd, box('mdia', hdlr));
}
function mp4(opts: { seconds: number; w: number; h: number; audio: boolean; pad?: number }) {
  const parts = [mvhd(1000, Math.round(opts.seconds * 1000)), track('vide', opts.w, opts.h)];
  if (opts.audio) parts.push(track('soun'));
  return concat(box('ftyp', new TextEncoder().encode('isom'), u32s(0)), box('mdat', new Uint8Array(opts.pad ?? 200_000)), box('moov', ...parts));
}
function concat(...xs: Uint8Array[]) {
  const out = new Uint8Array(xs.reduce((n, x) => n + x.length, 0));
  let o = 0;
  for (const x of xs) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

describe('MP4 inspection', () => {
  it('reads length, frame size and tracks (moov after mdat, like most generated files)', () => {
    const info = inspectMp4(mp4({ seconds: 8, w: 1080, h: 1920, audio: true }));
    expect(info).toEqual({ durationSec: 8, width: 1080, height: 1920, hasVideo: true, hasAudio: true });
  });
  it('rejects files that are not MP4', () => {
    expect(inspectMp4(new Uint8Array(500))).toBeNull();
    expect(inspectMp4(new TextEncoder().encode('<html>error</html>'.padEnd(400, ' ')))).toBeNull();
  });
});

describe('result checks', () => {
  const video = { kind: 'video' as const, seconds: 8, aspectRatio: '9:16' as const, needsAudio: true };
  it('accepts a good clip', () => {
    expect(checkMedia(mp4({ seconds: 8, w: 1080, h: 1920, audio: true }), 'video/mp4', video)).toBeNull();
  });
  it('rejects silent, short, wrong-shape, tiny or non-video results', () => {
    expect(checkMedia(mp4({ seconds: 8, w: 1080, h: 1920, audio: false }), 'video/mp4', video)).toContain('no sound');
    expect(checkMedia(mp4({ seconds: 3, w: 1080, h: 1920, audio: true }), 'video/mp4', video)).toContain('only 3.0 s');
    expect(checkMedia(mp4({ seconds: 8, w: 1920, h: 1080, audio: true }), 'video/mp4', video)).toContain('not 9:16');
    expect(checkMedia(mp4({ seconds: 8, w: 1080, h: 1920, audio: true, pad: 10 }), 'video/mp4', video)).toContain('too small');
    expect(checkMedia(new Uint8Array(300_000), 'text/html', video)).toContain('not a playable MP4');
  });
  it('checks pictures and music by type and size', () => {
    expect(checkMedia(new Uint8Array(50_000), 'image/png', { kind: 'image' })).toBeNull();
    expect(checkMedia(new Uint8Array(5_000), 'image/png', { kind: 'image' })).toContain('too small');
    expect(checkMedia(new Uint8Array(500_000), 'text/plain', { kind: 'music' })).toContain('expected audio');
    expect(checkMedia(new Uint8Array(500_000), 'audio/wav', { kind: 'music' })).toBeNull();
  });
  it('allows the final cut a little slack on length', () => {
    expect(checkMedia(mp4({ seconds: 29, w: 1080, h: 1920, audio: true }), 'video/mp4', { kind: 'render', seconds: 30, aspectRatio: '9:16', needsAudio: true })).toBeNull();
    expect(checkMedia(mp4({ seconds: 20, w: 1080, h: 1920, audio: true }), 'video/mp4', { kind: 'render', seconds: 30 })).toContain('only 20.0 s');
  });
});

describe('busy providers', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('retries after 10, 30, 90 seconds, then gives up', () => {
    expect([0, 1, 2, 3].map(retryDelay)).toEqual([10, 30, 90, null]);
  });

  it('turns busy statuses and network failures into ProviderBusyError, but not real errors', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('overloaded', { status: 529 })));
    await expect(providerFetch('Claude', 'https://x', {})).rejects.toBeInstanceOf(ProviderBusyError);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limit', { status: 429 })));
    await expect(providerFetch('fal.ai', 'https://x', {})).rejects.toBeInstanceOf(ProviderBusyError);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    await expect(providerFetch('Gemini', 'https://x', {})).rejects.toBeInstanceOf(ProviderBusyError);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"bad prompt"}', { status: 400 })));
    expect((await providerFetch('Gemini', 'https://x', {})).status).toBe(400);
  });

  it('quick retries recover from a short busy spell and pass real errors through', async () => {
    let n = 0;
    const flaky = async () => {
      if (n++ < 2) throw new ProviderBusyError('busy');
      return 'ok';
    };
    expect(await withQuickRetries(flaky, [1, 1])).toBe('ok');
    await expect(withQuickRetries(async () => { throw new Error('bad request'); }, [1])).rejects.toThrow('bad request');
    await expect(withQuickRetries(async () => { throw new ProviderBusyError('still busy'); }, [1])).rejects.toBeInstanceOf(ProviderBusyError);
  });
});
