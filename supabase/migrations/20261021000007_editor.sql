-- Manual editor: an edit list per film (clip order, trims, volumes, sound overlays) and a library of
-- sounds/clips the user added (uploads, AI sound effects, AI voice-overs).

alter table public.projects add column edit jsonb; -- null = default cut (all shots in order + music)

create table public.project_assets (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('sfx', 'voice', 'upload_audio', 'upload_video')),
  label text not null default '',
  prompt text,
  url text,
  duration_sec numeric(7, 2),
  status text not null default 'done' check (status in ('queued', 'running', 'done', 'failed')),
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index project_assets_project_idx on public.project_assets (project_id, created_at);

create trigger project_assets_touch before update on public.project_assets
  for each row execute function public.touch_updated_at();

alter table public.project_assets enable row level security;
create policy "own assets" on public.project_assets for select to authenticated using (user_id = auth.uid());
grant select on public.project_assets to authenticated;

alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check
  check (kind in ('plan', 'portrait', 'keyframe', 'video', 'music', 'render', 'director', 'poster', 'sfx', 'voice'));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.project_assets;
  end if;
end $$;
