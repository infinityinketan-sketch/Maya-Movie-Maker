-- "HD Value" quality tier (LTX-2 1080p with sound) and side-by-side comparison of takes.
alter table public.projects drop constraint projects_tier_check;
alter table public.projects add constraint projects_tier_check check (tier in ('budget', 'value', 'standard', 'premium'));

alter table public.shots add column video_model text;
alter table public.shots add column prev_video_url text;
alter table public.shots add column prev_video_model text;
