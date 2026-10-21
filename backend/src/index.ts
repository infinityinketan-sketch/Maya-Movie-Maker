import { Hono, type Context } from 'hono';
import { balanceOf, db, getOwnedCharacter, getOwnedProject, getOwnedShot, must, type AdOrder, type Project, type Shot } from './db';
import { HttpError, type AppUser, type Env, type JobMessage } from './env';
import { AD_LENGTHS, adIdea, BUSINESS_TYPES, minAdvance, OCCASIONS, waLink, waMessage, type AdBrief } from './ads';
import { CAMERA_LIBRARY, directCostUsd, directorPrices, directShot, reviewCostUsd, reviewFilm, type ShotContext } from './director';
import { assertCanAfford, chargeJob, failJob, startJob, succeedJob } from './jobs';
import { checkOwnClip, inspectMp4, ProviderBusyError, withQuickRetries } from './reliability';
import { audioSeconds, AUDIO_TYPES, defaultEdit, editLength, isSimpleEdit, normalizeEdit, projectMedia, type Edit } from './edit';
import { verifyFalWebhook, type FalWebhook } from './providers/fal';
import { consumeProductPurchase, getProductPurchase } from './providers/googleplay';
import {
  catalog,
  CREDIT_PACKS,
  creditsFor,
  imageCostUsd,
  musicCostUsd,
  MUSIC_MODEL,
  planCostUsd,
  priceConfig,
  RENDER_MODEL,
  renderCostUsd,
  renderCredits,
  billedSeconds,
  SFX_MAX_SEC,
  SFX_MODEL,
  sfxCostUsd,
  sfxCredits,
  snapDuration,
  TIERS,
  VIDEO_MODELS,
  videoCostUsd,
  VOICE_MAX_CHARS,
  VOICE_MODEL,
  voiceCostUsd,
  voiceCredits,
  type Tier,
} from './pricing';
import { deletePrefix, keyFromUrl, mediaKey, putBytes } from './storage';
import { handleCron, handleQueue } from './worker';

type App = { Bindings: Env; Variables: { user: AppUser } };
const app = new Hono<App>();

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.code, message: err.message }, err.status as 400);
  console.error(err);
  return c.json({ error: 'server_error', message: 'Something went wrong. Please try again.' }, 500);
});

app.get('/health', (c) => c.json({ ok: true }));

// ---------------------------------------------------------------- public

app.get('/v1/catalog', (c) => {
  const cfg = priceConfig(c.env);
  return c.json({ ...catalog(cfg), director: directorPrices((usd) => creditsFor(usd, cfg)) });
});

app.get('/v1/director/library', (c) => c.json({ groups: CAMERA_LIBRARY }));

app.post('/v1/webhooks/fal', async (c) => {
  const raw = await c.req.arrayBuffer();
  if (!(await verifyFalWebhook(c.req.raw.headers, raw))) return c.json({ error: 'bad_signature' }, 401);
  const hook = JSON.parse(new TextDecoder().decode(raw)) as FalWebhook;
  if (hook.request_id !== c.req.header('x-fal-webhook-request-id')) return c.json({ error: 'bad_signature' }, 401);
  const d = db(c.env);
  let jobId = ((await d.from('jobs').select('id').eq('provider_request_id', hook.request_id).maybeSingle()).data as { id: string } | null)?.id;
  // A fast result can arrive before the worker saved the request id: match it by the job id in the URL.
  const hinted = c.req.query('job');
  if (!jobId && hinted && /^[0-9a-f-]{36}$/i.test(hinted)) {
    const j = (await d.from('jobs').select('id,status,provider_request_id').eq('id', hinted).maybeSingle()).data as
      | { id: string; status: string; provider_request_id: string | null }
      | null;
    if (j && !j.provider_request_id && busy(j.status)) {
      jobId = j.id;
      await d.from('jobs').update({ provider_request_id: hook.request_id }).eq('id', j.id);
    }
  }
  if (!jobId) return c.json({ ok: true, ignored: true });
  const msg: JobMessage = {
    type: 'finalize',
    jobId,
    ok: hook.status === 'OK' && !hook.payload_error,
    result: hook.payload,
    error: hook.error || hook.payload_error || (hook.status === 'ERROR' ? JSON.stringify(hook.payload).slice(0, 400) : undefined),
  };
  await c.env.JOBS.send(msg);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- auth

app.use('/v1/*', async (c, next) => {
  const path = c.req.path;
  if (path === '/v1/catalog' || path === '/v1/director/library' || path.startsWith('/v1/webhooks/')) return next();
  const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) throw new HttpError(401, 'unauthorized', 'Please sign in.');
  const res = await db(c.env).auth.getUser(token);
  if (res.error || !res.data.user) throw new HttpError(401, 'unauthorized', 'Your session expired. Please sign in again.');
  c.set('user', { id: res.data.user.id, email: res.data.user.email ?? undefined });
  return next();
});

async function body<T = Record<string, unknown>>(c: Context<App>): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    return {} as T;
  }
}
function text(v: unknown, min: number, max: number, field: string): string {
  if (typeof v !== 'string' || v.trim().length < min) throw new HttpError(400, 'invalid', `${field} must be at least ${min} characters.`);
  return v.trim().slice(0, max);
}
function optText(v: unknown, max: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string') throw new HttpError(400, 'invalid', 'expected text');
  return v.trim().slice(0, max);
}
function busy(status: string): boolean {
  return status === 'queued' || status === 'running';
}
function clean(o: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

/** Paid work still in progress for a film (deleting or rewriting it now would lose those credits). */
async function busyJobs(d: ReturnType<typeof db>, projectId: string): Promise<number> {
  const res = await d.from('jobs').select('id', { count: 'exact', head: true }).eq('project_id', projectId).in('status', ['queued', 'running']);
  return res.count ?? 0;
}

// ---------------------------------------------------------------- account

app.get('/v1/me', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const prof = await d.from('profiles').select('role').eq('id', user.id).maybeSingle();
  return c.json({ user, balance: await balanceOf(d, user.id), director: await hasDirector(d, user.id), role: prof.data?.role ?? 'user' });
});

/** Play Store policy: users must be able to delete their account and data in the app. */
app.delete('/v1/me', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  await deletePrefix(c.env, `u/${user.id}/`);
  const res = await d.auth.admin.deleteUser(user.id);
  if (res.error) throw new Error(res.error.message);
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- projects

app.post('/v1/projects', async (c) => {
  const user = c.get('user');
  const b = await body(c);
  const tier = (TIERS as string[]).includes(b.tier as string) ? (b.tier as Tier) : 'standard';
  const target = Math.min(300, Math.max(15, Math.round(Number(b.target_duration_sec) || 30)));
  const row = must(
    await db(c.env)
      .from('projects')
      .insert({
        user_id: user.id,
        idea: text(b.idea, 10, 4000, 'Idea'),
        title: optText(b.title, 80) || 'Untitled film',
        genre: optText(b.genre, 40) ?? null,
        language: optText(b.language, 40) || 'English',
        style: optText(b.style, 300) ?? null,
        aspect_ratio: b.aspect_ratio === '9:16' ? '9:16' : '16:9',
        target_duration_sec: target,
        tier,
      })
      .select('*')
      .single(),
    'project',
  );
  return c.json(row, 201);
});

app.patch('/v1/projects/:id', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  await getOwnedProject(d, user.id, c.req.param('id'));
  const b = await body(c);
  const patch = clean({
    title: optText(b.title, 80) ?? undefined,
    music_prompt: optText(b.music_prompt, 500),
    style: optText(b.style, 300),
    tier: (TIERS as string[]).includes(b.tier as string) ? b.tier : undefined,
  });
  const row = must(await d.from('projects').update(patch).eq('id', c.req.param('id')).select('*').single(), 'project');
  return c.json(row);
});

app.delete('/v1/projects/:id', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const p = await getOwnedProject(d, user.id, c.req.param('id'));
  if (await busyJobs(d, p.id)) throw new HttpError(409, 'busy', 'Something is still being made for this film. Delete it once that finishes.');
  await deletePrefix(c.env, `u/${user.id}/${p.id}/`);
  await d.from('projects').delete().eq('id', p.id);
  return c.json({ ok: true });
});

/** Story: idea -> title, characters, scenes and shot list (Claude). */
app.post('/v1/projects/:id/plan', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const p = await getOwnedProject(d, user.id, c.req.param('id'));
  if (p.status === 'planning') throw new HttpError(409, 'busy', 'The story is already being written.');
  if (await busyJobs(d, p.id)) throw new HttpError(409, 'busy', 'Frames or videos are still being made. Rewrite the story once they finish.');
  if (p.kind === 'ad') await requireAdvance(d, p.id);
  const cfg = priceConfig(c.env);
  const cost = planCostUsd(p.target_duration_sec);
  const job = await startJob(c.env, d, {
    userId: user.id,
    projectId: p.id,
    targetId: p.id,
    kind: 'plan',
    credits: creditsFor(cost, cfg),
    costUsd: cost,
    provider: 'anthropic',
    model: c.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
  });
  await d.from('projects').update({ status: 'planning', error: null }).eq('id', p.id);
  return c.json({ job }, 202);
});

// ---------------------------------------------------------------- characters

app.patch('/v1/characters/:id', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  await getOwnedCharacter(d, user.id, c.req.param('id'));
  const b = await body(c);
  const patch = clean({ name: optText(b.name, 60) ?? undefined, description: optText(b.description, 800) ?? undefined, voice: optText(b.voice, 200) });
  return c.json(must(await d.from('characters').update(patch).eq('id', c.req.param('id')).select('*').single(), 'character'));
});

async function portraitJob(c: Context<App>, characterId: string) {
  const user = c.get('user');
  const d = db(c.env);
  const ch = await getOwnedCharacter(d, user.id, characterId);
  if (busy(ch.portrait_status)) throw new HttpError(409, 'busy', 'This look is already being drawn.');
  const cost = imageCostUsd();
  const job = await startJob(c.env, d, {
    userId: user.id,
    projectId: ch.project_id,
    targetId: ch.id,
    kind: 'portrait',
    credits: creditsFor(cost, priceConfig(c.env)),
    costUsd: cost,
    provider: 'google',
    model: c.env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1',
  });
  await d.from('characters').update({ portrait_status: 'queued' }).eq('id', ch.id);
  return job;
}

app.post('/v1/characters/:id/portrait', async (c) => c.json({ job: await portraitJob(c, c.req.param('id')) }, 202));

app.post('/v1/projects/:id/portraits', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const p = await getOwnedProject(d, user.id, c.req.param('id'));
  const chars = ((await d.from('characters').select('id,portrait_status,portrait_url').eq('project_id', p.id)).data ?? []).filter(
    (ch) => !ch.portrait_url && !busy(ch.portrait_status),
  );
  await assertCanAfford(c.env, d, user.id, chars.length * creditsFor(imageCostUsd(), priceConfig(c.env)));
  const jobs = [];
  for (const ch of chars) jobs.push(await portraitJob(c, ch.id));
  return c.json({ jobs }, 202);
});

// ---------------------------------------------------------------- shots

app.patch('/v1/shots/:id', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const shot = await getOwnedShot(d, user.id, c.req.param('id'));
  const b = await body(c);
  const patch = clean({
    action: b.action !== undefined ? text(b.action, 5, 2000, 'Shot description') : undefined,
    dialogue: optText(b.dialogue, 400),
    speaker: optText(b.speaker, 60),
    camera: optText(b.camera, 200),
    duration_sec: b.duration_sec !== undefined ? snapDuration(Number(b.duration_sec)) : undefined,
  });
  if (Object.keys(patch).length && shot.approved) (patch as Record<string, unknown>).approved = false;
  return c.json(must(await d.from('shots').update(patch).eq('id', shot.id).select('*').single(), 'shot'));
});

app.post('/v1/shots/:id/approve', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const shot = await getOwnedShot(d, user.id, c.req.param('id'));
  const approved = (await body<{ approved?: boolean }>(c)).approved !== false;
  if (approved && !shot.keyframe_url) throw new HttpError(400, 'no_frame', 'Generate the storyboard frame first.');
  return c.json(must(await d.from('shots').update({ approved }).eq('id', shot.id).select('*').single(), 'shot'));
});

async function keyframeJob(c: Context<App>, shot: Shot) {
  if (busy(shot.keyframe_status)) throw new HttpError(409, 'busy', 'This frame is already being drawn.');
  const d = db(c.env);
  const cost = imageCostUsd();
  const job = await startJob(c.env, d, {
    userId: shot.user_id,
    projectId: shot.project_id,
    targetId: shot.id,
    kind: 'keyframe',
    credits: creditsFor(cost, priceConfig(c.env)),
    costUsd: cost,
    provider: 'google',
    model: c.env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1',
  });
  await d.from('shots').update({ keyframe_status: 'queued', approved: false, error: null }).eq('id', shot.id);
  return job;
}

app.post('/v1/shots/:id/keyframe', async (c) => {
  const shot = await getOwnedShot(db(c.env), c.get('user').id, c.req.param('id'));
  return c.json({ job: await keyframeJob(c, shot) }, 202);
});

app.post('/v1/projects/:id/storyboard', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const p = await getOwnedProject(d, user.id, c.req.param('id'));
  const shots = (((await d.from('shots').select('*').eq('project_id', p.id).order('idx')).data ?? []) as Shot[]).filter(
    (s) => !s.keyframe_url && !busy(s.keyframe_status),
  );
  await assertCanAfford(c.env, d, user.id, shots.length * creditsFor(imageCostUsd(), priceConfig(c.env)));
  const jobs = [];
  for (const s of shots) jobs.push(await keyframeJob(c, s));
  await d.from('projects').update({ status: 'producing' }).eq('id', p.id);
  return c.json({ jobs }, 202);
});

async function videoJob(c: Context<App>, shot: Shot, tier: Tier) {
  if (!shot.keyframe_url || !shot.approved) throw new HttpError(400, 'not_approved', 'Approve the storyboard frame before making the video.');
  if (busy(shot.video_status)) throw new HttpError(409, 'busy', 'This shot is already being filmed.');
  const d = db(c.env);
  const cost = videoCostUsd(tier, shot.duration_sec);
  const job = await startJob(c.env, d, {
    userId: shot.user_id,
    projectId: shot.project_id,
    targetId: shot.id,
    kind: 'video',
    credits: creditsFor(cost, priceConfig(c.env)),
    costUsd: cost,
    provider: 'fal',
    model: VIDEO_MODELS[tier].endpoint,
    input: { tier, seconds: billedSeconds(tier, shot.duration_sec) },
  });
  await d.from('shots').update({ video_status: 'queued', error: null }).eq('id', shot.id);
  return job;
}

app.post('/v1/shots/:id/video', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const shot = await getOwnedShot(d, user.id, c.req.param('id'));
  const p = await getOwnedProject(d, user.id, shot.project_id);
  return c.json({ job: await videoJob(c, shot, p.tier) }, 202);
});

app.post('/v1/projects/:id/videos', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const p = await getOwnedProject(d, user.id, c.req.param('id'));
  const cfg = priceConfig(c.env);
  const shots = (((await d.from('shots').select('*').eq('project_id', p.id).order('idx')).data ?? []) as Shot[]).filter(
    (s) => s.approved && s.keyframe_url && !s.video_url && !busy(s.video_status),
  );
  if (!shots.length) throw new HttpError(400, 'nothing_to_do', 'Approve some storyboard frames first.');
  await assertCanAfford(c.env, d, user.id, shots.reduce((sum, s) => sum + creditsFor(videoCostUsd(p.tier, s.duration_sec), cfg), 0));
  const jobs = [];
  for (const s of shots) jobs.push(await videoJob(c, s, p.tier));
  await d.from('projects').update({ status: 'producing' }).eq('id', p.id);
  return c.json({ jobs }, 202);
});

// ---------------------------------------------------------------- music + render

app.post('/v1/projects/:id/music', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const p = await getOwnedProject(d, user.id, c.req.param('id'));
  if (busy(p.music_status ?? '')) throw new HttpError(409, 'busy', 'The score is already being composed.');
  const cost = musicCostUsd();
  const job = await startJob(c.env, d, {
    userId: user.id,
    projectId: p.id,
    targetId: p.id,
    kind: 'music',
    credits: creditsFor(cost, priceConfig(c.env)),
    costUsd: cost,
    provider: 'fal',
    model: MUSIC_MODEL,
  });
  await d.from('projects').update({ music_status: 'queued' }).eq('id', p.id);
  return c.json({ job }, 202);
});

// ---------------------------------------------------------------- editor + final cut

const VOICES = [
  { id: 'Aria', label: 'Aria · woman, expressive' },
  { id: 'Sarah', label: 'Sarah · woman, soft' },
  { id: 'Charlotte', label: 'Charlotte · woman, warm' },
  { id: 'Lily', label: 'Lily · woman, young' },
  { id: 'Roger', label: 'Roger · man, confident' },
  { id: 'George', label: 'George · man, warm' },
  { id: 'Brian', label: 'Brian · man, deep' },
  { id: 'Liam', label: 'Liam · man, young' },
];
const VOICE_LANGS: Record<string, string> = { English: 'en', Hindi: 'hi', Marathi: 'mr' };

type D = ReturnType<typeof db>;

/** The film's media library and its current edit list (the saved one, or Maya's default cut). */
async function editContext(env: Env, d: D, p: Project) {
  const shots = ((await d.from('shots').select('id,idx,video_url,prev_video_url,duration_sec').eq('project_id', p.id).order('idx')).data ?? []) as unknown as (Pick<Shot, 'id' | 'idx' | 'video_url' | 'duration_sec'> & { prev_video_url: string | null })[];
  const assets = ((await d.from('project_assets').select('*').eq('project_id', p.id).order('created_at')).data ?? []) as {
    id: string;
    kind: 'sfx' | 'voice' | 'upload_audio' | 'upload_video';
    label: string;
    url: string | null;
    duration_sec: number | null;
    status: string;
  }[];
  const media = projectMedia(shots, p.music_url, assets);
  let edit = defaultEdit(shots, p.music_url);
  let custom = false;
  if (p.edit) {
    try {
      edit = normalizeEdit(p.edit, media);
      custom = true;
    } catch {
      // saved edit no longer valid (e.g. media deleted): fall back to the default cut
    }
  }
  const missingVideos = shots.filter((s) => !s.video_url).length;
  return { shots, assets, media, edit, custom, missingVideos };
}

function editResponse(env: Env, ctx: Awaited<ReturnType<typeof editContext>>) {
  const seconds = editLength(ctx.edit);
  const simple = isSimpleEdit(ctx.edit, ctx.media);
  return {
    edit: ctx.edit,
    custom: ctx.custom,
    media: ctx.media,
    assets: ctx.assets,
    seconds,
    mixer: Boolean(env.RENDER_SERVICE_URL),
    simple,
    renderCredits: renderCredits(seconds, priceConfig(env)),
    missingVideos: ctx.missingVideos,
  };
}

app.get('/v1/projects/:id/edit', async (c) => {
  const d = db(c.env);
  const p = await getOwnedProject(d, c.get('user').id, c.req.param('id'));
  return c.json(editResponse(c.env, await editContext(c.env, d, p)));
});

/** Saves the edit list ({ edit }) or goes back to Maya's default cut ({ reset: true }). */
app.put('/v1/projects/:id/edit', async (c) => {
  const d = db(c.env);
  const p = await getOwnedProject(d, c.get('user').id, c.req.param('id'));
  const b = await body(c);
  let saved: Edit | null = null;
  if (b.reset !== true) {
    const ctx = await editContext(c.env, d, p);
    saved = normalizeEdit(b.edit, ctx.media);
  }
  const res = await d.from('projects').update({ edit: saved }).eq('id', p.id);
  if (res.error) throw new Error(res.error.message);
  return c.json(editResponse(c.env, await editContext(c.env, d, { ...p, edit: saved })));
});

app.get('/v1/editor/options', (c) => {
  const cfg = priceConfig(c.env);
  return c.json({
    voices: VOICES,
    languages: Object.keys(VOICE_LANGS),
    sfxMaxSec: SFX_MAX_SEC,
    voiceMaxChars: VOICE_MAX_CHARS,
    sfxPer5Sec: sfxCredits(5, cfg),
    voicePer100Chars: voiceCredits(100, cfg),
    mixer: Boolean(c.env.RENDER_SERVICE_URL),
  });
});

/** Upload a sound (MP3/M4A/WAV) or a video clip into the film's library. No credits. */
app.post('/v1/projects/:id/assets', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const p = await getOwnedProject(d, user.id, c.req.param('id'));
  const type = (c.req.header('content-type') || '').split(';')[0].trim().toLowerCase();
  if (p.status === 'draft' || p.status === 'planning') throw new HttpError(400, 'no_story', 'Write the story first, then add your own sounds and clips.');
  const label = (c.req.query('label') || '').trim().slice(0, 60);
  const count = await d.from('project_assets').select('id', { count: 'exact', head: true }).eq('project_id', p.id);
  if ((count.count ?? 0) >= 100) throw new HttpError(400, 'too_many', 'This film already has 100 sounds and clips. Delete some first.');
  const buf = new Uint8Array(await c.req.arrayBuffer());
  let row: Record<string, unknown>;
  if (type.startsWith('video/')) {
    if (buf.byteLength > 90 * 1024 * 1024) throw new HttpError(413, 'too_big', 'Clips must be under 90 MB.');
    const info = inspectMp4(buf);
    if (!info || !info.hasVideo) throw new HttpError(400, 'bad_clip', 'Send an MP4 video.');
    const seconds = info.durationSec ?? 0;
    if (seconds < 0.5 || seconds > 300) throw new HttpError(400, 'bad_clip', 'Clips must be between 0.5 seconds and 5 minutes.');
    const id = crypto.randomUUID();
    const url = await putBytes(c.env, mediaKey(user.id, p.id, 'upload', id, 'mp4'), buf, 'video/mp4');
    row = { id, kind: 'upload_video', label: label || 'My clip', url, duration_sec: Math.round(seconds * 100) / 100 };
  } else {
    const ext = AUDIO_TYPES[type];
    if (!ext) throw new HttpError(415, 'bad_type', 'Send an MP3, M4A or WAV sound file.');
    if (buf.byteLength < 1000 || buf.byteLength > 25 * 1024 * 1024) throw new HttpError(413, 'bad_size', 'Sound files must be under 25 MB.');
    const seconds = audioSeconds(buf, ext);
    if (!seconds || seconds < 0.2 || seconds > 900) throw new HttpError(400, 'bad_audio', 'That sound file could not be read. Try an MP3, M4A or WAV.');
    const id = crypto.randomUUID();
    const url = await putBytes(c.env, mediaKey(user.id, p.id, 'upload', id, ext), buf, ext === 'mp3' ? 'audio/mpeg' : ext === 'm4a' ? 'audio/mp4' : 'audio/wav');
    row = { id, kind: 'upload_audio', label: label || 'My sound', url, duration_sec: Math.round(seconds * 100) / 100 };
  }
  const ins = must(await d.from('project_assets').insert({ ...row, project_id: p.id, user_id: user.id, status: 'done' }).select('*').single(), 'asset');
  return c.json(ins, 201);
});

app.delete('/v1/assets/:id', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const a = must(await d.from('project_assets').select('*').eq('id', c.req.param('id')).eq('user_id', user.id).maybeSingle(), 'asset') as {
    id: string;
    url: string | null;
    status: string;
  };
  if (busy(a.status)) throw new HttpError(409, 'busy', 'This sound is still being made.');
  const key = a.url ? keyFromUrl(c.env, a.url) : null;
  if (key) await c.env.MEDIA.delete(key);
  await d.from('project_assets').delete().eq('id', a.id);
  return c.json({ ok: true });
});

/** AI sound effect from a description ("door slams", "crowd cheering"). */
app.post('/v1/projects/:id/sfx', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const p = await getOwnedProject(d, user.id, c.req.param('id'));
  const b = await body(c);
  const prompt = text(b.prompt, 3, 300, 'Description');
  const seconds = Math.min(SFX_MAX_SEC, Math.max(1, Math.round(Number(b.seconds) || 3)));
  const asset = must(
    await d
      .from('project_assets')
      .insert({ project_id: p.id, user_id: user.id, kind: 'sfx', label: optText(b.label, 60) || prompt.slice(0, 40), prompt, status: 'queued' })
      .select('*')
      .single(),
    'asset',
  ) as { id: string };
  try {
    const job = await startJob(c.env, d, {
      userId: user.id,
      projectId: p.id,
      targetId: asset.id,
      kind: 'sfx',
      credits: sfxCredits(seconds, priceConfig(c.env)),
      costUsd: sfxCostUsd(seconds),
      provider: 'fal',
      model: SFX_MODEL,
      input: { prompt, seconds },
    });
    return c.json({ job, asset }, 202);
  } catch (e) {
    await d.from('project_assets').delete().eq('id', asset.id);
    throw e;
  }
});

/** AI voice-over from text, in one of the listed voices. */
app.post('/v1/projects/:id/voice', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const p = await getOwnedProject(d, user.id, c.req.param('id'));
  const b = await body(c);
  const words = text(b.text, 2, VOICE_MAX_CHARS, 'Voice-over text');
  const voice = VOICES.some((v) => v.id === b.voice) ? (b.voice as string) : VOICES[0].id;
  const language = typeof b.language === 'string' && VOICE_LANGS[b.language] ? b.language : null;
  const asset = must(
    await d
      .from('project_assets')
      .insert({ project_id: p.id, user_id: user.id, kind: 'voice', label: optText(b.label, 60) || `${voice}: ${words.slice(0, 30)}`, prompt: words, status: 'queued' })
      .select('*')
      .single(),
    'asset',
  ) as { id: string };
  try {
    const job = await startJob(c.env, d, {
      userId: user.id,
      projectId: p.id,
      targetId: asset.id,
      kind: 'voice',
      credits: voiceCredits(words.length, priceConfig(c.env)),
      costUsd: voiceCostUsd(words.length),
      provider: 'fal',
      model: VOICE_MODEL,
      input: { text: words, voice, ...(language ? { language_code: VOICE_LANGS[language] } : {}) },
    });
    return c.json({ job, asset }, 202);
  } catch (e) {
    await d.from('project_assets').delete().eq('id', asset.id);
    throw e;
  }
});

/** Final cut of the current edit list. Trims, volumes and sound overlays need the mixing server. */
app.post('/v1/projects/:id/render', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const p = await getOwnedProject(d, user.id, c.req.param('id'));
  if (busy(p.render_status ?? '')) throw new HttpError(409, 'busy', 'The final cut is already being made.');
  const ctx = await editContext(c.env, d, p);
  if (!ctx.custom && ctx.missingVideos > 0) {
    throw new HttpError(400, 'missing_videos', 'Every shot needs a video before the final cut — or open the editor to cut the film without them.');
  }
  if (!ctx.edit.clips.length) throw new HttpError(400, 'empty_edit', 'Add at least one clip to the cut.');
  const seconds = editLength(ctx.edit);
  const mixer = Boolean(c.env.RENDER_SERVICE_URL);
  if (!mixer && !isSimpleEdit(ctx.edit, ctx.media)) {
    throw new HttpError(400, 'needs_mixer', 'Trims, volume changes and extra sounds need the mixing server, which is not set up yet.');
  }
  const job = await startJob(c.env, d, {
    userId: user.id,
    projectId: p.id,
    targetId: p.id,
    kind: 'render',
    credits: renderCredits(seconds, priceConfig(c.env)),
    costUsd: renderCostUsd(seconds),
    provider: mixer ? 'maya' : 'fal',
    model: mixer ? 'ffmpeg-mixer' : RENDER_MODEL,
    input: { edit: ctx.edit, seconds, mixer },
  });
  await d.from('projects').update({ render_status: 'queued', status: 'rendering' }).eq('id', p.id);
  return c.json({ job }, 202);
});

// ---------------------------------------------------------------- AI Director (paying users)

async function hasDirector(d: ReturnType<typeof db>, userId: string): Promise<boolean> {
  const res = await d.from('profiles').select('director_access').eq('id', userId).maybeSingle();
  return Boolean(res.data?.director_access);
}

async function requireDirector(d: ReturnType<typeof db>, userId: string): Promise<void> {
  if (!(await hasDirector(d, userId))) {
    throw new HttpError(403, 'director_locked', 'The Director is unlocked with your first credit pack.');
  }
}

type FilmInfo = ShotContext['film'];
function filmInfo(p: Awaited<ReturnType<typeof getOwnedProject>>): FilmInfo {
  return { title: p.title, genre: p.genre, style: p.style, language: p.language, aspectRatio: p.aspect_ratio, logline: p.logline };
}
function shotInfo(s: Shot): ShotContext['shot'] {
  return { idx: s.idx, durationSec: s.duration_sec, camera: s.camera, action: s.action, dialogue: s.dialogue, speaker: s.speaker };
}

/** Three ways to shoot one shot. Charged up front, refunded if the Director fails. */
app.post('/v1/shots/:id/direct', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  await requireDirector(d, user.id);
  const shot = await getOwnedShot(d, user.id, c.req.param('id'));
  const p = await getOwnedProject(d, user.id, shot.project_id);
  const [scene, shots, chars] = await Promise.all([
    d.from('scenes').select('heading,summary').eq('id', shot.scene_id).maybeSingle(),
    d.from('shots').select('idx,camera,action').eq('project_id', p.id).in('idx', [shot.idx - 1, shot.idx + 1]),
    d.from('characters').select('name,description').eq('project_id', p.id),
  ]);
  const near = (shots.data ?? []) as { idx: number; camera: string | null; action: string }[];
  const ctx: ShotContext = {
    film: filmInfo(p),
    scene: { heading: scene.data?.heading ?? 'SCENE', summary: scene.data?.summary ?? null },
    characters: (chars.data ?? []) as { name: string; description: string }[],
    previous: near.find((x) => x.idx === shot.idx - 1) ?? null,
    next: near.find((x) => x.idx === shot.idx + 1) ?? null,
    shot: shotInfo(shot),
  };
  const cost = directCostUsd();
  const job = await chargeJob(
    c.env,
    d,
    { userId: user.id, projectId: p.id, targetId: shot.id, kind: 'director', credits: creditsFor(cost, priceConfig(c.env)), costUsd: cost, provider: 'anthropic', model: c.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', input: { action: 'direct' } },
    'running',
  );
  try {
    const { options, costUsd } = await withQuickRetries(() => directShot(c.env, ctx));
    await succeedJob(d, job.id, { options }, costUsd);
    return c.json({ options, credits: job.credits });
  } catch (e) {
    await failJob(d, job.id, e instanceof Error ? e.message : String(e));
    throw new HttpError(
      e instanceof ProviderBusyError ? 503 : 502,
      'director_failed',
      e instanceof ProviderBusyError ? 'The AI is very busy right now. Your credits were returned — try again in a minute.' : 'The Director could not answer just now. Your credits were returned.',
    );
  }
});

/** Director's review of the whole shot list. */
app.post('/v1/projects/:id/review', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  await requireDirector(d, user.id);
  const p = await getOwnedProject(d, user.id, c.req.param('id'));
  const [scenesRes, shotsRes] = await Promise.all([
    d.from('scenes').select('id,heading,idx').eq('project_id', p.id).order('idx'),
    d.from('shots').select('*').eq('project_id', p.id).order('idx'),
  ]);
  const shots = (shotsRes.data ?? []) as Shot[];
  if (!shots.length) throw new HttpError(400, 'no_shots', 'Write the story first.');
  const scenes = ((scenesRes.data ?? []) as { id: string; heading: string }[]).map((sc) => ({
    heading: sc.heading,
    shots: shots.filter((s) => s.scene_id === sc.id).map(shotInfo),
  }));
  const cost = reviewCostUsd(shots.length);
  const job = await chargeJob(
    c.env,
    d,
    { userId: user.id, projectId: p.id, targetId: p.id, kind: 'director', credits: creditsFor(cost, priceConfig(c.env)), costUsd: cost, provider: 'anthropic', model: c.env.ANTHROPIC_MODEL || 'claude-sonnet-5-5', input: { action: 'review' } },
    'running',
  );
  try {
    const { review, costUsd } = await withQuickRetries(() => reviewFilm(c.env, filmInfo(p), scenes));
    // Point each note at the real shot id so the app can apply it.
    const notes = review.notes.map((n) => ({ ...n, shotId: shots.find((s) => s.idx === n.shot - 1)?.id ?? null })).filter((n) => n.shotId);
    await succeedJob(d, job.id, { review }, costUsd);
    return c.json({ ...review, notes, credits: job.credits });
  } catch (e) {
    await failJob(d, job.id, e instanceof Error ? e.message : String(e));
    throw new HttpError(
      e instanceof ProviderBusyError ? 503 : 502,
      'director_failed',
      e instanceof ProviderBusyError ? 'The AI is very busy right now. Your credits were returned — try again in a minute.' : 'The Director could not answer just now. Your credits were returned.',
    );
  }
});

// ---------------------------------------------------------------- shop-ad orders (operator)

async function requireOperator(d: ReturnType<typeof db>, userId: string): Promise<void> {
  const res = await d.from('profiles').select('role').eq('id', userId).maybeSingle();
  if (res.data?.role !== 'operator') throw new HttpError(403, 'not_operator', 'Shop-ad orders are only for the studio account.');
}

/**
 * Your own clip for a shot (for example made in Google Flow with your own credits). No credits are
 * charged; the clip is checked, kept as the shot's newest take, and used in the final cut.
 */
app.post('/v1/shots/:id/clip', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const shot = await getOwnedShot(d, user.id, c.req.param('id'));
  const p = await getOwnedProject(d, user.id, shot.project_id);
  if (shot.video_status === 'queued' || shot.video_status === 'running') throw new HttpError(409, 'busy', 'This shot is being filmed right now.');
  const type = (c.req.header('content-type') || '').split(';')[0].trim();
  if (!['video/mp4', 'video/quicktime', 'application/octet-stream'].includes(type)) throw new HttpError(415, 'bad_type', 'Send an MP4 video.');
  const buf = await c.req.arrayBuffer();
  if (buf.byteLength < 50_000) throw new HttpError(400, 'too_small', 'That video file is too small.');
  if (buf.byteLength > 90 * 1024 * 1024) throw new HttpError(413, 'too_big', 'Clips must be under 90 MB.');
  const bytes = new Uint8Array(buf);
  const checked = checkOwnClip(bytes, p.aspect_ratio);
  if ('problem' in checked) throw new HttpError(400, 'bad_clip', checked.problem);
  const url = await putBytes(c.env, mediaKey(user.id, p.id, 'video', shot.id, 'mp4'), bytes, 'video/mp4');
  const row = must(
    await d
      .from('shots')
      .update({
        video_url: url,
        video_model: checked.hasAudio ? 'Your clip' : 'Your clip (no sound)',
        prev_video_url: shot.video_url,
        prev_video_model: shot.video_url ? (shot as Shot & { video_model?: string | null }).video_model ?? null : null,
        video_status: 'done',
        duration_sec: checked.seconds,
        takes: shot.takes + 1,
        error: null,
      })
      .eq('id', shot.id)
      .select('*')
      .single(),
    'shot',
  );
  return c.json(row, 201);
});

/** Photo of the customer's shop or product, used as a reference in every frame and on the poster. */
app.post('/v1/uploads/photo', async (c) => {
  const user = c.get('user');
  await requireOperator(db(c.env), user.id); // only the shop-ad order form uploads photos
  const type = (c.req.header('content-type') || '').split(';')[0].trim();
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(type)) throw new HttpError(415, 'bad_type', 'Send a JPG, PNG or WebP photo.');
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength < 1000 || bytes.byteLength > 8 * 1024 * 1024) throw new HttpError(413, 'bad_size', 'Photos must be under 8 MB.');
  const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
  const url = await putBytes(c.env, mediaKey(user.id, 'uploads', 'photo', crypto.randomUUID(), ext), bytes, type);
  return c.json({ url }, 201);
});

app.post('/v1/orders', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  await requireOperator(d, user.id);
  const b = await body(c);
  const photoUrl = optText(b.photo_url, 500) ?? null;
  if (photoUrl && !keyFromUrl(c.env, photoUrl)?.startsWith(`u/${user.id}/`)) throw new HttpError(400, 'invalid', 'Upload the photo through the app first.');
  const brief: AdBrief = {
    businessName: text(b.business_name, 2, 80, 'Shop name'),
    businessType: BUSINESS_TYPES.includes(b.business_type as string) ? (b.business_type as string) : 'Other',
    area: optText(b.area, 80) ?? null,
    offer: text(b.offer, 3, 200, 'Offer'),
    occasion: OCCASIONS.includes(b.occasion as string) ? (b.occasion as string) : null,
    language: ['Marathi', 'Hindi', 'English'].includes(b.language as string) ? (b.language as string) : 'Marathi',
    contactLine: optText(b.contact_line, 120) ?? null,
    photoUrl,
  };
  const target = AD_LENGTHS.includes(Number(b.target_duration_sec)) ? Number(b.target_duration_sec) : 20;
  const price = Math.max(1, Math.round(Number(b.price_inr) || 499));
  const advance = Math.min(price, Math.max(0, Math.round(Number(b.advance_inr) || 0)));
  const tier = (TIERS as string[]).includes(b.tier as string) ? (b.tier as Tier) : 'budget';
  const project = must(
    await d
      .from('projects')
      .insert({
        user_id: user.id,
        kind: 'ad',
        ad_brief: brief,
        title: brief.businessName,
        idea: adIdea(brief),
        genre: 'Ad / promo',
        language: brief.language,
        style: 'bright commercial look, warm inviting light, crisp 35mm, festive Indian colours',
        aspect_ratio: '9:16',
        target_duration_sec: target,
        tier,
      })
      .select('*')
      .single(),
    'project',
  ) as Project;
  const order = must(
    await d
      .from('ad_orders')
      .insert({
        user_id: user.id,
        project_id: project.id,
        customer_name: text(b.customer_name, 2, 80, 'Customer name'),
        customer_phone: text(b.customer_phone, 10, 20, 'Customer phone'),
        business_name: brief.businessName,
        business_type: brief.businessType,
        area: brief.area,
        offer: brief.offer,
        occasion: brief.occasion,
        language: brief.language,
        contact_line: brief.contactLine,
        photo_url: brief.photoUrl,
        price_inr: price,
        advance_inr: advance,
        advance_at: advance > 0 ? new Date().toISOString() : null,
        status: advance >= minAdvance(price) ? 'new' : 'awaiting_advance',
        notes: optText(b.notes, 1000) ?? null,
      })
      .select('*')
      .single(),
    'order',
  );
  return c.json({ order, project }, 201);
});

const ORDER_STATUSES = ['awaiting_advance', 'new', 'producing', 'ready', 'delivered', 'paid', 'cancelled'];

/** No work (and no API spend) on an ad until at least half its price is received. */
async function requireAdvance(d: ReturnType<typeof db>, projectId: string): Promise<void> {
  const o = (await d.from('ad_orders').select('price_inr,advance_inr').eq('project_id', projectId).maybeSingle()).data as Pick<AdOrder, 'price_inr' | 'advance_inr'> | null;
  if (o && o.advance_inr < minAdvance(o.price_inr)) {
    throw new HttpError(402, 'advance_required', `Collect at least ₹${minAdvance(o.price_inr) - o.advance_inr} more advance before starting this ad.`);
  }
}

app.patch('/v1/orders/:id', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  await requireOperator(d, user.id);
  const cur = must(await d.from('ad_orders').select('*').eq('id', c.req.param('id')).eq('user_id', user.id).maybeSingle(), 'order') as AdOrder;
  const b = await body(c);
  let status = ORDER_STATUSES.includes(b.status as string) ? (b.status as string) : undefined;
  const price = b.price_inr !== undefined ? Math.max(1, Math.round(Number(b.price_inr) || 0)) : cur.price_inr;
  const advance = b.advance_inr !== undefined ? Math.min(price, Math.max(0, Math.round(Number(b.advance_inr) || 0))) : cur.advance_inr;
  const advanced = advance >= minAdvance(price);
  const target = status ?? cur.status;
  if (!advanced && ['new', 'producing', 'ready', 'delivered'].includes(target)) {
    if (status) throw new HttpError(402, 'advance_required', `Record at least ₹${minAdvance(price)} advance first.`);
    status = 'awaiting_advance';
  }
  if (advanced && target === 'awaiting_advance') status = 'new';
  const patch = clean({
    status,
    price_inr: b.price_inr !== undefined ? price : undefined,
    advance_inr: b.advance_inr !== undefined ? advance : undefined,
    advance_at: b.advance_inr !== undefined && advance > cur.advance_inr ? new Date().toISOString() : undefined,
    notes: optText(b.notes, 1000),
    delivered_at: status === 'delivered' && !cur.delivered_at ? new Date().toISOString() : undefined,
    paid_at: status === 'paid' && !cur.paid_at ? new Date().toISOString() : undefined,
  });
  return c.json(must(await d.from('ad_orders').update(patch).eq('id', cur.id).select('*').single(), 'order'));
});

/** Ready-made WhatsApp chat link with the Reel and poster links for the customer. */
app.get('/v1/orders/:id/whatsapp', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  await requireOperator(d, user.id);
  const o = must(await d.from('ad_orders').select('*').eq('id', c.req.param('id')).eq('user_id', user.id).maybeSingle(), 'order') as AdOrder;
  const p = o.project_id ? (await d.from('projects').select('final_video_url,poster_url').eq('id', o.project_id).maybeSingle()).data : null;
  const message = waMessage({
    customerName: o.customer_name,
    businessName: o.business_name,
    videoUrl: p?.final_video_url ?? null,
    posterUrl: p?.poster_url ?? null,
    priceInr: o.price_inr,
    advanceInr: o.advance_inr,
    paid: o.status === 'paid',
  });
  return c.json({ link: waLink(o.customer_phone, message), message });
});

app.post('/v1/projects/:id/poster', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const p = await getOwnedProject(d, user.id, c.req.param('id'));
  if (p.kind !== 'ad') throw new HttpError(400, 'not_ad', 'Posters are made for shop ads.');
  if (busy(p.poster_status ?? '')) throw new HttpError(409, 'busy', 'The poster is already being made.');
  const cost = imageCostUsd();
  const job = await startJob(c.env, d, {
    userId: user.id,
    projectId: p.id,
    targetId: p.id,
    kind: 'poster',
    credits: creditsFor(cost, priceConfig(c.env)),
    costUsd: cost,
    provider: 'google',
    model: c.env.GEMINI_IMAGE_MODEL || 'gemini-nano-banana-2.1',
  });
  await d.from('projects').update({ poster_status: 'queued' }).eq('id', p.id);
  return c.json({ job }, 202);
});

app.get('/v1/orders/options', (c) => c.json({ businessTypes: BUSINESS_TYPES, occasions: OCCASIONS, lengths: AD_LENGTHS }));

// ---------------------------------------------------------------- billing

app.post('/v1/billing/google-play/verify', async (c) => {
  const user = c.get('user');
  if (!c.env.GOOGLE_SERVICE_ACCOUNT_JSON) throw new HttpError(503, 'billing_off', 'Purchases are not set up yet.');
  const b = await body<{ productId?: string; purchaseToken?: string }>(c);
  const pack = CREDIT_PACKS.find((p) => p.productId === b.productId);
  if (!pack || typeof b.purchaseToken !== 'string' || b.purchaseToken.length < 10) throw new HttpError(400, 'invalid', 'Unknown product.');
  const purchase = await getProductPurchase(c.env, pack.productId, b.purchaseToken);
  if (purchase.purchaseState === 2) throw new HttpError(409, 'pending', 'Payment is still pending. Credits arrive once it completes.');
  if (purchase.purchaseState !== 0) throw new HttpError(400, 'not_purchased', 'This purchase was cancelled.');
  if (purchase.obfuscatedExternalAccountId !== user.id) throw new HttpError(403, 'wrong_account', 'This purchase belongs to another account.');

  const d = db(c.env);
  const existing = await d.from('purchases').select('user_id').eq('provider', 'google_play').eq('purchase_token', b.purchaseToken).maybeSingle();
  if (existing.data && existing.data.user_id !== user.id) throw new HttpError(403, 'wrong_account', 'This purchase belongs to another account.');
  if (!existing.data) {
    const ins = await d.from('purchases').insert({
      user_id: user.id,
      provider: 'google_play',
      product_id: pack.productId,
      order_id: purchase.orderId ?? null,
      purchase_token: b.purchaseToken,
      credits: pack.credits,
      price_inr: pack.priceInr,
      raw: purchase,
    });
    if (ins.error && !ins.error.message.includes('duplicate')) throw new Error(ins.error.message);
  }
  const granted = await d.rpc('grant_credits', {
    p_user: user.id,
    p_amount: pack.credits,
    p_kind: 'purchase',
    p_valid_days: pack.validDays,
    p_ref_type: 'google_play',
    p_ref_id: b.purchaseToken,
    p_note: `${pack.label} pack · ${pack.credits} credits`,
  });
  if (granted.error) throw new Error(granted.error.message);
  // Consume on the server too: if the app closes before it finishes the purchase, Google would
  // otherwise refund it after 3 days while the credits stay granted.
  if (purchase.consumptionState !== 1) await consumeProductPurchase(c.env, pack.productId, b.purchaseToken).catch((e: unknown) => console.error('consume failed', e));
  return c.json({ ok: true, balance: granted.data as number, credits: pack.credits });
});

export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: (_e: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(handleCron(env)),
} satisfies ExportedHandler<Env, JobMessage>;

export { app };
