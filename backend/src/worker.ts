// Queue consumer: runs each paid job once. A busy/overloaded provider is retried after
// 10 s, 30 s and 90 s (nothing was generated yet, so nothing is paid twice); any other
// error, or a result that fails its checks, refunds the credits (fail_job).
import { db, must, type Character, type Db, type Job, type Project, type Shot } from './db';
import type { Env, JobMessage } from './env';
import { failJob, succeedJob } from './jobs';
import { planFilm } from './providers/anthropic';
import { falLookup, falSubmit, resultUrl, type FalSubmission } from './providers/fal';
import { generateImage, type InlineImage } from './providers/gemini';
import { posterPrompt } from './ads';
import { billedSeconds, MUSIC_MODEL, RENDER_MODEL, VIDEO_MODELS, type Tier } from './pricing';
import { checkMedia, ProviderBusyError, retryDelay, type MediaExpectation } from './reliability';
import { copyFromUrl, download, fromBase64, mediaKey, putBytes, readAsBase64 } from './storage';

export async function handleQueue(batch: MessageBatch<JobMessage>, env: Env): Promise<void> {
  const d = db(env);
  for (const msg of batch.messages) {
    try {
      if (msg.body.type === 'start') await startJobWork(env, d, msg.body.jobId);
      else await finalizeJob(env, d, msg.body);
    } catch (e) {
      console.error('job error', msg.body, e);
      if (e instanceof ProviderBusyError && (await retryLater(env, d, msg.body, e))) {
        msg.ack();
        continue;
      }
      try {
        await markTarget(d, await loadJob(d, msg.body.jobId), 'failed', errText(e));
        await failJob(d, msg.body.jobId, errText(e));
      } catch (inner) {
        console.error('could not fail job', inner);
      }
    }
    msg.ack();
  }
}

/** Re-queues a job whose provider was busy. Returns false once the retries are used up. */
async function retryLater(env: Env, d: Db, body: JobMessage, e: ProviderBusyError): Promise<boolean> {
  const attempt = body.attempt ?? 0;
  const delay = retryDelay(attempt);
  if (delay === null) return false;
  try {
    const patch: Record<string, unknown> = { attempts: attempt + 1, error: e.message.slice(0, 300) };
    if (body.type === 'start') patch.status = 'queued'; // run the provider call again
    await update(d, 'jobs', body.jobId, patch);
    await env.JOBS.send({ ...body, attempt: attempt + 1 }, { delaySeconds: delay });
    return true;
  } catch (inner) {
    console.error('could not re-queue', inner);
    return false;
  }
}

async function saveSubmission(d: Db, jobId: string, sub: FalSubmission): Promise<void> {
  await update(d, 'jobs', jobId, { provider_request_id: sub.requestId, provider_status_url: sub.statusUrl, provider_response_url: sub.responseUrl });
}

function errText(e: unknown): string {
  if (e instanceof ProviderBusyError) return 'The AI service is busy right now. Your credits were returned — please try again in a few minutes.';
  return e instanceof Error ? e.message : String(e);
}

async function loadJob(d: Db, id: string): Promise<Job> {
  return must(await d.from('jobs').select('*').eq('id', id).maybeSingle(), 'job') as Job;
}

async function loadProject(d: Db, id: string): Promise<Project> {
  return must(await d.from('projects').select('*').eq('id', id).maybeSingle(), 'project') as Project;
}

async function update(d: Db, table: string, id: string, patch: Record<string, unknown>): Promise<void> {
  const res = await d.from(table).update(patch).eq('id', id);
  if (res.error) throw new Error(`${table}: ${res.error.message}`);
}

/** Mirrors job progress onto the row the app is watching. */
async function markTarget(d: Db, job: Job, status: 'running' | 'done' | 'failed', error?: string, extra: Record<string, unknown> = {}) {
  if (!job.target_id) return;
  const e = error ? { error: error.slice(0, 500) } : {};
  switch (job.kind) {
    case 'plan':
      return update(d, 'projects', job.target_id, {
        status: status === 'running' ? 'planning' : status === 'done' ? 'planned' : 'failed',
        ...e,
        ...extra,
      });
    case 'portrait':
      return update(d, 'characters', job.target_id, { portrait_status: status, ...extra });
    case 'keyframe':
      return update(d, 'shots', job.target_id, { keyframe_status: status, ...e, ...extra });
    case 'video':
      return update(d, 'shots', job.target_id, { video_status: status, ...e, ...extra });
    case 'music':
      return update(d, 'projects', job.target_id, { music_status: status, ...extra });
    case 'poster':
      return update(d, 'projects', job.target_id, { poster_status: status, ...extra });
    case 'render':
      return update(d, 'projects', job.target_id, {
        render_status: status,
        status: status === 'done' ? 'done' : status === 'failed' ? 'planned' : 'rendering',
        ...e,
        ...extra,
      });
  }
}

async function startJobWork(env: Env, d: Db, jobId: string): Promise<void> {
  const job = await loadJob(d, jobId);
  if (job.status !== 'queued') return; // already handled (queue redelivery)
  await update(d, 'jobs', job.id, { status: 'running' });
  await markTarget(d, job, 'running');

  switch (job.kind) {
    case 'plan':
      return runPlan(env, d, job);
    case 'portrait':
      return runPortrait(env, d, job);
    case 'keyframe':
      return runKeyframe(env, d, job);
    case 'video':
      return submitVideo(env, d, job);
    case 'music':
      return submitMusic(env, d, job);
    case 'render':
      return submitRender(env, d, job);
    case 'poster':
      return runPoster(env, d, job);
    case 'director':
      return; // handled inside the request
  }
}

async function runPoster(env: Env, d: Db, job: Job): Promise<void> {
  const p = await loadProject(d, job.project_id!);
  if (!p.ad_brief) throw new Error('this film has no shop details');
  const photo = p.ad_brief.photoUrl ? await readAsBase64(env, p.ad_brief.photoUrl) : null;
  const img = await generateImage(env, { aspectRatio: '9:16', refs: photo ? [photo] : [], prompt: posterPrompt(p.ad_brief) });
  const url = await saveImage(env, p, 'poster', p.id, img);
  await markTarget(d, job, 'done', undefined, { poster_url: url });
  await succeedJob(d, job.id, { url });
}

// ---------------------------------------------------------------- plan

async function runPlan(env: Env, d: Db, job: Job): Promise<void> {
  const p = await loadProject(d, job.project_id!);
  const { plan, costUsd } = await planFilm(env, {
    idea: p.idea,
    genre: p.genre,
    language: p.language,
    style: p.style,
    aspectRatio: p.aspect_ratio,
    targetSec: p.target_duration_sec,
    ad: p.kind === 'ad' ? p.ad_brief : null,
  });

  // Replace any earlier plan for this project.
  await d.from('scenes').delete().eq('project_id', p.id);
  await d.from('characters').delete().eq('project_id', p.id);

  const chars = plan.characters.length
    ? (must(
        await d
          .from('characters')
          .insert(plan.characters.map((c, i) => ({ project_id: p.id, user_id: p.user_id, idx: i, name: c.name, description: c.description, voice: c.voice ?? null })))
          .select('id,name'),
        'characters',
      ) as { id: string; name: string }[])
    : [];
  const idByName = new Map(chars.map((c) => [c.name.toLowerCase(), c.id]));

  let shotIdx = 0;
  for (let s = 0; s < plan.scenes.length; s++) {
    const sc = plan.scenes[s];
    const scene = must(
      await d.from('scenes').insert({ project_id: p.id, user_id: p.user_id, idx: s, heading: sc.heading, summary: sc.summary }).select('id').single(),
      'scene',
    ) as { id: string };
    const rows = sc.shots.map((sh) => {
      const names = new Set([...(sh.characters ?? []), ...(sh.speaker ? [sh.speaker] : [])].map((n) => n.toLowerCase()));
      return {
        project_id: p.id,
        scene_id: scene.id,
        user_id: p.user_id,
        idx: shotIdx++,
        duration_sec: sh.duration_sec,
        camera: sh.camera,
        action: sh.action,
        dialogue: sh.dialogue ?? null,
        speaker: sh.speaker ?? null,
        character_ids: [...names].map((n) => idByName.get(n)).filter(Boolean),
      };
    });
    must(await d.from('shots').insert(rows).select('id'), 'shots');
  }

  await markTarget(d, job, 'done', undefined, {
    title: plan.title,
    logline: plan.logline,
    synopsis: plan.synopsis,
    music_prompt: plan.music_prompt,
    error: null,
  });
  await succeedJob(d, job.id, { scenes: plan.scenes.length, shots: shotIdx, characters: chars.length }, costUsd);
}

// ---------------------------------------------------------------- images

function styleOf(p: Project): string {
  return p.style || 'cinematic film still, natural light, shallow depth of field, 35mm';
}

async function runPortrait(env: Env, d: Db, job: Job): Promise<void> {
  const c = must(await d.from('characters').select('*').eq('id', job.target_id!).maybeSingle(), 'character') as Character;
  const p = await loadProject(d, c.project_id);
  const img = await generateImage(env, {
    aspectRatio: '16:9',
    prompt: [
      `Character reference sheet for a film. Style: ${styleOf(p)}.`,
      'Left: full-body front view. Right: head-and-shoulders close-up of the same person. Plain light-grey background, even soft studio light, no text.',
      `Character "${c.name}": ${c.description}`,
    ].join('\n'),
  });
  const url = await saveImage(env, p, 'portrait', c.id, img);
  await markTarget(d, job, 'done', undefined, { portrait_url: url });
  await succeedJob(d, job.id, { url });
}

async function runKeyframe(env: Env, d: Db, job: Job): Promise<void> {
  const shot = must(await d.from('shots').select('*').eq('id', job.target_id!).maybeSingle(), 'shot') as Shot;
  const p = await loadProject(d, shot.project_id);
  const chars = shot.character_ids.length
    ? ((await d.from('characters').select('*').in('id', shot.character_ids)).data as Character[]) ?? []
    : [];
  const refs: InlineImage[] = [];
  const brandPhoto = p.kind === 'ad' && p.ad_brief?.photoUrl ? await readAsBase64(env, p.ad_brief.photoUrl) : null;
  if (brandPhoto) refs.push(brandPhoto);
  for (const c of chars) {
    if (!c.portrait_url) continue;
    const img = await readAsBase64(env, c.portrait_url);
    if (img) refs.push(img);
  }
  const img = await generateImage(env, {
    aspectRatio: p.aspect_ratio,
    refs,
    prompt: [
      `First frame of a shot from a film. Style: ${styleOf(p)}.`,
      shot.camera ? `Camera: ${shot.camera}.` : '',
      shot.action,
      chars.length ? `Characters in frame: ${chars.map((c) => `${c.name} — ${c.description}`).join(' | ')}` : '',
      brandPhoto ? 'The first reference image is the real shop/product: match its look, colours and products.' : '',
      chars.some((c) => c.portrait_url) ? 'Keep every character exactly as in their reference images: same face, hair, skin tone and clothes.' : '',
      'No text, captions, logos or watermarks.',
    ]
      .filter(Boolean)
      .join('\n'),
  });
  const url = await saveImage(env, p, 'keyframe', shot.id, img);
  await markTarget(d, job, 'done', undefined, { keyframe_url: url, approved: false, error: null });
  await succeedJob(d, job.id, { url });
}

async function saveImage(env: Env, p: Project, kind: string, id: string, img: InlineImage): Promise<string> {
  const ext = img.mimeType.includes('jpeg') ? 'jpg' : img.mimeType.includes('webp') ? 'webp' : 'png';
  const bytes = fromBase64(img.data);
  const problem = checkMedia(bytes, img.mimeType, { kind: 'image' });
  if (problem) throw new Error(`The picture was unusable: ${problem}. Your credits were returned — please try again.`);
  return putBytes(env, mediaKey(p.user_id, p.id, kind, id, ext), bytes, img.mimeType);
}

// ---------------------------------------------------------------- fal.ai (async, finished by webhook)

export function videoPrompt(p: Pick<Project, 'language' | 'style'>, shot: Pick<Shot, 'camera' | 'action' | 'dialogue' | 'speaker'>, voice?: string | null): string {
  const parts = [shot.camera ? `${shot.camera}.` : '', shot.action];
  if (shot.dialogue) {
    parts.push(`${shot.speaker || 'The character'} says in ${p.language}: "${shot.dialogue}"${voice ? ` (voice: ${voice})` : ''}.`);
  }
  parts.push('Natural ambient sound and sound effects only. No background music, no subtitles, no on-screen text.');
  return parts.filter(Boolean).join(' ');
}

async function submitVideo(env: Env, d: Db, job: Job): Promise<void> {
  const shot = must(await d.from('shots').select('*').eq('id', job.target_id!).maybeSingle(), 'shot') as Shot;
  const p = await loadProject(d, shot.project_id);
  if (!shot.keyframe_url) throw new Error('shot has no approved storyboard frame');
  let voice: string | null = null;
  if (shot.speaker) {
    const sp = await d.from('characters').select('voice').eq('project_id', p.id).ilike('name', shot.speaker).maybeSingle();
    voice = (sp.data?.voice as string | undefined) ?? null;
  }
  const tier = (job.input.tier as Tier) ?? p.tier;
  const model = VIDEO_MODELS[tier];
  const sub = await falSubmit(
    env,
    model.endpoint,
    model.input({ prompt: videoPrompt(p, shot, voice), imageUrl: shot.keyframe_url, seconds: billedSeconds(tier, shot.duration_sec), aspectRatio: p.aspect_ratio }),
  );
  await saveSubmission(d, job.id, sub);
}

async function submitMusic(env: Env, d: Db, job: Job): Promise<void> {
  const p = await loadProject(d, job.project_id!);
  const sub = await falSubmit(env, MUSIC_MODEL, {
    prompt: `${p.music_prompt || 'cinematic instrumental film score'}. Instrumental only, suitable as background under dialogue.`,
    negative_prompt: 'vocals, singing, lyrics, low quality',
  });
  await saveSubmission(d, job.id, sub);
}

/** Builds the fal FFmpeg compose timeline: shots back to back, music looped quietly underneath. */
export function renderTracks(shots: Pick<Shot, 'video_url' | 'duration_sec'>[], musicUrl: string | null, musicLoopSec = 30) {
  let t = 0;
  const video = shots.map((s) => {
    const k = { url: s.video_url!, timestamp: t, duration: s.duration_sec * 1000 };
    t += s.duration_sec * 1000;
    return k;
  });
  const tracks: { id: string; type: 'video' | 'audio'; keyframes: { url: string; timestamp: number; duration: number }[] }[] = [
    { id: 'shots', type: 'video', keyframes: video },
  ];
  if (musicUrl) {
    const music: { url: string; timestamp: number; duration: number }[] = [];
    for (let m = 0; m < t; m += musicLoopSec * 1000) music.push({ url: musicUrl, timestamp: m, duration: Math.min(musicLoopSec * 1000, t - m) });
    tracks.push({ id: 'music', type: 'audio', keyframes: music });
  }
  return { tracks, totalMs: t };
}

async function submitRender(env: Env, d: Db, job: Job): Promise<void> {
  const p = await loadProject(d, job.project_id!);
  const shots = (await d.from('shots').select('video_url,duration_sec,idx').eq('project_id', p.id).order('idx')).data as Shot[];
  if (!shots?.length || shots.some((s) => !s.video_url)) throw new Error('every shot needs a video before rendering');
  const { tracks } = renderTracks(shots, p.music_url);
  const sub = await falSubmit(env, RENDER_MODEL, { tracks });
  await saveSubmission(d, job.id, sub);
}

// ---------------------------------------------------------------- webhook results

async function finalizeJob(env: Env, d: Db, msg: Extract<JobMessage, { type: 'finalize' }>): Promise<void> {
  const job = await loadJob(d, msg.jobId);
  if (job.status === 'succeeded' || job.status === 'failed') return; // duplicate or late delivery
  if (!msg.ok) {
    await markTarget(d, job, 'failed', msg.error || 'generation failed');
    await failJob(d, job.id, msg.error || 'generation failed');
    return;
  }
  const out = resultUrl(job.kind, msg.result);
  if (!out) throw new Error('the provider sent no file back');
  const p = await loadProject(d, job.project_id!);

  if (job.kind === 'video') {
    const shot = must(await d.from('shots').select('takes,video_url,video_model,duration_sec').eq('id', job.target_id!).maybeSingle(), 'shot') as {
      takes: number;
      video_url: string | null;
      video_model: string | null;
      duration_sec: number;
    };
    const tier = (job.input.tier as Tier) ?? p.tier;
    const url = await keepChecked(env, out.url, mediaKey(p.user_id, p.id, 'video', job.target_id!, 'mp4'), 'video/mp4', {
      kind: 'video',
      seconds: billedSeconds(tier, shot.duration_sec),
      aspectRatio: p.aspect_ratio,
      needsAudio: true,
    });
    const label = VIDEO_MODELS[tier]?.label ?? job.model;
    // Keep the previous take so two models can be compared side by side.
    await markTarget(d, job, 'done', undefined, {
      video_url: url,
      video_model: label,
      prev_video_url: shot.video_url,
      prev_video_model: shot.video_url ? shot.video_model : null,
      takes: shot.takes + 1,
      error: null,
    });
    await succeedJob(d, job.id, { url });
  } else if (job.kind === 'music') {
    const url = await keepChecked(env, out.url, mediaKey(p.user_id, p.id, 'music', p.id, 'wav'), 'audio/wav', { kind: 'music' });
    await markTarget(d, job, 'done', undefined, { music_url: url });
    await succeedJob(d, job.id, { url });
  } else if (job.kind === 'render') {
    const shots = ((await d.from('shots').select('duration_sec').eq('project_id', p.id)).data ?? []) as { duration_sec: number }[];
    const seconds = shots.reduce((n, x) => n + x.duration_sec, 0);
    const url = await keepChecked(env, out.url, mediaKey(p.user_id, p.id, 'final', p.id, 'mp4'), 'video/mp4', {
      kind: 'render',
      seconds,
      aspectRatio: p.aspect_ratio,
      needsAudio: true,
    });
    const thumb = out.thumbnail ? await copyFromUrl(env, out.thumbnail, mediaKey(p.user_id, p.id, 'final', `${p.id}-thumb`, 'jpg'), 'image/jpeg').catch(() => null) : null;
    await markTarget(d, job, 'done', undefined, { final_video_url: url, thumbnail_url: thumb, error: null });
    await succeedJob(d, job.id, { url, thumbnail: thumb });
  }
}

/** Above this size a file is streamed straight to storage and only its size is checked. */
const MAX_INSPECT_BYTES = 60 * 1024 * 1024;

/** Downloads a result, rejects it if it is broken (the job then fails and refunds), and stores it. */
async function keepChecked(env: Env, sourceUrl: string, key: string, fallbackType: string, exp: MediaExpectation): Promise<string> {
  const got = await download(sourceUrl, MAX_INSPECT_BYTES);
  if ('tooBig' in got) return copyFromUrl(env, sourceUrl, key, got.contentType || fallbackType);
  const type = got.contentType || fallbackType;
  const problem = checkMedia(got.bytes, type, exp);
  if (problem) throw new Error(`The result was unusable: ${problem}. Your credits were returned — please try again.`);
  return putBytes(env, key, got.bytes, type.startsWith('application/') ? fallbackType : type);
}

// ---------------------------------------------------------------- cron

/**
 * Every 30 minutes: jobs with no news for 45 minutes are looked up at fal.ai — a finished result is
 * collected, one still running is left alone (up to 3 hours), anything else fails and refunds.
 * Also expires old credits.
 */
export async function handleCron(env: Env): Promise<void> {
  const d = db(env);
  const cutoff = new Date(Date.now() - 45 * 60_000).toISOString();
  const giveUpBefore = Date.now() - 3 * 3600_000;
  const stuck = await d.from('jobs').select('*').in('status', ['queued', 'running']).lt('updated_at', cutoff).limit(200);
  for (const job of (stuck.data ?? []) as (Job & { created_at: string })[]) {
    try {
      if (job.status === 'running' && job.provider_status_url && job.provider_response_url) {
        const found = await falLookup(env, job.provider_status_url, job.provider_response_url);
        if (found.state === 'done') {
          await env.JOBS.send({ type: 'finalize', jobId: job.id, ok: found.ok, result: found.payload, error: found.error });
          continue;
        }
        if (Date.parse(job.created_at) > giveUpBefore) continue; // still being made
      }
    } catch (e) {
      if (Date.parse(job.created_at) > giveUpBefore) continue; // fal.ai unreachable right now: check again next run
      console.error('lookup failed', job.id, e);
    }
    await markTarget(d, job, 'failed', 'timed out').catch(() => undefined);
    await failJob(d, job.id, 'The provider did not finish in time. Your credits were returned.');
  }
  const exp = await d.rpc('expire_all_credits');
  if (exp.error) console.error('expire credits', exp.error.message);
}
