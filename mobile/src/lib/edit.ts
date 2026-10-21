import type { Edit, EditAudio, EditClip, MediaItem } from './types';

// Small, pure helpers for the editor screen. The server re-checks everything on save.

const r2 = (x: number) => Math.round(x * 100) / 100;
export const clamp = (x: number, lo: number, hi: number) => r2(Math.min(hi, Math.max(lo, x)));
const uid = (p: string) => `${p}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function filmLength(edit: Edit): number {
  return r2(edit.clips.reduce((s, c) => s + (c.out - c.in), 0));
}

/** Where each clip starts in the finished film. */
export function clipStarts(edit: Edit): number[] {
  let t = 0;
  return edit.clips.map((c) => {
    const at = t;
    t += c.out - c.in;
    return r2(at);
  });
}

export function secs(x: number): string {
  if (x < 60) return `${r2(x)} s`;
  const m = Math.floor(x / 60);
  const s = Math.round(x - m * 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function sourceLength(media: MediaItem[], url: string, fallback: number): number {
  return media.find((m) => m.url === url)?.seconds ?? fallback;
}

export function moveClip(edit: Edit, i: number, by: -1 | 1): Edit {
  const j = i + by;
  if (j < 0 || j >= edit.clips.length) return edit;
  const clips = [...edit.clips];
  [clips[i], clips[j]] = [clips[j], clips[i]];
  return { ...edit, clips };
}

export function updateClip(edit: Edit, i: number, patch: Partial<EditClip>): Edit {
  return { ...edit, clips: edit.clips.map((c, k) => (k === i ? { ...c, ...patch } : c)) };
}

export function removeClip(edit: Edit, i: number): Edit {
  return { ...edit, clips: edit.clips.filter((_, k) => k !== i) };
}

export function duplicateClip(edit: Edit, i: number): Edit {
  const clips = [...edit.clips];
  clips.splice(i + 1, 0, { ...edit.clips[i], id: uid('c') });
  return { ...edit, clips };
}

/** Moves a clip's start (which = 'in') or end (which = 'out') by `by` seconds, keeping at least 0.5 s. */
export function trimClip(edit: Edit, i: number, which: 'in' | 'out', by: number, sourceSec: number): Edit {
  const c = edit.clips[i];
  if (which === 'in') return updateClip(edit, i, { in: clamp(c.in + by, 0, c.out - 0.5) });
  return updateClip(edit, i, { out: clamp(c.out + by, c.in + 0.5, sourceSec) });
}

export function addClip(edit: Edit, m: MediaItem, at = edit.clips.length): Edit {
  const clip: EditClip = {
    id: uid('c'),
    ...(m.shotId ? { shotId: m.shotId } : {}),
    ...(m.shotId && m.label.includes('previous') ? { pinned: true } : {}),
    url: m.url,
    label: m.label,
    in: 0,
    out: m.seconds,
    volume: 1,
  };
  const clips = [...edit.clips];
  clips.splice(at, 0, clip);
  return { ...edit, clips };
}

export function updateAudio(edit: Edit, i: number, patch: Partial<EditAudio>): Edit {
  return { ...edit, audio: edit.audio.map((a, k) => (k === i ? { ...a, ...patch } : a)) };
}

export function removeAudio(edit: Edit, i: number): Edit {
  return { ...edit, audio: edit.audio.filter((_, k) => k !== i) };
}

export function trimAudio(edit: Edit, i: number, which: 'in' | 'out', by: number, sourceSec: number): Edit {
  const a = edit.audio[i];
  if (which === 'in') return updateAudio(edit, i, { in: clamp(a.in + by, 0, a.out - 0.2) });
  return updateAudio(edit, i, { out: clamp(a.out + by, a.in + 0.2, sourceSec) });
}

/** Lays a sound over the film starting at `start` seconds. Music loops quietly under everything. */
export function addAudio(edit: Edit, m: MediaItem, start: number): Edit {
  const music = m.audioKind === 'music';
  const a: EditAudio = {
    id: uid('a'),
    kind: m.audioKind ?? 'upload',
    url: m.url,
    label: m.label,
    start: music ? 0 : clamp(start, 0, 600),
    in: 0,
    out: m.seconds,
    volume: music ? 0.35 : 1,
    fadeIn: music ? 1 : 0,
    fadeOut: music ? 2 : 0,
    loop: music,
  };
  return { ...edit, audio: [...edit.audio, a] };
}

/** How long a sound plays in the film (looped sounds run to the end). */
export function audioPlays(edit: Edit, a: EditAudio): number {
  const total = filmLength(edit);
  if (a.start >= total) return 0;
  return r2(a.loop ? total - a.start : Math.min(a.out - a.in, total - a.start));
}

export const VOLUME_STEPS = [0, 0.25, 0.5, 1, 1.5] as const;
export function volumeLabel(v: number): string {
  return v === 0 ? 'Mute' : `${Math.round(v * 100)}%`;
}

/** Mirrors the server: can fal.ai's plain joiner make this cut, or does it need the mixing server? */
export function isSimpleEdit(edit: Edit, media: MediaItem[]): boolean {
  const whole = edit.clips.every((c) => c.in === 0 && c.out === sourceLength(media, c.url, c.out) && c.volume === 1);
  const a = edit.audio;
  return whole && (a.length === 0 || (a.length === 1 && a[0].kind === 'music' && a[0].start === 0 && a[0].in === 0 && a[0].loop));
}
