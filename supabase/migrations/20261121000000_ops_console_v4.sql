-- 운영 콘솔 v4: 조건별 대상 우편, 이상 징후 알림.
-- 게임 저장소 변경은 필요 없다(우편은 대상 지정 우편 표를 그대로 쓰고, 이상 징후는 이미 쌓이는 기록을 읽기만 한다).
-- v3(20261120100000_ops_console_v3.sql) 다음에 적용한다 — 환불 급증 규칙이 purchase_records 를 읽는다(없으면 건너뛴다).

-- ───────── 조건별 대상 우편 ─────────
-- 조건(jsonb): levelMin·levelMax(1~999) · activeWithinDays(최근 N일 안에 접속) · inactiveDays(N일 넘게 미접속)
--   · createdFrom·createdTo(가입 시각) · includeSuspended(정지 계정 포함). 조건이 하나도 없으면 거절한다(전체 발송은 기존 우편을 쓴다).
-- 영구 제한·삭제 계정은 늘 뺀다.
create or replace function private.mail_segment_valid(p jsonb) returns boolean language plpgsql immutable set search_path = '' as $fn$
declare k text; n int := 0;
begin
  if p is null or jsonb_typeof(p) <> 'object' then return false; end if;
  for k in select jsonb_object_keys(p) loop
    if k not in ('levelMin','levelMax','activeWithinDays','inactiveDays','createdFrom','createdTo','includeSuspended') then return false; end if;
  end loop;
  if p ? 'levelMin' then if jsonb_typeof(p->'levelMin') <> 'number' or (p->>'levelMin')::numeric not between 1 and 999 then return false; end if; n := n + 1; end if;
  if p ? 'levelMax' then if jsonb_typeof(p->'levelMax') <> 'number' or (p->>'levelMax')::numeric not between 1 and 999 then return false; end if; n := n + 1; end if;
  if p ? 'activeWithinDays' then if jsonb_typeof(p->'activeWithinDays') <> 'number' or (p->>'activeWithinDays')::numeric not between 1 and 365 then return false; end if; n := n + 1; end if;
  if p ? 'inactiveDays' then if jsonb_typeof(p->'inactiveDays') <> 'number' or (p->>'inactiveDays')::numeric not between 1 and 3650 then return false; end if; n := n + 1; end if;
  if p ? 'createdFrom' then perform (p->>'createdFrom')::timestamptz; n := n + 1; end if;
  if p ? 'createdTo' then perform (p->>'createdTo')::timestamptz; n := n + 1; end if;
  if p ? 'includeSuspended' and jsonb_typeof(p->'includeSuspended') <> 'boolean' then return false; end if;
  if p ? 'levelMin' and p ? 'levelMax' and (p->>'levelMin')::numeric > (p->>'levelMax')::numeric then return false; end if;
  if p ? 'activeWithinDays' and p ? 'inactiveDays' then return false; end if;
  return n > 0;
exception when others then
  return false;
end $fn$;

create or replace function private.mail_segment_players(p jsonb) returns setof public.players language sql stable set search_path = '' as $fn$
  select pl.* from public.players pl
  where (pl.status = 'active' or (pl.status = 'suspended' and coalesce((p->>'includeSuspended')::boolean, false)))
    and (not (p ? 'levelMin') or coalesce(pl.level, 1) >= (p->>'levelMin')::int)
    and (not (p ? 'levelMax') or coalesce(pl.level, 1) <= (p->>'levelMax')::int)
    and (not (p ? 'activeWithinDays') or pl.last_seen_at >= now() - make_interval(days => (p->>'activeWithinDays')::int))
    and (not (p ? 'inactiveDays') or coalesce(pl.last_seen_at, pl.created_at) < now() - make_interval(days => (p->>'inactiveDays')::int))
    and (not (p ? 'createdFrom') or pl.created_at >= (p->>'createdFrom')::timestamptz)
    and (not (p ? 'createdTo') or pl.created_at < (p->>'createdTo')::timestamptz)
$fn$;

create or replace function public.admin_mail_segment_preview(p_segment jsonb)
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.mail_segment_valid(p_segment) then raise exception 'invalid_segment'; end if;
  return jsonb_build_object(
    'count', (select count(*) from private.mail_segment_players(p_segment)),
    'sample', coalesce((select jsonb_agg(jsonb_build_object('uid', s.uid, 'nickname', s.nickname, 'level', s.level, 'lastSeen', s.last_seen_at) order by s.last_seen_at desc nulls last)
      from (select * from private.mail_segment_players(p_segment) order by last_seen_at desc nulls last limit 8) s), '[]'::jsonb));
end $fn$;

-- 한 번에 5만 명까지. 받는 계정마다 대상 지정 우편 한 통이 생긴다(전체 우편처럼 이후 가입자에게 퍼지지 않는다).
create or replace function public.admin_send_mail_segment(p_segment jsonb, p_title text, p_body text, p_rewards jsonb default '[]'::jsonb,
  p_starts timestamptz default null, p_expires timestamptz default null, p_unlimited boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare st timestamptz := coalesce(p_starts, now()); ex timestamptz; n int; total int; batch uuid := gen_random_uuid();
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.mail_segment_valid(p_segment) then raise exception 'invalid_segment'; end if;
  if not private.valid_rewards(p_rewards) then raise exception 'invalid_rewards'; end if;
  if char_length(trim(coalesce(p_title, ''))) not between 1 and 80 or char_length(coalesce(p_body, '')) > 2000 then raise exception 'invalid_text'; end if;
  ex := case when coalesce(p_unlimited, false) then null else coalesce(p_expires, st + interval '30 days') end;
  if ex is not null and ex <= st then raise exception 'invalid_period'; end if;
  select count(*) into total from private.mail_segment_players(p_segment);
  if total = 0 then raise exception 'segment_empty'; end if;
  if total > 50000 then raise exception 'segment_too_large'; end if;
  insert into public.mails(title, body, rewards, target_player, starts_at, expires_at, created_by, include_new_accounts)
  select trim(p_title), trim(coalesce(p_body, '')), p_rewards, s.id, st, ex, (select auth.uid()), false
    from private.mail_segment_players(p_segment) s;
  get diagnostics n = row_count;
  perform private.audit('mail_send_segment', 'mails:batch:' || batch, jsonb_build_object('title', p_title, 'sent', n, 'segment', p_segment, 'rewards', p_rewards, 'unlimited', ex is null));
  return jsonb_build_object('ok', true, 'sent', n);
end $fn$;

-- ───────── 이상 징후 ─────────
-- 규칙 키: gain:<재화>(한국 날짜 하루에 한 계정이 얻은 양) · error:new_players(24시간 안에 새로 잡힌 오류의 영향 계정 수)
--   · error:hot_occurrences(최근 1시간 안에 발생한 열린 오류의 누적 횟수) · refund:day(24시간 안 환불 표시 건수).
-- 운영자가 연 수동 조정은 같은 재화의 gain 문턱을 넘으면 한 건으로 잡는다(내부 오남용 감시).
-- 기본 문턱은 2026-11-06 운영 DB의 하루 최대 획득량의 대략 3~5배다. 운영 데이터가 쌓이면 소유자가 고친다.
create table if not exists public.ops_anomaly_rules (
  key text primary key check (key ~ '^(gain:[A-Za-z:_-]{1,40}|error:new_players|error:hot_occurrences|refund:day)$'),
  threshold bigint not null check (threshold > 0),
  updated_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.ops_anomaly_rules enable row level security;
revoke all on public.ops_anomaly_rules from public, anon, authenticated;
insert into public.ops_anomaly_rules(key, threshold) values
  ('gain:gems', 50000), ('gain:gold', 3000000), ('gain:cheesecake', 200000), ('gain:amber', 100), ('gain:fossil', 100),
  ('gain:rawStone', 30000), ('gain:dnaFragments', 500), ('gain:duelEmblem', 2000), ('gain:raidSigil', 1000),
  ('gain:salvageRecord', 5000), ('gain:stamina', 10000),
  ('error:new_players', 3), ('error:hot_occurrences', 500), ('refund:day', 5)
on conflict (key) do nothing;

-- 확인 표시. 같은 키는 다시 뜨지 않는다(키에 날짜·대상이 들어 있어 다음 날의 새 징후는 따로 뜬다).
create table if not exists public.ops_anomaly_acks (
  key text primary key check (length(key) <= 200),
  note text not null default '' check (length(note) <= 200),
  acked_by uuid,
  acked_at timestamptz not null default now()
);
alter table public.ops_anomaly_acks enable row level security;
revoke all on public.ops_anomaly_acks from public, anon, authenticated;

-- 오류·환불 규칙은 표가 없을 수도 있어 동적 SQL 로 따로 모은다.
create or replace function private.anomaly_error_items() returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare out jsonb := '[]'::jsonb; th_new bigint; th_hot bigint; part jsonb;
begin
  if to_regclass('public.client_errors') is null then return out; end if;
  select threshold into th_new from public.ops_anomaly_rules where key = 'error:new_players';
  select threshold into th_hot from public.ops_anomaly_rules where key = 'error:hot_occurrences';
  execute $q$select coalesce(jsonb_agg(jsonb_build_object('key', 'error_new:' || e.id, 'kind', 'error_new', 'errorId', e.id, 'code', e.code,
      'message', left(e.message, 160), 'amount', e.affected_players, 'threshold', $1::bigint, 'occurrences', e.occurrences, 'at', e.first_seen)
      order by e.affected_players desc), '[]'::jsonb)
    from public.client_errors e where e.status = 'open' and e.first_seen >= now() - interval '24 hours' and e.affected_players >= $1::bigint$q$
    into part using coalesce(th_new, 3);
  out := out || part;
  execute $q$select coalesce(jsonb_agg(jsonb_build_object('key', 'error_hot:' || e.id || ':' || to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD'), 'kind', 'error_hot',
      'errorId', e.id, 'code', e.code, 'message', left(e.message, 160), 'amount', e.occurrences, 'threshold', $1::bigint, 'players', e.affected_players, 'at', e.last_seen)
      order by e.occurrences desc), '[]'::jsonb)
    from public.client_errors e where e.status = 'open' and e.last_seen >= now() - interval '1 hour' and e.occurrences >= $1::bigint$q$
    into part using coalesce(th_hot, 500);
  return out || part;
end $fn$;
revoke all on function private.anomaly_error_items() from public, anon, authenticated;

create or replace function private.anomaly_refund_items() returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare n bigint; th bigint;
begin
  if to_regclass('public.purchase_records') is null then return '[]'::jsonb; end if;
  select threshold into th from public.ops_anomaly_rules where key = 'refund:day';
  execute 'select count(*) from public.purchase_records where refunded_at >= now() - interval ''24 hours''' into n;
  if n < coalesce(th, 5) then return '[]'::jsonb; end if;
  return jsonb_build_array(jsonb_build_object('key', 'refund:' || to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM-DD'), 'kind', 'refund',
    'amount', n, 'threshold', th, 'at', now()));
end $fn$;
revoke all on function private.anomaly_refund_items() from public, anon, authenticated;

-- 확인한 징후는 기본으로 뺀다.
create or replace function public.admin_anomalies(p_include_acked boolean default false)
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
declare items jsonb := '[]'::jsonb; today date := (now() at time zone 'Asia/Seoul')::date;
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;

  if to_regclass('public.currency_log') is not null then
    items := items || coalesce((select jsonb_agg(jsonb_build_object('key', 'gain:' || g.asset || ':' || g.player_id || ':' || g.day, 'kind', 'gain',
        'asset', g.asset, 'amount', g.total, 'threshold', r.threshold, 'day', g.day, 'playerId', g.player_id, 'uid', p.uid, 'nickname', p.nickname,
        'sources', (select jsonb_agg(jsonb_build_object('source', x.source, 'amount', x.amount) order by x.amount desc) from (
           select l2.source, sum(l2.delta) as amount from public.currency_log l2
           where l2.player_id = g.player_id and l2.asset = g.asset and l2.delta > 0 and (l2.created_at at time zone 'Asia/Seoul')::date = g.day
           group by l2.source order by amount desc limit 5) x),
        'at', g.last_at) order by g.total::numeric / r.threshold desc)
      from (select l.player_id, l.asset, (l.created_at at time zone 'Asia/Seoul')::date as day, sum(l.delta) as total, max(l.created_at) as last_at
            from public.currency_log l
            where l.delta > 0 and l.created_at >= ((today - 1)::timestamp at time zone 'Asia/Seoul')
            group by l.player_id, l.asset, (l.created_at at time zone 'Asia/Seoul')::date) g
      join public.ops_anomaly_rules r on r.key = 'gain:' || g.asset
      join public.players p on p.id = g.player_id
      where g.total >= r.threshold), '[]'::jsonb);
  end if;

  items := items || coalesce((select jsonb_agg(jsonb_build_object('key', 'adjust:' || a.id, 'kind', 'adjust', 'asset', a.asset, 'amount', a.delta,
      'threshold', r.threshold, 'playerId', a.player_id, 'uid', p.uid, 'nickname', p.nickname, 'note', a.note,
      'actor', (select u.email from auth.users u where u.id = a.created_by), 'at', a.created_at) order by a.created_at desc)
    from public.player_adjustments a
    join public.ops_anomaly_rules r on r.key = 'gain:' || a.asset
    join public.players p on p.id = a.player_id
    where a.created_at >= now() - interval '48 hours' and abs(a.delta) >= r.threshold), '[]'::jsonb);

  items := items || private.anomaly_error_items() || private.anomaly_refund_items();

  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(i || jsonb_build_object('acked', k.key is not null, 'ackNote', k.note, 'ackedAt', k.acked_at))
      from jsonb_array_elements(items) i left join public.ops_anomaly_acks k on k.key = i->>'key'
      where coalesce(p_include_acked, false) or k.key is null), '[]'::jsonb),
    'rules', coalesce((select jsonb_object_agg(key, threshold) from public.ops_anomaly_rules), '{}'::jsonb));
end $fn$;

create or replace function public.admin_ack_anomaly(p_key text, p_note text default '')
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator','cs']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_key is null or length(p_key) not between 1 and 200 or char_length(coalesce(p_note, '')) > 200 then raise exception 'invalid_text'; end if;
  insert into public.ops_anomaly_acks(key, note, acked_by) values (p_key, trim(coalesce(p_note, '')), (select auth.uid()))
  on conflict (key) do nothing;
  perform private.audit('anomaly_ack', 'anomaly:' || p_key, jsonb_build_object('note', p_note));
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.admin_set_anomaly_rule(p_key text, p_threshold bigint)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare prev bigint;
begin
  if not private.admin_can(array['owner']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_threshold is null or p_threshold <= 0 or p_threshold > 1000000000000 then raise exception 'invalid_amount'; end if;
  if p_key !~ '^(gain:[A-Za-z:_-]{1,40}|error:new_players|error:hot_occurrences|refund:day)$' then raise exception 'invalid_rule'; end if;
  select threshold into prev from public.ops_anomaly_rules where key = p_key;
  insert into public.ops_anomaly_rules(key, threshold, updated_by, updated_at) values (p_key, p_threshold, (select auth.uid()), now())
  on conflict (key) do update set threshold = excluded.threshold, updated_by = excluded.updated_by, updated_at = now();
  perform private.audit('anomaly_rule', 'anomaly_rule:' || p_key, jsonb_build_object('from', prev, 'to', p_threshold));
  return jsonb_build_object('ok', true);
end $fn$;

-- ───────── 계정 화면: 받은 신고 수 ─────────
create or replace function public.admin_player_reports(p_uid bigint)
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  return jsonb_build_object(
    'total', (select count(*) from public.support_tickets t where t.reported_uid = p_uid and t.deleted_at is null),
    'open', (select count(*) from public.support_tickets t where t.reported_uid = p_uid and t.deleted_at is null and t.status in ('open','in_progress')),
    'reporters', (select count(distinct t.player_id) from public.support_tickets t where t.reported_uid = p_uid and t.deleted_at is null),
    'recent', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'ticketNo', r.ticket_no, 'subject', r.subject, 'status', r.status, 'createdAt', r.created_at) order by r.created_at desc)
      from (select * from public.support_tickets t where t.reported_uid = p_uid and t.deleted_at is null order by t.created_at desc limit 5) r), '[]'::jsonb));
end $fn$;

revoke all on function public.admin_mail_segment_preview(jsonb),
  public.admin_send_mail_segment(jsonb, text, text, jsonb, timestamptz, timestamptz, boolean),
  public.admin_anomalies(boolean), public.admin_ack_anomaly(text, text), public.admin_set_anomaly_rule(text, bigint),
  public.admin_player_reports(bigint) from public, anon;
grant execute on function public.admin_mail_segment_preview(jsonb),
  public.admin_send_mail_segment(jsonb, text, text, jsonb, timestamptz, timestamptz, boolean),
  public.admin_anomalies(boolean), public.admin_ack_anomaly(text, text), public.admin_set_anomaly_rule(text, bigint),
  public.admin_player_reports(bigint) to authenticated;
revoke all on function private.mail_segment_valid(jsonb), private.mail_segment_players(jsonb) from public, anon, authenticated;
