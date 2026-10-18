-- Director tools (camera library + AI Director) are for paying users.
-- Access turns on automatically with the first credit purchase and stays on.

alter table public.profiles add column director_access boolean not null default false;

create or replace function public.unlock_director_on_purchase() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'credited' then
    update public.profiles set director_access = true where id = new.user_id and not director_access;
  end if;
  return new;
end $$;

create trigger purchases_unlock_director after insert on public.purchases
  for each row execute function public.unlock_director_on_purchase();

-- Backfill anyone who already bought credits.
update public.profiles p set director_access = true
where exists (select 1 from public.purchases pu where pu.user_id = p.id and pu.status = 'credited');

-- Users can read their own flag (existing "own profile" select policy), never change it.
revoke update on public.profiles from authenticated;

-- AI Director calls are logged as jobs too, so their real cost is tracked and failures refund.
alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check
  check (kind in ('plan', 'portrait', 'keyframe', 'video', 'music', 'render', 'director'));
