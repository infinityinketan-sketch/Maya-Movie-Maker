import { beforeEach, describe, expect, it } from 'vitest';
import { dailyCleanup } from '../src/cleanup';

type Row = Record<string, any>;
let tables: Record<string, Row[]>;
let failTable: string | null = null;

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  let del = false;
  const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const q: any = {
    select: () => q,
    eq: (c: string, v: any) => (filters.push((r) => r[c] === v), q),
    lt: (c: string, v: any) => (filters.push((r) => r[c] < v), q),
    gte: (c: string, v: any) => (filters.push((r) => r[c] >= v), q),
    not: (c: string, _op: string, _v: null) => (filters.push((r) => r[c] !== null && r[c] !== undefined), q),
    limit: () => q,
    update: (p: Row) => ((patch = p), q),
    delete: () => ((del = true), q),
    then: (res: any, rej: any) => {
      if (table === failTable) return Promise.resolve({ data: null, error: { message: 'db down' }, count: null }).then(res, rej);
      const hit = rows();
      if (patch) hit.forEach((r) => Object.assign(r, patch));
      if (del) tables[table] = (tables[table] ?? []).filter((r) => !hit.includes(r));
      return Promise.resolve({ data: hit, error: null, count: hit.length }).then(res, rej);
    },
  };
  return q;
}
const d: any = { from: (t: string) => query(t) };

const NOW = Date.parse('2026-12-01T00:00:00Z');
const daysAgo = (n: number) => new Date(NOW - n * 86400_000).toISOString();
const M = 'https://media.test/';
let objects: { key: string; uploaded: Date; size: number }[];
const deleted: string[] = [];
const env: any = {
  MEDIA_PUBLIC_BASE: 'https://media.test',
  MEDIA: {
    list: async ({ prefix }: { prefix: string }) => ({ objects: objects.filter((o) => o.key.startsWith(prefix)), truncated: false }),
    delete: async (keys: string | string[]) => {
      for (const k of [keys].flat()) {
        deleted.push(k);
        objects = objects.filter((o) => o.key !== k);
      }
    },
  },
};
const obj = (key: string, ageDays: number) => ({ key, uploaded: new Date(NOW - ageDays * 86400_000), size: 1000 });

beforeEach(() => {
  failTable = null;
  deleted.length = 0;
  tables = {
    projects: [
      { id: 'p1', user_id: 'u1', status: 'producing', kind: 'film', updated_at: daysAgo(1), music_url: `${M}u/u1/p1/music/m2.wav`, edit: null, ad_brief: null },
    ],
    shots: [{ id: 's1', project_id: 'p1', user_id: 'u1', updated_at: daysAgo(1), keyframe_url: `${M}u/u1/p1/keyframe/k2.png`, video_url: `${M}u/u1/p1/video/v3.mp4`, prev_video_url: `${M}u/u1/p1/video/v2.mp4` }],
    characters: [],
    project_assets: [],
    ad_orders: [],
    jobs: [{ project_id: 'p1', user_id: 'u1', created_at: daysAgo(1) }],
  };
  objects = [
    obj('u/u1/p1/video/v1.mp4', 5), // take before the previous one: unused
    obj('u/u1/p1/video/v2.mp4', 3), // previous take: kept
    obj('u/u1/p1/video/v3.mp4', 1), // newest take: kept
    obj('u/u1/p1/keyframe/k1.png', 4), // redrawn frame: unused
    obj('u/u1/p1/keyframe/k2.png', 4),
    obj('u/u1/p1/music/m1.wav', 9), // re-made music: unused
    obj('u/u1/p1/music/m2.wav', 2),
    obj('u/u1/p1/final/f-new.mp4', 0.1), // being saved right now: too new to touch
  ];
});

describe('daily clean-up', () => {
  it('deletes only files nothing uses, and never brand-new ones', async () => {
    const r = await dailyCleanup(env, d, NOW);
    expect(deleted.sort()).toEqual(['u/u1/p1/keyframe/k1.png', 'u/u1/p1/music/m1.wav', 'u/u1/p1/video/v1.mp4']);
    expect(r).toMatchObject({ filmsChecked: 1, filesDeleted: 3, bytesFreed: 3000 });
  });

  it('keeps files the user’s own edit uses', async () => {
    tables.projects[0].edit = { clips: [{ url: `${M}u/u1/p1/video/v1.mp4` }], audio: [] };
    await dailyCleanup(env, d, NOW);
    expect(deleted).not.toContain('u/u1/p1/video/v1.mp4');
  });

  it('deletes nothing for a film when the database cannot be read', async () => {
    failTable = 'characters';
    const r = await dailyCleanup(env, d, NOW);
    expect(deleted).toEqual([]);
    expect(r.filmsChecked).toBe(0);
  });

  it('lets go of previous takes after 60 idle days, unless the edit pins them', async () => {
    tables.shots[0].updated_at = daysAgo(61);
    tables.shots.push({ id: 's2', project_id: 'p1', user_id: 'u1', updated_at: daysAgo(90), video_url: 'x', prev_video_url: `${M}u/u1/p1/video/pinned.mp4` });
    tables.projects[0].edit = { clips: [{ url: `${M}u/u1/p1/video/pinned.mp4`, pinned: true }], audio: [] };
    const r = await dailyCleanup(env, d, NOW);
    expect(tables.shots[0].prev_video_url).toBeNull();
    expect(tables.shots[1].prev_video_url).toBe(`${M}u/u1/p1/video/pinned.mp4`);
    expect(r.previousTakesReleased).toBe(1);
    expect(deleted).toContain('u/u1/p1/video/v2.mp4');
  });

  it('deletes empty drafts after 30 days, never paid-for films or shop ads', async () => {
    tables.projects.push(
      { id: 'd1', user_id: 'u2', status: 'draft', kind: 'film', updated_at: daysAgo(31) },
      { id: 'd2', user_id: 'u2', status: 'draft', kind: 'film', updated_at: daysAgo(10) },
      { id: 'd3', user_id: 'u2', status: 'draft', kind: 'ad', updated_at: daysAgo(90) },
      { id: 'd4', user_id: 'u2', status: 'draft', kind: 'film', updated_at: daysAgo(90) },
    );
    tables.jobs.push({ project_id: 'd4', user_id: 'u2', created_at: daysAgo(90) }); // a failed paid story
    const r = await dailyCleanup(env, d, NOW);
    expect(tables.projects.map((p) => p.id).sort()).toEqual(['d2', 'd3', 'd4', 'p1']);
    expect(r.draftsDeleted).toBe(1);
  });

  it('removes shop photos from abandoned order forms after a week', async () => {
    objects.push(obj('u/u1/uploads/photo/used.jpg', 30), obj('u/u1/uploads/photo/abandoned.jpg', 8), obj('u/u1/uploads/photo/today.jpg', 1));
    tables.ad_orders = [{ user_id: 'u1', project_id: 'px', photo_url: `${M}u/u1/uploads/photo/used.jpg` }];
    await dailyCleanup(env, d, NOW);
    expect(deleted).toContain('u/u1/uploads/photo/abandoned.jpg');
    expect(deleted).not.toContain('u/u1/uploads/photo/used.jpg');
    expect(deleted).not.toContain('u/u1/uploads/photo/today.jpg');
  });
});
