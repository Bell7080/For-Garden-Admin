-- 문의/신고/버그 접수. 게임(로그인한 플레이어)과 홈페이지(서버가 대신 접수) 두 길이 같은 표를 쓴다.
-- 개인정보(이메일·IP 해시)가 있어 직원 중 owner/operator/cs만 읽는다. 쓰기는 전부 함수가 맡는다.

create table if not exists public.support_tickets (
  id uuid primary key default gen_random_uuid(),
  ticket_no bigint generated always as identity unique,
  source text not null check (source in ('game','web')),
  category text not null check (category in ('inquiry','bug','report','other')),
  subject text not null check (char_length(subject) between 1 and 100),
  body text not null check (char_length(body) between 1 and 4000),
  status text not null default 'open' check (status in ('open','in_progress','answered','closed')),
  player_id uuid,
  contact_email text check (contact_email is null or (char_length(contact_email) <= 254 and contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')),
  reported_uid bigint,
  app_version text check (app_version is null or char_length(app_version) <= 32),
  platform text check (platform is null or char_length(platform) <= 16),
  assigned_to uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((source = 'game' and player_id is not null) or (source = 'web' and contact_email is not null))
);
create index if not exists support_tickets_status_idx on public.support_tickets(status, created_at desc);
create index if not exists support_tickets_player_idx on public.support_tickets(player_id, created_at desc);

create table if not exists public.support_messages (
  id bigint generated always as identity primary key,
  ticket_id uuid not null references public.support_tickets(id),
  author_kind text not null check (author_kind in ('player','staff')),
  author_id uuid,
  body text not null check (char_length(body) between 1 and 4000),
  created_at timestamptz not null default now()
);
create index if not exists support_messages_ticket_idx on public.support_messages(ticket_id, id);

-- 접수 속도 제한용 기록. 키는 'player:<uuid>' 같은 문자열(IP·이메일은 해시만 둔다).
create table if not exists public.support_limits (
  id bigint generated always as identity primary key,
  key text not null,
  at timestamptz not null default now()
);
create index if not exists support_limits_key_idx on public.support_limits(key, at desc);

alter table public.support_tickets enable row level security;
alter table public.support_messages enable row level security;
alter table public.support_limits enable row level security;

create policy support_tickets_staff_read on public.support_tickets for select to authenticated
  using (private.admin_can(array['owner','operator','cs']));
create policy support_messages_staff_read on public.support_messages for select to authenticated
  using (private.admin_can(array['owner','operator','cs']));
grant select on public.support_tickets, public.support_messages to authenticated;
-- support_limits: 정책도 권한도 없음(함수 전용).

-- 접수 한도: 같은 키로 최근 한 시간 안에 p_max 건 이상이면 거절.
create or replace function private.support_limited(p_key text, p_max int)
returns boolean language plpgsql security definer set search_path = '' as $fn$
declare n int;
begin
  select count(*) into n from public.support_limits where key = p_key and at > now() - interval '1 hour';
  if n >= p_max then return true; end if;
  insert into public.support_limits(key) values (p_key);
  return false;
end $fn$;

create or replace function public.submit_ticket(p_category text, p_subject text, p_body text,
  p_reported_uid bigint default null, p_version text default null, p_platform text default null)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare me uuid := (select auth.uid()); tno bigint; tid uuid;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from public.players where id = me) then return jsonb_build_object('ok', false, 'error', 'no_player'); end if;
  if p_category not in ('inquiry','bug','report','other') then return jsonb_build_object('ok', false, 'error', 'invalid_category'); end if;
  if char_length(trim(coalesce(p_subject, ''))) not between 1 and 100 or char_length(trim(coalesce(p_body, ''))) not between 1 and 4000 then
    return jsonb_build_object('ok', false, 'error', 'invalid_text');
  end if;
  if private.support_limited('player:' || me, 5) then return jsonb_build_object('ok', false, 'error', 'rate_limited'); end if;
  insert into public.support_tickets(source, category, subject, body, player_id, reported_uid, app_version, platform)
  values ('game', p_category, trim(p_subject), trim(p_body), me, p_reported_uid, left(p_version, 32), left(p_platform, 16))
  returning id, ticket_no into tid, tno;
  return jsonb_build_object('ok', true, 'id', tid, 'ticket_no', tno);
end $fn$;

-- 홈페이지 서버(service_role)만 부른다. IP·이메일은 서버가 해시해서 넘긴다.
create or replace function public.web_submit_ticket(p_email text, p_category text, p_subject text, p_body text,
  p_ip_hash text, p_reported_uid bigint default null)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare tno bigint; mail text := lower(trim(coalesce(p_email, '')));
begin
  if p_category not in ('inquiry','bug','report','other') then return jsonb_build_object('ok', false, 'error', 'invalid_category'); end if;
  if char_length(mail) > 254 or mail !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then return jsonb_build_object('ok', false, 'error', 'invalid_email'); end if;
  if char_length(trim(coalesce(p_subject, ''))) not between 1 and 100 or char_length(trim(coalesce(p_body, ''))) not between 1 and 4000 then
    return jsonb_build_object('ok', false, 'error', 'invalid_text');
  end if;
  if p_ip_hash is null or char_length(p_ip_hash) not between 16 and 128 then return jsonb_build_object('ok', false, 'error', 'invalid_request'); end if;
  if private.support_limited('ip:' || p_ip_hash, 5) or private.support_limited('mail:' || encode(extensions.digest(mail, 'sha256'), 'hex'), 3) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  insert into public.support_tickets(source, category, subject, body, contact_email, reported_uid)
  values ('web', p_category, trim(p_subject), trim(p_body), mail, p_reported_uid) returning ticket_no into tno;
  return jsonb_build_object('ok', true, 'ticket_no', tno);
end $fn$;

create or replace function public.list_my_tickets()
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object('id', t.id, 'ticket_no', t.ticket_no, 'category', t.category, 'subject', t.subject,
    'status', t.status, 'created_at', t.created_at, 'updated_at', t.updated_at) order by t.created_at desc), '[]'::jsonb)
  from (select * from public.support_tickets where player_id = (select auth.uid()) order by created_at desc limit 50) t;
$fn$;

create or replace function public.get_my_ticket(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select jsonb_build_object('id', t.id, 'ticket_no', t.ticket_no, 'category', t.category, 'subject', t.subject, 'body', t.body,
    'status', t.status, 'created_at', t.created_at,
    'messages', coalesce((select jsonb_agg(jsonb_build_object('author', m.author_kind, 'body', m.body, 'at', m.created_at) order by m.id)
                          from public.support_messages m where m.ticket_id = t.id), '[]'::jsonb))
  from public.support_tickets t where t.id = p_id and t.player_id = (select auth.uid());
$fn$;

create or replace function public.add_my_ticket_message(p_id uuid, p_body text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare me uuid := (select auth.uid()); t public.support_tickets;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into t from public.support_tickets where id = p_id and player_id = me for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if t.status = 'closed' then return jsonb_build_object('ok', false, 'error', 'ticket_closed'); end if;
  if char_length(trim(coalesce(p_body, ''))) not between 1 and 4000 then return jsonb_build_object('ok', false, 'error', 'invalid_text'); end if;
  if private.support_limited('msg:' || me, 10) then return jsonb_build_object('ok', false, 'error', 'rate_limited'); end if;
  insert into public.support_messages(ticket_id, author_kind, author_id, body) values (t.id, 'player', me, trim(p_body));
  update public.support_tickets set status = case when status = 'answered' then 'open' else status end, updated_at = now() where id = t.id;
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.admin_reply_ticket(p_id uuid, p_body text, p_status text default 'answered')
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator','cs']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('open','in_progress','answered','closed') then raise exception 'invalid_status'; end if;
  if char_length(trim(coalesce(p_body, ''))) not between 1 and 4000 then raise exception 'invalid_text'; end if;
  perform 1 from public.support_tickets where id = p_id for update;
  if not found then raise exception 'not_found'; end if;
  insert into public.support_messages(ticket_id, author_kind, author_id, body) values (p_id, 'staff', (select auth.uid()), trim(p_body));
  update public.support_tickets set status = p_status, updated_at = now(), assigned_to = coalesce(assigned_to, (select auth.uid())) where id = p_id;
  perform private.audit('ticket_reply', 'support_tickets:' || p_id, jsonb_build_object('status', p_status));
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.admin_set_ticket_status(p_id uuid, p_status text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator','cs']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_status not in ('open','in_progress','answered','closed') then raise exception 'invalid_status'; end if;
  update public.support_tickets set status = p_status, updated_at = now() where id = p_id;
  if not found then raise exception 'not_found'; end if;
  perform private.audit('ticket_status', 'support_tickets:' || p_id, jsonb_build_object('status', p_status));
  return jsonb_build_object('ok', true);
end $fn$;

revoke all on function private.support_limited(text, int) from public, anon, authenticated;
revoke all on function public.submit_ticket(text, text, text, bigint, text, text), public.web_submit_ticket(text, text, text, text, text, bigint),
  public.list_my_tickets(), public.get_my_ticket(uuid), public.add_my_ticket_message(uuid, text),
  public.admin_reply_ticket(uuid, text, text), public.admin_set_ticket_status(uuid, text) from public, anon, authenticated;
grant execute on function public.submit_ticket(text, text, text, bigint, text, text), public.list_my_tickets(), public.get_my_ticket(uuid),
  public.add_my_ticket_message(uuid, text), public.admin_reply_ticket(uuid, text, text), public.admin_set_ticket_status(uuid, text) to authenticated;
grant execute on function public.web_submit_ticket(text, text, text, text, text, bigint) to service_role;
