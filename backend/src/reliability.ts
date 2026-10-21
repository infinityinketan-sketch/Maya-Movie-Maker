// Busy providers, lost results and broken outputs.
//  - Busy/overloaded/timeouts → ProviderBusyError → the job is retried after 10 s, 30 s, 90 s (credits stay held).
//  - Any other provider error → the job fails and credits are refunded (no paid retry loops).
//  - Every media result is checked (type, size, length, sound, frame shape) before it is accepted.

export class ProviderBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderBusyError';
  }
}

/** HTTP statuses that mean "try again later", not "your request is wrong". */
export const BUSY_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 520, 521, 522, 523, 524, 529]);

export const RETRY_DELAYS_SEC = [10, 30, 90];

export function retryDelay(attempt: number): number | null {
  return attempt < RETRY_DELAYS_SEC.length ? RETRY_DELAYS_SEC[attempt] : null;
}

/** fetch with a timeout; network failures and busy statuses become ProviderBusyError. */
export async function providerFetch(name: string, url: string, init: RequestInit, timeoutMs = 120_000): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new ProviderBusyError(`${name} did not respond (${e instanceof Error ? e.name : 'network error'})`);
  }
  if (BUSY_STATUSES.has(res.status)) {
    const detail = (await res.text().catch(() => '')).slice(0, 200);
    throw new ProviderBusyError(`${name} is busy (${res.status}) ${detail}`.trim());
  }
  return res;
}

/** For work done inside a request (AI Director): a couple of quick retries on busy errors. */
export async function withQuickRetries<T>(fn: () => Promise<T>, delaysMs = [1000, 3000]): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ProviderBusyError) || i >= delaysMs.length) throw e;
      await new Promise((r) => setTimeout(r, delaysMs[i]));
    }
  }
}

// ---------------------------------------------------------------- MP4 inspection

export interface Mp4Info {
  durationSec: number | null; // null when the file does not state it (fragmented MP4)
  width: number | null;
  height: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
}

interface Box {
  type: string;
  start: number; // payload start
  end: number;
}

function readBoxes(v: DataView, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = v.getUint32(p);
    const type = String.fromCharCode(v.getUint8(p + 4), v.getUint8(p + 5), v.getUint8(p + 6), v.getUint8(p + 7));
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) break;
      size = Number(v.getBigUint64(p + 8));
      header = 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < header || p + size > end) break;
    out.push({ type, start: p + header, end: p + size });
    p += size;
  }
  return out;
}

/** Reads duration, frame size and track kinds from an MP4 without decoding it. Returns null if it is not an MP4. */
export function inspectMp4(bytes: Uint8Array): Mp4Info | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const top = readBoxes(v, 0, bytes.byteLength);
  if (!top.some((b) => b.type === 'ftyp')) return null;
  const moov = top.find((b) => b.type === 'moov');
  const info: Mp4Info = { durationSec: null, width: null, height: null, hasVideo: false, hasAudio: false };
  if (!moov) return info;
  for (const b of readBoxes(v, moov.start, moov.end)) {
    if (b.type === 'mvhd') {
      const version = v.getUint8(b.start);
      const timescale = version === 1 ? v.getUint32(b.start + 20) : v.getUint32(b.start + 12);
      const duration = version === 1 ? Number(v.getBigUint64(b.start + 24)) : v.getUint32(b.start + 16);
      if (timescale > 0 && duration > 0) info.durationSec = duration / timescale;
    }
    if (b.type === 'trak') {
      const kids = readBoxes(v, b.start, b.end);
      const tkhd = kids.find((k) => k.type === 'tkhd');
      const mdia = kids.find((k) => k.type === 'mdia');
      const hdlr = mdia ? readBoxes(v, mdia.start, mdia.end).find((k) => k.type === 'hdlr') : undefined;
      const handler = hdlr && hdlr.start + 12 <= hdlr.end ? String.fromCharCode(...bytes.subarray(hdlr.start + 8, hdlr.start + 12)) : '';
      if (handler === 'soun') info.hasAudio = true;
      if (handler === 'vide') {
        info.hasVideo = true;
        if (tkhd && tkhd.end - tkhd.start >= 8) {
          info.width = v.getUint32(tkhd.end - 8) >>> 16;
          info.height = v.getUint32(tkhd.end - 4) >>> 16;
        }
      }
    }
  }
  return info;
}

// ---------------------------------------------------------------- your own clips

/** Shot length for an uploaded clip: the longest of 4/6/8 s that the clip covers (longer clips are trimmed). */
export function shotLengthForClip(clipSec: number): 4 | 6 | 8 | null {
  if (clipSec >= 8) return 8;
  if (clipSec >= 6) return 6;
  if (clipSec >= 4) return 4;
  return null;
}

/** Checks a clip the user made elsewhere (e.g. Google Flow). Returns the problem, or the shot length to use. */
export function checkOwnClip(bytes: Uint8Array, aspectRatio: '16:9' | '9:16'): { problem: string } | { seconds: 4 | 6 | 8; hasAudio: boolean } {
  const info = inspectMp4(bytes);
  if (!info || !info.hasVideo) return { problem: 'That file is not a playable MP4 video. Export or download it as MP4 and try again.' };
  if (info.width && info.height && info.height > info.width !== (aspectRatio === '9:16')) {
    return { problem: `The clip is ${info.width}×${info.height}, but this film is ${aspectRatio === '9:16' ? 'vertical (9:16)' : 'wide (16:9)'}. Make the clip in the same shape.` };
  }
  const seconds = shotLengthForClip(info.durationSec ?? 8);
  if (!seconds) return { problem: 'The clip must be at least 4 seconds long.' };
  return { seconds, hasAudio: info.hasAudio };
}

// ---------------------------------------------------------------- result checks

export interface MediaExpectation {
  kind: 'video' | 'render' | 'music' | 'image';
  seconds?: number; // expected length
  aspectRatio?: '16:9' | '9:16';
  needsAudio?: boolean;
}

const MIN_BYTES: Record<MediaExpectation['kind'], number> = { video: 100_000, render: 200_000, music: 100_000, image: 20_000 };

/** Returns why a result is unusable, or null when it passes. */
export function checkMedia(bytes: Uint8Array, contentType: string, exp: MediaExpectation): string | null {
  if (bytes.byteLength < MIN_BYTES[exp.kind]) return `the file is too small (${Math.round(bytes.byteLength / 1024)} KB)`;
  if (exp.kind === 'image') return /^image\//.test(contentType) ? null : `expected an image, got ${contentType || 'unknown type'}`;
  if (exp.kind === 'music') return /^audio\//.test(contentType) || contentType === 'application/octet-stream' ? null : `expected audio, got ${contentType}`;

  const mp4 = inspectMp4(bytes);
  if (!mp4) return 'the file is not a playable MP4 video';
  if (!mp4.hasVideo) return 'the file has no picture';
  if (exp.needsAudio && !mp4.hasAudio) return 'the video has no sound';
  if (exp.seconds && mp4.durationSec !== null) {
    const tolerance = exp.kind === 'render' ? 2 : 1.5;
    if (mp4.durationSec < exp.seconds - tolerance) return `the video is only ${mp4.durationSec.toFixed(1)} s long (expected ${exp.seconds} s)`;
  }
  if (exp.aspectRatio && mp4.width && mp4.height) {
    const portrait = mp4.height > mp4.width;
    if (portrait !== (exp.aspectRatio === '9:16')) return `the video came out ${mp4.width}×${mp4.height}, not ${exp.aspectRatio}`;
  }
  return null;
}
