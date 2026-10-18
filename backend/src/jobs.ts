import { balanceOf, type Db, type Job } from './db';
import { HttpError, type Env, type JobKind } from './env';

export interface NewJob {
  userId: string;
  projectId: string | null;
  targetId: string | null;
  kind: JobKind;
  credits: number;
  costUsd: number;
  provider: string;
  model: string;
  input?: Record<string, unknown>;
}

/** Credits a user may spend per rolling 24 h — stops runaway spend from a stolen account or a bug. */
async function assertDailyLimit(env: Env, d: Db, userId: string, extra: number): Promise<void> {
  const limit = Number(env.DAILY_CREDIT_LIMIT || 20000);
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const res = await d.from('credit_ledger').select('delta').eq('user_id', userId).eq('kind', 'charge').gte('created_at', since);
  if (res.error) throw new Error(res.error.message);
  const spent = (res.data ?? []).reduce((s, r) => s - (r.delta as number), 0);
  if (spent + extra > limit) throw new HttpError(429, 'daily_limit', `Daily limit of ${limit} credits reached. Try again tomorrow.`);
}

/** Checks the user can afford a batch before any job of it is created, so batches never half-run. */
export async function assertCanAfford(env: Env, d: Db, userId: string, credits: number): Promise<void> {
  const balance = await balanceOf(d, userId);
  if (balance < credits) throw new HttpError(402, 'insufficient_credits', `This needs ${credits} credits; you have ${balance}.`);
  await assertDailyLimit(env, d, userId, credits);
}

/**
 * Creates a job, charges its credits up front (before any provider is called) and queues it.
 * If the charge fails the job is removed and nothing is spent.
 */
export async function startJob(env: Env, d: Db, j: NewJob): Promise<Job> {
  const job = await chargeJob(env, d, j);
  await env.JOBS.send({ type: 'start', jobId: job.id });
  return job;
}

/** Same as startJob but for work done inside the request (no queue); the caller must succeed or fail it. */
export async function chargeJob(env: Env, d: Db, j: NewJob, status: 'queued' | 'running' = 'queued'): Promise<Job> {
  await assertDailyLimit(env, d, j.userId, j.credits);
  const ins = await d
    .from('jobs')
    .insert({
      user_id: j.userId,
      project_id: j.projectId,
      target_id: j.targetId,
      kind: j.kind,
      credits: j.credits,
      cost_usd: j.costUsd,
      provider: j.provider,
      model: j.model,
      input: j.input ?? {},
      status,
    })
    .select('*')
    .single();
  if (ins.error) throw new Error(ins.error.message);
  const job = ins.data as Job;

  const charge = await d.rpc('charge_credits', {
    p_user: j.userId,
    p_amount: j.credits,
    p_ref_type: 'job',
    p_ref_id: job.id,
    p_note: `${j.kind} · ${j.model}`,
  });
  if (charge.error) {
    await d.from('jobs').delete().eq('id', job.id);
    if (charge.error.message.includes('insufficient_credits')) {
      throw new HttpError(402, 'insufficient_credits', `This needs ${j.credits} credits. Please buy more credits.`);
    }
    throw new Error(charge.error.message);
  }
  return job;
}

export async function failJob(d: Db, jobId: string, error: string): Promise<void> {
  const res = await d.rpc('fail_job', { p_job: jobId, p_error: error });
  if (res.error) throw new Error(res.error.message);
}

export async function succeedJob(d: Db, jobId: string, output: Record<string, unknown>, costUsd?: number): Promise<void> {
  const patch: Record<string, unknown> = { status: 'succeeded', output, finished_at: new Date().toISOString() };
  if (costUsd !== undefined) patch.cost_usd = Number(costUsd.toFixed(4));
  const res = await d.from('jobs').update(patch).eq('id', jobId).neq('status', 'failed');
  if (res.error) throw new Error(res.error.message);
}
