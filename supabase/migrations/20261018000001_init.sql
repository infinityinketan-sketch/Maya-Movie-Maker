-- Maya All in 1 movie maker — core schema
-- Every write that costs credits goes through the backend worker (service role).
-- The mobile app only READS its own rows (RLS) and listens to realtime changes.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Users, wallets and credits
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

-- balance = sum of remaining, unexpired credit lots (kept in sync by functions below)
create table public.wallets (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance integer not null default 0 check (balance >= 0),
  updated_at timestamptz not null default now()
);

-- Credits arrive in lots so each purchase can expire on its own date.
create table public.credit_lots (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  source text not null check (source in ('purchase', 'refund', 'grant')),
  amount integer not null check (amount > 0),
  remaining integer not null check (remaining >= 0),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index credit_lots_user_open on public.credit_lots (user_id, expires_at) where remaining > 0;

create table public.credit_ledger (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  delta integer not null,
  kind text not null check (kind in ('purchase', 'charge', 'refund', 'grant', 'expire', 'adjust')),
  ref_type text,
  ref_id text,
  note text,
  balance_after integer not null,
  created_at timestamptz not null default now()
);
create index credit_ledger_user on public.credit_ledger (user_id, created_at desc);
-- A purchase or refund for the same reference can only ever be credited once.
create unique index credit_ledger_once on public.credit_ledger (kind, ref_type, ref_id)
  where kind in ('purchase', 'refund') and ref_id is not null;

create table public.purchases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  provider text not null check (provider in ('google_play', 'razorpay')),
  product_id text not null,
  order_id text,
  purchase_token text not null,
  credits integer not null check (credits > 0),
  price_inr numeric(12, 2),
  status text not null default 'credited' check (status in ('credited', 'refunded', 'rejected')),
  raw jsonb,
  created_at timestamptz not null default now(),
  unique (provider, purchase_token)
);
create index purchases_user on public.purchases (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Films
-- ---------------------------------------------------------------------------

create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  title text not null default 'Untitled film',
  idea text not null,
  genre text,
  language text not null default 'English',
  style text,
  aspect_ratio text not null default '16:9' check (aspect_ratio in ('16:9', '9:16')),
  target_duration_sec integer not null default 30 check (target_duration_sec between 8 and 600),
  tier text not null default 'standard' check (tier in ('budget', 'standard', 'premium')),
  status text not null default 'draft'
    check (status in ('draft', 'planning', 'planned', 'producing', 'rendering', 'done', 'failed')),
  logline text,
  synopsis text,
  music_prompt text,
  music_url text,
  music_status text not null default 'none' check (music_status in ('none', 'queued', 'running', 'done', 'failed')),
  final_video_url text,
  thumbnail_url text,
  render_status text not null default 'none' check (render_status in ('none', 'queued', 'running', 'done', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index projects_user on public.projects (user_id, updated_at desc);

create table public.characters (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  idx integer not null default 0,
  name text not null,
  description text not null,
  voice text,
  portrait_url text,
  portrait_status text not null default 'none' check (portrait_status in ('none', 'queued', 'running', 'done', 'failed')),
  created_at timestamptz not null default now()
);
create index characters_project on public.characters (project_id, idx);

create table public.scenes (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  idx integer not null,
  heading text not null,
  summary text,
  created_at timestamptz not null default now()
);
create index scenes_project on public.scenes (project_id, idx);

create table public.shots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  scene_id uuid not null references public.scenes (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  idx integer not null,
  duration_sec integer not null default 6 check (duration_sec in (4, 6, 8)),
  camera text,
  action text not null,
  dialogue text,
  speaker text,
  character_ids uuid[] not null default '{}',
  keyframe_url text,
  keyframe_status text not null default 'none' check (keyframe_status in ('none', 'queued', 'running', 'done', 'failed')),
  approved boolean not null default false,
  video_url text,
  video_status text not null default 'none' check (video_status in ('none', 'queued', 'running', 'done', 'failed')),
  takes integer not null default 0,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index shots_project on public.shots (project_id, idx);

-- One row per paid provider call. Credits are charged when the job is created
-- and refunded automatically if it fails.
create table public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete cascade,
  target_id uuid,
  kind text not null check (kind in ('plan', 'portrait', 'keyframe', 'video', 'music', 'render')),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  credits integer not null check (credits >= 0),
  cost_usd numeric(10, 4) not null default 0,
  provider text,
  model text,
  provider_request_id text unique,
  input jsonb not null default '{}',
  output jsonb,
  error text,
  refunded boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz
);
create index jobs_user on public.jobs (user_id, created_at desc);
create index jobs_running on public.jobs (status, created_at) where status in ('queued', 'running');

-- ---------------------------------------------------------------------------
-- updated_at
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger projects_touch before update on public.projects for each row execute function public.touch_updated_at();
create trigger shots_touch before update on public.shots for each row execute function public.touch_updated_at();
create trigger jobs_touch before update on public.jobs for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- New user → profile + empty wallet (no free credits: every credit is paid for)
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data ->> 'name', split_part(coalesce(new.email, ''), '@', 1)))
  on conflict do nothing;
  insert into public.wallets (user_id) values (new.id) on conflict do nothing;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Credit functions (service role only)
-- ---------------------------------------------------------------------------

-- Adds credits as a new lot. Idempotent for purchases and refunds on (kind, ref_type, ref_id):
-- a repeated call returns the current balance without adding anything.
create or replace function public.grant_credits(
  p_user uuid, p_amount integer, p_kind text, p_valid_days integer,
  p_ref_type text default null, p_ref_id text default null, p_note text default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_balance integer;
  v_source text;
begin
  if p_amount <= 0 then raise exception 'amount must be positive'; end if;
  if p_kind not in ('purchase', 'refund', 'grant') then raise exception 'bad kind %', p_kind; end if;
  v_source := p_kind;

  insert into public.wallets (user_id) values (p_user) on conflict do nothing;
  select balance into v_balance from public.wallets where user_id = p_user for update;

  if p_ref_id is not null and p_kind in ('purchase', 'refund') and exists (
    select 1 from public.credit_ledger where kind = p_kind and ref_type = p_ref_type and ref_id = p_ref_id
  ) then
    return v_balance;
  end if;

  insert into public.credit_lots (user_id, source, amount, remaining, expires_at)
  values (p_user, v_source, p_amount, p_amount, now() + make_interval(days => p_valid_days));

  v_balance := v_balance + p_amount;
  update public.wallets set balance = v_balance, updated_at = now() where user_id = p_user;

  insert into public.credit_ledger (user_id, delta, kind, ref_type, ref_id, note, balance_after)
  values (p_user, p_amount, p_kind, p_ref_type, p_ref_id, p_note, v_balance);
  return v_balance;
end $$;

-- Takes credits from the lots that expire first. Raises 'insufficient_credits' if the
-- unexpired balance is too low, so a job can never run on credit the user has not bought.
create or replace function public.charge_credits(
  p_user uuid, p_amount integer, p_ref_type text, p_ref_id text, p_note text default null
) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_balance integer;
  v_need integer := p_amount;
  v_lot record;
  v_take integer;
begin
  if p_amount <= 0 then raise exception 'amount must be positive'; end if;
  insert into public.wallets (user_id) values (p_user) on conflict do nothing;
  perform 1 from public.wallets where user_id = p_user for update;

  perform public.expire_user_credits(p_user);
  select balance into v_balance from public.wallets where user_id = p_user;
  if v_balance < p_amount then
    raise exception 'insufficient_credits' using errcode = 'P0001', detail = format('need %s, have %s', p_amount, v_balance);
  end if;

  for v_lot in
    select id, remaining from public.credit_lots
    where user_id = p_user and remaining > 0 and expires_at > now()
    order by expires_at, id
    for update
  loop
    exit when v_need = 0;
    v_take := least(v_need, v_lot.remaining);
    update public.credit_lots set remaining = remaining - v_take where id = v_lot.id;
    v_need := v_need - v_take;
  end loop;

  v_balance := v_balance - p_amount;
  update public.wallets set balance = v_balance, updated_at = now() where user_id = p_user;
  insert into public.credit_ledger (user_id, delta, kind, ref_type, ref_id, note, balance_after)
  values (p_user, -p_amount, 'charge', p_ref_type, p_ref_id, p_note, v_balance);
  return v_balance;
end $$;

-- Expires lots past their date for one user. Called inside charge_credits and by the nightly cron.
create or replace function public.expire_user_credits(p_user uuid) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_expired integer;
  v_balance integer;
begin
  select coalesce(sum(remaining), 0) into v_expired
  from public.credit_lots where user_id = p_user and remaining > 0 and expires_at <= now();

  if v_expired > 0 then
    update public.credit_lots set remaining = 0
    where user_id = p_user and remaining > 0 and expires_at <= now();
    update public.wallets set balance = balance - v_expired, updated_at = now()
    where user_id = p_user returning balance into v_balance;
    insert into public.credit_ledger (user_id, delta, kind, note, balance_after)
    values (p_user, -v_expired, 'expire', 'credits passed their expiry date', v_balance);
  end if;
  return v_expired;
end $$;

create or replace function public.expire_all_credits() returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_user uuid;
  v_total integer := 0;
begin
  for v_user in
    select distinct user_id from public.credit_lots where remaining > 0 and expires_at <= now()
  loop
    perform 1 from public.wallets where user_id = v_user for update;
    v_total := v_total + public.expire_user_credits(v_user);
  end loop;
  return v_total;
end $$;

-- Marks a job failed and returns its credits exactly once.
create or replace function public.fail_job(p_job uuid, p_error text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_job public.jobs;
begin
  select * into v_job from public.jobs where id = p_job for update;
  if not found or v_job.status = 'succeeded' then return; end if;
  update public.jobs set status = 'failed', error = left(p_error, 2000), finished_at = now() where id = p_job;
  if not v_job.refunded and v_job.credits > 0 then
    perform public.grant_credits(v_job.user_id, v_job.credits, 'refund', 90, 'job', p_job::text, 'automatic refund: ' || v_job.kind || ' failed');
    update public.jobs set refunded = true where id = p_job;
  end if;
end $$;

revoke all on function public.grant_credits(uuid, integer, text, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.charge_credits(uuid, integer, text, text, text) from public, anon, authenticated;
revoke all on function public.expire_user_credits(uuid) from public, anon, authenticated;
revoke all on function public.expire_all_credits() from public, anon, authenticated;
revoke all on function public.fail_job(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Row level security: users read their own rows; only the backend writes.
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.wallets enable row level security;
alter table public.credit_lots enable row level security;
alter table public.credit_ledger enable row level security;
alter table public.purchases enable row level security;
alter table public.projects enable row level security;
alter table public.characters enable row level security;
alter table public.scenes enable row level security;
alter table public.shots enable row level security;
alter table public.jobs enable row level security;

create policy "own profile" on public.profiles for select to authenticated using (id = auth.uid());
create policy "own wallet" on public.wallets for select to authenticated using (user_id = auth.uid());
create policy "own lots" on public.credit_lots for select to authenticated using (user_id = auth.uid());
create policy "own ledger" on public.credit_ledger for select to authenticated using (user_id = auth.uid());
create policy "own purchases" on public.purchases for select to authenticated using (user_id = auth.uid());
create policy "own projects" on public.projects for select to authenticated using (user_id = auth.uid());
create policy "own characters" on public.characters for select to authenticated using (user_id = auth.uid());
create policy "own scenes" on public.scenes for select to authenticated using (user_id = auth.uid());
create policy "own shots" on public.shots for select to authenticated using (user_id = auth.uid());
create policy "own jobs" on public.jobs for select to authenticated using (user_id = auth.uid());

revoke insert, update, delete on all tables in schema public from anon, authenticated;
grant select on all tables in schema public to authenticated;

-- Realtime: the app watches these tables to show progress live.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.projects, public.shots, public.characters, public.jobs, public.wallets;
  end if;
end $$;
