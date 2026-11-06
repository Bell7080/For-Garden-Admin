-- 운영 콘솔 2단계: 대시보드(일별 활성) · 운영진 권한 관리 · 제재 이력 · UID 묶음 우편 · 홈페이지 FAQ.
-- 운영 DB 적용은 사람이 확인한 뒤 한 번에 한다. 모든 쓰기는 보안 정의자 함수가 역할을 다시 확인한다.
-- 자세한 내용은 docs/ops-console-v2.md.

-- ───────── 일별 활성 기록 ─────────
-- players.last_seen_at 은 마지막 접속 하나뿐이라 지난날의 DAU·잔존을 셀 수 없다.
-- 접속 시각이 바뀔 때마다 (한국 날짜, 계정) 한 줄을 남긴다. 하루 한 줄이라 계정 수 × 일수만큼만 쌓인다.
create table if not exists public.player_daily_activity (
  day date not null,
  player_id uuid not null references public.players(id) on delete cascade,
  primary key (day, player_id)
);
create index if not exists player_daily_activity_player_idx on public.player_daily_activity(player_id, day desc);
alter table public.player_daily_activity enable row level security;
drop policy if exists daily_activity_no_client on public.player_daily_activity;
create policy daily_activity_no_client on public.player_daily_activity for all to anon, authenticated using (false) with check (false);

create or replace function private.record_daily_activity() returns trigger
language plpgsql security definer set search_path = '' as $fn$
begin
  if new.last_seen_at is not null and (tg_op = 'INSERT' or new.last_seen_at is distinct from old.last_seen_at) then
    insert into public.player_daily_activity(day, player_id)
    values ((new.last_seen_at at time zone 'Asia/Seoul')::date, new.id)
    on conflict do nothing;
  end if;
  return null;
end $fn$;
drop trigger if exists players_daily_activity on public.players;
create trigger players_daily_activity after insert or update of last_seen_at on public.players
  for each row execute function private.record_daily_activity();

-- 기존 계정의 마지막 접속일을 한 줄씩 채워 둔다(그 이전 날은 기록이 없다).
insert into public.player_daily_activity(day, player_id)
select (last_seen_at at time zone 'Asia/Seoul')::date, id from public.players where last_seen_at is not null
on conflict do nothing;

-- ───────── 대시보드 ─────────
-- 날짜는 한국 시간 기준. 14일 추이(DAU·신규)와 D1 잔존, 처리할 일(문의·오류·탈퇴 요청) 수를 한 번에 돌려준다.
create or replace function public.admin_dashboard()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  today date := (now() at time zone 'Asia/Seoul')::date;
  res jsonb;
  errs jsonb := 'null'::jsonb;
  dels int := null;
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if to_regclass('public.client_errors') is not null then
    execute 'select jsonb_build_object(''open'', count(*) filter (where status = ''open''), ''newToday'', count(*) filter (where status = ''open'' and (first_seen at time zone ''Asia/Seoul'')::date = $1), ''occurrences24h'', coalesce(sum(occurrences) filter (where last_seen > now() - interval ''24 hours''), 0)) from public.client_errors'
      into errs using today;
  end if;
  if to_regclass('public.account_deletion_requests') is not null then
    execute 'select count(*)::int from public.account_deletion_requests where cancelled_at is null' into dels;
  end if;
  select jsonb_build_object(
    'today', today,
    'players', jsonb_build_object(
      'total', (select count(*) from public.players where status <> 'deleted'),
      'newToday', (select count(*) from public.players where (created_at at time zone 'Asia/Seoul')::date = today),
      'dau', (select count(*) from public.player_daily_activity where day = today),
      'wau', (select count(distinct player_id) from public.player_daily_activity where day > today - 7),
      'mau', (select count(distinct player_id) from public.player_daily_activity where day > today - 30),
      'online15m', (select count(*) from public.players where last_seen_at > now() - interval '15 minutes'),
      'restricted', (select count(*) from public.players where status in ('suspended','banned'))
    ),
    'series', (
      select jsonb_agg(jsonb_build_object(
        'day', d,
        'dau', (select count(*) from public.player_daily_activity a where a.day = d),
        'new', (select count(*) from public.players p where (p.created_at at time zone 'Asia/Seoul')::date = d),
        -- D1 잔존: 그날 가입한 계정 중 다음 날 접속한 비율(다음 날이 아직 오지 않았으면 null)
        'd1', case when d >= today then null else (
          select case when count(*) = 0 then null else round(100.0 * count(*) filter (where exists (
            select 1 from public.player_daily_activity a where a.player_id = p.id and a.day = d + 1)) / count(*), 1) end
          from public.players p where (p.created_at at time zone 'Asia/Seoul')::date = d) end
      ) order by d)
      from generate_series(today - 13, today, interval '1 day') as g(t), lateral (select g.t::date as d) x
    ),
    'platforms', (
      select coalesce(jsonb_object_agg(coalesce(platform, 'unknown'), n), '{}'::jsonb)
      from (select platform, count(*) n from public.players where last_seen_at > now() - interval '7 days' group by platform) s
    ),
    'versions', (
      select coalesce(jsonb_agg(jsonb_build_object('version', app_version, 'players', n) order by n desc), '[]'::jsonb)
      from (select coalesce(app_version, '?') app_version, count(*) n from public.players where last_seen_at > now() - interval '7 days' group by 1 order by 2 desc limit 6) s
    ),
    'support', jsonb_build_object(
      'open', (select count(*) from public.support_tickets where deleted_at is null and status in ('open','in_progress')),
      'reports', (select count(*) from public.support_tickets where deleted_at is null and status in ('open','in_progress') and category = 'report'),
      'oldestOpen', (select min(created_at) from public.support_tickets where deleted_at is null and status = 'open')
    ),
    'errors', errs,
    'deletionRequests', dels,
    'live', jsonb_build_object(
      'maintenance', (select maintenance from public.app_config where id = 1),
      'mails', (select count(*) from public.mails where status = 'active' and deleted_at is null and starts_at <= now() and (expires_at is null or expires_at > now())),
      'coupons', (select count(*) from public.coupons where status = 'active' and deleted_at is null and (ends_at is null or ends_at > now()))
    )
  ) into res;
  return res;
end $fn$;

-- ───────── 운영진 권한 관리 ─────────
-- 소유자만 본다·바꾼다. 자기 권한은 바꾸지 못하고, 마지막 소유자는 내릴 수 없다.
create or replace function public.admin_list_staff()
returns table(user_id uuid, email text, role text, created_at timestamptz, last_sign_in_at timestamptz, uid bigint, nickname text)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner']) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    select r.user_id, u.email::text, r.role, r.created_at, u.last_sign_in_at, p.uid, p.nickname
      from public.admin_roles r
      join auth.users u on u.id = r.user_id
      left join public.players p on p.id = r.user_id
     order by array_position(array['owner','operator','cs','viewer'], r.role), r.created_at;
end $fn$;

create or replace function public.admin_set_staff_role(p_email text, p_role text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare target uuid; prev text;
begin
  if not private.admin_can(array['owner']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_role is not null and p_role not in ('owner','operator','cs','viewer') then raise exception 'invalid_status'; end if;
  select id into target from auth.users where lower(email) = lower(trim(p_email));
  if target is null then raise exception 'staff_user_not_found'; end if;
  if target = (select auth.uid()) then raise exception 'cannot_change_self'; end if;
  select role into prev from public.admin_roles where user_id = target;
  if prev = 'owner' and coalesce(p_role, '') <> 'owner'
     and (select count(*) from public.admin_roles where role = 'owner') <= 1 then raise exception 'last_owner'; end if;
  if p_role is null then
    delete from public.admin_roles where user_id = target;
  else
    insert into public.admin_roles(user_id, role) values (target, p_role)
    on conflict (user_id) do update set role = excluded.role;
  end if;
  perform private.audit('staff_role', 'admin_roles:' || target, jsonb_build_object('email', lower(trim(p_email)), 'from', prev, 'to', p_role));
  return jsonb_build_object('ok', true, 'from', prev, 'to', p_role);
end $fn$;

-- ───────── 제재 이력 ─────────
-- 상태 변경·삭제는 감사 로그에 남아 있다. 감사 로그 전체는 소유자만 읽으므로, 한 계정의 제재 기록만 CS까지 연다.
create or replace function public.admin_player_sanctions(p_player uuid)
returns table(action text, detail jsonb, at timestamptz, actor_email text)
language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator','cs']) then raise exception 'forbidden' using errcode = '42501'; end if;
  return query
    select l.action, l.detail, l.at, u.email::text
      from public.admin_audit_log l left join auth.users u on u.id = l.actor
     where l.target = 'players:' || p_player and l.action in ('player_status','player_delete','asset_adjust')
     order by l.id desc limit 50;
end $fn$;

-- ───────── UID 묶음 우편(보상·보상 지급) ─────────
-- 장애 보상·이벤트 당첨자처럼 여러 계정에 같은 우편을 보낸다. 계정마다 한 통씩 만들고 감사 기록은 한 줄로 남긴다.
create or replace function public.admin_send_mail_many(p_uids bigint[], p_title text, p_body text, p_rewards jsonb default '[]'::jsonb,
  p_starts timestamptz default null, p_expires timestamptz default null, p_unlimited boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare st timestamptz := coalesce(p_starts, now()); ex timestamptz; n int; missing bigint[]; batch uuid := gen_random_uuid();
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.valid_rewards(p_rewards) then raise exception 'invalid_rewards'; end if;
  if p_uids is null or cardinality(p_uids) = 0 or cardinality(p_uids) > 1000 then raise exception 'invalid_count'; end if;
  if char_length(trim(coalesce(p_title, ''))) not between 1 and 80 or char_length(coalesce(p_body, '')) > 2000 then raise exception 'invalid_text'; end if;
  ex := case when coalesce(p_unlimited, false) then null else coalesce(p_expires, st + interval '30 days') end;
  if ex is not null and ex <= st then raise exception 'invalid_period'; end if;
  select array_agg(u) into missing from (select distinct unnest(p_uids) u) x
   where not exists (select 1 from public.players p where p.uid = x.u and p.status <> 'deleted');
  insert into public.mails(title, body, rewards, target_player, starts_at, expires_at, created_by, include_new_accounts)
  select trim(p_title), trim(coalesce(p_body, '')), p_rewards, p.id, st, ex, (select auth.uid()), false
    from public.players p where p.uid = any(p_uids) and p.status <> 'deleted';
  get diagnostics n = row_count;
  perform private.audit('mail_send_many', 'mails:batch:' || batch, jsonb_build_object('title', p_title, 'sent', n, 'uids', cardinality(p_uids), 'missing', coalesce(missing, '{}'), 'rewards', p_rewards, 'unlimited', ex is null));
  return jsonb_build_object('ok', true, 'sent', n, 'missing', coalesce(to_jsonb(missing), '[]'::jsonb));
end $fn$;

-- ───────── 홈페이지 FAQ ─────────
-- 원문(question/answer)과 직접 작성한 언어별 원고(translations: {locale: {question, answer}})만 둔다. 자동 번역은 없다.
create table if not exists public.website_faqs (
  id uuid primary key default gen_random_uuid(),
  category text not null default 'game' check (category in ('account','game','payment','event','etc')),
  sort int not null default 100,
  published boolean not null default false,
  source_locale text not null default 'ko',
  question text not null check (char_length(question) between 1 and 200),
  answer text not null check (char_length(answer) between 1 and 5000),
  translations jsonb not null default '{}'::jsonb check (jsonb_typeof(translations) = 'object'),
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create index if not exists website_faqs_order_idx on public.website_faqs(category, sort, updated_at);
alter table public.website_faqs enable row level security;
drop policy if exists faqs_staff_read on public.website_faqs;
create policy faqs_staff_read on public.website_faqs for select to authenticated using (private.admin_can(array['owner','operator','cs','viewer']));
grant select on public.website_faqs to authenticated;

create or replace function public.admin_save_faq(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare fid uuid := nullif(p->>'id', '')::uuid; tr jsonb := coalesce(p->'translations', '{}'::jsonb); k text; v jsonb;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(tr) <> 'object' then raise exception 'invalid_text'; end if;
  for k, v in select * from jsonb_each(tr) loop
    if k !~ '^[a-z]{2}(-[A-Za-z]{2,4})?$' or jsonb_typeof(v) <> 'object'
       or char_length(coalesce(v->>'question', '')) not between 1 and 200
       or char_length(coalesce(v->>'answer', '')) not between 1 and 5000 then raise exception 'invalid_text'; end if;
  end loop;
  if char_length(trim(coalesce(p->>'question', ''))) not between 1 and 200 or char_length(trim(coalesce(p->>'answer', ''))) not between 1 and 5000 then
    raise exception 'invalid_text';
  end if;
  if fid is null then
    insert into public.website_faqs(category, sort, published, source_locale, question, answer, translations, updated_by)
    values (coalesce(p->>'category', 'game'), coalesce((p->>'sort')::int, 100), coalesce((p->>'published')::boolean, false),
            coalesce(p->>'source_locale', 'ko'), trim(p->>'question'), trim(p->>'answer'), tr, (select auth.uid()))
    returning id into fid;
  else
    update public.website_faqs set category = coalesce(p->>'category', category), sort = coalesce((p->>'sort')::int, sort),
      published = coalesce((p->>'published')::boolean, published), source_locale = coalesce(p->>'source_locale', source_locale),
      question = trim(p->>'question'), answer = trim(p->>'answer'), translations = tr, updated_at = now(), updated_by = (select auth.uid())
     where id = fid;
    if not found then raise exception 'not_found'; end if;
  end if;
  perform private.audit('faq_save', 'website_faqs:' || fid, jsonb_build_object('question', p->>'question', 'published', p->>'published'));
  return jsonb_build_object('ok', true, 'id', fid);
end $fn$;

create or replace function public.admin_delete_faq(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.website_faqs where id = p_id;
  if not found then raise exception 'not_found'; end if;
  perform private.audit('faq_delete', 'website_faqs:' || p_id, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $fn$;

-- ───────── 권한 ─────────
revoke all on function private.record_daily_activity() from public, anon, authenticated;
revoke all on function public.admin_dashboard(), public.admin_list_staff(), public.admin_set_staff_role(text, text),
  public.admin_player_sanctions(uuid), public.admin_send_mail_many(bigint[], text, text, jsonb, timestamptz, timestamptz, boolean),
  public.admin_save_faq(jsonb), public.admin_delete_faq(uuid) from public, anon;
grant execute on function public.admin_dashboard(), public.admin_list_staff(), public.admin_set_staff_role(text, text),
  public.admin_player_sanctions(uuid), public.admin_send_mail_many(bigint[], text, text, jsonb, timestamptz, timestamptz, boolean),
  public.admin_save_faq(jsonb), public.admin_delete_faq(uuid) to authenticated;
