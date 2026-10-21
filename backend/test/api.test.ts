// Runs API routes against an in-memory database: guards that protect credits and storage.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const tables: Record<string, Row[]> = {};
const rpcCalls: { fn: string; args: any }[] = [];

function query(table: string) {
  const filters: ((r: Row) => boolean)[] = [];
  let patch: Row | null = null;
  let del = false;
  const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
  const q: any = {
    select: () => q,
    eq: (c: string, v: any) => (filters.push((r) => r[c] === v), q),
    neq: (c: string, v: any) => (filters.push((r) => r[c] !== v), q),
    in: (c: string, v: any[]) => (filters.push((r) => v.includes(r[c])), q),
    order: () => q,
    limit: () => q,
    update: (p: Row) => ((patch = p), q),
    delete: () => ((del = true), q),
    maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
    single: async () => ({ data: rows()[0] ?? null, error: null }),
    then: (res: any, rej: any) => {
      const hit = rows();
      if (patch) hit.forEach((r) => Object.assign(r, patch));
      if (del) tables[table] = (tables[table] ?? []).filter((r) => !hit.includes(r));
      return Promise.resolve({ data: hit, error: null, count: hit.length }).then(res, rej);
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
      rpc: async (fn: string, args: any) => (rpcCalls.push({ fn, args }), { data: 0, error: null }),
      auth: { getUser: async (token: string) => ({ data: { user: token === 'tok-u1' ? { id: 'u1', email: 'u1@x.in' } : null }, error: null }) },
    }),
  };
});
vi.mock('../src/providers/fal', async (orig) => ({ ...((await orig()) as object), verifyFalWebhook: async () => true }));

const { app } = await import('../src/index');

const sent: any[] = [];
const env: any = {
  MEDIA_PUBLIC_BASE: 'https://media.test',
  USD_INR: '88',
  CREDIT_MARKUP: '3',
  JOBS: { send: async (b: any) => void sent.push(b) },
  MEDIA: { put: vi.fn(async () => undefined), delete: vi.fn(async () => undefined), list: async () => ({ objects: [], truncated: false }) },
};
const auth = { authorization: 'Bearer tok-u1' };
const call = (method: string, path: string, init: RequestInit = {}) =>
  app.request(path, { method, ...init, headers: { ...auth, ...(init.headers as object) } }, env);

beforeEach(() => {
  sent.length = 0;
  rpcCalls.length = 0;
  tables.profiles = [{ id: 'u1', role: 'user', director_access: false }];
  tables.projects = [{ id: 'p1', user_id: 'u1', status: 'draft', kind: 'film', music_status: 'none', poster_status: 'none', aspect_ratio: '9:16' }];
  tables.jobs = [];
  tables.project_assets = [];
});

describe('fal.ai webhook', () => {
  it('matches a result that arrives before the request id was saved', async () => {
    tables.jobs = [{ id: '11111111-1111-1111-1111-111111111111', status: 'running', provider_request_id: null }];
    const res = await app.request(
      '/v1/webhooks/fal?job=11111111-1111-1111-1111-111111111111',
      { method: 'POST', headers: { 'x-fal-webhook-request-id': 'req-9' }, body: JSON.stringify({ request_id: 'req-9', status: 'OK', payload: { audio: { url: 'a' } } }) },
      env,
    );
    expect(res.status).toBe(200);
    expect(tables.jobs[0].provider_request_id).toBe('req-9');
    expect(sent[0]).toMatchObject({ type: 'finalize', jobId: '11111111-1111-1111-1111-111111111111', ok: true });
  });

  it('refuses a body whose request id differs from the signed header', async () => {
    const res = await app.request('/v1/webhooks/fal', { method: 'POST', headers: { 'x-fal-webhook-request-id': 'req-1' }, body: JSON.stringify({ request_id: 'req-2', status: 'OK' }) }, env);
    expect(res.status).toBe(401);
    expect(sent).toHaveLength(0);
  });
});

describe('guards', () => {
  it('a second tap on "Compose score" does not charge twice', async () => {
    tables.projects[0].music_status = 'running';
    const res = await call('POST', '/v1/projects/p1/music');
    expect(res.status).toBe(409);
    expect(rpcCalls).toHaveLength(0);
  });

  it('a film cannot be deleted or rewritten while paid work is running', async () => {
    tables.jobs = [{ id: 'j', project_id: 'p1', status: 'running' }];
    expect((await call('DELETE', '/v1/projects/p1')).status).toBe(409);
    expect(tables.projects).toHaveLength(1);
    expect((await call('POST', '/v1/projects/p1/plan')).status).toBe(409);
    expect(rpcCalls).toHaveLength(0);
  });

  it('no free storage: uploads need a written story, photos need the studio account', async () => {
    const up = await call('POST', '/v1/projects/p1/assets', { headers: { 'content-type': 'audio/mpeg' }, body: new Uint8Array(5000) });
    expect(up.status).toBe(400);
    const photo = await call('POST', '/v1/uploads/photo', { headers: { 'content-type': 'image/jpeg' }, body: new Uint8Array(5000) });
    expect(photo.status).toBe(403);
    expect(env.MEDIA.put).not.toHaveBeenCalled();
  });

  it('other users’ films are not found', async () => {
    tables.projects[0].user_id = 'someone-else';
    expect((await call('GET', '/v1/projects/p1/edit')).status).toBe(404);
  });
});
