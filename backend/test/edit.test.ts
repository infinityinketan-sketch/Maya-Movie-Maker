import { describe, expect, it } from 'vitest';
import { audioSeconds, defaultEdit, editLength, isSimpleEdit, normalizeEdit, projectMedia } from '../src/edit';

const shots = [
  { id: 's1', idx: 0, video_url: 'https://m/s1-new.mp4', prev_video_url: 'https://m/s1-old.mp4', duration_sec: 8 },
  { id: 's2', idx: 1, video_url: 'https://m/s2.mp4', prev_video_url: null, duration_sec: 6 },
];
const assets = [
  { id: 'x1', kind: 'sfx' as const, label: 'Door slam', url: 'https://m/door.mp3', duration_sec: 2, status: 'done' },
  { id: 'x2', kind: 'upload_video' as const, label: 'Shop front', url: 'https://m/shop.mp4', duration_sec: '12.5', status: 'done' },
  { id: 'x3', kind: 'voice' as const, label: 'Still making', url: null, duration_sec: null, status: 'running' },
];
const media = projectMedia(shots, 'https://m/music.wav', assets);

describe('editor', () => {
  it('lists every take, the score and finished uploads/sounds', () => {
    expect(media.map((m) => m.label)).toEqual(['Shot 1', 'Shot 1 · previous take', 'Shot 2', 'Music score', 'Door slam', 'Shop front']);
  });

  it('default cut: shots in order, quiet looped music', () => {
    const e = defaultEdit(shots, 'https://m/music.wav');
    expect(e.clips.map((c) => c.url)).toEqual(['https://m/s1-new.mp4', 'https://m/s2.mp4']);
    expect(e.audio[0]).toMatchObject({ kind: 'music', loop: true, volume: 0.35 });
    expect(editLength(e)).toBe(14);
    expect(isSimpleEdit(e, media)).toBe(true);
  });

  it('clamps trims and volumes, drops media that is not this film’s', () => {
    const e = normalizeEdit(
      {
        clips: [
          { url: 'https://m/s2.mp4', shotId: 's2', in: -3, out: 99, volume: 7 },
          { url: 'https://evil.example/x.mp4', in: 0, out: 2 },
          { url: 'https://m/shop.mp4', in: 2, out: 4.555, volume: 0 },
        ],
        audio: [
          { url: 'https://m/door.mp3', start: 3.2, volume: 1.5, fadeIn: 50 },
          { url: 'https://m/s2.mp4', start: 0 }, // a video is not a sound
        ],
      },
      media,
    );
    expect(e.clips).toHaveLength(2);
    expect(e.clips[0]).toMatchObject({ in: 0, out: 6, volume: 2 });
    expect(e.clips[1]).toMatchObject({ in: 2, out: 4.56, volume: 0 });
    expect(e.audio).toEqual([expect.objectContaining({ kind: 'sfx', start: 3.2, in: 0, out: 2, volume: 1.5, fadeIn: 10, loop: false })]);
    expect(isSimpleEdit(e, media)).toBe(false);
  });

  it('a shot clip follows its newest take unless the user pinned a take', () => {
    const olderMedia = projectMedia([{ ...shots[0], video_url: 'https://m/s1-newer.mp4', prev_video_url: 'https://m/s1-new.mp4' }], null, []);
    const e = normalizeEdit(
      {
        clips: [
          { url: 'https://m/s1-new.mp4', shotId: 's1', in: 0, out: 8 },
          { url: 'https://m/s1-new.mp4', shotId: 's1', pinned: true, in: 0, out: 8 },
        ],
        audio: [],
      },
      olderMedia,
    );
    expect(e.clips.map((c) => c.url)).toEqual(['https://m/s1-newer.mp4', 'https://m/s1-new.mp4']);
  });

  it('a music layer moves to the new score when the music is re-composed', () => {
    const e = normalizeEdit({ clips: [], audio: [{ kind: 'music', url: 'https://m/old-music.wav', start: 0, volume: 0.2, loop: true }] }, media);
    expect(e.audio).toEqual([expect.objectContaining({ url: 'https://m/music.wav', volume: 0.2, loop: true })]);
  });

  it('rejects edits that are too long or malformed', () => {
    const many = Array.from({ length: 80 }, () => ({ url: 'https://m/shop.mp4', in: 0, out: 12.5 }));
    expect(() => normalizeEdit({ clips: many, audio: [] }, media)).toThrow(/at most 10 minutes/);
    expect(() => normalizeEdit({ clips: 'x' }, media)).toThrow(/clips and audio/);
  });

  it('measures WAV, MP3 and rejects unknown audio', () => {
    const wav = new Uint8Array(44 + 96_000);
    const v = new DataView(wav.buffer);
    wav.set([...'RIFF'].map((ch) => ch.charCodeAt(0)), 0);
    wav.set([...'WAVEfmt '].map((ch) => ch.charCodeAt(0)), 8);
    v.setUint32(16, 16, true);
    v.setUint32(28, 48_000, true); // byte rate: 24 kHz mono 16-bit
    wav.set([...'data'].map((ch) => ch.charCodeAt(0)), 36);
    v.setUint32(40, 96_000, true);
    expect(audioSeconds(wav, 'wav')).toBe(2);
    const mp3 = new Uint8Array(32_000);
    mp3.set([0xff, 0xfb, 0x90, 0x64]); // MPEG-1 Layer III 128 kbps
    expect(audioSeconds(mp3, 'mp3')).toBe(2);
    expect(audioSeconds(new Uint8Array(1000), 'mp3')).toBeNull();
  });
});
