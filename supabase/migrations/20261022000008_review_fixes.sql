-- Fixes from the full code review.

-- 1. Keep purchase records when a user deletes their account (needed for GST/tax records).
alter table public.purchases alter column user_id drop not null;
alter table public.purchases drop constraint purchases_user_id_fkey;
alter table public.purchases add constraint purchases_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete set null;

-- 2. Refunds of failed jobs stay valid for a year (like purchased credits), not 90 days.
create or replace function public.fail_job(p_job uuid, p_error text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_job public.jobs;
begin
  select * into v_job from public.jobs where id = p_job for update;
  if not found or v_job.status = 'succeeded' then return; end if;
  update public.jobs set status = 'failed', error = left(p_error, 2000), finished_at = now() where id = p_job;
  if not v_job.refunded and v_job.credits > 0 then
    perform public.grant_credits(v_job.user_id, v_job.credits, 'refund', 365, 'job', p_job::text, 'automatic refund: ' || v_job.kind || ' failed');
    update public.jobs set refunded = true where id = p_job;
  end if;
end $$;
revoke all on function public.fail_job(uuid, text) from public, anon, authenticated;

-- 3. The app only reads editor sounds; only the backend writes them.
revoke insert, update, delete on public.project_assets from anon, authenticated;

-- 4. A Google Play purchase that was refunded or charged back: take back the credits it gave
--    (as many as are left — the balance never goes below zero). Runs once per purchase.
create or replace function public.revoke_purchase(p_token text, p_reason text) returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_p public.purchases;
  v_balance integer;
  v_take integer;
  v_need integer;
  v_lot record;
  v_cut integer;
begin
  select * into v_p from public.purchases where provider = 'google_play' and purchase_token = p_token for update;
  if not found or v_p.status <> 'credited' then return 0; end if;
  update public.purchases set status = 'refunded' where id = v_p.id;
  if v_p.user_id is null then return 0; end if;

  insert into public.wallets (user_id) values (v_p.user_id) on conflict do nothing;
  select balance into v_balance from public.wallets where user_id = v_p.user_id for update;
  perform public.expire_user_credits(v_p.user_id);
  select balance into v_balance from public.wallets where user_id = v_p.user_id;
  v_take := least(v_p.credits, v_balance);
  if v_take <= 0 then return 0; end if;

  v_need := v_take;
  for v_lot in
    select id, remaining from public.credit_lots
    where user_id = v_p.user_id and remaining > 0 and expires_at > now()
    order by (source = 'purchase') desc, expires_at desc, id desc
    for update
  loop
    exit when v_need = 0;
    v_cut := least(v_need, v_lot.remaining);
    update public.credit_lots set remaining = remaining - v_cut where id = v_lot.id;
    v_need := v_need - v_cut;
  end loop;

  v_balance := v_balance - v_take;
  update public.wallets set balance = v_balance, updated_at = now() where user_id = v_p.user_id;
  insert into public.credit_ledger (user_id, delta, kind, ref_type, ref_id, note, balance_after)
  values (v_p.user_id, -v_take, 'adjust', 'google_play_void', p_token, left('purchase refunded: ' || coalesce(p_reason, ''), 200), v_balance);
  return v_take;
end $$;
revoke all on function public.revoke_purchase(text, text) from public, anon, authenticated;
