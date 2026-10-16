-- 운영 핵심: 플레이어 상태, 재화 원장, 우편, 쿠폰, 운영 설정.
-- 원칙: 클라이언트는 테이블을 직접 바꾸지 못한다. 모든 쓰기는 보안 정의자 함수(역할 확인 + 감사 기록)만 거친다.
-- 원장·청구 기록은 계정이 사라져도 남도록 플레이어 FK를 걸지 않는다.

-- ───────── 플레이어 상태 ─────────
alter table public.players
  add column if not exists status text not null default 'active' check (status in ('active','suspended','banned')),
  add column if not exists status_reason text check (status_reason is null or char_length(status_reason) <= 300),
  add column if not exists status_until timestamptz,
  add column if not exists last_seen_at timestamptz,
  add column if not exists app_version text check (app_version is null or char_length(app_version) <= 32),
  add column if not exists platform text check (platform is null or char_length(platform) <= 16);

-- ───────── 지급 가능한 재화 목록(화이트리스트) ─────────
-- 키는 게임 Wallet 키와 같아야 한다. 한 번에 줄 수 있는 상한이 오타·남용 방지 안전장치다.
create table if not exists public.reward_assets (
  asset text primary key check (asset ~ '^[a-zA-Z][a-zA-Z0-9]{1,31}$'),
  label text not null,
  max_per_grant bigint not null check (max_per_grant > 0),
  enabled boolean not null default true
);
insert into public.reward_assets(asset, label, max_per_grant) values
  ('gems','젬',100000),('gold','골드',100000000),('cheesecake','치즈케이크',1000000),
  ('fossil','화석',1000),('amber','호박석',1000),('rawStone','원석',100000),
  ('dnaFragments','DNA 마일리지',100000),('stamina','스테미나',1000)
on conflict (asset) do nothing;

create table if not exists public.player_assets (
  player_id uuid not null,
  asset text not null references public.reward_assets(asset),
  amount bigint not null default 0 check (amount between 0 and 1000000000000),
  updated_at timestamptz not null default now(),
  primary key (player_id, asset)
);

create table if not exists public.asset_ledger (
  id bigint generated always as identity primary key,
  player_id uuid not null,
  asset text not null,
  delta bigint not null,
  balance_after bigint not null,
  reason text not null check (reason in ('mail','coupon','admin_adjust')),
  ref text,
  note text check (note is null or char_length(note) <= 300),
  actor uuid,
  created_at timestamptz not null default now()
);
create index if not exists asset_ledger_player_idx on public.asset_ledger(player_id, id desc);

-- ───────── 우편 ─────────
create table if not exists public.mails (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(title) between 1 and 80),
  body text not null check (char_length(body) between 1 and 2000),
  rewards jsonb not null default '[]'::jsonb,
  target_player uuid,
  status text not null default 'active' check (status in ('active','cancelled')),
  starts_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '30 days'),
  created_by uuid,
  created_at timestamptz not null default now(),
  check (expires_at > starts_at)
);
create index if not exists mails_active_idx on public.mails(status, starts_at desc);

create table if not exists public.mail_claims (
  mail_id uuid not null references public.mails(id),
  player_id uuid not null,
  claimed_at timestamptz not null default now(),
  primary key (mail_id, player_id)
);

-- ───────── 쿠폰 ─────────
-- shared: 모두가 같은 코드를 쓴다(1인 1회, 총 사용 수 제한 가능). single: 코드마다 한 명만 쓴다.
-- 코드 원문은 저장하지 않고 sha256 해시만 둔다. 단일 코드의 원문은 만든 직후 응답으로 한 번만 보여 준다.
create table if not exists public.coupons (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  kind text not null check (kind in ('shared','single')),
  rewards jsonb not null,
  starts_at timestamptz not null default now(),
  ends_at timestamptz not null,
  max_redemptions integer check (max_redemptions is null or max_redemptions > 0),
  redeemed_count integer not null default 0,
  status text not null default 'active' check (status in ('active','disabled')),
  created_by uuid,
  created_at timestamptz not null default now(),
  check (ends_at > starts_at)
);
create table if not exists public.coupon_codes (
  id uuid primary key default gen_random_uuid(),
  coupon_id uuid not null references public.coupons(id),
  code_hash text not null unique,
  code_hint text not null,
  redeemed_by uuid,
  redeemed_at timestamptz
);
create index if not exists coupon_codes_coupon_idx on public.coupon_codes(coupon_id);
create table if not exists public.coupon_redemptions (
  coupon_id uuid not null references public.coupons(id),
  player_id uuid not null,
  code_id uuid not null references public.coupon_codes(id),
  redeemed_at timestamptz not null default now(),
  primary key (coupon_id, player_id)
);
create table if not exists public.coupon_attempts (
  id bigint generated always as identity primary key,
  player_id uuid not null,
  ok boolean not null,
  at timestamptz not null default now()
);
create index if not exists coupon_attempts_player_idx on public.coupon_attempts(player_id, at desc);

-- ───────── 운영 설정(한 줄짜리 표) ─────────
create table if not exists public.app_config (
  id smallint primary key default 1 check (id = 1),
  maintenance boolean not null default false,
  maintenance_message text not null default '' check (char_length(maintenance_message) <= 500),
  maintenance_ends_at timestamptz,
  min_app_version text not null default '0.0.0' check (min_app_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  latest_app_version text not null default '0.0.0' check (latest_app_version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
insert into public.app_config(id) values (1) on conflict (id) do nothing;

-- ───────── RLS: 전부 켜고, 정책은 읽기만 연다 ─────────
alter table public.reward_assets enable row level security;
alter table public.player_assets enable row level security;
alter table public.asset_ledger enable row level security;
alter table public.mails enable row level security;
alter table public.mail_claims enable row level security;
alter table public.coupons enable row level security;
alter table public.coupon_codes enable row level security;
alter table public.coupon_redemptions enable row level security;
alter table public.coupon_attempts enable row level security;
alter table public.app_config enable row level security;

create policy players_admin_read on public.players for select to authenticated
  using (private.admin_can(array['owner','operator','cs','viewer']));
create policy reward_assets_admin_read on public.reward_assets for select to authenticated
  using (private.is_admin());
create policy player_assets_own_read on public.player_assets for select to authenticated
  using (player_id = (select auth.uid()));
create policy player_assets_admin_read on public.player_assets for select to authenticated
  using (private.admin_can(array['owner','operator','cs']));
create policy asset_ledger_admin_read on public.asset_ledger for select to authenticated
  using (private.admin_can(array['owner','operator','cs']));
create policy mails_admin_read on public.mails for select to authenticated
  using (private.admin_can(array['owner','operator','cs','viewer']));
create policy mail_claims_admin_read on public.mail_claims for select to authenticated
  using (private.admin_can(array['owner','operator']));
create policy coupons_admin_read on public.coupons for select to authenticated
  using (private.admin_can(array['owner','operator']));
create policy coupon_codes_admin_read on public.coupon_codes for select to authenticated
  using (private.admin_can(array['owner','operator']));
create policy coupon_redemptions_admin_read on public.coupon_redemptions for select to authenticated
  using (private.admin_can(array['owner','operator']));
create policy app_config_admin_read on public.app_config for select to authenticated
  using (private.is_admin());

grant select on public.reward_assets, public.player_assets, public.asset_ledger, public.mails,
  public.mail_claims, public.coupons, public.coupon_codes, public.coupon_redemptions, public.app_config
  to authenticated;
-- coupon_attempts 는 서버 함수만 쓰고 읽는다(정책 없음 + 권한 없음).

-- ───────── 내부 도우미(private 스키마: API로 노출되지 않는다) ─────────
create or replace function private.audit(p_action text, p_target text, p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $fn$
  insert into public.admin_audit_log(actor, action, target, detail)
  values ((select auth.uid()), p_action, p_target, p_detail);
$fn$;

create or replace function private.is_restricted(p public.players)
returns boolean language sql stable set search_path = '' as $fn$
  select p.status = 'banned' or (p.status = 'suspended' and (p.status_until is null or p.status_until > now()));
$fn$;

create or replace function private.valid_rewards(p jsonb)
returns boolean language plpgsql stable security definer set search_path = '' as $fn$
declare r jsonb; a bigint;
begin
  if p is null or jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 10 then return false; end if;
  for r in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(r) <> 'object' or jsonb_typeof(r->'amount') <> 'number' or jsonb_typeof(r->'asset') <> 'string' then return false; end if;
    if (r->>'amount') !~ '^[0-9]{1,15}$' then return false; end if;
    a := (r->>'amount')::bigint;
    if not exists (select 1 from public.reward_assets x where x.asset = r->>'asset' and x.enabled and a between 1 and x.max_per_grant) then return false; end if;
  end loop;
  return true;
end $fn$;

-- 재화 증감의 유일한 길. 호출하는 쪽이 플레이어 행을 잠근 상태여야 한다(동시 증감 방지).
create or replace function private.grant_asset(p_player uuid, p_asset text, p_delta bigint, p_reason text, p_ref text, p_note text, p_actor uuid)
returns bigint language plpgsql security definer set search_path = '' as $fn$
declare bal bigint;
begin
  insert into public.player_assets(player_id, asset, amount) values (p_player, p_asset, 0) on conflict (player_id, asset) do nothing;
  select amount into bal from public.player_assets where player_id = p_player and asset = p_asset for update;
  if bal + p_delta < 0 then raise exception 'insufficient_balance' using errcode = '22003'; end if;
  update public.player_assets set amount = bal + p_delta, updated_at = now() where player_id = p_player and asset = p_asset;
  insert into public.asset_ledger(player_id, asset, delta, balance_after, reason, ref, note, actor)
  values (p_player, p_asset, p_delta, bal + p_delta, p_reason, p_ref, p_note, p_actor);
  return bal + p_delta;
end $fn$;

create or replace function private.grant_rewards(p_player uuid, p_rewards jsonb, p_reason text, p_ref text)
returns void language plpgsql security definer set search_path = '' as $fn$
declare r jsonb;
begin
  for r in select * from jsonb_array_elements(p_rewards) loop
    perform private.grant_asset(p_player, r->>'asset', (r->>'amount')::bigint, p_reason, p_ref, null, null);
  end loop;
end $fn$;

create or replace function private.coupon_fail(p_player uuid, p_error text, p_penalize boolean)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  insert into public.coupon_attempts(player_id, ok) values (p_player, not p_penalize);
  return jsonb_build_object('ok', false, 'error', p_error);
end $fn$;

-- ───────── 플레이어용 함수 ─────────
create or replace function public.touch_player(p_version text, p_platform text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare me uuid := (select auth.uid()); p public.players;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into p from public.players where id = me;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_player'); end if;
  if p.last_seen_at is null or p.last_seen_at < now() - interval '1 minute' then
    update public.players set last_seen_at = now(),
      app_version = left(nullif(trim(p_version), ''), 32), platform = left(nullif(trim(p_platform), ''), 16)
    where id = me;
  end if;
  return jsonb_build_object('ok', true, 'restricted', private.is_restricted(p), 'status', p.status,
    'until', p.status_until, 'reason', case when private.is_restricted(p) then p.status_reason end);
end $fn$;

create or replace function public.list_my_mails()
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title, 'body', m.body, 'rewards', m.rewards,
    'sent_at', m.starts_at, 'expires_at', m.expires_at, 'claimed', c.mail_id is not null) order by m.starts_at desc), '[]'::jsonb)
  from (
    select mm.* from public.mails mm
    where mm.status = 'active' and mm.starts_at <= now() and mm.expires_at > now()
      and (mm.target_player = (select auth.uid())
           or (mm.target_player is null and mm.starts_at >= (select pl.created_at from public.players pl where pl.id = (select auth.uid()))))
    order by mm.starts_at desc limit 100
  ) m
  left join public.mail_claims c on c.mail_id = m.id and c.player_id = (select auth.uid());
$fn$;

create or replace function public.claim_mail(p_mail_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare me uuid := (select auth.uid()); p public.players; m public.mails;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into p from public.players where id = me for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_player'); end if;
  if private.is_restricted(p) then return jsonb_build_object('ok', false, 'error', 'account_restricted'); end if;
  select * into m from public.mails mm
   where mm.id = p_mail_id and mm.status = 'active' and mm.starts_at <= now() and mm.expires_at > now()
     and (mm.target_player = me or (mm.target_player is null and mm.starts_at >= p.created_at));
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  insert into public.mail_claims(mail_id, player_id) values (m.id, me) on conflict do nothing;
  if not found then return jsonb_build_object('ok', false, 'error', 'already_claimed'); end if;
  perform private.grant_rewards(me, m.rewards, 'mail', m.id::text);
  return jsonb_build_object('ok', true, 'rewards', m.rewards);
end $fn$;

create or replace function public.redeem_coupon(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare me uuid := (select auth.uid()); p public.players; norm text; cd public.coupon_codes; cp public.coupons; fails int;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into p from public.players where id = me for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_player'); end if;
  if private.is_restricted(p) then return jsonb_build_object('ok', false, 'error', 'account_restricted'); end if;
  select count(*) into fails from public.coupon_attempts where player_id = me and not ok and at > now() - interval '10 minutes';
  if fails >= 5 then return jsonb_build_object('ok', false, 'error', 'rate_limited'); end if;
  norm := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if char_length(norm) not between 4 and 32 then return private.coupon_fail(me, 'invalid_code', true); end if;
  select * into cd from public.coupon_codes where code_hash = encode(extensions.digest(norm, 'sha256'), 'hex');
  if not found then return private.coupon_fail(me, 'invalid_code', true); end if;
  select * into cp from public.coupons where id = cd.coupon_id for update;
  if cp.status <> 'active' or now() < cp.starts_at or now() >= cp.ends_at then return private.coupon_fail(me, 'unavailable', true); end if;
  if exists (select 1 from public.coupon_redemptions where coupon_id = cp.id and player_id = me) then return private.coupon_fail(me, 'already_redeemed', false); end if;
  if cp.kind = 'single' and cd.redeemed_by is not null then return private.coupon_fail(me, 'already_used', true); end if;
  if cp.max_redemptions is not null and cp.redeemed_count >= cp.max_redemptions then return private.coupon_fail(me, 'exhausted', false); end if;
  if cp.kind = 'single' then
    update public.coupon_codes set redeemed_by = me, redeemed_at = now() where id = cd.id;
  end if;
  insert into public.coupon_redemptions(coupon_id, player_id, code_id) values (cp.id, me, cd.id);
  update public.coupons set redeemed_count = redeemed_count + 1 where id = cp.id;
  perform private.grant_rewards(me, cp.rewards, 'coupon', cp.id::text);
  insert into public.coupon_attempts(player_id, ok) values (me, true);
  return jsonb_build_object('ok', true, 'rewards', cp.rewards, 'name', cp.name);
end $fn$;

-- 로그인 전에도 읽는 공개 설정(점검·최소 버전). 민감한 값은 담지 않는다.
create or replace function public.get_public_config()
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select jsonb_build_object('maintenance', c.maintenance, 'message', c.maintenance_message, 'ends_at', c.maintenance_ends_at,
    'min_version', c.min_app_version, 'latest_version', c.latest_app_version, 'server_time', now())
  from public.app_config c where c.id = 1;
$fn$;

-- ───────── 운영자용 함수(역할 확인 + 감사 기록) ─────────
create or replace function public.admin_set_player_status(p_player uuid, p_status text, p_reason text, p_until timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator','cs']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('active','suspended','banned') then raise exception 'invalid_status'; end if;
  if p_status = 'banned' and not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status <> 'active' and char_length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required'; end if;
  update public.players set status = p_status, status_reason = case when p_status = 'active' then null else left(trim(p_reason), 300) end,
    status_until = case when p_status = 'suspended' then p_until else null end where id = p_player;
  if not found then raise exception 'player_not_found'; end if;
  perform private.audit('player_status', 'players:' || p_player, jsonb_build_object('status', p_status, 'reason', p_reason, 'until', p_until));
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.admin_adjust_asset(p_player uuid, p_asset text, p_delta bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare bal bigint; lim bigint;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if char_length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required'; end if;
  select max_per_grant into lim from public.reward_assets where asset = p_asset and enabled;
  if lim is null then raise exception 'unknown_asset'; end if;
  if p_delta = 0 or abs(p_delta) > lim then raise exception 'invalid_amount'; end if;
  perform 1 from public.players where id = p_player for update;
  if not found then raise exception 'player_not_found'; end if;
  bal := private.grant_asset(p_player, p_asset, p_delta, 'admin_adjust', null, left(trim(p_reason), 300), (select auth.uid()));
  perform private.audit('asset_adjust', 'players:' || p_player, jsonb_build_object('asset', p_asset, 'delta', p_delta, 'reason', p_reason, 'balance', bal));
  return jsonb_build_object('ok', true, 'balance', bal);
end $fn$;

create or replace function public.admin_send_mail(p_title text, p_body text, p_rewards jsonb default '[]'::jsonb,
  p_target uuid default null, p_starts timestamptz default null, p_expires timestamptz default null)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare mid uuid;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.valid_rewards(p_rewards) then raise exception 'invalid_rewards'; end if;
  if p_target is not null and not exists (select 1 from public.players where id = p_target) then raise exception 'player_not_found'; end if;
  insert into public.mails(title, body, rewards, target_player, starts_at, expires_at, created_by)
  values (trim(p_title), trim(p_body), p_rewards, p_target, coalesce(p_starts, now()), coalesce(p_expires, coalesce(p_starts, now()) + interval '30 days'), (select auth.uid()))
  returning id into mid;
  perform private.audit('mail_send', 'mails:' || mid, jsonb_build_object('title', p_title, 'target', p_target, 'rewards', p_rewards));
  return jsonb_build_object('ok', true, 'id', mid);
end $fn$;

create or replace function public.admin_cancel_mail(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.mails set status = 'cancelled' where id = p_id;
  if not found then raise exception 'not_found'; end if;
  perform private.audit('mail_cancel', 'mails:' || p_id, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $fn$;

-- 단일 코드는 이 응답에서만 원문을 볼 수 있다(저장은 해시뿐).
create or replace function public.admin_create_coupon(p_name text, p_kind text, p_rewards jsonb, p_starts timestamptz,
  p_ends timestamptz, p_max integer default null, p_code text default null, p_count integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare cid uuid; norm text; raw text; alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea; made int := 0; tries int := 0; codes text[] := '{}'; i int; hash text;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind not in ('shared','single') then raise exception 'invalid_kind'; end if;
  if jsonb_typeof(p_rewards) <> 'array' or jsonb_array_length(p_rewards) = 0 or not private.valid_rewards(p_rewards) then raise exception 'invalid_rewards'; end if;
  if p_ends <= p_starts then raise exception 'invalid_period'; end if;
  insert into public.coupons(name, kind, rewards, starts_at, ends_at, max_redemptions, created_by)
  values (trim(p_name), p_kind, p_rewards, p_starts, p_ends, p_max, (select auth.uid())) returning id into cid;
  if p_kind = 'shared' then
    norm := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
    if char_length(norm) not between 6 and 32 then raise exception 'invalid_code'; end if;
    insert into public.coupon_codes(coupon_id, code_hash, code_hint)
    values (cid, encode(extensions.digest(norm, 'sha256'), 'hex'), left(norm, 2) || '…' || right(norm, 2));
  else
    if p_count is null or p_count not between 1 and 1000 then raise exception 'invalid_count'; end if;
    while made < p_count loop
      tries := tries + 1;
      if tries > p_count * 5 + 20 then raise exception 'code_generation_failed'; end if;
      bytes := extensions.gen_random_bytes(12);
      raw := '';
      for i in 0..11 loop raw := raw || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1); end loop;
      hash := encode(extensions.digest(raw, 'sha256'), 'hex');
      insert into public.coupon_codes(coupon_id, code_hash, code_hint) values (cid, hash, left(raw, 2) || '…' || right(raw, 2)) on conflict (code_hash) do nothing;
      if found then
        made := made + 1;
        codes := codes || (substr(raw, 1, 4) || '-' || substr(raw, 5, 4) || '-' || substr(raw, 9, 4));
      end if;
    end loop;
  end if;
  perform private.audit('coupon_create', 'coupons:' || cid, jsonb_build_object('name', p_name, 'kind', p_kind, 'rewards', p_rewards, 'count', p_count, 'max', p_max));
  return jsonb_build_object('ok', true, 'id', cid, 'codes', to_jsonb(codes));
end $fn$;

create or replace function public.admin_set_coupon_status(p_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('active','disabled') then raise exception 'invalid_status'; end if;
  update public.coupons set status = p_status where id = p_id;
  if not found then raise exception 'not_found'; end if;
  perform private.audit('coupon_status', 'coupons:' || p_id, jsonb_build_object('status', p_status));
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.admin_set_config(p_maintenance boolean, p_message text, p_ends_at timestamptz,
  p_min_version text, p_latest_version text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.app_config set maintenance = p_maintenance, maintenance_message = left(coalesce(p_message, ''), 500),
    maintenance_ends_at = p_ends_at, min_app_version = p_min_version, latest_app_version = p_latest_version,
    updated_at = now(), updated_by = (select auth.uid()) where id = 1;
  perform private.audit('config_set', 'app_config:1', jsonb_build_object('maintenance', p_maintenance, 'ends_at', p_ends_at, 'min', p_min_version, 'latest', p_latest_version));
  return jsonb_build_object('ok', true);
end $fn$;

-- ───────── 실행 권한: 기본은 모두 닫고 필요한 것만 연다 ─────────
revoke all on all functions in schema private from public, anon, authenticated;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.admin_can(text[]) to authenticated;
alter default privileges in schema private revoke execute on functions from public, anon, authenticated;

revoke all on function public.touch_player(text, text), public.list_my_mails(), public.claim_mail(uuid),
  public.redeem_coupon(text), public.get_public_config(),
  public.admin_set_player_status(uuid, text, text, timestamptz), public.admin_adjust_asset(uuid, text, bigint, text),
  public.admin_send_mail(text, text, jsonb, uuid, timestamptz, timestamptz), public.admin_cancel_mail(uuid),
  public.admin_create_coupon(text, text, jsonb, timestamptz, timestamptz, integer, text, integer),
  public.admin_set_coupon_status(uuid, text), public.admin_set_config(boolean, text, timestamptz, text, text)
  from public, anon, authenticated;

grant execute on function public.get_public_config() to anon, authenticated;
grant execute on function public.touch_player(text, text), public.list_my_mails(), public.claim_mail(uuid),
  public.redeem_coupon(text),
  public.admin_set_player_status(uuid, text, text, timestamptz), public.admin_adjust_asset(uuid, text, bigint, text),
  public.admin_send_mail(text, text, jsonb, uuid, timestamptz, timestamptz), public.admin_cancel_mail(uuid),
  public.admin_create_coupon(text, text, jsonb, timestamptz, timestamptz, integer, text, integer),
  public.admin_set_coupon_status(uuid, text), public.admin_set_config(boolean, text, timestamptz, text, text)
  to authenticated;
