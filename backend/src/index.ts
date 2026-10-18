import { Hono, type Context } from 'hono';
import { balanceOf, db, getOwnedCharacter, getOwnedProject, getOwnedShot, must, type Shot } from './db';
import { HttpError, type AppUser, type Env, type JobMessage } from './env';
import { assertCanAfford, startJob } from './jobs';
import { verifyFalWebhook, type FalWebhook } from './providers/fal';
import { getProductPurchase } from './providers/googleplay';
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
  snapDuration,
  TIERS,
  VIDEO_MODELS,
  videoCostUsd,
  type Tier,
} from './pricing';
import { deletePrefix } from './storage';
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

app.get('/v1/catalog', (c) => c.json(catalog(priceConfig(c.env))));

app.post('/v1/webhooks/fal', async (c) => {
  const raw = await c.req.arrayBuffer();
  if (!(await verifyFalWebhook(c.req.raw.headers, raw))) return c.json({ error: 'bad_signature' }, 401);
  const hook = JSON.parse(new TextDecoder().decode(raw)) as FalWebhook;
  const d = db(c.env);
  const job = await d.from('jobs').select('id').eq('provider_request_id', hook.request_id).maybeSingle();
  if (!job.data) return c.json({ ok: true, ignored: true });
  const msg: JobMessage = {
    type: 'finalize',
    jobId: job.data.id,
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
  if (path === '/v1/catalog' || path.startsWith('/v1/webhooks/')) return next();
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

// ---------------------------------------------------------------- account

app.get('/v1/me', async (c) => {
  const user = c.get('user');
  return c.json({ user, balance: await balanceOf(db(c.env), user.id) });
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
    input: { tier },
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

app.post('/v1/projects/:id/render', async (c) => {
  const user = c.get('user');
  const d = db(c.env);
  const p = await getOwnedProject(d, user.id, c.req.param('id'));
  const shots = ((await d.from('shots').select('video_url,duration_sec').eq('project_id', p.id)).data ?? []) as Shot[];
  if (!shots.length || shots.some((s) => !s.video_url)) throw new HttpError(400, 'missing_videos', 'Every shot needs a video before the final cut.');
  const seconds = shots.reduce((s, x) => s + x.duration_sec, 0);
  const cost = renderCostUsd(seconds);
  const job = await startJob(c.env, d, {
    userId: user.id,
    projectId: p.id,
    targetId: p.id,
    kind: 'render',
    credits: renderCredits(seconds, priceConfig(c.env)),
    costUsd: cost,
    provider: 'fal',
    model: RENDER_MODEL,
  });
  await d.from('projects').update({ render_status: 'queued', status: 'rendering' }).eq('id', p.id);
  return c.json({ job }, 202);
});

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
  return c.json({ ok: true, balance: granted.data as number, credits: pack.credits });
});

export default {
  fetch: app.fetch,
  queue: handleQueue,
  scheduled: (_e: ScheduledController, env: Env, ctx: ExecutionContext) => ctx.waitUntil(handleCron(env)),
} satisfies ExportedHandler<Env, JobMessage>;

export { app };
