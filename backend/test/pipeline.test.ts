import { afterEach, describe, expect, it, vi } from 'vitest';
import { continueSetup, normalizePlan, planPrompt, type FilmPlan } from '../src/providers/anthropic';
import { resultUrl, verifyFalWebhook } from '../src/providers/fal';
import { shotCast, videoPrompt } from '../src/worker';
import { defaultEdit, falTracks } from '../src/edit';

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
  const asha = { name: 'Asha', description: 'young woman in a yellow saree, long braid', voice: 'light, soft, youthful female voice' };
  const ravi = { name: 'Ravi', description: 'older man with a grey moustache, white kurta', voice: 'deep, slow, aged male voice' };

  it('puts the line first, by appearance, with voice, language and lip sync', () => {
    const p = videoPrompt({ language: 'Hindi', style: null }, { camera: 'close-up', action: 'Asha smiles', dialogue: 'Chalo!', speaker: 'Asha' }, [asha], [asha, ravi]);
    expect(p.startsWith('Asha (young woman in a yellow saree, long braid) says in Hindi: "Chalo!"')).toBe(true);
    expect(p).toContain('The voice is light, soft, youthful female voice.');
    expect(p).toContain('lips move clearly in sync');
    expect(p).toContain('Asha is the only voice heard.');
    expect(p).toContain('No background music');
  });

  it('describes only the wanted voice, never the voices to avoid', () => {
    const p = videoPrompt({ language: 'Hindi', style: null }, { camera: 'close-up', action: 'Asha looks away', dialogue: 'Nahi.', speaker: 'Asha' }, [asha], [asha, ravi]);
    expect(p).not.toContain('deep, slow, aged male voice');
    expect(p).not.toMatch(/do not use|not deep|not old/i);
  });

  it('keeps any other character in the shot silent', () => {
    const p = videoPrompt({ language: 'Hindi', style: null }, { camera: 'two-shot', action: 'They sit on the veranda', dialogue: 'Suno.', speaker: 'Ravi' }, [asha, ravi], [asha, ravi]);
    expect(p.startsWith('Ravi (older man with a grey moustache, white kurta) says in Hindi: "Suno."')).toBe(true);
    expect(p).toContain('Asha (young woman in a yellow saree, long braid) stays silent and does not speak.');
  });

  it('tells the model no one speaks in a silent shot', () => {
    const p = videoPrompt({ language: 'Hindi', style: null }, { camera: 'wide shot', action: 'A crane flies over the river', dialogue: null, speaker: null }, [], [asha, ravi]);
    expect(p.startsWith('No one on screen speaks')).toBe(true);
    expect(p).not.toContain('says');
  });

  it('still works when the speaker is not in the cast list', () => {
    const p = videoPrompt({ language: 'English', style: null }, { camera: null, action: 'A voice calls out', dialogue: 'Wait!', speaker: 'Guard' }, [asha], [asha]);
    expect(p.startsWith('Guard says in English: "Wait!"')).toBe(true);
    expect(p).toContain('Asha (young woman in a yellow saree, long braid) stays silent');
  });

  it('shows only the speaker in a talking shot, everyone listed in a silent one', () => {
    expect(shotCast({ characters: ['Asha', 'Ravi'], dialogue: 'Suno.', speaker: 'Ravi' })).toEqual(['ravi']);
    expect(shotCast({ characters: ['Asha', 'Ravi'], dialogue: null, speaker: null })).toEqual(['asha', 'ravi']);
    expect(shotCast({ characters: ['Asha'], dialogue: null, speaker: 'Asha' })).toEqual(['asha']);
  });

  it('copies camera, action and cast word for word into a continuing shot; only the line changes', () => {
    const prev = { duration_sec: 8, camera: 'medium close-up, slightly high angle', action: 'Karunya sits on the veranda and speaks', dialogue: 'Line one.', speaker: 'Karunya', characters: ['Karunya'] };
    const next = { duration_sec: 8, camera: 'slow push-in', action: 'Karunya gazes into the distance', dialogue: 'Line two.', speaker: 'Karunya', characters: ['Karunya'], same_setup_as_previous: true };
    const out = continueSetup(next, prev);
    expect(out.camera).toBe(prev.camera);
    expect(out.action).toBe(prev.action);
    expect(out.dialogue).toBe('Line two.');
  });

  it('does not treat a shot with a different speaker, or a first shot, as a continuation', () => {
    const prev = { duration_sec: 8, camera: 'mcu', action: 'Ravi speaks', dialogue: 'A.', speaker: 'Ravi', characters: ['Ravi'] };
    const other = { duration_sec: 8, camera: 'cu', action: 'Asha answers', dialogue: 'B.', speaker: 'Asha', characters: ['Asha'], same_setup_as_previous: true };
    expect(continueSetup(other, prev)).toMatchObject({ camera: 'cu', action: 'Asha answers', same_setup_as_previous: undefined });
    expect(continueSetup(other, undefined).action).toBe('Asha answers');
  });

  it('applies continuations when normalising a plan', () => {
    const plan = normalizePlan({
      title: 'T', logline: 'L', synopsis: 'S', music_prompt: 'M',
      characters: [{ name: 'Karunya', description: 'young man' }],
      scenes: [{ heading: 'EXT. VERANDA - DAY', summary: 's', shots: [
        { duration_sec: 8, camera: 'mcu high angle', action: 'Karunya speaks', dialogue: 'One.', speaker: 'Karunya', characters: ['Karunya'] },
        { duration_sec: 8, camera: 'push-in', action: 'something else', dialogue: 'Two.', speaker: 'Karunya', characters: ['Karunya'], same_setup_as_previous: true },
      ] }],
    });
    expect(plan.scenes[0].shots[1]).toMatchObject({ camera: 'mcu high angle', action: 'Karunya speaks', dialogue: 'Two.' });
  });

  it('lays shots back to back and loops music to the film length', () => {
    const shots = [8, 6, 8, 8, 8].map((sec, idx) => ({ id: `s${idx}`, idx, video_url: `${'abcde'[idx]}.mp4`, duration_sec: sec }));
    const { tracks, totalMs } = falTracks(defaultEdit(shots, 'm.wav'));
    expect(totalMs).toBe(38000);
    expect(tracks[0].keyframes.map((k) => k.timestamp)).toEqual([0, 8000, 14000, 22000, 30000]);
    expect(tracks[1].keyframes).toEqual([
      { url: 'm.wav', timestamp: 0, duration: 30000 },
      { url: 'm.wav', timestamp: 30000, duration: 8000 },
    ]);
  });

  it('renders without music when none was made', () => {
    expect(falTracks(defaultEdit([{ id: 's', idx: 0, video_url: 'a.mp4', duration_sec: 4 }], null)).tracks).toHaveLength(1);
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
