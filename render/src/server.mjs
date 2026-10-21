// Maya mixing server: POST /render with an edit list → finished MP4 uploaded to R2.
// Runs one render at a time; host it with scale-to-zero (see SETUP.md).
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { AwsClient } from 'aws4fetch';
import { validateJob } from './plan.mjs';
import { render } from './render.mjs';

const env = process.env;
const PORT = Number(env.PORT || 8080);
const required = ['RENDER_SECRET', 'MEDIA_PUBLIC_BASE', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET'];
for (const k of required) if (!env[k]) console.warn(`missing env ${k}`);

const r2 = new AwsClient({ accessKeyId: env.R2_ACCESS_KEY_ID ?? '', secretAccessKey: env.R2_SECRET_ACCESS_KEY ?? '', service: 's3', region: 'auto' });
const mediaBase = (env.MEDIA_PUBLIC_BASE ?? '').replace(/\/$/, '') + '/';

async function upload(key, body, contentType) {
  const url = `${env.R2_ENDPOINT.replace(/\/$/, '')}/${env.R2_BUCKET}/${key}`;
  const res = await r2.fetch(url, {
    method: 'PUT',
    body,
    headers: { 'content-type': contentType, 'cache-control': 'public, max-age=31536000, immutable', 'x-amz-content-sha256': 'UNSIGNED-PAYLOAD' },
  });
  if (!res.ok) throw new Error(`upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return mediaBase + key;
}

function authorized(req) {
  const got = Buffer.from(req.headers.authorization ?? '');
  const want = Buffer.from(`Bearer ${env.RENDER_SECRET ?? ''}`);
  return Boolean(env.RENDER_SECRET) && got.length === want.length && timingSafeEqual(got, want);
}

function send(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

let busy = false;

createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/health') return send(res, 200, { ok: true, busy });
  if (req.method !== 'POST' || req.url !== '/render') return send(res, 404, { error: 'not_found' });
  if (!authorized(req)) return send(res, 401, { error: 'unauthorized' });
  if (busy) return send(res, 503, { error: 'busy' }); // the API retries later
  let job;
  try {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    job = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return send(res, 400, { error: 'bad_json' });
  }
  const problem = validateJob(job, mediaBase);
  if (problem) return send(res, 400, { error: 'bad_job', message: problem });

  busy = true;
  const started = Date.now();
  try {
    const out = await render(job);
    const url = await upload(job.outputKey, out.video, 'video/mp4');
    const thumbnailUrl = out.thumb && job.thumbKey ? await upload(job.thumbKey, out.thumb, 'image/jpeg').catch(() => null) : null;
    console.log(`rendered ${job.outputKey} ${out.seconds.toFixed(1)}s in ${((Date.now() - started) / 1000).toFixed(1)}s`);
    send(res, 200, { url, thumbnailUrl, bytes: out.bytes, seconds: out.seconds, width: out.width, height: out.height, hasAudio: out.hasAudio });
  } catch (e) {
    console.error('render failed', e);
    // Input problems (broken file, no picture) are the user's to fix: 422. Anything else: 500 → retried.
    const msg = e instanceof Error ? e.message : String(e);
    const userFault = /has no picture|has no audio|could not download .* \(4\d\d\)|too large|Invalid data/.test(msg);
    send(res, userFault ? 422 : 500, { error: userFault ? 'bad_media' : 'render_failed', message: msg.slice(0, 500) });
  } finally {
    busy = false;
  }
}).listen(PORT, () => console.log(`maya-render listening on ${PORT}`));
