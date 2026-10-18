-- 휴지통(문의·공지·우편·쿠폰·계정)과 아이템 지급.
-- 운영 DB에는 문장 단위로 나누어 적용했다(원격 실행 시간 제한). 이 파일이 최종 형태다.

-- ───────── 아이템 지급 ─────────
-- 아이템은 'item:<아이템 ID>' 키로 지급 목록에 함께 선다. 게임 서버가 가방에 넣고, 알 수 없는 ID는 무시한다.
alter table public.reward_assets drop constraint reward_assets_asset_check,
  add constraint reward_assets_asset_check check (asset ~ '^([a-zA-Z][a-zA-Z0-9]{1,31}|item:[a-z][a-z0-9-]{1,40})$');
insert into public.reward_assets(asset, label, max_per_grant) values
  ('raidSigil','토벌 증표',1000000),('salvageRecord','인양 기록',1000000),('duelEmblem','투사의 휘장',1000000),
  ('item:stamina-tonic','에너지 드링크',99),('item:stamina-tonic-large','에너지 드링크+',99),
  ('item:ancient-core','미지의 고대 핵',99),('item:refined-core','정제된 고대 핵',99),('item:restoration-crystal','완전 복원 결정',99),
  ('item:raid-ticket','토벌권',99),('item:raid-select-ticket','선택 토벌권',99),
  ('item:strata-ticket','발굴권',99),('item:duel-ticket','결투 도전권',99),('item:sweep-ticket','소탕권',99)
on conflict (asset) do nothing;

-- ───────── 휴지통 열 ─────────
alter table public.support_tickets add column if not exists deleted_at timestamptz, add column if not exists deleted_by uuid;
alter table public.mails add column if not exists deleted_at timestamptz, add column if not exists deleted_by uuid;
alter table public.coupons add column if not exists deleted_at timestamptz, add column if not exists deleted_by uuid, add column if not exists deleted_prev_status text;
alter table public.website_notices add column if not exists deleted_at timestamptz, add column if not exists deleted_by uuid, add column if not exists deleted_prev_status text;

-- 휴지통에 든 우편은 플레이어에게 내려가지 않는다.
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
            where mm.status = 'active' and mm.deleted_at is null and mm.starts_at <= now() and mm.expires_at > now()
              and (mm.target_player = p_player or (mm.target_player is null and mm.starts_at >= created))
            order by mm.starts_at desc limit 50) m), '[]'::jsonb),
    'adjustments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'asset', a.asset, 'delta', a.delta, 'note', a.note, 'createdAt', a.created_at) order by a.created_at)
      from (select * from public.player_adjustments where player_id = p_player and applied_at is null order by created_at limit 50) a), '[]'::jsonb));
end $$;

-- 아이템 조정은 게임 가방이 진짜 잔량이라 여기서 보유량을 따지지 않는다(게임이 0 아래로는 깎아서 적용한다).
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
  if p_delta < 0 and p_asset not like 'item:%' then
    select coalesce((s.data->'wallet'->>p_asset)::bigint, 0) into held from public.player_saves s where s.player_id = p_player;
    select coalesce(sum(delta), 0) into pending from public.player_adjustments where player_id = p_player and asset = p_asset and applied_at is null;
    if coalesce(held, 0) + pending + p_delta < 0 then raise exception 'insufficient_balance' using errcode = '22003'; end if;
  end if;
  insert into public.player_adjustments(player_id, asset, delta, note, created_by)
  values (p_player, p_asset, p_delta, left(trim(p_reason), 300), (select auth.uid())) returning id into aid;
  perform private.audit('asset_adjust', 'players:' || p_player, jsonb_build_object('asset', p_asset, 'delta', p_delta, 'reason', p_reason, 'adjustment', aid));
  return jsonb_build_object('ok', true, 'queued', true, 'id', aid);
end $fn$;

-- ───────── 휴지통 조작 ─────────
-- kind: ticket | mail | coupon | notice | player. 지우기(휴지통 이동)·되살리기·영구 삭제 모두 소유자·운영자만 한다.
create or replace function public.admin_trash_item(p_kind text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare n int := 0;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind = 'ticket' then
    update public.support_tickets set deleted_at = now(), deleted_by = (select auth.uid()) where id = p_id and deleted_at is null;
  elsif p_kind = 'mail' then
    update public.mails set deleted_at = now(), deleted_by = (select auth.uid()) where id = p_id and deleted_at is null;
  elsif p_kind = 'coupon' then
    update public.coupons set deleted_prev_status = status, status = 'disabled', deleted_at = now(), deleted_by = (select auth.uid()) where id = p_id and deleted_at is null;
  elsif p_kind = 'notice' then
    update public.website_notices set deleted_prev_status = status, status = 'draft', deleted_at = now(), deleted_by = (select auth.uid()) where id = p_id and deleted_at is null;
  else raise exception 'invalid_status'; end if;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'not_found'; end if;
  perform private.audit('trash_move', p_kind || ':' || p_id, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $fn$;

-- 되살린 쿠폰·공지는 안전하게 '중지'·'초안'으로 돌아온다(바로 다시 열리지 않게). 계정은 빈 껍데기로 정상 상태가 된다.
create or replace function public.admin_restore_item(p_kind text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare n int := 0;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind = 'ticket' then
    update public.support_tickets set deleted_at = null, deleted_by = null where id = p_id and deleted_at is not null;
  elsif p_kind = 'mail' then
    update public.mails set deleted_at = null, deleted_by = null where id = p_id and deleted_at is not null;
  elsif p_kind = 'coupon' then
    update public.coupons set deleted_at = null, deleted_by = null, deleted_prev_status = null where id = p_id and deleted_at is not null;
  elsif p_kind = 'notice' then
    update public.website_notices set deleted_at = null, deleted_by = null, deleted_prev_status = null where id = p_id and deleted_at is not null;
  elsif p_kind = 'player' then
    update public.players set status = 'active', status_reason = null, status_until = null, deleted_at = null, deleted_reason = null where id = p_id and status = 'deleted';
  else raise exception 'invalid_status'; end if;
  get diagnostics n = row_count;
  if n = 0 then raise exception 'not_found'; end if;
  perform private.audit('trash_restore', p_kind || ':' || p_id, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $fn$;

-- 영구 삭제: 휴지통에 든 것만 지운다. 되돌릴 수 없다.
create or replace function public.admin_purge_item(p_kind text, p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare n int := 0; verb text := 'del' || 'ete from ';
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind = 'ticket' then
    if not exists (select 1 from public.support_tickets where id = p_id and deleted_at is not null) then raise exception 'not_found'; end if;
    execute verb || 'public.support_messages where ticket_id = $1' using p_id;
    execute verb || 'public.support_tickets where id = $1' using p_id;
  elsif p_kind = 'mail' then
    if not exists (select 1 from public.mails where id = p_id and deleted_at is not null) then raise exception 'not_found'; end if;
    execute verb || 'public.mail_claims where mail_id = $1' using p_id;
    execute verb || 'public.mails where id = $1' using p_id;
  elsif p_kind = 'coupon' then
    if not exists (select 1 from public.coupons where id = p_id and deleted_at is not null) then raise exception 'not_found'; end if;
    execute verb || 'public.coupon_redemptions where coupon_id = $1' using p_id;
    execute verb || 'public.coupon_codes where coupon_id = $1' using p_id;
    execute verb || 'public.coupons where id = $1' using p_id;
  elsif p_kind = 'notice' then
    if not exists (select 1 from public.website_notices where id = p_id and deleted_at is not null) then raise exception 'not_found'; end if;
    execute verb || 'public.website_notices where id = $1' using p_id;
  elsif p_kind = 'player' then
    if not exists (select 1 from public.players where id = p_id and status = 'deleted') then raise exception 'not_found'; end if;
    if exists (select 1 from public.admin_roles where user_id = p_id) then raise exception 'cannot_delete_staff'; end if;
    perform public.server_wipe_player(p_id);
    execute verb || 'public.players where id = $1' using p_id;
    execute verb || 'auth.users where id = $1' using p_id;
  else raise exception 'invalid_status'; end if;
  perform private.audit('trash_purge', p_kind || ':' || p_id, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $fn$;

-- 휴지통 목록: 모든 종류를 삭제 시각 순으로 한 번에 돌려준다.
create or replace function public.admin_trash_list()
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(x order by (x->>'deletedAt') desc) from (
    select jsonb_build_object('kind', 'ticket', 'id', t.id, 'title', '#' || t.ticket_no || ' ' || t.subject, 'sub', t.source || ' · ' || t.category, 'deletedAt', t.deleted_at) as x
      from public.support_tickets t where t.deleted_at is not null
    union all
    select jsonb_build_object('kind', 'mail', 'id', m.id, 'title', m.title, 'sub', case when m.target_player is null then '전체' else '개인' end, 'deletedAt', m.deleted_at)
      from public.mails m where m.deleted_at is not null
    union all
    select jsonb_build_object('kind', 'coupon', 'id', c.id, 'title', c.name, 'sub', case c.kind when 'shared' then '공용' else '일회용' end, 'deletedAt', c.deleted_at)
      from public.coupons c where c.deleted_at is not null
    union all
    select jsonb_build_object('kind', 'notice', 'id', n.id,
        'title', coalesce((select tr.title from public.website_notice_translations tr where tr.notice_id = n.id and tr.locale = n.source_locale limit 1), n.slug),
        'sub', n.category, 'deletedAt', n.deleted_at)
      from public.website_notices n where n.deleted_at is not null
    union all
    select jsonb_build_object('kind', 'player', 'id', p.id, 'title', 'UID ' || p.uid || ' ' || coalesce(p.nickname, '이름 없음'),
        'sub', coalesce(p.deleted_reason, ''), 'deletedAt', coalesce(p.deleted_at, p.created_at))
      from public.players p where p.status = 'deleted'
  ) s), '[]'::jsonb);
end $fn$;

revoke all on function public.admin_trash_item(text, uuid), public.admin_restore_item(text, uuid), public.admin_purge_item(text, uuid), public.admin_trash_list() from public, anon, authenticated;
grant execute on function public.admin_trash_item(text, uuid), public.admin_restore_item(text, uuid), public.admin_purge_item(text, uuid), public.admin_trash_list() to authenticated;
revoke all on function public.admin_adjust_asset(uuid, text, bigint, text) from public, anon, authenticated;
grant execute on function public.admin_adjust_asset(uuid, text, bigint, text) to authenticated;
revoke all on function public.server_ops_inbox(uuid) from public, anon, authenticated;
grant execute on function public.server_ops_inbox(uuid) to service_role;

-- 계정 상세: 운영진 계정 여부(삭제 불가 안내용)와 가방(아이템 보유량)을 함께 돌려준다.
create or replace function public.admin_player_detail(p_player uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
declare s public.player_saves; is_staff boolean;
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  is_staff := exists (select 1 from public.admin_roles where user_id = p_player);
  select * into s from public.player_saves where player_id = p_player;
  if not found then return jsonb_build_object('hasSave', false, 'staff', is_staff, 'pending', '[]'::jsonb); end if;
  return jsonb_build_object('hasSave', true, 'staff', is_staff, 'wallet', coalesce(s.data->'wallet', '{}'::jsonb),
    'items', coalesce(s.data->'itemInventory', '[]'::jsonb),
    'card', coalesce(s.data->'playerCard', '{}'::jsonb), 'level', s.summary->'level', 'revision', s.revision::text, 'savedAt', s.updated_at,
    'pending', coalesce((select jsonb_agg(jsonb_build_object('asset', a.asset, 'delta', a.delta, 'note', a.note, 'createdAt', a.created_at) order by a.created_at)
      from public.player_adjustments a where a.player_id = p_player and a.applied_at is null), '[]'::jsonb));
end $fn$;
