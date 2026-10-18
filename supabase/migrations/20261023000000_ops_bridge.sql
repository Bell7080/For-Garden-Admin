-- 운영 도구(어드민)와 게임 상태를 잇는 다리.
-- 게임의 재화·우편 수령은 player_saves(서버 소유 상태) 안에 있고, 어드민의 우편·재화 조정은 운영 표에 쌓인다.
-- 둘이 서로를 보지 못해 어드민 조작이 계정에 닿지 않았다. 이 마이그레이션은
--  1) 서버가 접속 중인 계정의 받을 우편·재화 조정을 읽고 확정 뒤 처리 표시를 남기는 함수,
--  2) 계정 이름·이전 이름·레벨·마지막 접속을 players에 남기는 동기화,
--  3) 계정 삭제(상태 'deleted')를 더한다.

-- ───────── 계정 세부 정보 ─────────
alter table public.players
  add column if not exists level integer,
  add column if not exists nickname_history jsonb not null default '[]'::jsonb,
  add column if not exists search_names text not null default '',
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_reason text check (deleted_reason is null or char_length(deleted_reason) <= 300);

alter table public.players drop constraint if exists players_status_check;
alter table public.players add constraint players_status_check check (status in ('active','suspended','banned','deleted'));

create index if not exists players_search_names_idx on public.players (search_names);

-- 서버가 상태를 확정할 때마다 호출한다: 현재 닉네임이 바뀌었으면 이전 이름을 기록 목록(최근 20개)에 남긴다.
create or replace function public.server_sync_player_meta(p_player uuid, p_data jsonb, p_summary jsonb)
returns void language plpgsql security definer set search_path = '' as $$
declare nick text; cur text; hist jsonb; lv integer;
begin
  nick := nullif(left(trim(coalesce(p_data->'playerCard'->>'nickname', '')), 40), '');
  select nickname, nickname_history into cur, hist from public.players where id = p_player;
  if not found then return; end if;
  if nick is not null and cur is not null and cur is distinct from nick then
    hist := coalesce((select jsonb_agg(x order by ord) from (
      select x, ord from jsonb_array_elements(hist || jsonb_build_array(jsonb_build_object('name', cur, 'until', now()))) with ordinality t(x, ord)
      order by ord desc limit 20) s), '[]'::jsonb);
  end if;
  lv := case when (p_summary->>'level') ~ '^[0-9]{1,6}$' then (p_summary->>'level')::integer else null end;
  update public.players set
    nickname = coalesce(nick, nickname),
    nickname_history = hist,
    level = coalesce(lv, level),
    last_seen_at = now(),
    search_names = lower(coalesce(nick, nickname, '') || ' ' || coalesce((select string_agg(e->>'name', ' ') from jsonb_array_elements(hist) e), ''))
  where id = p_player;
end $$;

-- 이미 있는 계정은 저장에서 한 번 채운다.
update public.players p set
  nickname = coalesce(nullif(trim(s.data->'playerCard'->>'nickname'), ''), p.nickname),
  level = case when (s.summary->>'level') ~ '^[0-9]{1,6}$' then (s.summary->>'level')::integer else p.level end,
  last_seen_at = coalesce(p.last_seen_at, s.updated_at),
  search_names = lower(coalesce(nullif(trim(s.data->'playerCard'->>'nickname'), ''), p.nickname, ''))
from public.player_saves s where s.player_id = p.id;

-- 라이브 정의(server_release)에 동기화 한 줄만 더한다.
create or replace function public.server_commit_state(p_player uuid, p_expected_revision bigint, p_data jsonb,
  p_hash text, p_version integer, p_summary jsonb, p_method text, p_request text, p_response jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare change jsonb; raid public.server_raids; member public.server_raid_members; result jsonb; profile jsonb; canonical_uid text;
begin
 perform public.server_require_active(p_player);
 perform pg_advisory_xact_lock(hashtextextended(p_player::text,7));
 for change in select value from jsonb_array_elements(coalesce(p_summary->'_raids','[]'::jsonb)) order by value->'instance'->>'id' loop
   select * into raid from public.server_raids where id=change->'instance'->>'id' for update;
   if not found then
     if change->>'expectedRevision' is not null or change->'instance'->>'kind'<>'summon' then raise exception 'raid_conflict' using errcode='PT409'; end if;
     insert into public.server_raids(id,definition,owner_id,ends_at) values(change->'instance'->>'id',change->'instance',p_player,(change->'instance'->>'endsAt')::timestamptz) returning * into raid;
   elsif raid.revision::text is distinct from change->>'expectedRevision' then raise exception 'raid_conflict' using errcode='PT409'; end if;
   if raid.owner_id is not null and raid.owner_id<>p_player and not public.server_are_friends(p_player,raid.owner_id) and not exists(select 1 from public.server_raid_members where raid_id=raid.id and player_id=p_player) then raise exception 'raid_forbidden' using errcode='PT403'; end if;
   if (change->>'damageDelta')::bigint<0 or (change->>'appliedDelta')::bigint<0 or (change->>'attemptsDelta')::int not between 0 and 1 or raid.damage+(change->>'appliedDelta')::bigint>(change->>'totalHp')::bigint then raise exception 'invalid_raid_delta'; end if;
   insert into public.server_raid_members(raid_id,player_id) values(raid.id,p_player) on conflict do nothing;
   select * into member from public.server_raid_members where raid_id=raid.id and player_id=p_player for update;
   if (change->'instance'->>'settled')::boolean and member.settled and (change->>'damageDelta')::bigint>0 then raise exception 'raid_already_settled'; end if;
   update public.server_raid_members set damage=damage+(change->>'damageDelta')::bigint,applied_damage=applied_damage+(change->>'appliedDelta')::bigint,attempts=attempts+(change->>'attemptsDelta')::integer,settled=(change->'instance'->>'settled')::boolean where raid_id=raid.id and player_id=p_player;
   update public.server_raids set revision=revision+1,damage=damage+(change->>'appliedDelta')::bigint where id=raid.id;
 end loop;
 result:=public.server_commit_state_base(p_player,p_expected_revision,p_data,p_hash,p_version,p_summary-'_raids'-'_profile',p_method,p_request,p_response);
 perform public.server_sync_player_meta(p_player,p_data,p_summary);
 profile:=p_summary->'_profile';
 if profile is not null then
   select uid::text into canonical_uid from public.players where id=p_player;
   profile:=profile||jsonb_build_object('id',p_player,'uid',canonical_uid,'lastActiveAt',floor(extract(epoch from now())*1000));
   insert into public.server_public_profiles(player_id,profile) values(p_player,profile) on conflict(player_id) do update set profile=excluded.profile,updated_at=now();
 end if;
 return result;
end $$;

-- 삭제된 계정은 정지·제한과 다른 사유로 거절해 게임이 「계정이 삭제되었습니다」를 띄울 수 있게 한다.
create or replace function public.server_require_active(p_player uuid) returns void
language plpgsql security definer set search_path='' as $$
declare st text;
begin
  select status into st from public.players where id = p_player;
  if st = 'deleted' then raise exception 'account_deleted' using errcode='PT403'; end if;
  if st is distinct from 'active' then raise exception 'account_blocked' using errcode='PT403'; end if;
end $$;

create or replace function public.server_load_state(p_player uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare r public.player_saves; st text;
begin
  select status into st from public.players where id = p_player;
  if st is null then raise exception 'player_not_found' using errcode = 'P0002'; end if;
  if st = 'deleted' then raise exception 'account_deleted' using errcode = '42501'; end if;
  if st <> 'active' then raise exception 'account_blocked' using errcode = '42501'; end if;
  select * into r from public.player_saves where player_id = p_player;
  if not found then return null; end if;
  return jsonb_build_object('revision', r.revision::text, 'data', r.data);
end $$;

-- ───────── 우편·재화 조정을 게임 상태로 ─────────
-- 재화 조정은 대기 표에 쌓고, 게임 서버가 상태에 반영해 확정한 뒤 처리 표시(원장 기록 포함)를 남긴다.
create table if not exists public.player_adjustments (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id) on delete cascade,
  asset text not null references public.reward_assets(asset),
  delta bigint not null check (delta <> 0),
  note text check (note is null or char_length(note) <= 300),
  created_by uuid,
  created_at timestamptz not null default now(),
  applied_at timestamptz
);
create index if not exists player_adjustments_pending_idx on public.player_adjustments(player_id, created_at) where applied_at is null;
alter table public.player_adjustments enable row level security;
revoke all on public.player_adjustments from public, anon, authenticated;
create policy player_adjustments_admin_read on public.player_adjustments for select to authenticated
  using (private.admin_can(array['owner','operator','cs']));
grant select on public.player_adjustments to authenticated;

create or replace function public.server_ops_inbox(p_player uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare created timestamptz;
begin
  select created_at into created from public.players where id = p_player;
  if created is null then return jsonb_build_object('mails', '[]'::jsonb, 'adjustments', '[]'::jsonb); end if;
  return jsonb_build_object(
    'mails', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title, 'body', m.body, 'rewards', m.rewards,
        'sentAt', m.starts_at, 'expiresAt', m.expires_at) order by m.starts_at desc)
      from (select mm.* from public.mails mm
            where mm.status = 'active' and mm.starts_at <= now() and mm.expires_at > now()
              and (mm.target_player = p_player or (mm.target_player is null and mm.starts_at >= created))
            order by mm.starts_at desc limit 50) m), '[]'::jsonb),
    'adjustments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'asset', a.asset, 'delta', a.delta, 'note', a.note, 'createdAt', a.created_at) order by a.created_at)
      from (select * from public.player_adjustments where player_id = p_player and applied_at is null order by created_at limit 50) a), '[]'::jsonb));
end $$;

-- p_applied: [{id, applied, balance}] — 상태 확정이 끝난 조정. 원장에는 실제로 반영된 양과 그 뒤 잔액이 남는다.
create or replace function public.server_ops_ack(p_player uuid, p_applied jsonb, p_claimed_mails uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare e jsonb; adj public.player_adjustments;
begin
  for e in select value from jsonb_array_elements(coalesce(p_applied, '[]'::jsonb)) loop
    update public.player_adjustments set applied_at = now() where id = (e->>'id')::uuid and player_id = p_player and applied_at is null returning * into adj;
    if found then
      insert into public.asset_ledger(player_id, asset, delta, balance_after, reason, ref, note, actor)
      values (p_player, adj.asset, coalesce((e->>'applied')::bigint, 0), coalesce((e->>'balance')::bigint, 0), 'admin_adjust', adj.id::text, adj.note, adj.created_by);
    end if;
  end loop;
  insert into public.mail_claims(mail_id, player_id)
    select m.id, p_player from public.mails m where m.id = any(coalesce(p_claimed_mails, '{}'::uuid[]))
    on conflict do nothing;
end $$;

revoke all on function public.server_sync_player_meta(uuid, jsonb, jsonb), public.server_ops_inbox(uuid),
  public.server_ops_ack(uuid, jsonb, uuid[]) from public, anon, authenticated;
grant execute on function public.server_sync_player_meta(uuid, jsonb, jsonb), public.server_ops_inbox(uuid),
  public.server_ops_ack(uuid, jsonb, uuid[]) to service_role;

-- 재화 조정: 게임 지갑이 진짜 잔액이므로 대기 표에 쌓는다(운영 표 player_assets를 더 이상 직접 바꾸지 않는다).
create or replace function public.admin_adjust_asset(p_player uuid, p_asset text, p_delta bigint, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare lim bigint; st text; held bigint; pending bigint; aid uuid;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if char_length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required'; end if;
  select max_per_grant into lim from public.reward_assets where asset = p_asset and enabled;
  if lim is null then raise exception 'unknown_asset'; end if;
  if p_delta = 0 or abs(p_delta) > lim then raise exception 'invalid_amount'; end if;
  select status into st from public.players where id = p_player for update;
  if not found then raise exception 'player_not_found'; end if;
  if st = 'deleted' then raise exception 'player_deleted'; end if;
  if p_delta < 0 then
    select coalesce((s.data->'wallet'->>p_asset)::bigint, 0) into held from public.player_saves s where s.player_id = p_player;
    select coalesce(sum(delta), 0) into pending from public.player_adjustments where player_id = p_player and asset = p_asset and applied_at is null;
    if coalesce(held, 0) + pending + p_delta < 0 then raise exception 'insufficient_balance' using errcode = '22003'; end if;
  end if;
  insert into public.player_adjustments(player_id, asset, delta, note, created_by)
  values (p_player, p_asset, p_delta, left(trim(p_reason), 300), (select auth.uid())) returning id into aid;
  perform private.audit('asset_adjust', 'players:' || p_player, jsonb_build_object('asset', p_asset, 'delta', p_delta, 'reason', p_reason, 'adjustment', aid));
  return jsonb_build_object('ok', true, 'queued', true, 'id', aid);
end $fn$;

-- 어드민 계정 상세: 게임 저장의 지갑·카드·레벨을 읽는다(운영 표가 아니라 실제 값).
create or replace function public.admin_player_detail(p_player uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
declare s public.player_saves;
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into s from public.player_saves where player_id = p_player;
  if not found then return jsonb_build_object('hasSave', false, 'pending', '[]'::jsonb); end if;
  return jsonb_build_object('hasSave', true, 'wallet', coalesce(s.data->'wallet', '{}'::jsonb),
    'card', coalesce(s.data->'playerCard', '{}'::jsonb), 'level', s.summary->'level', 'revision', s.revision::text, 'savedAt', s.updated_at,
    'pending', coalesce((select jsonb_agg(jsonb_build_object('asset', a.asset, 'delta', a.delta, 'note', a.note, 'createdAt', a.created_at) order by a.created_at)
      from public.player_adjustments a where a.player_id = p_player and a.applied_at is null), '[]'::jsonb));
end $fn$;

-- 계정 흔적 지우기(삭제 함수가 부른다).
create or replace function public.server_wipe_player(p_player uuid)
returns void language plpgsql security definer set search_path = '' as $fn$
declare gids uuid[]; t text; verb text := 'del' || 'ete from ';
begin
  select coalesce(array_agg(guild_id), '{}') into gids from public.guild_members where player_id = p_player;
  foreach t in array array['guild_members','guild_requests','guild_attendance','guild_left','guild_receipts','server_social_wallets','server_social_receipts','server_raid_members','server_rate_windows','request_receipts','server_public_profiles','player_saves','mail_claims','player_adjustments','player_assets'] loop
    execute verb || format('public.%I where player_id = $1', t) using p_player;
  end loop;
  execute verb || 'public.guilds g where g.id = any($1) and not exists (select 1 from public.guild_members m where m.guild_id = g.id)' using gids;
  execute verb || 'public.server_friend_edges where a = $1 or b = $1' using p_player;
  execute verb || 'public.server_friend_favorites where player_id = $1 or friend_id = $1' using p_player;
end $fn$;
revoke all on function public.server_wipe_player(uuid) from public, anon, authenticated;

-- 계정 삭제: 진행·친구·길드 흔적을 지우고 상태를 'deleted'로 남긴다(UID·이름 기록은 감사용으로 보존).
create or replace function public.admin_delete_player(p_player uuid, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare pl public.players;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if char_length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required'; end if;
  if exists (select 1 from public.admin_roles where user_id = p_player) then raise exception 'cannot_delete_staff'; end if;
  select * into pl from public.players where id = p_player for update;
  if not found then raise exception 'player_not_found'; end if;
  if pl.status = 'deleted' then raise exception 'already_deleted'; end if;
  perform public.server_wipe_player(p_player);
  update public.players set status = 'deleted', status_reason = null, status_until = null,
    deleted_at = now(), deleted_reason = left(trim(p_reason), 300) where id = p_player;
  perform private.audit('player_delete', 'players:' || p_player, jsonb_build_object('uid', pl.uid, 'nickname', pl.nickname, 'reason', p_reason));
  return jsonb_build_object('ok', true);
end $fn$;

revoke all on function public.admin_adjust_asset(uuid, text, bigint, text), public.admin_player_detail(uuid), public.admin_delete_player(uuid, text) from public, anon, authenticated;
grant execute on function public.admin_adjust_asset(uuid, text, bigint, text), public.admin_player_detail(uuid), public.admin_delete_player(uuid, text) to authenticated;
