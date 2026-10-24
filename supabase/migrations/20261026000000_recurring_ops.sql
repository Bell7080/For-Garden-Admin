-- 정기 운영: 무제한 우편 · 정기 우편(자동 발송) · 패치노트 · 정기 이벤트(주단위 순환 미니컨텐츠).
-- 운영 DB 적용은 사람이 확인한 뒤 한 번에 한다. 모든 쓰기는 보안 정의자 함수가 역할을 다시 확인한다.

-- ───────── 우편 보관기간 무제한 ─────────
-- expires_at 이 null 이면 만료되지 않는 우편이다. 게임(MailDto.expiresAt: string | null)은 이미 null 을 무제한으로 읽는다.
alter table public.mails alter column expires_at drop not null;
alter table public.mails drop constraint if exists mails_check;
alter table public.mails add constraint mails_expiry_after_start check (expires_at is null or expires_at > starts_at);

create or replace function private.mail_visible_to(m public.mails, p_player uuid, p_created timestamptz)
returns boolean language sql immutable set search_path = '' as $$
  select m.status = 'active' and m.deleted_at is null and m.starts_at <= now() and (m.expires_at is null or m.expires_at > now())
    and (m.target_player = p_player
         or (m.target_player is null and (m.include_new_accounts or m.starts_at >= p_created)));
$$;
revoke all on function private.mail_visible_to(public.mails, uuid, timestamptz) from public, anon, authenticated;
grant execute on function private.mail_visible_to(public.mails, uuid, timestamptz) to service_role;

drop function if exists public.admin_send_mail(text, text, jsonb, uuid, timestamptz, timestamptz, boolean);
create or replace function public.admin_send_mail(p_title text, p_body text, p_rewards jsonb default '[]'::jsonb,
  p_target uuid default null, p_starts timestamptz default null, p_expires timestamptz default null,
  p_include_new boolean default false, p_unlimited boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare mid uuid; inc boolean := coalesce(p_include_new, false) and p_target is null; st timestamptz := coalesce(p_starts, now()); ex timestamptz;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.valid_rewards(p_rewards) then raise exception 'invalid_rewards'; end if;
  if p_target is not null and not exists (select 1 from public.players where id = p_target) then raise exception 'player_not_found'; end if;
  ex := case when coalesce(p_unlimited, false) then null else coalesce(p_expires, st + interval '30 days') end;
  if ex is not null and ex <= st then raise exception 'invalid_period'; end if;
  insert into public.mails(title, body, rewards, target_player, starts_at, expires_at, created_by, include_new_accounts)
  values (trim(p_title), trim(p_body), p_rewards, p_target, st, ex, (select auth.uid()), inc)
  returning id into mid;
  perform private.audit('mail_send', 'mails:' || mid, jsonb_build_object('title', p_title, 'target', p_target, 'rewards', p_rewards, 'includeNewAccounts', inc, 'unlimited', ex is null));
  return jsonb_build_object('ok', true, 'id', mid);
end $fn$;
revoke all on function public.admin_send_mail(text, text, jsonb, uuid, timestamptz, timestamptz, boolean, boolean) from public, anon, authenticated;
grant execute on function public.admin_send_mail(text, text, jsonb, uuid, timestamptz, timestamptz, boolean, boolean) to authenticated;

-- ───────── 정기 우편 ─────────
-- 정해진 요일·시각마다 우편 한 통을 자동으로 만든다(아침·점심·저녁 식사, 핫타임 등).
-- slot 은 화면 분류일 뿐 동작은 같다. valid_hours 가 null 이면 무제한, 핫타임은 짧게 둔다.
create table if not exists public.recurring_mails (
  id uuid primary key default gen_random_uuid(),
  slot text not null default 'custom' check (slot in ('morning','lunch','evening','hottime','custom')),
  name text not null check (char_length(name) between 1 and 40),
  title text not null check (char_length(title) between 1 and 80),
  body text not null check (char_length(body) between 1 and 2000),
  rewards jsonb not null default '[]'::jsonb,
  send_time time not null,
  timezone text not null default 'Asia/Seoul',
  days int[] not null default '{1,2,3,4,5,6,7}' check (days <@ array[1,2,3,4,5,6,7] and cardinality(days) >= 1),
  valid_hours int check (valid_hours is null or valid_hours between 1 and 8760),
  include_new_accounts boolean not null default false,
  active_from date,
  active_until date,
  enabled boolean not null default true,
  last_fired_on date,
  deleted_at timestamptz,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (active_until is null or active_from is null or active_until >= active_from)
);
alter table public.mails add column if not exists recurring_id uuid references public.recurring_mails(id);
alter table public.mails add column if not exists fire_date date;
create unique index if not exists mails_recurring_once on public.mails(recurring_id, fire_date) where recurring_id is not null;

alter table public.recurring_mails enable row level security;
drop policy if exists recurring_mails_admin_read on public.recurring_mails;
create policy recurring_mails_admin_read on public.recurring_mails for select to authenticated
  using (private.admin_can(array['owner','operator','cs','viewer']));
grant select on public.recurring_mails to authenticated;

create or replace function public.admin_save_recurring_mail(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare rid uuid := nullif(p->>'id', '')::uuid; rw jsonb := coalesce(p->'rewards', '[]'::jsonb);
  d int[]; tz text := coalesce(nullif(p->>'timezone', ''), 'Asia/Seoul');
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.valid_rewards(rw) then raise exception 'invalid_rewards'; end if;
  if not exists (select 1 from pg_catalog.pg_timezone_names where name = tz) then raise exception 'invalid_text'; end if;
  select coalesce(array_agg(x::int order by x::int), '{}') into d from jsonb_array_elements_text(coalesce(p->'days', '[1,2,3,4,5,6,7]'::jsonb)) x;
  if rid is null then
    insert into public.recurring_mails(slot, name, title, body, rewards, send_time, timezone, days, valid_hours, include_new_accounts, active_from, active_until, enabled, created_by)
    values (coalesce(p->>'slot', 'custom'), trim(p->>'name'), trim(p->>'title'), trim(p->>'body'), rw, (p->>'send_time')::time, tz, d,
      nullif(p->>'valid_hours', '')::int, coalesce((p->>'include_new_accounts')::boolean, false),
      nullif(p->>'active_from', '')::date, nullif(p->>'active_until', '')::date, coalesce((p->>'enabled')::boolean, true), (select auth.uid()))
    returning id into rid;
  else
    update public.recurring_mails set slot = coalesce(p->>'slot', slot), name = trim(p->>'name'), title = trim(p->>'title'), body = trim(p->>'body'),
      rewards = rw, send_time = (p->>'send_time')::time, timezone = tz, days = d, valid_hours = nullif(p->>'valid_hours', '')::int,
      include_new_accounts = coalesce((p->>'include_new_accounts')::boolean, false),
      active_from = nullif(p->>'active_from', '')::date, active_until = nullif(p->>'active_until', '')::date,
      enabled = coalesce((p->>'enabled')::boolean, enabled), updated_at = now()
    where id = rid and deleted_at is null;
    if not found then raise exception 'not_found'; end if;
  end if;
  perform private.audit('recurring_mail_save', 'recurring_mails:' || rid, jsonb_build_object('name', p->>'name', 'send_time', p->>'send_time', 'days', d, 'rewards', rw));
  return jsonb_build_object('ok', true, 'id', rid);
end $fn$;

create or replace function public.admin_set_recurring_mail(p_id uuid, p_enabled boolean default null, p_delete boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_delete, false) then
    update public.recurring_mails set deleted_at = now(), enabled = false, updated_at = now() where id = p_id and deleted_at is null;
  else
    update public.recurring_mails set enabled = coalesce(p_enabled, enabled), updated_at = now() where id = p_id and deleted_at is null;
  end if;
  if not found then raise exception 'not_found'; end if;
  perform private.audit('recurring_mail_set', 'recurring_mails:' || p_id, jsonb_build_object('enabled', p_enabled, 'delete', coalesce(p_delete, false)));
  return jsonb_build_object('ok', true);
end $fn$;

-- 발송기: 매 분 돈다. 오늘 보낼 시각이 지났고 아직 안 보냈으며 3시간(유예) 안이면 우편을 만든다.
-- (recurring_id, fire_date) 유일 색인이 중복 발송을 막으므로 여러 번 불려도 하루에 한 통이다.
-- 유예를 넘긴 회차(점검·장애로 놓친 것)는 보내지 않고 건너뛴다 — 핫타임이 뒤늦게 나가면 뜻이 없다.
create or replace function private.run_recurring_mails(p_now timestamptz default now())
returns int language plpgsql security definer set search_path = '' as $fn$
declare r public.recurring_mails; local_now timestamp; today date; fire_at timestamptz; made int := 0; n int;
begin
  for r in select * from public.recurring_mails where enabled and deleted_at is null loop
    local_now := p_now at time zone r.timezone;
    today := local_now::date;
    if not (extract(isodow from today)::int = any(r.days)) then continue; end if;
    if r.active_from is not null and today < r.active_from then continue; end if;
    if r.active_until is not null and today > r.active_until then continue; end if;
    fire_at := (today + r.send_time) at time zone r.timezone;
    if p_now < fire_at or p_now > fire_at + interval '3 hours' then continue; end if;
    insert into public.mails(title, body, rewards, starts_at, expires_at, include_new_accounts, recurring_id, fire_date, created_by)
    values (r.title, r.body, r.rewards, fire_at, case when r.valid_hours is null then null else fire_at + make_interval(hours => r.valid_hours) end,
      r.include_new_accounts, r.id, today, r.created_by)
    on conflict (recurring_id, fire_date) where recurring_id is not null do nothing;
    get diagnostics n = row_count;
    if n > 0 then
      made := made + 1;
      update public.recurring_mails set last_fired_on = today where id = r.id;
    end if;
  end loop;
  return made;
end $fn$;
revoke all on function private.run_recurring_mails(timestamptz) from public, anon, authenticated;

-- pg_cron 이 켜져 있으면 매 분 발송기를 건다. 켜져 있지 않으면 건너뛰고(마이그레이션은 성공),
-- 어드민 화면이 「자동 발송기 꺼짐」으로 알린다. Supabase 대시보드 > Database > Extensions 에서 pg_cron 을 켠 뒤 이 블록만 다시 실행한다.
do $cron$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then
    raise notice 'pg_cron 을 켤 수 없어 정기 우편 발송기를 걸지 않았습니다: %', sqlerrm;
  end;
  if to_regclass('cron.job') is not null then
    execute $q$select cron.unschedule(jobid) from cron.job where jobname = 'recurring-mails'$q$;
    execute $q$select cron.schedule('recurring-mails', '* * * * *', 'select private.run_recurring_mails()')$q$;
  end if;
exception when others then
  raise notice '정기 우편 발송기 예약 실패: %', sqlerrm;
end $cron$;

-- 발송기가 걸려 있는지: 어드민 화면의 경고용.
create or replace function public.admin_recurring_mail_status()
returns jsonb language plpgsql security definer set search_path = '' stable as $fn$
declare scheduled boolean := false;
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if to_regclass('cron.job') is not null then
    execute $q$select exists (select 1 from cron.job where jobname = 'recurring-mails' and active)$q$ into scheduled;
  end if;
  return jsonb_build_object('scheduled', scheduled);
end $fn$;

-- ───────── 패치노트 ─────────
-- 1.0.0 정식 출시 이후의 패치부터 기록한다. items 는 [{kind, text}] (new·improve·fix·balance·etc).
create table if not exists public.patch_notes (
  id uuid primary key default gen_random_uuid(),
  version text not null check (version ~ '^[0-9]+\.[0-9]+\.[0-9]+$'),
  title text not null default '' check (char_length(title) <= 120),
  released_at timestamptz not null default now(),
  items jsonb not null default '[]'::jsonb,
  note text not null default '' check (char_length(note) <= 4000),
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (jsonb_typeof(items) = 'array' and jsonb_array_length(items) <= 100)
);
create unique index if not exists patch_notes_version_live on public.patch_notes(version) where deleted_at is null;
alter table public.patch_notes enable row level security;
drop policy if exists patch_notes_admin_read on public.patch_notes;
create policy patch_notes_admin_read on public.patch_notes for select to authenticated
  using (private.admin_can(array['owner','operator','cs','viewer']));
grant select on public.patch_notes to authenticated;

create or replace function public.admin_save_patch_note(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare pid uuid := nullif(p->>'id', '')::uuid; it jsonb := coalesce(p->'items', '[]'::jsonb); e jsonb;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(it) <> 'array' or jsonb_array_length(it) > 100 then raise exception 'invalid_text'; end if;
  for e in select * from jsonb_array_elements(it) loop
    if (e->>'kind') not in ('new','improve','fix','balance','etc') or char_length(coalesce(e->>'text', '')) not between 1 and 500 then
      raise exception 'invalid_text';
    end if;
  end loop;
  if (p->>'version') !~ '^[0-9]+\.[0-9]+\.[0-9]+$' then raise exception 'invalid_text'; end if;
  if string_to_array(p->>'version', '.')::int[] < array[1,0,0] then raise exception 'before_launch'; end if;
  if pid is null then
    insert into public.patch_notes(version, title, released_at, items, note, created_by)
    values (p->>'version', coalesce(trim(p->>'title'), ''), coalesce(nullif(p->>'released_at', '')::timestamptz, now()), it, coalesce(trim(p->>'note'), ''), (select auth.uid()))
    returning id into pid;
  else
    update public.patch_notes set version = p->>'version', title = coalesce(trim(p->>'title'), ''),
      released_at = coalesce(nullif(p->>'released_at', '')::timestamptz, released_at), items = it, note = coalesce(trim(p->>'note'), ''), updated_at = now()
    where id = pid and deleted_at is null;
    if not found then raise exception 'not_found'; end if;
  end if;
  perform private.audit('patch_note_save', 'patch_notes:' || pid, jsonb_build_object('version', p->>'version'));
  return jsonb_build_object('ok', true, 'id', pid);
end $fn$;

create or replace function public.admin_delete_patch_note(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  update public.patch_notes set deleted_at = now(), updated_at = now() where id = p_id and deleted_at is null;
  if not found then raise exception 'not_found'; end if;
  perform private.audit('patch_note_delete', 'patch_notes:' || p_id, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $fn$;

-- ───────── 정기 이벤트(주단위 순환 미니컨텐츠) ─────────
-- 돌림판(변형 1~3)·모래캐기·타로집·대장장이(블랙잭) 같은 이벤트 재화 소모처를 주마다 하나씩 돌린다.
-- event_contents 는 컨텐츠 정의(비용·보상표), event_rotation 은 어느 주에 무엇이 열리는지다.
-- reward_table: [{ "weight": 정수, "rewards": [{asset, amount}], "label": 선택 }]
create table if not exists public.event_contents (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('wheel','sand_dig','tarot','blacksmith','custom')),
  variant int not null default 1 check (variant between 1 and 9),
  name text not null check (char_length(name) between 1 and 40),
  description text not null default '' check (char_length(description) <= 500),
  currency text not null check (currency ~ '^[a-zA-Z][a-zA-Z0-9]{1,31}$'),
  cost_per_play bigint not null default 1 check (cost_per_play between 0 and 1000000),
  daily_free_plays int not null default 0 check (daily_free_plays between 0 and 100),
  reward_table jsonb not null default '[]'::jsonb,
  enabled boolean not null default true,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create table if not exists public.event_rotation (
  week_start date primary key check (extract(isodow from week_start) = 1),
  content_id uuid not null references public.event_contents(id),
  set_by uuid,
  updated_at timestamptz not null default now()
);
alter table public.event_contents enable row level security;
alter table public.event_rotation enable row level security;
drop policy if exists event_contents_admin_read on public.event_contents;
drop policy if exists event_rotation_admin_read on public.event_rotation;
create policy event_contents_admin_read on public.event_contents for select to authenticated
  using (private.admin_can(array['owner','operator','cs','viewer']));
create policy event_rotation_admin_read on public.event_rotation for select to authenticated
  using (private.admin_can(array['owner','operator','cs','viewer']));
grant select on public.event_contents, public.event_rotation to authenticated;

create or replace function private.valid_reward_table(p jsonb)
returns boolean language plpgsql immutable set search_path = '' as $fn$
declare e jsonb;
begin
  if jsonb_typeof(p) <> 'array' or jsonb_array_length(p) > 60 then return false; end if;
  for e in select * from jsonb_array_elements(p) loop
    if jsonb_typeof(e) <> 'object' or jsonb_typeof(e->'weight') <> 'number' or (e->>'weight')::numeric <> trunc((e->>'weight')::numeric)
       or (e->>'weight')::numeric not between 1 and 1000000 or not private.valid_rewards(coalesce(e->'rewards', '[]'::jsonb)) then
      return false;
    end if;
  end loop;
  return true;
end $fn$;
revoke all on function private.valid_reward_table(jsonb) from public, anon, authenticated;

create or replace function public.admin_save_event_content(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare cid uuid := nullif(p->>'id', '')::uuid; tbl jsonb := coalesce(p->'reward_table', '[]'::jsonb);
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.valid_reward_table(tbl) then raise exception 'invalid_rewards'; end if;
  if cid is null then
    insert into public.event_contents(kind, variant, name, description, currency, cost_per_play, daily_free_plays, reward_table, enabled, created_by)
    values (p->>'kind', coalesce((p->>'variant')::int, 1), trim(p->>'name'), coalesce(trim(p->>'description'), ''), p->>'currency',
      coalesce((p->>'cost_per_play')::bigint, 1), coalesce((p->>'daily_free_plays')::int, 0), tbl, coalesce((p->>'enabled')::boolean, true), (select auth.uid()))
    returning id into cid;
  else
    update public.event_contents set kind = p->>'kind', variant = coalesce((p->>'variant')::int, 1), name = trim(p->>'name'),
      description = coalesce(trim(p->>'description'), ''), currency = p->>'currency', cost_per_play = coalesce((p->>'cost_per_play')::bigint, 1),
      daily_free_plays = coalesce((p->>'daily_free_plays')::int, 0), reward_table = tbl, enabled = coalesce((p->>'enabled')::boolean, enabled), updated_at = now()
    where id = cid and deleted_at is null;
    if not found then raise exception 'not_found'; end if;
  end if;
  perform private.audit('event_content_save', 'event_contents:' || cid, jsonb_build_object('name', p->>'name', 'kind', p->>'kind'));
  return jsonb_build_object('ok', true, 'id', cid);
end $fn$;

create or replace function public.admin_delete_event_content(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if exists (select 1 from public.event_rotation where content_id = p_id and week_start >= date_trunc('week', (now() at time zone 'Asia/Seoul'))::date) then
    raise exception 'in_rotation';
  end if;
  update public.event_contents set deleted_at = now(), enabled = false, updated_at = now() where id = p_id and deleted_at is null;
  if not found then raise exception 'not_found'; end if;
  perform private.audit('event_content_delete', 'event_contents:' || p_id, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $fn$;

-- 주 편성: 월요일(한국 시간) 기준 한 주에 컨텐츠 하나. p_content 가 null 이면 그 주를 비운다.
create or replace function public.admin_set_event_rotation(p_weeks jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare e jsonb; w date; c uuid; n int := 0;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if jsonb_typeof(p_weeks) <> 'array' or jsonb_array_length(p_weeks) > 60 then raise exception 'invalid_text'; end if;
  for e in select * from jsonb_array_elements(p_weeks) loop
    w := (e->>'week_start')::date;
    if extract(isodow from w) <> 1 then raise exception 'invalid_period'; end if;
    c := nullif(e->>'content_id', '')::uuid;
    if c is null then
      delete from public.event_rotation where week_start = w;
    else
      if not exists (select 1 from public.event_contents where id = c and deleted_at is null) then raise exception 'not_found'; end if;
      insert into public.event_rotation(week_start, content_id, set_by) values (w, c, (select auth.uid()))
      on conflict (week_start) do update set content_id = excluded.content_id, set_by = excluded.set_by, updated_at = now();
    end if;
    n := n + 1;
  end loop;
  perform private.audit('event_rotation_set', 'event_rotation', jsonb_build_object('weeks', p_weeks));
  return jsonb_build_object('ok', true, 'count', n);
end $fn$;

-- 게임이 읽는 지금 주의 정기 이벤트(활성인 것만). 확률 공개를 위해 보상표도 함께 돌려준다.
create or replace function public.get_regular_event()
returns jsonb language sql stable security definer set search_path = '' as $fn$
  with wk as (select date_trunc('week', (now() at time zone 'Asia/Seoul'))::date as w)
  select coalesce((
    select jsonb_build_object('id', c.id, 'kind', c.kind, 'variant', c.variant, 'name', c.name, 'description', c.description,
      'currency', c.currency, 'costPerPlay', c.cost_per_play, 'dailyFreePlays', c.daily_free_plays, 'rewardTable', c.reward_table,
      'weekStart', r.week_start, 'endsAt', ((r.week_start + 7)::timestamp at time zone 'Asia/Seoul'))
    from wk join public.event_rotation r on r.week_start = wk.w
    join public.event_contents c on c.id = r.content_id and c.enabled and c.deleted_at is null
  ), 'null'::jsonb);
$fn$;

revoke all on function public.admin_save_recurring_mail(jsonb), public.admin_set_recurring_mail(uuid, boolean, boolean), public.admin_recurring_mail_status(),
  public.admin_save_patch_note(jsonb), public.admin_delete_patch_note(uuid),
  public.admin_save_event_content(jsonb), public.admin_delete_event_content(uuid), public.admin_set_event_rotation(jsonb),
  public.get_regular_event() from public, anon, authenticated;
grant execute on function public.admin_save_recurring_mail(jsonb), public.admin_set_recurring_mail(uuid, boolean, boolean), public.admin_recurring_mail_status(),
  public.admin_save_patch_note(jsonb), public.admin_delete_patch_note(uuid),
  public.admin_save_event_content(jsonb), public.admin_delete_event_content(uuid), public.admin_set_event_rotation(jsonb),
  public.get_regular_event() to authenticated;
