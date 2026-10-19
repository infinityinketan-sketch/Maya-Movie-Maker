-- Shop-ad orders: the operator (you) takes orders from local businesses over WhatsApp,
-- makes the Reel + poster in Maya, delivers it and records payment.

alter table public.profiles add column role text not null default 'user' check (role in ('user', 'operator'));

alter table public.projects add column kind text not null default 'film' check (kind in ('film', 'ad'));
alter table public.projects add column ad_brief jsonb;
alter table public.projects add column poster_url text;
alter table public.projects add column poster_status text not null default 'none'
  check (poster_status in ('none', 'queued', 'running', 'done', 'failed'));

alter table public.jobs drop constraint jobs_kind_check;
alter table public.jobs add constraint jobs_kind_check
  check (kind in ('plan', 'portrait', 'keyframe', 'video', 'music', 'render', 'director', 'poster'));

create table public.ad_orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade, -- the operator
  project_id uuid references public.projects (id) on delete set null,
  customer_name text not null,
  customer_phone text not null,
  business_name text not null,
  business_type text not null,
  area text,
  offer text not null,
  occasion text,
  language text not null default 'Marathi',
  contact_line text,
  photo_url text,
  price_inr integer not null default 499 check (price_inr >= 0),
  status text not null default 'new'
    check (status in ('new', 'producing', 'ready', 'delivered', 'paid', 'cancelled')),
  notes text,
  delivered_at timestamptz,
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index ad_orders_user on public.ad_orders (user_id, created_at desc);

create trigger ad_orders_touch before update on public.ad_orders for each row execute function public.touch_updated_at();

alter table public.ad_orders enable row level security;
create policy "own orders" on public.ad_orders for select to authenticated using (user_id = auth.uid());
revoke insert, update, delete on public.ad_orders from anon, authenticated;
grant select on public.ad_orders to authenticated;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    alter publication supabase_realtime add table public.ad_orders;
  end if;
end $$;
