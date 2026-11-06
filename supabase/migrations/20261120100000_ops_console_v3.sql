-- 운영 콘솔 v3: 결제 기록·환불, 금칙어·프로필 초기화, 랭킹 부정 기록 제외, 길드 관리, 공지 팝업 배너.
-- 표와 게임 쪽 함수는 For-Garden 저장소의 20261120000000_ops_moderation.sql 이 만든다 — 그 파일을 먼저 적용한다.
-- 읽기는 모두 이 함수들로만 한다(표에 직접 읽기 정책을 열지 않는다). 쓰기는 소유자·운영자, 프로필 초기화만 CS도 한다.

-- ───────── 결제 기록·환불 ─────────
create or replace function public.admin_list_purchases(p_query text default '', p_refunded boolean default null, p_limit int default 100)
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
declare q text := trim(coalesce(p_query, '')); uid_q bigint;
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if q ~ '^[0-9]{9}$' then uid_q := q::bigint; end if;
  return coalesce((select jsonb_agg(row_to_json(r)::jsonb order by r.recorded_at desc) from (
    select pr.transaction_id, pr.player_id, p.uid, p.nickname, pr.product_id, pr.granted, pr.first_bonus, pr.recorded_at,
      pr.refunded_at, pr.refund_reason, pr.clawback
    from public.purchase_records pr join public.players p on p.id = pr.player_id
    where (q = '' or pr.transaction_id = q or pr.product_id = q or p.uid = uid_q)
      and (p_refunded is null or (pr.refunded_at is not null) = p_refunded)
    order by pr.recorded_at desc
    limit least(greatest(coalesce(p_limit, 100), 1), 300)) r), '[]'::jsonb);
end $fn$;

create or replace function public.admin_purchase_summary(p_days int default 30)
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'count', (select count(*) from public.purchase_records where recorded_at > now() - make_interval(days => p_days)),
    'refunded', (select count(*) from public.purchase_records where refunded_at > now() - make_interval(days => p_days)),
    'buyers', (select count(distinct player_id) from public.purchase_records where recorded_at > now() - make_interval(days => p_days)),
    'products', coalesce((select jsonb_agg(jsonb_build_object('product', product_id, 'count', n) order by n desc) from (
      select product_id, count(*) as n from public.purchase_records where recorded_at > now() - make_interval(days => p_days) and refunded_at is null
      group by product_id order by n desc limit 10) t), '[]'::jsonb));
end $fn$;

-- 환불 표시. p_clawback 이면 지급했던 재화·아이템을 음수 조정으로 회수한다(게임이 0 아래로는 깎아서 적용한다).
create or replace function public.admin_refund_purchase(p_transaction text, p_reason text, p_clawback boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare pr public.purchase_records; g jsonb; v_asset text; amount bigint; claws jsonb := '[]'::jsonb; aid uuid;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if char_length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required'; end if;
  select * into pr from public.purchase_records where transaction_id = p_transaction for update;
  if not found then raise exception 'purchase_not_found'; end if;
  if pr.refunded_at is not null then raise exception 'already_refunded'; end if;
  if p_clawback then
    for g in select value from jsonb_array_elements(coalesce(pr.granted, '[]'::jsonb)) loop
      v_asset := case g->>'kind' when 'currency' then g->>'currency' when 'item' then 'item:' || (g->>'itemId') else null end;
      amount := coalesce((g->>'amount')::bigint, 0);
      if v_asset is null or amount <= 0 then continue; end if;
      -- 조정 대기열은 등록된 재화·아이템만 받는다. 없는 것(패스·외형 등)은 회수 목록에 건너뜀으로만 남긴다.
      if not exists (select 1 from public.reward_assets ra where ra.asset = v_asset) then
        claws := claws || jsonb_build_object('asset', v_asset, 'delta', -amount, 'skipped', true);
        continue;
      end if;
      insert into public.player_adjustments(player_id, asset, delta, note, created_by)
      values (pr.player_id, v_asset, -amount, left('환불 회수 · ' || trim(p_reason), 300), (select auth.uid())) returning id into aid;
      claws := claws || jsonb_build_object('asset', v_asset, 'delta', -amount, 'adjustment', aid);
    end loop;
  end if;
  update public.purchase_records set refunded_at = now(), refund_reason = left(trim(p_reason), 200), refunded_by = (select auth.uid()),
    clawback = case when p_clawback then claws else null end
  where transaction_id = p_transaction;
  perform private.audit('purchase_refund', 'purchase_records:' || p_transaction,
    jsonb_build_object('player', pr.player_id, 'product', pr.product_id, 'reason', p_reason, 'clawback', claws));
  return jsonb_build_object('ok', true, 'clawback', claws);
end $fn$;

-- ───────── 금칙어 ─────────
create or replace function public.admin_list_banned_words()
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('word', word, 'createdAt', created_at) order by word) from public.banned_words), '[]'::jsonb);
end $fn$;

create or replace function public.admin_set_banned_word(p_word text, p_banned boolean)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare w text := lower(regexp_replace(trim(coalesce(p_word, '')), '\s+', '', 'g'));
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if char_length(w) not between 1 and 40 then raise exception 'invalid_word'; end if;
  if p_banned then
    insert into public.banned_words(word, created_by) values (w, (select auth.uid())) on conflict (word) do nothing;
  else
    delete from public.banned_words where word = w;
  end if;
  perform private.audit(case when p_banned then 'banned_word_add' else 'banned_word_remove' end, 'banned_words:' || w, jsonb_build_object('word', w));
  return jsonb_build_object('ok', true, 'word', w);
end $fn$;

-- ───────── 프로필 강제 초기화 ─────────
create or replace function public.admin_reset_profile(p_player uuid, p_kind text, p_reason text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare st text; aid uuid;
begin
  if not private.admin_can(array['owner','operator','cs']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind not in ('nickname_reset', 'bio_reset') then raise exception 'invalid_kind'; end if;
  if char_length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required'; end if;
  select status into st from public.players where id = p_player;
  if not found then raise exception 'player_not_found'; end if;
  if st = 'deleted' then raise exception 'player_deleted'; end if;
  if exists (select 1 from public.player_profile_actions where player_id = p_player and kind = p_kind and applied_at is null) then raise exception 'already_pending'; end if;
  insert into public.player_profile_actions(player_id, kind, reason, created_by)
  values (p_player, p_kind, left(trim(p_reason), 200), (select auth.uid())) returning id into aid;
  perform private.audit('profile_reset', 'players:' || p_player, jsonb_build_object('kind', p_kind, 'reason', p_reason, 'action', aid));
  return jsonb_build_object('ok', true, 'id', aid);
end $fn$;

create or replace function public.admin_profile_actions(p_player uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('kind', kind, 'reason', reason, 'createdAt', created_at, 'appliedAt', applied_at) order by created_at desc)
    from (select * from public.player_profile_actions where player_id = p_player order by created_at desc limit 20) a), '[]'::jsonb);
end $fn$;

-- 제재 이력에 프로필 초기화·환불·랭킹 제외도 함께 보이게 넓힌다(v2와 같은 반환 모양을 지킨다).
create or replace function public.admin_player_sanctions(p_player uuid)
returns table(action text, detail jsonb, at timestamptz, actor_email text)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator','cs']) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    select l.action, l.detail, l.at, u.email::text
      from public.admin_audit_log l left join auth.users u on u.id = l.actor
     where (l.target = 'players:' || p_player and l.action in ('player_status','player_delete','asset_adjust','profile_reset'))
        or (l.action in ('purchase_refund','ranking_remove') and l.detail->>'player' = p_player::text)
     order by l.id desc limit 50;
end $fn$;

-- ───────── 랭킹 관리 ─────────
create or replace function public.admin_competitive_periods(p_board text)
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(period order by period desc) from (
    select distinct period from public.server_competitive_scores where board = p_board
    union select distinct period from public.server_competitive_bans where board = p_board
    order by period desc limit 12) t), '[]'::jsonb);
end $fn$;

create or replace function public.admin_competitive_scores(p_board text, p_period date, p_limit int default 100)
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'rows', coalesce((select jsonb_agg(jsonb_build_object('rank', r.rnk, 'playerId', r.player_id, 'uid', r.uid, 'nickname', r.nickname, 'score', r.score, 'achievedAt', r.achieved_at) order by r.rnk) from (
      select c.player_id, p.uid, p.nickname, c.score, c.achieved_at,
        row_number() over (order by c.score desc, c.achieved_at, c.player_id) as rnk
      from public.server_competitive_scores c join public.players p on p.id = c.player_id
      where c.board = p_board and c.period = p_period
      order by c.score desc, c.achieved_at, c.player_id
      limit least(greatest(coalesce(p_limit, 100), 1), 500)) r), '[]'::jsonb),
    'bans', coalesce((select jsonb_agg(jsonb_build_object('playerId', b.player_id, 'uid', p.uid, 'nickname', p.nickname, 'reason', b.reason, 'at', b.created_at) order by b.created_at desc)
      from public.server_competitive_bans b join public.players p on p.id = b.player_id
      where b.board = p_board and b.period = p_period), '[]'::jsonb));
end $fn$;

-- 그 기간의 기록을 지우고 다시 들어오지 못하게 막는다. 이미 보낸 순위 보상 우편은 되돌리지 않는다(필요하면 재화 조정).
create or replace function public.admin_remove_competitive_score(p_board text, p_period date, p_player uuid, p_reason text, p_remove boolean default true)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare old_score bigint;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_remove then
    if char_length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required'; end if;
    insert into public.server_competitive_bans(board, period, player_id, reason, created_by)
    values (p_board, p_period, p_player, left(trim(p_reason), 200), (select auth.uid()))
    on conflict (board, period, player_id) do update set reason = excluded.reason;
    delete from public.server_competitive_scores where board = p_board and period = p_period and player_id = p_player returning score into old_score;
  else
    delete from public.server_competitive_bans where board = p_board and period = p_period and player_id = p_player;
  end if;
  perform private.audit(case when p_remove then 'ranking_remove' else 'ranking_restore' end, 'ranking:' || p_board || ':' || p_period,
    jsonb_build_object('player', p_player, 'board', p_board, 'period', p_period, 'score', old_score, 'reason', p_reason));
  return jsonb_build_object('ok', true, 'removedScore', old_score);
end $fn$;

-- ───────── 길드 관리 ─────────
create or replace function public.admin_list_guilds(p_query text default '')
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
declare q text := lower(regexp_replace(trim(coalesce(p_query, '')), '\s+', '', 'g'));
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(row_to_json(r)::jsonb order by r.members desc, r.created_at) from (
    select g.id, g.name, g.prosperity, g.join_mode, g.created_at,
      (select count(*) from public.guild_members m where m.guild_id = g.id) as members,
      (select m.name from public.guild_members m where m.guild_id = g.id and m.role = 'leader') as leader
    from public.guilds g
    where q = '' or g.name_key like '%' || q || '%'
       or exists (select 1 from public.guild_members m join public.players p on p.id = m.player_id where m.guild_id = g.id and p.uid::text = q)
    order by members desc, g.created_at limit 100) r), '[]'::jsonb);
end $fn$;

create or replace function public.admin_guild_detail(p_guild uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
declare g public.guilds;
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  select * into g from public.guilds where id = p_guild;
  if not found then raise exception 'guild_not_found'; end if;
  return jsonb_build_object('id', g.id, 'name', g.name, 'notice', g.notice, 'prosperity', g.prosperity, 'joinMode', g.join_mode, 'createdAt', g.created_at,
    'members', coalesce((select jsonb_agg(jsonb_build_object('playerId', m.player_id, 'uid', p.uid, 'name', m.name, 'role', m.role, 'level', m.level,
        'joinedAt', m.joined_at, 'lastActiveAt', m.last_active_at, 'contributionWeek', m.contribution_week, 'contributionTotal', m.contribution_total)
        order by case m.role when 'leader' then 0 when 'vice' then 1 when 'officer' then 2 else 3 end, m.joined_at)
      from public.guild_members m join public.players p on p.id = m.player_id where m.guild_id = g.id), '[]'::jsonb));
end $fn$;

-- p_action: kick(대상 길드원) · transfer(새 길드장) · rename(새 이름) · reset_notice · disband
create or replace function public.admin_guild_action(p_guild uuid, p_action text, p_player uuid default null, p_name text default null, p_reason text default '')
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare g public.guilds; m public.guild_members; nm text; nk text;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if char_length(trim(coalesce(p_reason, ''))) = 0 then raise exception 'reason_required'; end if;
  select * into g from public.guilds where id = p_guild for update;
  if not found then raise exception 'guild_not_found'; end if;
  if p_action = 'kick' then
    select * into m from public.guild_members where player_id = p_player and guild_id = p_guild;
    if not found then raise exception 'not_member'; end if;
    if m.role = 'leader' then raise exception 'leader_cannot_be_kicked'; end if;
    delete from public.guild_members where player_id = p_player;
    insert into public.guild_left(player_id, left_at) values (p_player, now()) on conflict (player_id) do update set left_at = excluded.left_at;
  elsif p_action = 'transfer' then
    select * into m from public.guild_members where player_id = p_player and guild_id = p_guild;
    if not found then raise exception 'not_member'; end if;
    if m.role <> 'leader' then
      update public.guild_members set role = 'vice' where guild_id = p_guild and role = 'leader';
      update public.guild_members set role = 'leader' where player_id = p_player;
    end if;
  elsif p_action = 'rename' then
    nm := regexp_replace(trim(coalesce(p_name, '')), '\s+', ' ', 'g');
    if nm !~ '^[[:alpha:][:digit:] ]+$' or char_length(nm) not between 2 and 12 then raise exception 'invalid_guild_name'; end if;
    nk := lower(replace(nm, ' ', ''));
    if exists (select 1 from public.guilds where name_key = nk and id <> p_guild) then raise exception 'guild_name_taken'; end if;
    update public.guilds set name = nm, name_key = nk where id = p_guild;
  elsif p_action = 'reset_notice' then
    update public.guilds set notice = '' where id = p_guild;
  elsif p_action = 'disband' then
    insert into public.guild_left(player_id, left_at)
      select player_id, now() from public.guild_members where guild_id = p_guild
      on conflict (player_id) do update set left_at = excluded.left_at;
    delete from public.guilds where id = p_guild;
  else
    raise exception 'invalid_action';
  end if;
  perform private.audit('guild_' || p_action, 'guilds:' || p_guild,
    jsonb_build_object('guild', g.name, 'player', p_player, 'name', nm, 'reason', p_reason));
  return jsonb_build_object('ok', true);
end $fn$;

-- ───────── 공지 팝업 배너 ─────────
create or replace function public.admin_list_banners()
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(row_to_json(b)::jsonb order by b.starts_at desc) from (
    select id, title, body, translations, starts_at, ends_at, created_at from public.ops_banners
    where deleted_at is null order by starts_at desc limit 100) b), '[]'::jsonb);
end $fn$;

create or replace function public.admin_save_banner(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare bid uuid := nullif(p->>'id', '')::uuid; tr jsonb := coalesce(p->'translations', '{}'::jsonb); k text;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(tr) <> 'object' then raise exception 'invalid_translations'; end if;
  for k in select jsonb_object_keys(tr) loop
    if k not in ('en', 'ja') then raise exception 'invalid_translations'; end if;
  end loop;
  if bid is null then
    insert into public.ops_banners(title, body, translations, starts_at, ends_at, created_by)
    values (trim(p->>'title'), coalesce(p->>'body', ''), tr, coalesce((p->>'startsAt')::timestamptz, now()), (p->>'endsAt')::timestamptz, (select auth.uid()))
    returning id into bid;
  else
    update public.ops_banners set title = trim(p->>'title'), body = coalesce(p->>'body', ''), translations = tr,
      starts_at = coalesce((p->>'startsAt')::timestamptz, starts_at), ends_at = (p->>'endsAt')::timestamptz
    where id = bid and deleted_at is null;
    if not found then raise exception 'banner_not_found'; end if;
  end if;
  perform private.audit('banner_save', 'ops_banners:' || bid, jsonb_build_object('title', p->>'title', 'startsAt', p->>'startsAt', 'endsAt', p->>'endsAt'));
  return jsonb_build_object('ok', true, 'id', bid);
end $fn$;

create or replace function public.admin_delete_banner(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.ops_banners set deleted_at = now() where id = p_id and deleted_at is null;
  if not found then raise exception 'banner_not_found'; end if;
  perform private.audit('banner_delete', 'ops_banners:' || p_id, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $fn$;

revoke all on function public.admin_list_purchases(text, boolean, int), public.admin_purchase_summary(int), public.admin_refund_purchase(text, text, boolean),
  public.admin_list_banned_words(), public.admin_set_banned_word(text, boolean), public.admin_reset_profile(uuid, text, text), public.admin_profile_actions(uuid),
  public.admin_player_sanctions(uuid), public.admin_competitive_periods(text), public.admin_competitive_scores(text, date, int),
  public.admin_remove_competitive_score(text, date, uuid, text, boolean), public.admin_list_guilds(text), public.admin_guild_detail(uuid),
  public.admin_guild_action(uuid, text, uuid, text, text), public.admin_list_banners(), public.admin_save_banner(jsonb), public.admin_delete_banner(uuid)
  from public, anon;
grant execute on function public.admin_list_purchases(text, boolean, int), public.admin_purchase_summary(int), public.admin_refund_purchase(text, text, boolean),
  public.admin_list_banned_words(), public.admin_set_banned_word(text, boolean), public.admin_reset_profile(uuid, text, text), public.admin_profile_actions(uuid),
  public.admin_player_sanctions(uuid), public.admin_competitive_periods(text), public.admin_competitive_scores(text, date, int),
  public.admin_remove_competitive_score(text, date, uuid, text, boolean), public.admin_list_guilds(text), public.admin_guild_detail(uuid),
  public.admin_guild_action(uuid, text, uuid, text, text), public.admin_list_banners(), public.admin_save_banner(jsonb), public.admin_delete_banner(uuid)
  to authenticated;
