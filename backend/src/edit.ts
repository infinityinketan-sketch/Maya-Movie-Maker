// The manual editor's edit list: which clips play in what order (with trims and volume), and which
// sounds are laid over them (music, voice-over, sound effects, uploads) with start time, trim,
// volume and fades. The app sends it; the server only accepts media that belongs to the film.
import { HttpError } from './env';
import { inspectMp4 } from './reliability';

export interface EditClip {
  id: string;
  shotId?: string;
  /** Set when the user picked a specific take; otherwise a shot's clip follows its newest take. */
  pinned?: boolean;
  url: string;
  label: string;
  in: number;
  out: number;
  volume: number; // 0 = mute, 1 = as filmed, 2 = double
}

export type AudioKind = 'music' | 'voice' | 'sfx' | 'upload';

export interface EditAudio {
  id: string;
  kind: AudioKind;
  url: string;
  label: string;
  start: number; // seconds into the film
  in: number;
  out: number;
  volume: number;
  fadeIn: number;
  fadeOut: number;
  loop: boolean;
}

export interface Edit {
  version: 1;
  clips: EditClip[];
  audio: EditAudio[];
}

/** A piece of media the film may use. */
export interface MediaItem {
  url: string;
  type: 'video' | 'audio';
  label: string;
  seconds: number;
  shotId?: string;
  assetId?: string;
  audioKind?: AudioKind;
}

export const MAX_CLIPS = 200;
export const MAX_AUDIO = 50;
export const MAX_FILM_SEC = 600;
export const DEFAULT_MUSIC_VOLUME = 0.35; // quiet enough to keep dialogue clear
const MUSIC_SECONDS = 30; // Lyria 2 makes ~30 s; it is looped

interface ShotLike {
  id: string;
  idx: number;
  video_url: string | null;
  prev_video_url?: string | null;
  duration_sec: number;
}
interface AssetLike {
  id: string;
  kind: 'sfx' | 'voice' | 'upload_audio' | 'upload_video';
  label: string;
  url: string | null;
  duration_sec: number | string | null;
  status: string;
}

/** Everything this film's edit may use: each shot's newest and previous take, the score, and the user's sounds/clips. */
export function projectMedia(shots: ShotLike[], musicUrl: string | null, assets: AssetLike[]): MediaItem[] {
  const out: MediaItem[] = [];
  for (const s of [...shots].sort((a, b) => a.idx - b.idx)) {
    if (s.video_url) out.push({ url: s.video_url, type: 'video', label: `Shot ${s.idx + 1}`, seconds: s.duration_sec, shotId: s.id });
    if (s.prev_video_url) out.push({ url: s.prev_video_url, type: 'video', label: `Shot ${s.idx + 1} · previous take`, seconds: s.duration_sec, shotId: s.id });
  }
  if (musicUrl) out.push({ url: musicUrl, type: 'audio', label: 'Music score', seconds: MUSIC_SECONDS, audioKind: 'music' });
  for (const a of assets) {
    if (a.status !== 'done' || !a.url) continue;
    const seconds = Number(a.duration_sec) || 1;
    if (a.kind === 'upload_video') out.push({ url: a.url, type: 'video', label: a.label || 'My clip', seconds, assetId: a.id });
    else out.push({ url: a.url, type: 'audio', label: a.label, seconds, assetId: a.id, audioKind: a.kind === 'upload_audio' ? 'upload' : a.kind });
  }
  return out;
}

let counter = 0;
const newId = (p: string) => `${p}${Date.now().toString(36)}${(counter++).toString(36)}`;

/** The cut Maya makes on its own: every shot in order, the score looped quietly underneath. */
export function defaultEdit(shots: ShotLike[], musicUrl: string | null): Edit {
  const clips = [...shots]
    .sort((a, b) => a.idx - b.idx)
    .filter((s) => s.video_url)
    .map((s) => ({ id: `c-${s.id}`, shotId: s.id, url: s.video_url!, label: `Shot ${s.idx + 1}`, in: 0, out: s.duration_sec, volume: 1 }));
  const audio: EditAudio[] = musicUrl
    ? [{ id: 'a-music', kind: 'music', url: musicUrl, label: 'Music score', start: 0, in: 0, out: MUSIC_SECONDS, volume: DEFAULT_MUSIC_VOLUME, fadeIn: 1, fadeOut: 2, loop: true }]
    : [];
  return { version: 1, clips, audio };
}

const r2 = (x: number) => Math.round(x * 100) / 100;
function num(x: unknown, lo: number, hi: number, fallback: number): number {
  const v = typeof x === 'number' && Number.isFinite(x) ? x : fallback;
  return r2(Math.min(hi, Math.max(lo, v)));
}
const text = (x: unknown, fallback: string) => (typeof x === 'string' && x.trim() ? x.trim().slice(0, 60) : fallback);

/**
 * Cleans an edit list from the app. Media must belong to this film (a clip whose take was replaced
 * moves to the shot's newest take); numbers are clamped; anything unusable is dropped.
 */
export function normalizeEdit(raw: unknown, media: MediaItem[]): Edit {
  const r = (raw ?? {}) as { clips?: unknown; audio?: unknown };
  if (!Array.isArray(r.clips) || !Array.isArray(r.audio)) throw new HttpError(400, 'bad_edit', 'The edit must have clips and audio lists.');
  if (r.clips.length > MAX_CLIPS) throw new HttpError(400, 'bad_edit', `At most ${MAX_CLIPS} clips.`);
  if (r.audio.length > MAX_AUDIO) throw new HttpError(400, 'bad_edit', `At most ${MAX_AUDIO} sounds.`);
  const byUrl = new Map(media.map((m) => [m.url, m]));
  const newestTake = new Map<string, MediaItem>();
  for (const m of media) if (m.shotId && !newestTake.has(m.shotId)) newestTake.set(m.shotId, m); // first listed = newest

  const clips: EditClip[] = [];
  for (const c of r.clips as Record<string, unknown>[]) {
    let m = typeof c?.url === 'string' ? byUrl.get(c.url) : undefined;
    const pinned = c?.pinned === true && m?.type === 'video';
    if (!pinned && typeof c?.shotId === 'string' && newestTake.has(c.shotId)) m = newestTake.get(c.shotId);
    if (!m || m.type !== 'video') continue;
    const len = m.seconds;
    const inn = num(c.in, 0, Math.max(0, len - 0.5), 0);
    const out = num(c.out, inn + 0.5, len, len);
    clips.push({
      id: text(c.id, newId('c')),
      ...(m.shotId ? { shotId: m.shotId } : {}),
      ...(pinned ? { pinned: true } : {}),
      url: m.url,
      label: text(c.label, m.label),
      in: inn,
      out,
      volume: num(c.volume, 0, 2, 1),
    });
  }

  const audio: EditAudio[] = [];
  for (const a of r.audio as Record<string, unknown>[]) {
    let m = typeof a?.url === 'string' ? byUrl.get(a.url) : undefined;
    // A re-composed score replaces the old one: keep the music layer on the new score.
    if (!m && a?.kind === 'music') m = media.find((x) => x.audioKind === 'music');
    if (!m || m.type !== 'audio') continue;
    const len = m.seconds;
    const inn = num(a.in, 0, Math.max(0, len - 0.2), 0);
    audio.push({
      id: text(a.id, newId('a')),
      kind: m.audioKind ?? 'upload',
      url: m.url,
      label: text(a.label, m.label),
      start: num(a.start, 0, MAX_FILM_SEC, 0),
      in: inn,
      out: num(a.out, inn + 0.2, len, len),
      volume: num(a.volume, 0, 2, 1),
      fadeIn: num(a.fadeIn, 0, 10, 0),
      fadeOut: num(a.fadeOut, 0, 10, 0),
      loop: a.loop === true,
    });
  }
  const edit: Edit = { version: 1, clips, audio };
  if (editLength(edit) > MAX_FILM_SEC) throw new HttpError(400, 'too_long', `The cut can be at most ${MAX_FILM_SEC / 60} minutes.`);
  return edit;
}

export function editLength(edit: Pick<Edit, 'clips'>): number {
  return r2(edit.clips.reduce((s, c) => s + (c.out - c.in), 0));
}

/**
 * True when fal.ai's simple joiner can make this cut (no mixing server needed): whole clips at
 * normal volume, and at most the score looped from the start. fal.ai cannot trim or set volumes.
 */
export function isSimpleEdit(edit: Edit, media: MediaItem[]): boolean {
  const len = new Map(media.map((m) => [m.url, m.seconds]));
  const clipsWhole = edit.clips.every((c) => c.in === 0 && c.out === len.get(c.url) && c.volume === 1);
  const audioSimple =
    edit.audio.length === 0 ||
    (edit.audio.length === 1 && edit.audio[0].kind === 'music' && edit.audio[0].start === 0 && edit.audio[0].in === 0 && edit.audio[0].loop);
  return clipsWhole && audioSimple;
}

/** fal.ai FFmpeg compose timeline for a simple edit (see isSimpleEdit). */
export function falTracks(edit: Edit) {
  let t = 0;
  const video = edit.clips.map((c) => {
    const k = { url: c.url, timestamp: t, duration: Math.round((c.out - c.in) * 1000) };
    t += k.duration;
    return k;
  });
  const tracks: { id: string; type: 'video' | 'audio'; keyframes: { url: string; timestamp: number; duration: number }[] }[] = [
    { id: 'shots', type: 'video', keyframes: video },
  ];
  const music = edit.audio[0];
  if (music) {
    const loopMs = Math.round((music.out - music.in) * 1000);
    const keys = [];
    for (let m = 0; m < t; m += loopMs) keys.push({ url: music.url, timestamp: m, duration: Math.min(loopMs, t - m) });
    tracks.push({ id: 'music', type: 'audio', keyframes: keys });
  }
  return { tracks, totalMs: t };
}

/** What the mixing server is sent. */
export function renderJobBody(edit: Edit, aspectRatio: '16:9' | '9:16', outputKey: string, thumbKey: string) {
  return {
    aspectRatio,
    outputKey,
    thumbKey,
    clips: edit.clips.map((c) => ({ url: c.url, in: c.in, out: c.out, volume: c.volume })),
    audio: edit.audio.map((a) => ({ url: a.url, start: a.start, in: a.in, out: a.out, volume: a.volume, fadeIn: a.fadeIn, fadeOut: a.fadeOut, loop: a.loop })),
  };
}

// ---------------------------------------------------------------- uploaded sound files

export const AUDIO_TYPES: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
};

const MP3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]; // MPEG-1 Layer III
const MP3_KBPS_V2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]; // MPEG-2/2.5 Layer III

/** Length of an MP3 / M4A / WAV file in seconds, or null if it is not one of those. MP3 assumes a constant bitrate. */
export function audioSeconds(bytes: Uint8Array, ext: string): number | null {
  if (ext === 'm4a') {
    const info = inspectMp4(bytes);
    return info && info.hasAudio && info.durationSec ? info.durationSec : null;
  }
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (ext === 'wav') {
    if (bytes.byteLength < 44 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'RIFF' || String.fromCharCode(...bytes.subarray(8, 12)) !== 'WAVE') return null;
    let p = 12;
    let byteRate = 0;
    while (p + 8 <= bytes.byteLength) {
      const id = String.fromCharCode(...bytes.subarray(p, p + 4));
      const size = v.getUint32(p + 4, true);
      if (id === 'fmt ') byteRate = v.getUint32(p + 16, true);
      if (id === 'data' && byteRate > 0) return Math.min(size, bytes.byteLength - p - 8) / byteRate;
      p += 8 + size + (size % 2);
    }
    return null;
  }
  if (ext === 'mp3') {
    let p = 0;
    if (bytes.byteLength > 10 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
      p = 10 + (((bytes[6] & 0x7f) << 21) | ((bytes[7] & 0x7f) << 14) | ((bytes[8] & 0x7f) << 7) | (bytes[9] & 0x7f)); // skip ID3v2
    }
    const end = Math.min(bytes.byteLength - 4, p + 64 * 1024);
    for (; p < end; p++) {
      if (bytes[p] !== 0xff || (bytes[p + 1] & 0xe0) !== 0xe0) continue;
      const version = (bytes[p + 1] >> 3) & 3; // 3 = MPEG-1
      const layer = (bytes[p + 1] >> 1) & 3; // 1 = Layer III
      const idx = bytes[p + 2] >> 4;
      if (layer !== 1 || version === 1 || idx === 0 || idx === 15) continue;
      const kbps = (version === 3 ? MP3_KBPS : MP3_KBPS_V2)[idx];
      return ((bytes.byteLength - p) * 8) / (kbps * 1000);
    }
    return null;
  }
  return null;
}
