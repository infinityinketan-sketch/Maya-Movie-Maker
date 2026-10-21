// Real renders with the local ffmpeg: builds small test clips and sounds, mixes them, checks the result.
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { buildArgs, filmLength, validateJob } from '../src/plan.mjs';
import { render, run } from '../src/render.mjs';

let dir;
const files = {};
const BASE = 'https://media.example.com/';
const local = (url, dest) => copyFile(files[url.slice(BASE.length)], dest);

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'maya-test-'));
  const ff = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);
  files.talk = join(dir, 'talk.mp4'); // vertical clip with sound
  await ff(['-f', 'lavfi', '-i', 'testsrc=size=360x640:rate=24:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=4', '-c:v', 'libx264', '-c:a', 'aac', '-shortest', files.talk]);
  files.wide = join(dir, 'wide.mp4'); // wide clip, no sound (must be padded and given silence)
  await ff(['-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=3', '-c:v', 'libx264', files.wide]);
  files.music = join(dir, 'music.mp3');
  await ff(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'libmp3lame', '-b:a', '128k', files.music]);
  files.boom = join(dir, 'boom.wav');
  await ff(['-f', 'lavfi', '-i', 'anoisesrc=d=1:a=0.5', files.boom]);
});

after(() => rm(dir, { recursive: true, force: true }));

const meanVolume = async (file, from, to) => {
  const out = await new Promise((resolve) => {
    import('node:child_process').then(({ spawn }) => {
      const p = spawn('ffmpeg', ['-hide_banner', '-ss', String(from), '-t', String(to - from), '-i', file, '-af', 'volumedetect', '-f', 'null', '-']);
      let err = '';
      p.stderr.on('data', (d) => (err += d));
      p.on('close', () => resolve(err));
    });
  });
  const m = /mean_volume: (-?[\d.]+|-inf) dB/.exec(out);
  return m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : -Infinity;
};

const job = (over) => ({ aspectRatio: '9:16', outputKey: 'u/x/p/final/a.mp4', thumbKey: 'u/x/p/final/a.jpg', audio: [], ...over });

test('trims, reorders, mixes music + sound effect into a vertical 1080x1920 film', async () => {
  const j = job({
    clips: [
      { url: BASE + 'talk', in: 0.5, out: 3.5, volume: 1 },
      { url: BASE + 'wide', in: 0, out: 2, volume: 1 },
      { url: BASE + 'talk', in: 0, out: 1, volume: 1 },
    ],
    audio: [
      { url: BASE + 'music', start: 0, in: 0, out: 2, volume: 0.3, fadeIn: 0.5, fadeOut: 1, loop: true },
      { url: BASE + 'boom', start: 3.2, in: 0, out: 1, volume: 1, fadeIn: 0, fadeOut: 0, loop: false },
    ],
  });
  assert.equal(validateJob(j, BASE), null);
  const out = await render(j, { download: local });
  assert.equal(out.width, 1080);
  assert.equal(out.height, 1920);
  assert.ok(out.hasAudio);
  assert.ok(Math.abs(out.seconds - 6) < 0.15, `length ${out.seconds}`);
  assert.ok(out.thumb && out.thumb.length > 1000, 'has a cover frame');
  const f = join(dir, 'mix.mp4');
  await import('node:fs/promises').then((fs) => fs.writeFile(f, out.video));
  // The wide clip has no sound of its own, but the looped music must still be heard there (3.0–5.0 s).
  assert.ok((await meanVolume(f, 4.3, 4.9)) > -45, 'music loops under the silent clip');
});

test('volume 0 mutes a clip completely', async () => {
  const out = await render(job({ clips: [{ url: BASE + 'talk', in: 0, out: 2, volume: 0 }] }), { download: local });
  const f = join(dir, 'mute.mp4');
  await import('node:fs/promises').then((fs) => fs.writeFile(f, out.video));
  assert.ok((await meanVolume(f, 0.2, 1.8)) < -80, 'muted');
});

test('wide film: clips are padded, overlay starting after the end is ignored', async () => {
  const j = job({
    aspectRatio: '16:9',
    clips: [{ url: BASE + 'talk', in: 0, out: 2, volume: 1 }],
    audio: [{ url: BASE + 'boom', start: 5, in: 0, out: 1, volume: 1, fadeIn: 0, fadeOut: 0, loop: false }],
  });
  const out = await render(j, { download: local });
  assert.deepEqual([out.width, out.height], [1920, 1080]);
  assert.ok(Math.abs(out.seconds - 2) < 0.15);
});

test('trims past the real end of a file are cut back', async () => {
  const out = await render(job({ clips: [{ url: BASE + 'wide', in: 0, out: 8, volume: 1 }] }), { download: local });
  assert.ok(Math.abs(out.seconds - 3) < 0.15, `length ${out.seconds}`);
});

test('validateJob refuses foreign URLs, bad keys and bad numbers', () => {
  const ok = job({ clips: [{ url: BASE + 'a', in: 0, out: 2, volume: 1 }] });
  assert.equal(validateJob(ok, BASE), null);
  assert.match(validateJob({ ...ok, clips: [{ url: 'http://169.254.169.254/x', in: 0, out: 2, volume: 1 }] }, BASE), /not allowed/);
  assert.match(validateJob({ ...ok, outputKey: '../etc/passwd' }, BASE), /outputKey/);
  assert.match(validateJob({ ...ok, clips: [{ url: BASE + 'a', in: 2, out: 2, volume: 1 }] }, BASE), /numbers/);
  assert.match(validateJob({ ...ok, clips: [] }, BASE), /clips/);
});

test('buildArgs: one input per use, loops music, limiter on the mix', () => {
  const args = buildArgs(
    { aspectRatio: '9:16', clips: [{ in: 0, out: 4, volume: 1 }, { in: 1, out: 3, volume: 0.5 }], audio: [{ start: 1, in: 0, out: 30, volume: 0.3, fadeIn: 1, fadeOut: 2, loop: true }] },
    { clipFiles: ['a', 'a'], clipHasAudio: [true, false], audioFiles: ['m'] },
    'out.mp4',
  );
  assert.equal(args.filter((a) => a === '-i').length, 3);
  const graph = args[args.indexOf('-filter_complex') + 1];
  assert.match(graph, /aloop=loop=-1:size=1440000/);
  assert.match(graph, /adelay=1000:all=1/);
  assert.match(graph, /afade=t=out:st=3:d=2/); // music runs 1 s → 6 s, fades over the last 2 s
  assert.match(graph, /aevalsrc=0/); // silent clip gets silence
  assert.match(graph, /amix=inputs=2.*alimiter/);
  assert.equal(filmLength([{ in: 0, out: 4 }, { in: 1, out: 3 }]), 6);
});
