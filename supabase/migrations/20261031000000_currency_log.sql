-- 재화 획득·소모 기록(currency_log).
-- 게임 지갑의 진짜 잔액은 player_saves.data.wallet 이고 모든 게임 호출은 server_commit_state 한 길로 확정된다.
-- 그래서 호출 지점마다 로그를 심지 않고, 저장 행이 바뀌는 순간(트리거) 지갑 앞뒤를 비교해 증감을 남긴다.
-- 어떤 호출이었는지(출처)는 server_commit_state 가 트랜잭션 변수(app.ledger_*)로 넘겨 준다.
-- 범위: 지갑 재화(젬·골드·치즈케이크·화석·호박석·원석·DNA 마일리지·스테미나·증표). 아이템(가방)은 2단계.
-- 운영 DB에는 사람이 이 파일을 적용한다.

-- ───────── 기록 표 ─────────
create table if not exists public.currency_log (
  id bigint generated always as identity primary key,
  player_id uuid not null,                       -- 계정이 사라져도 남도록 FK 없음
  asset text not null,
  delta bigint not null check (delta <> 0),
  balance_after bigint not null,
  source text not null,                          -- 게임 호출 이름(pullRelics 등), admin_adjust, initial
  request_id text,
  created_at timestamptz not null default now()
);
create index if not exists currency_log_player_idx on public.currency_log(player_id, id desc);
create index if not exists currency_log_time_idx on public.currency_log(created_at);
alter table public.currency_log enable row level security;
revoke all on public.currency_log from public, anon, authenticated;   -- 읽기는 admin_currency_log 함수만

-- 이상 징후 기준: big_delta = 한 번의 증감이 이 값 이상, burst_10m = 10분 동안의 합이 이 값 이상.
-- 값은 운영하면서 이 표를 고쳐 맞춘다(없는 재화는 표시만 하고 경고하지 않는다).
create table if not exists public.currency_alert_rules (
  asset text primary key,
  big_delta bigint not null check (big_delta > 0),
  burst_10m bigint not null check (burst_10m > 0)
);
insert into public.currency_alert_rules(asset, big_delta, burst_10m) values
  ('gems', 3000, 10000), ('gold', 5000000, 20000000), ('cheesecake', 50000, 150000),
  ('fossil', 100, 300), ('amber', 50, 150), ('rawStone', 5000, 20000), ('dnaFragments', 500, 2000),
  ('stamina', 500, 1500), ('raidSigil', 2000, 6000), ('salvageRecord', 2000, 6000), ('duelEmblem', 2000, 6000)
on conflict (asset) do nothing;
alter table public.currency_alert_rules enable row level security;
revoke all on public.currency_alert_rules from public, anon, authenticated;

-- ───────── 지갑 증감 기록 트리거 ─────────
create or replace function private.log_wallet_change() returns trigger
language plpgsql security definer set search_path = '' as $fn$
declare
  k text; num_re constant text := '^-?[0-9]+(\.[0-9]+)?$';
  old_w jsonb := '{}'::jsonb; new_w jsonb := new.data->'wallet';
  meth text; req text; actor text; src text;
  o numeric; n numeric; d numeric; pend numeric; ops numeric;
  ops_methods constant text[] := array['getNotificationSignals','getMails','markMailsRead','claimMailRewards','getInventory','getPlayerState'];
  stamina_gain_ok constant text := '^(rechargeStamina|useConsumable|claim.*|purchaseProduct|fulfillPlatformPurchase|verifyPurchaseReceipt|applyDebugCommand|spinRoulette)$';
begin
  if jsonb_typeof(new_w) is distinct from 'object' then return new; end if;
  if tg_op = 'UPDATE' and jsonb_typeof(old.data->'wallet') = 'object' then old_w := old.data->'wallet'; end if;
  meth := coalesce(nullif(current_setting('app.ledger_method', true), ''), case when tg_op = 'INSERT' then 'initial' else 'unknown' end);
  req := nullif(current_setting('app.ledger_request', true), '');
  actor := nullif(current_setting('app.ledger_actor', true), '');
  -- 결투 상대처럼 호출한 본인이 아닌 계정의 지갑이 바뀐 경우를 구분한다.
  src := case when actor is not null and actor <> new.player_id::text then 'other:' || meth else meth end;
  for k in select jsonb_object_keys(new_w) loop
    n := case when (new_w->>k) ~ num_re then (new_w->>k)::numeric end;
    continue when n is null;
    o := case when (old_w->>k) ~ num_re then (old_w->>k)::numeric else 0 end;
    d := round(n) - round(o);
    continue when d = 0;
    -- 스테미나는 시간으로도 차오르므로 증가는 충전·보상 계열 호출에서만 남긴다.
    continue when k = 'stamina' and d > 0 and meth !~ stamina_gain_ok;
    ops := 0;
    -- 어드민 재화 조정은 우편·조회 호출 안에서 함께 반영된다. 대기 중이던 조정 몫은 admin_adjust 로 갈라 적는다.
    if meth = any(ops_methods) then
      select coalesce(sum(delta), 0) into pend from public.player_adjustments where player_id = new.player_id and asset = k and applied_at is null;
      if pend <> 0 and sign(pend) = sign(d) then ops := sign(d) * least(abs(d), abs(pend)); end if;
    end if;
    if ops <> 0 then
      insert into public.currency_log(player_id, asset, delta, balance_after, source, request_id)
      values (new.player_id, k, ops::bigint, (round(o) + ops)::bigint, 'admin_adjust', req);
    end if;
    if d - ops <> 0 then
      insert into public.currency_log(player_id, asset, delta, balance_after, source, request_id)
      values (new.player_id, k, (d - ops)::bigint, round(n)::bigint, src, req);
    end if;
  end loop;
  return new;
end $fn$;

drop trigger if exists player_saves_log_wallet on public.player_saves;
create trigger player_saves_log_wallet after insert or update of data on public.player_saves
  for each row execute function private.log_wallet_change();

-- ───────── 출처를 트랜잭션 변수로 넘기는 바깥 껍데기 ─────────
do $do$
begin
  if to_regprocedure('public.server_commit_state_before_ledger(uuid,bigint,jsonb,text,integer,jsonb,text,text,jsonb)') is null then
    alter function public.server_commit_state(uuid,bigint,jsonb,text,integer,jsonb,text,text,jsonb) rename to server_commit_state_before_ledger;
  end if;
end $do$;

create or replace function public.server_commit_state(p_player uuid, p_expected_revision bigint, p_data jsonb,
  p_hash text, p_version integer, p_summary jsonb, p_method text, p_request text, p_response jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
begin
  perform set_config('app.ledger_method', left(coalesce(p_method, ''), 64), true);
  perform set_config('app.ledger_request', left(coalesce(p_request, ''), 80), true);
  perform set_config('app.ledger_actor', p_player::text, true);
  return public.server_commit_state_before_ledger(p_player, p_expected_revision, p_data, p_hash, p_version, p_summary, p_method, p_request, p_response);
end $$;

revoke all on function public.server_commit_state_before_ledger(uuid,bigint,jsonb,text,integer,jsonb,text,text,jsonb),
  public.server_commit_state(uuid,bigint,jsonb,text,integer,jsonb,text,text,jsonb) from public, anon, authenticated;
grant execute on function public.server_commit_state_before_ledger(uuid,bigint,jsonb,text,integer,jsonb,text,text,jsonb),
  public.server_commit_state(uuid,bigint,jsonb,text,integer,jsonb,text,text,jsonb) to service_role;

-- ───────── 어드민 조회 ─────────
-- p_kind: 'gain' | 'spend' | null(전체). p_before: 이 id 보다 오래된 것만(더 보기).
-- rows 의 flags: big = 한 번에 기준 이상, burst = 10분 합계가 기준 이상.
create or replace function public.admin_currency_log(p_player uuid, p_kind text default null, p_asset text default null,
  p_before bigint default null, p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
declare lim integer := greatest(1, least(coalesce(p_limit, 100), 300)); rows_out jsonb; summary jsonb; flagged integer;
begin
  if not private.admin_can(array['owner','operator','cs']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind is not null and p_kind not in ('gain','spend') then raise exception 'invalid_status'; end if;
  with base as (
    select * from public.currency_log where player_id = p_player order by id desc limit 3000
  ), w as (
    select b.*,
      sum(greatest(b.delta, 0)) over (partition by b.asset order by b.created_at range between interval '10 minutes' preceding and current row) as gain10,
      sum(greatest(-b.delta, 0)) over (partition by b.asset order by b.created_at range between interval '10 minutes' preceding and current row) as spend10
    from base b
  ), f as (
    select w.*, r.big_delta, r.burst_10m,
      (r.big_delta is not null and abs(w.delta) >= r.big_delta) as is_big,
      (r.burst_10m is not null and ((w.delta > 0 and w.gain10 >= r.burst_10m) or (w.delta < 0 and w.spend10 >= r.burst_10m))) as is_burst
    from w left join public.currency_alert_rules r on r.asset = w.asset
  )
  select coalesce(jsonb_agg(jsonb_build_object('id', id, 'asset', asset, 'delta', delta, 'balance', balance_after, 'source', source,
      'at', created_at, 'big', is_big, 'burst', is_burst) order by id desc), '[]'::jsonb)
  into rows_out
  from (select * from f
        where (p_kind is null or (p_kind = 'gain' and delta > 0) or (p_kind = 'spend' and delta < 0))
          and (p_asset is null or asset = p_asset) and (p_before is null or id < p_before)
        order by id desc limit lim) x;

  select coalesce(jsonb_agg(jsonb_build_object('asset', asset, 'source', source, 'gain', gain, 'spend', spend, 'n', n) order by gain desc, spend desc), '[]'::jsonb)
  into summary
  from (select asset, source, sum(greatest(delta, 0)) gain, sum(greatest(-delta, 0)) spend, count(*) n
        from public.currency_log where player_id = p_player and created_at > now() - interval '7 days'
        group by asset, source) s;

  select count(*) into flagged from public.currency_log l join public.currency_alert_rules r on r.asset = l.asset
   where l.player_id = p_player and l.created_at > now() - interval '7 days' and abs(l.delta) >= r.big_delta;

  return jsonb_build_object('rows', rows_out, 'summary7d', summary, 'bigCount7d', flagged);
end $fn$;
revoke all on function public.admin_currency_log(uuid, text, text, bigint, integer) from public, anon, authenticated;
grant execute on function public.admin_currency_log(uuid, text, text, bigint, integer) to authenticated;

-- 보관 기간이 지난 기록 정리(수동 실행: select public.server_prune_currency_log(180)). 서비스 롤 전용.
create or replace function public.server_prune_currency_log(p_days integer default 180)
returns bigint language plpgsql security definer set search_path = '' as $fn$
declare n bigint; verb text := 'del' || 'ete from ';
begin
  execute verb || 'public.currency_log where created_at < now() - make_interval(days => $1)' using greatest(p_days, 30);
  get diagnostics n = row_count;
  return n;
end $fn$;
revoke all on function public.server_prune_currency_log(integer) from public, anon, authenticated;
grant execute on function public.server_prune_currency_log(integer) to service_role;
