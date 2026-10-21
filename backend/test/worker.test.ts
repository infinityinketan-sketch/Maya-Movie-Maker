// Runs the queue consumer and cron against an in-memory database and fake providers.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const tables: Record<string, Row[]> = {};
const rpcCalls: { fn: string; args: any }[] = [];

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const q: any = {
    select: () => q,
    eq: (c: string, v: any) => (filters.push((r) => r[c] === v), q),
    neq: (c: string, v: any) => (filters.push((r) => r[c] !== v), q),
    in: (c: string, v: any[]) => (filters.push((r) => v.includes(r[c])), q),
    lt: (c: string, v: any) => (filters.push((r) => r[c] < v), q),
    ilike: (c: string, v: string) => (filters.push((r) => String(r[c]).toLowerCase() === v.toLowerCase()), q),
    order: () => q,
    limit: () => q,
    update: (p: Row) => ((patch = p), q),
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    single: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (res: any, rej: any) => {
      if (patch) rows().forEach((r) => Object.assign(r, patch));
      return Promise.resolve({ data: rows(), error: null }).then(res, rej);
    },
  };
  return q;
}

vi.mock('../src/db', async (orig) => {
  const real: any = await orig();
  return {
    ...real,
    db: () => ({
      from: (t: string) => query(t),
      rpc: async (fn: string, args: any) => {
        rpcCalls.push({ fn, args });
        if (fn === 'fail_job') {
          const j = tables.jobs.find((r) => r.id === args.p_job);
          if (j) Object.assign(j, { status: 'failed', error: args.p_error, refunded: true });
        }
        return { data: null, error: null };
      },
    }),
  };
});

const { handleQueue, handleCron } = await import('../src/worker');

const sent: { body: any; opts?: any }[] = [];
const env: any = {
  PUBLIC_API_BASE: 'https://api.test',
  MEDIA_PUBLIC_BASE: 'https://media.test',
  FAL_KEY: 'k',
  JOBS: { send: async (body: any, opts?: any) => void sent.push({ body, opts }) },
  MEDIA: { put: vi.fn(async () => undefined) },
};

function batch(body: any) {
  const msg = { body, ack: vi.fn() };
  return { msg, batch: { messages: [msg] } as any };
}

beforeEach(() => {
  sent.length = 0;
  rpcCalls.length = 0;
  tables.projects = [{ id: 'p1', user_id: 'u1', tier: 'standard', aspect_ratio: '9:16', language: 'Hindi', style: null, kind: 'film', ad_brief: null, music_url: null }];
  tables.shots = [{ id: 's1', project_id: 'p1', user_id: 'u1', idx: 0, duration_sec: 8, camera: 'wide', action: 'A tea stall at dawn', dialogue: null, speaker: null, keyframe_url: 'https://media.test/f.png', takes: 0, video_url: null, video_model: null }];
  tables.characters = [];
  tables.jobs = [
    { id: 'j1', user_id: 'u1', project_id: 'p1', target_id: 's1', kind: 'video', status: 'queued', credits: 317, input: { tier: 'standard' }, attempts: 0, refunded: false, model: 'veo', created_at: new Date().toISOString(), updated_at: new Date().toISOString() },
  ];
  vi.unstubAllGlobals();
});

describe('busy provider', () => {
  it('re-queues the job after 10 s instead of refunding', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limited', { status: 429 })));
    const { batch: b, msg } = batch({ type: 'start', jobId: 'j1' });
    await handleQueue(b, env);
    expect(msg.ack).toHaveBeenCalled();
    expect(sent).toEqual([{ body: { type: 'start', jobId: 'j1', attempt: 1 }, opts: { delaySeconds: 10 } }]);
    expect(tables.jobs[0].status).toBe('queued');
    expect(rpcCalls.find((c) => c.fn === 'fail_job')).toBeUndefined();
  });

  it('refunds once the three retries are used up', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('busy', { status: 503 })));
    await handleQueue(batch({ type: 'start', jobId: 'j1', attempt: 3 }).batch, env);
    expect(sent).toHaveLength(0);
    expect(rpcCalls.find((c) => c.fn === 'fail_job')?.args.p_job).toBe('j1');
    expect(tables.shots[0].video_status).toBe('failed');
  });

  it('a real error (bad request) refunds at once, no retry', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"detail":"invalid prompt"}', { status: 422 })));
    await handleQueue(batch({ type: 'start', jobId: 'j1' }).batch, env);
    expect(sent).toHaveLength(0);
    expect(rpcCalls.find((c) => c.fn === 'fail_job')).toBeDefined();
  });

  it('stores the fal.ai status links when the submission is accepted', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ request_id: 'r1', status_url: 'https://q/status', response_url: 'https://q/resp' })));
    await handleQueue(batch({ type: 'start', jobId: 'j1' }).batch, env);
    expect(tables.jobs[0]).toMatchObject({ status: 'running', provider_request_id: 'r1', provider_status_url: 'https://q/status', provider_response_url: 'https://q/resp' });
  });
});

describe('broken results', () => {
  it('a "successful" clip with no picture data is rejected and refunded', async () => {
    tables.jobs[0].status = 'running';
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new Uint8Array(300_000), { headers: { 'content-type': 'video/mp4' } })));
    await handleQueue(batch({ type: 'finalize', jobId: 'j1', ok: true, result: { video: { url: 'https://cdn/clip.mp4' } } }).batch, env);
    const fail = rpcCalls.find((c) => c.fn === 'fail_job');
    expect(fail?.args.p_error).toContain('not a playable MP4');
    expect(env.MEDIA.put).not.toHaveBeenCalled();
    expect(tables.shots[0].video_url).toBeNull();
  });

  it('a failed download is retried later rather than refunded', async () => {
    tables.jobs[0].status = 'running';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway', { status: 502 })));
    await handleQueue(batch({ type: 'finalize', jobId: 'j1', ok: true, result: { video: { url: 'https://cdn/clip.mp4' } } }).batch, env);
    expect(sent[0]).toMatchObject({ body: { type: 'finalize', jobId: 'j1', attempt: 1 }, opts: { delaySeconds: 10 } });
    expect(tables.jobs[0].status).toBe('running');
    expect(rpcCalls.find((c) => c.fn === 'fail_job')).toBeUndefined();
  });
});

describe('lost results (cron)', () => {
  const old = new Date(Date.now() - 60 * 60_000).toISOString();

  it('collects a finished result from fal.ai instead of refunding', async () => {
    Object.assign(tables.jobs[0], { status: 'running', updated_at: old, provider_status_url: 'https://q/status', provider_response_url: 'https://q/resp' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.endsWith('/status') ? Response.json({ status: 'COMPLETED' }) : Response.json({ video: { url: 'https://cdn/clip.mp4' } }))),
    );
    await handleCron(env);
    expect(sent[0].body).toMatchObject({ type: 'finalize', jobId: 'j1', ok: true, result: { video: { url: 'https://cdn/clip.mp4' } } });
    expect(rpcCalls.find((c) => c.fn === 'fail_job')).toBeUndefined();
  });

  it('leaves a job that is still being made, and refunds one that never started', async () => {
    tables.jobs.push({ ...tables.jobs[0], id: 'j2', status: 'queued', updated_at: old });
    Object.assign(tables.jobs[0], { status: 'running', updated_at: old, provider_status_url: 'https://q/status', provider_response_url: 'https://q/resp' });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'IN_PROGRESS' })));
    await handleCron(env);
    const failed = rpcCalls.filter((c) => c.fn === 'fail_job').map((c) => c.args.p_job);
    expect(failed).toEqual(['j2']);
  });

  it('gives up after 3 hours', async () => {
    Object.assign(tables.jobs[0], {
      status: 'running',
      updated_at: old,
      created_at: new Date(Date.now() - 4 * 3600_000).toISOString(),
      provider_status_url: 'https://q/status',
      provider_response_url: 'https://q/resp',
    });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ status: 'IN_QUEUE' })));
    await handleCron(env);
    expect(rpcCalls.find((c) => c.fn === 'fail_job')?.args.p_job).toBe('j1');
  });
});

describe('final cut on the mixing server', () => {
  const edit = {
    version: 1,
    clips: [{ id: 'c1', shotId: 's1', url: 'https://media.test/a.mp4', label: 'Shot 1', in: 1, out: 7, volume: 0.8 }],
    audio: [{ id: 'a1', kind: 'sfx', url: 'https://media.test/boom.mp3', label: 'Boom', start: 2, in: 0, out: 1, volume: 1, fadeIn: 0, fadeOut: 0, loop: false }],
  };
  const mixEnv = { ...env, RENDER_SERVICE_URL: 'https://mixer.test', RENDER_SECRET: 'sss' };
  const renderJob = () => ({
    id: 'r1', user_id: 'u1', project_id: 'p1', target_id: 'p1', kind: 'render', status: 'queued', credits: 4,
    input: { edit, seconds: 6, mixer: true }, attempts: 0, refunded: false, model: 'ffmpeg-mixer',
  });

  it('sends the edit list with an output key and keeps the finished film', async () => {
    tables.jobs = [renderJob()];
    let sentBody: any;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: any) => {
      expect(url).toBe('https://mixer.test/render');
      expect(init.headers.authorization).toBe('Bearer sss');
      sentBody = JSON.parse(init.body);
      return Response.json({ url: `https://media.test/${sentBody.outputKey}`, thumbnailUrl: `https://media.test/${sentBody.thumbKey}`, bytes: 900_000, seconds: 6.02, width: 1080, height: 1920, hasAudio: true });
    }));
    await handleQueue(batch({ type: 'start', jobId: 'r1' }).batch, mixEnv);
    expect(sentBody.clips).toEqual([{ url: 'https://media.test/a.mp4', in: 1, out: 7, volume: 0.8 }]);
    expect(sentBody.audio[0]).toMatchObject({ start: 2, loop: false });
    expect(sentBody.outputKey).toMatch(/^u\/u1\/p1\/final\/.+\.mp4$/);
    expect(tables.projects[0].final_video_url).toBe(`https://media.test/${sentBody.outputKey}`);
    expect(tables.projects[0].render_status).toBe('done');
    expect(rpcCalls.find((c) => c.fn === 'fail_job')).toBeUndefined();
  });

  it('a film of the wrong length is refused and refunded', async () => {
    tables.jobs = [renderJob()];
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      const b = JSON.parse(init.body);
      return Response.json({ url: `https://media.test/${b.outputKey}`, thumbnailUrl: null, bytes: 900_000, seconds: 2, width: 1080, height: 1920, hasAudio: true });
    }));
    await handleQueue(batch({ type: 'start', jobId: 'r1' }).batch, mixEnv);
    expect(rpcCalls.find((c) => c.fn === 'fail_job')?.args.p_error).toContain('2.0 s long');
    expect(tables.projects[0].render_status).toBe('failed');
  });

  it('a busy mixing server is retried, a broken input fails at once', async () => {
    tables.jobs = [renderJob()];
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'busy' }, { status: 503 })));
    await handleQueue(batch({ type: 'start', jobId: 'r1' }).batch, mixEnv);
    expect(sent[0]).toMatchObject({ body: { type: 'start', jobId: 'r1', attempt: 1 } });

    tables.jobs = [renderJob()];
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'bad_media', message: 'clip 1 has no picture' }, { status: 422 })));
    await handleQueue(batch({ type: 'start', jobId: 'r1' }).batch, mixEnv);
    expect(rpcCalls.find((c) => c.fn === 'fail_job')?.args.p_error).toContain('clip 1 has no picture');
  });

  it('without a mixing server, a plain cut is joined by fal.ai', async () => {
    tables.jobs = [{ ...renderJob(), input: { edit: { ...edit, audio: [] }, seconds: 6, mixer: false } }];
    let falBody: any;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: any) => {
      falBody = JSON.parse(init.body);
      return Response.json({ request_id: 'x', status_url: 's', response_url: 'r' });
    }));
    await handleQueue(batch({ type: 'start', jobId: 'r1' }).batch, env);
    expect(falBody.tracks[0].keyframes).toEqual([{ url: 'https://media.test/a.mp4', timestamp: 0, duration: 6000 }]);
  });
});

describe('AI sound effects and voice-overs', () => {
  it('keeps a finished sound effect with its measured length', async () => {
    tables.project_assets = [{ id: 'as1', project_id: 'p1', kind: 'sfx', status: 'running', url: null }];
    tables.jobs = [{ id: 'x1', user_id: 'u1', project_id: 'p1', target_id: 'as1', kind: 'sfx', status: 'running', input: { prompt: 'door slam', seconds: 3 }, attempts: 0 }];
    const mp3 = new Uint8Array(48_000); // 128 kbps → 3 s
    mp3.set([0xff, 0xfb, 0x90, 0x64]);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(mp3, { headers: { 'content-type': 'audio/mpeg' } })));
    await handleQueue(batch({ type: 'finalize', jobId: 'x1', ok: true, result: { audio: { url: 'https://cdn/s.mp3' } } }).batch, env);
    expect(tables.project_assets[0]).toMatchObject({ status: 'done', duration_sec: 3 });
    expect(tables.project_assets[0].url).toMatch(/^https:\/\/media\.test\/u\/u1\/p1\/sfx\/as1-.+\.mp3$/);
  });

  it('submits a voice-over with the chosen voice and language', async () => {
    tables.project_assets = [{ id: 'as2', project_id: 'p1', kind: 'voice', status: 'queued', url: null }];
    tables.jobs = [{ id: 'x2', user_id: 'u1', project_id: 'p1', target_id: 'as2', kind: 'voice', status: 'queued', input: { text: 'Namaskar!', voice: 'George', language_code: 'mr' }, attempts: 0 }];
    let falBody: any;
    let falUrl = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string, init: any) => {
      falUrl = u;
      falBody = JSON.parse(init.body);
      return Response.json({ request_id: 'v', status_url: 's', response_url: 'r' });
    }));
    await handleQueue(batch({ type: 'start', jobId: 'x2' }).batch, env);
    expect(falUrl).toContain('fal-ai/elevenlabs/tts/eleven-v3');
    expect(falBody).toEqual({ text: 'Namaskar!', voice: 'George', language_code: 'mr' });
    expect(tables.project_assets[0].status).toBe('running');
  });
});
