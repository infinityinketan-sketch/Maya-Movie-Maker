// Turns an edit list into one FFmpeg command. Pure: no files, no network — easy to test.
//
// Edit list (already validated by the API):
//   clips: [{ url, in, out, volume }]                       played one after another
//   audio: [{ url, start, in, out, volume, fadeIn, fadeOut, loop }]   laid over the film
//
// Every clip is trimmed, scaled/padded to the film's frame, set to 30 fps and given a stereo
// track (silence if it has none), so clips from different models join cleanly. Overlays are
// trimmed, optionally looped, faded, delayed to their start time and mixed with the clips' own
// sound; a limiter stops loud mixes from clipping.

export const FRAME = { '9:16': { w: 1080, h: 1920 }, '16:9': { w: 1920, h: 1080 } };
export const SAMPLE_RATE = 48000;

const n = (x) => Number(x.toFixed(3)); // ffmpeg-friendly decimals

/** Total length of the film in seconds. */
export function filmLength(clips) {
  return n(clips.reduce((s, c) => s + (c.out - c.in), 0));
}

/**
 * @param {{aspectRatio: '9:16'|'16:9', clips: any[], audio: any[]}} edit
 * @param {{clipFiles: string[], clipHasAudio: boolean[], audioFiles: string[]}} media local files, same order as the edit
 * @param {string} outFile
 * @returns {string[]} ffmpeg arguments
 */
export function buildArgs(edit, media, outFile) {
  const { w, h } = FRAME[edit.aspectRatio] ?? FRAME['9:16'];
  const total = filmLength(edit.clips);
  if (!edit.clips.length || total <= 0) throw new Error('the edit has no clips');

  const args = ['-hide_banner', '-loglevel', 'error', '-y'];
  const graph = [];
  let input = 0;

  // ---- clips
  const pairs = [];
  edit.clips.forEach((c, i) => {
    const k = input++;
    args.push('-i', media.clipFiles[i]);
    const dur = n(c.out - c.in);
    graph.push(
      `[${k}:v]trim=start=${n(c.in)}:end=${n(c.out)},setpts=PTS-STARTPTS,` +
        `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,` +
        `setsar=1,fps=30,format=yuv420p[v${i}]`,
    );
    if (media.clipHasAudio[i]) {
      graph.push(
        `[${k}:a]atrim=start=${n(c.in)}:end=${n(c.out)},asetpts=PTS-STARTPTS,` +
          `aresample=${SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,` +
          `volume=${n(c.volume)},apad,atrim=end=${dur}[a${i}]`,
      );
    } else {
      graph.push(`aevalsrc=0:c=stereo:s=${SAMPLE_RATE}:d=${dur},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`);
    }
    pairs.push(`[v${i}][a${i}]`);
  });
  graph.push(`${pairs.join('')}concat=n=${edit.clips.length}:v=1:a=1[vcat][acat]`);

  // ---- overlays (music, voice-over, sound effects, uploads)
  const mixIn = ['[acat]'];
  edit.audio.forEach((a, j) => {
    if (a.start >= total) return; // starts after the film ends
    const k = input++;
    args.push('-i', media.audioFiles[j]);
    const seg = n(a.out - a.in);
    const len = n(a.loop ? total - a.start : Math.min(seg, total - a.start));
    const f = [
      `aresample=${SAMPLE_RATE}`,
      'aformat=sample_fmts=fltp:channel_layouts=stereo',
      `atrim=start=${n(a.in)}:end=${n(a.out)}`,
      'asetpts=PTS-STARTPTS',
    ];
    if (a.loop) f.push(`aloop=loop=-1:size=${Math.round(seg * SAMPLE_RATE)}`, 'asetpts=N/SR/TB');
    f.push(`atrim=end=${len}`, `volume=${n(a.volume)}`);
    const fadeIn = Math.min(a.fadeIn, len / 2);
    const fadeOut = Math.min(a.fadeOut, len / 2);
    if (fadeIn > 0) f.push(`afade=t=in:st=0:d=${n(fadeIn)}`);
    if (fadeOut > 0) f.push(`afade=t=out:st=${n(len - fadeOut)}:d=${n(fadeOut)}`);
    if (a.start > 0) f.push(`adelay=${Math.round(a.start * 1000)}:all=1`);
    graph.push(`[${k}:a]${f.join(',')}[o${j}]`);
    mixIn.push(`[o${j}]`);
  });
  if (mixIn.length > 1) {
    graph.push(`${mixIn.join('')}amix=inputs=${mixIn.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95[aout]`);
  } else {
    graph.push('[acat]alimiter=limit=0.95[aout]');
  }

  args.push(
    '-filter_complex', graph.join(';'),
    '-map', '[vcat]', '-map', '[aout]',
    '-t', String(total),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '21', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-ar', String(SAMPLE_RATE),
    '-movflags', '+faststart',
    outFile,
  );
  return args;
}

/** Arguments for a JPEG cover frame from the finished film. */
export function thumbArgs(videoFile, total, outFile) {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-ss', String(n(Math.min(1, total / 2))), '-i', videoFile, '-frames:v', '1', '-q:v', '3', outFile];
}

/** Checks a job body from the API. Returns an error message or null. */
export function validateJob(job, allowedPrefix) {
  if (!job || typeof job !== 'object') return 'bad body';
  if (!FRAME[job.aspectRatio]) return 'bad aspectRatio';
  if (!Array.isArray(job.clips) || job.clips.length === 0 || job.clips.length > 200) return 'clips must be 1–200 items';
  if (!Array.isArray(job.audio) || job.audio.length > 50) return 'audio must be 0–50 items';
  if (typeof job.outputKey !== 'string' || !/^u\/[\w/.-]+\.mp4$/.test(job.outputKey)) return 'bad outputKey';
  if (job.thumbKey != null && (typeof job.thumbKey !== 'string' || !/^u\/[\w/.-]+\.jpg$/.test(job.thumbKey))) return 'bad thumbKey';
  const ok = (u) => typeof u === 'string' && (!allowedPrefix || u.startsWith(allowedPrefix));
  const num = (x, lo, hi) => typeof x === 'number' && Number.isFinite(x) && x >= lo && x <= hi;
  for (const c of job.clips) {
    if (!ok(c.url)) return 'clip url not allowed';
    if (!num(c.in, 0, 3600) || !num(c.out, 0, 3600) || c.out - c.in < 0.2 || !num(c.volume, 0, 2)) return 'bad clip numbers';
  }
  for (const a of job.audio) {
    if (!ok(a.url)) return 'audio url not allowed';
    if (!num(a.start, 0, 3600) || !num(a.in, 0, 3600) || !num(a.out, 0, 3600) || a.out - a.in < 0.1 || !num(a.volume, 0, 2)) return 'bad audio numbers';
    if (!num(a.fadeIn, 0, 10) || !num(a.fadeOut, 0, 10) || typeof a.loop !== 'boolean') return 'bad audio numbers';
  }
  if (filmLength(job.clips) > 900) return 'film longer than 15 minutes';
  return null;
}
