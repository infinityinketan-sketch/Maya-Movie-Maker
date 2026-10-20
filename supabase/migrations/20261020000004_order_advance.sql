-- Advance payments: an ad is not started until at least half the price is received.
alter table public.ad_orders add column advance_inr integer not null default 0 check (advance_inr >= 0);
alter table public.ad_orders add column advance_at timestamptz;

alter table public.ad_orders drop constraint ad_orders_status_check;
alter table public.ad_orders add constraint ad_orders_status_check
  check (status in ('awaiting_advance', 'new', 'producing', 'ready', 'delivered', 'paid', 'cancelled'));
alter table public.ad_orders alter column status set default 'awaiting_advance';

-- Orders created before this rule are treated as fully advanced so nothing in progress gets blocked.
update public.ad_orders set advance_inr = price_inr where advance_inr = 0 and status <> 'cancelled';
