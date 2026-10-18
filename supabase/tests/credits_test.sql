-- Credit ledger tests. Run with: supabase/tests/run.sh
\set ON_ERROR_STOP on
begin;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000000a', 'a@test.in'),
  ('00000000-0000-0000-0000-00000000000b', 'b@test.in');

do $$
declare
  a uuid := '00000000-0000-0000-0000-00000000000a';
  b uuid := '00000000-0000-0000-0000-00000000000b';
  bal integer;
  j uuid;
  failed boolean;
begin
  -- signup creates an empty wallet: no free credits
  select balance into bal from public.wallets where user_id = a;
  assert bal = 0, 'new wallet must start at 0, got ' || bal;

  -- purchase is idempotent per purchase token
  bal := public.grant_credits(a, 100, 'purchase', 365, 'google_play', 'tok-1', 'starter');
  assert bal = 100, 'after purchase expected 100, got ' || bal;
  bal := public.grant_credits(a, 100, 'purchase', 365, 'google_play', 'tok-1', 'starter retry');
  assert bal = 100, 'duplicate purchase must not add credits, got ' || bal;

  -- charging more than the balance is refused
  failed := false;
  begin
    perform public.charge_credits(a, 101, 'job', 'x', 'too much');
  exception when others then
    failed := sqlerrm = 'insufficient_credits';
  end;
  assert failed, 'overdraft must raise insufficient_credits';

  -- normal charge
  bal := public.charge_credits(a, 66, 'job', 'plan-1', 'plan');
  assert bal = 34, 'after charge expected 34, got ' || bal;

  -- a failed job refunds exactly once
  insert into public.jobs (user_id, kind, credits) values (a, 'keyframe', 14) returning id into j;
  bal := public.charge_credits(a, 14, 'job', j::text, 'keyframe');
  assert bal = 20, 'expected 20, got ' || bal;
  perform public.fail_job(j, 'provider error');
  perform public.fail_job(j, 'provider error again');
  select balance into bal from public.wallets where user_id = a;
  assert bal = 34, 'refund must happen once, balance ' || bal;
  assert (select refunded from public.jobs where id = j), 'job must be marked refunded';

  -- charges use the lot that expires first
  perform public.grant_credits(b, 50, 'purchase', 400, 'google_play', 'tok-long', null);
  perform public.grant_credits(b, 30, 'purchase', 30, 'google_play', 'tok-short', null);
  perform public.charge_credits(b, 40, 'job', 'v1', null);
  assert (select remaining from public.credit_lots where user_id = b and amount = 30) = 0, 'short lot must be used first';
  assert (select remaining from public.credit_lots where user_id = b and amount = 50) = 40, 'long lot keeps 40';

  -- expired lots leave the balance and are logged
  update public.credit_lots set expires_at = now() - interval '1 day' where user_id = b and amount = 50;
  perform public.expire_all_credits();
  select balance into bal from public.wallets where user_id = b;
  assert bal = 0, 'expired credits must leave the balance, got ' || bal;
  assert exists (select 1 from public.credit_ledger where user_id = b and kind = 'expire' and delta = -40), 'expiry logged';

  -- ledger always matches the wallet
  assert (select balance from public.wallets where user_id = a)
       = (select sum(delta) from public.credit_ledger where user_id = a), 'ledger sum must equal wallet for a';
  assert (select balance from public.wallets where user_id = b)
       = (select sum(delta) from public.credit_ledger where user_id = b), 'ledger sum must equal wallet for b';
end $$;

-- RLS: a signed-in user sees only their own rows and cannot write
insert into public.projects (user_id, idea) values
  ('00000000-0000-0000-0000-00000000000a', 'idea A'),
  ('00000000-0000-0000-0000-00000000000b', 'idea B');

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000a';
do $$
declare n integer; denied boolean := false;
begin
  select count(*) into n from public.projects;
  assert n = 1, 'user A must see only 1 project, saw ' || n;
  select count(*) into n from public.wallets;
  assert n = 1, 'user A must see only own wallet';
  begin
    update public.wallets set balance = 999999;
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'users must not be able to edit their wallet';
  denied := false;
  begin
    perform public.grant_credits(auth.uid(), 1000, 'grant', 30);
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'users must not be able to grant themselves credits';
end $$;
reset role;

-- Director access: off by default, on after the first credited purchase, not editable by users
do $$
declare a uuid := '00000000-0000-0000-0000-00000000000a';
begin
  assert not (select director_access from public.profiles where id = a), 'director must start locked';
  insert into public.purchases (user_id, provider, product_id, purchase_token, credits)
  values (a, 'google_play', 'maya_credits_100', 'tok-director', 100);
  assert (select director_access from public.profiles where id = a), 'purchase must unlock director';
end $$;

set local role authenticated;
set local request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';
do $$
declare denied boolean := false;
begin
  begin
    update public.profiles set director_access = true;
  exception when insufficient_privilege then denied := true;
  end;
  assert denied, 'users must not be able to unlock director themselves';
end $$;
reset role;

rollback;
\echo 'ALL CREDIT TESTS PASSED'
