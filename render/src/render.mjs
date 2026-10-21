import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { buildArgs, filmLength, thumbArgs } from './plan.mjs';

const MAX_INPUT_BYTES = 300 * 1024 * 1024;

export function run(cmd, args, timeoutMs = 14 * 60_000) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err = (err + d).slice(-4000)));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} failed (${code}): ${err.trim()}`));
    });
  });
}

/** Duration, frame size and whether the file has sound. */
export async function probe(file) {
  const json = JSON.parse(await run('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], 60_000));
  const v = json.streams.find((s) => s.codec_type === 'video');
  return {
    seconds: Number(json.format?.duration ?? 0),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    hasVideo: Boolean(v),
    hasAudio: json.streams.some((s) => s.codec_type === 'audio'),
  };
}

/** Default downloader: plain HTTPS GET to a file. */
export async function httpDownload(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok || !res.body) throw new Error(`could not download ${url} (${res.status})`);
  if (Number(res.headers.get('content-length') || 0) > MAX_INPUT_BYTES) throw new Error('input file too large');
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

/**
 * Renders an edit list. Returns the finished MP4 (and cover JPEG) as buffers with a probe of the result.
 * @param {object} job validated job body
 * @param {{download?: (url: string, dest: string) => Promise<void>}} deps
 */
export async function render(job, deps = {}) {
  const download = deps.download ?? httpDownload;
  const dir = await mkdtemp(join(tmpdir(), 'maya-'));
  try {
    // Each distinct URL is fetched once, even if several clips use it.
    const files = new Map();
    let i = 0;
    const fetchOnce = async (url) => {
      if (!files.has(url)) {
        const dest = join(dir, `in${i++}`);
        files.set(url, download(url, dest).then(() => dest));
      }
      return files.get(url);
    };
    const clipFiles = await Promise.all(job.clips.map((c) => fetchOnce(c.url)));
    const audioFiles = await Promise.all(job.audio.map((a) => fetchOnce(a.url)));

    const probes = new Map();
    for (const f of new Set([...clipFiles, ...audioFiles])) probes.set(f, await probe(f));
    clipFiles.forEach((f, k) => {
      if (!probes.get(f).hasVideo) throw new Error(`clip ${k + 1} has no picture`);
    });
    audioFiles.forEach((f, k) => {
      if (!probes.get(f).hasAudio) throw new Error(`sound ${k + 1} has no audio`);
    });
    // Never trim past the real end of a file.
    const clips = job.clips.map((c, k) => {
      const len = probes.get(clipFiles[k]).seconds || c.out;
      const out = Math.min(c.out, len);
      return { ...c, out: out - c.in < 0.2 ? Math.min(len, c.in + 0.2) : out, in: Math.min(c.in, Math.max(0, len - 0.2)) };
    });
    const audio = job.audio.map((a, k) => {
      const len = probes.get(audioFiles[k]).seconds || a.out;
      const inn = Math.min(a.in, Math.max(0, len - 0.1));
      return { ...a, in: inn, out: Math.max(inn + 0.1, Math.min(a.out, len)) };
    });
    const edit = { aspectRatio: job.aspectRatio, clips, audio };

    const outFile = join(dir, 'out.mp4');
    await run('ffmpeg', buildArgs(edit, { clipFiles, clipHasAudio: clipFiles.map((f) => probes.get(f).hasAudio), audioFiles }, outFile));
    const result = await probe(outFile);
    const thumbFile = join(dir, 'thumb.jpg');
    const thumb = await run('ffmpeg', thumbArgs(outFile, filmLength(clips), thumbFile), 60_000)
      .then(() => readFile(thumbFile))
      .catch(() => null);
    return { video: await readFile(outFile), thumb, bytes: (await stat(outFile)).size, ...result };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
