// Daily storage clean-up (runs once a night from the cron).
//
// 1. Files nothing points to any more are deleted: takes older than the previous one, redrawn
//    frames and looks, re-made music, posters and final cuts, results that failed their checks,
//    and the media of rewritten stories. A file must be at least a day old, so nothing that is
//    being saved right now is touched.
// 2. A shot's "previous take" is let go once the shot has not changed for 60 days (unless the
//    user's edit uses it). The newest take is always kept.
// 3. Empty drafts — films whose story was never written, so nothing was paid for — are deleted
//    after 30 days. Shop-ad projects are never deleted automatically.
//
// Safety: a database error stops the clean-up for that film before anything is deleted.
import type { Db } from './db';
import type { Env } from './env';
import { deletePrefix, keyFromUrl } from './storage';

export const CLEANUP = {
  orphanGraceMs: 24 * 3600_000,
  uploadGraceMs: 7 * 24 * 3600_000, // shop photos may sit in an unfinished order form
  activityWindowMs: 3 * 24 * 3600_000, // films touched recently are the only ones that can have new orphans
  prevTakeIdleMs: 60 * 24 * 3600_000,
  draftIdleMs: 30 * 24 * 3600_000,
  batch: 200,
};

export interface CleanupReport {
  filmsChecked: number;
  filesDeleted: number;
  bytesFreed: number;
  previousTakesReleased: number;
  draftsDeleted: number;
}

function rows<T>(res: { data: T[] | null; error: { message: string } | null }, what: string): T[] {
  if (res.error) throw new Error(`${what}: ${res.error.message}`);
  return res.data ?? [];
}

/** Every URL in an edit list (clips and sound layers). */
export function editUrls(edit: unknown): string[] {
  const e = edit as { clips?: { url?: unknown }[]; audio?: { url?: unknown }[] } | null;
  return [...(e?.clips ?? []), ...(e?.audio ?? [])].map((x) => x?.url).filter((u): u is string => typeof u === 'string');
}

/** Storage keys still used by one film. Throws if any lookup fails. */
async function keysInUse(env: Env, d: Db, projectId: string): Promise<Set<string>> {
  const [proj, shots, chars, assets, orders] = await Promise.all([
    d.from('projects').select('music_url,final_video_url,thumbnail_url,poster_url,ad_brief,edit').eq('id', projectId),
    d.from('shots').select('keyframe_url,video_url,prev_video_url').eq('project_id', projectId),
    d.from('characters').select('portrait_url').eq('project_id', projectId),
    d.from('project_assets').select('url').eq('project_id', projectId),
    d.from('ad_orders').select('photo_url').eq('project_id', projectId),
  ]);
  const p = rows(proj, 'project')[0] as Record<string, unknown> | undefined;
  if (!p) throw new Error('project vanished');
  const urls: unknown[] = [
    p.music_url,
    p.final_video_url,
    p.thumbnail_url,
    p.poster_url,
    (p.ad_brief as { photoUrl?: string } | null)?.photoUrl,
    ...editUrls(p.edit),
    ...rows(shots, 'shots').flatMap((s) => [s.keyframe_url, s.video_url, s.prev_video_url]),
    ...rows(chars, 'characters').map((c) => c.portrait_url),
    ...rows(assets, 'assets').map((a) => a.url),
    ...rows(orders, 'orders').map((o) => o.photo_url),
  ];
  const keys = new Set<string>();
  for (const u of urls) if (typeof u === 'string') keys.add(keyFromUrl(env, u) ?? u);
  return keys;
}

/** Deletes files under `prefix` that are not in `keep` and older than `graceMs`. */
async function sweep(env: Env, prefix: string, keep: Set<string>, graceMs: number, now: number): Promise<{ files: number; bytes: number }> {
  let cursor: string | undefined;
  let files = 0;
  let bytes = 0;
  do {
    const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
    const gone = page.objects.filter((o) => !keep.has(o.key) && now - new Date(o.uploaded).getTime() > graceMs);
    if (gone.length) await env.MEDIA.delete(gone.map((o) => o.key));
    files += gone.length;
    bytes += gone.reduce((n, o) => n + (o.size ?? 0), 0);
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { files, bytes };
}

export async function dailyCleanup(env: Env, d: Db, now = Date.now()): Promise<CleanupReport> {
  const report: CleanupReport = { filmsChecked: 0, filesDeleted: 0, bytesFreed: 0, previousTakesReleased: 0, draftsDeleted: 0 };
  const iso = (ms: number) => new Date(now - ms).toISOString();

  // 2. Previous takes of shots idle for 60 days (kept if the user's edit uses them).
  const oldTakes = rows(
    await d.from('shots').select('id,project_id,prev_video_url').not('prev_video_url', 'is', null).lt('updated_at', iso(CLEANUP.prevTakeIdleMs)).limit(CLEANUP.batch),
    'old takes',
  ) as { id: string; project_id: string; prev_video_url: string }[];
  const editsOf = new Map<string, string[]>();
  for (const s of oldTakes) {
    if (!editsOf.has(s.project_id)) {
      const p = rows(await d.from('projects').select('edit').eq('id', s.project_id), 'project')[0] as { edit: unknown } | undefined;
      editsOf.set(s.project_id, editUrls(p?.edit));
    }
    if (editsOf.get(s.project_id)!.includes(s.prev_video_url)) continue;
    const res = await d.from('shots').update({ prev_video_url: null, prev_video_model: null }).eq('id', s.id);
    if (!res.error) report.previousTakesReleased++;
  }

  // 3. Empty drafts (no story written, nothing paid) idle for 30 days.
  const drafts = rows(
    await d.from('projects').select('id,user_id').eq('status', 'draft').eq('kind', 'film').lt('updated_at', iso(CLEANUP.draftIdleMs)).limit(CLEANUP.batch),
    'drafts',
  ) as { id: string; user_id: string }[];
  for (const p of drafts) {
    const jobs = await d.from('jobs').select('id', { count: 'exact', head: true }).eq('project_id', p.id);
    if (jobs.error || (jobs.count ?? 0) > 0) continue; // anything paid for: keep
    await deletePrefix(env, `u/${p.user_id}/${p.id}/`);
    const del = await d.from('projects').delete().eq('id', p.id);
    if (!del.error) report.draftsDeleted++;
  }

  // 1. Unused files of films with recent activity (only they can have new unused files).
  const since = iso(CLEANUP.activityWindowMs);
  const [byJobs, byProjects, byShots, byAssets] = await Promise.all([
    d.from('jobs').select('project_id,user_id').gte('created_at', since).limit(5000),
    d.from('projects').select('id,user_id').gte('updated_at', since).limit(5000),
    d.from('shots').select('project_id,user_id').gte('updated_at', since).limit(5000),
    d.from('project_assets').select('project_id,user_id').gte('updated_at', since).limit(5000),
  ]);
  const films = new Map<string, string>(); // project id -> user id
  for (const r of rows(byJobs, 'jobs') as { project_id: string | null; user_id: string }[]) if (r.project_id) films.set(r.project_id, r.user_id);
  for (const r of rows(byProjects, 'projects') as { id: string; user_id: string }[]) films.set(r.id, r.user_id);
  for (const r of [...rows(byShots, 'shots'), ...rows(byAssets, 'assets')] as { project_id: string; user_id: string }[]) films.set(r.project_id, r.user_id);

  for (const [projectId, userId] of films) {
    try {
      const keep = await keysInUse(env, d, projectId);
      const r = await sweep(env, `u/${userId}/${projectId}/`, keep, CLEANUP.orphanGraceMs, now);
      report.filmsChecked++;
      report.filesDeleted += r.files;
      report.bytesFreed += r.bytes;
    } catch (e) {
      console.error('cleanup skipped film', projectId, e);
    }
  }

  // Shop photos uploaded for orders that were never saved.
  for (const userId of new Set(films.values())) {
    try {
      const [orders, projects] = await Promise.all([
        d.from('ad_orders').select('photo_url').eq('user_id', userId),
        d.from('projects').select('ad_brief').eq('user_id', userId).eq('kind', 'ad'),
      ]);
      const keep = new Set<string>();
      for (const u of [
        ...rows(orders, 'orders').map((o) => o.photo_url),
        ...rows(projects, 'ad projects').map((p) => (p.ad_brief as { photoUrl?: string } | null)?.photoUrl),
      ]) {
        if (typeof u === 'string') keep.add(keyFromUrl(env, u) ?? u);
      }
      const r = await sweep(env, `u/${userId}/uploads/`, keep, CLEANUP.uploadGraceMs, now);
      report.filesDeleted += r.files;
      report.bytesFreed += r.bytes;
    } catch (e) {
      console.error('cleanup skipped uploads', userId, e);
    }
  }

  console.log('daily cleanup', JSON.stringify(report));
  return report;
}
