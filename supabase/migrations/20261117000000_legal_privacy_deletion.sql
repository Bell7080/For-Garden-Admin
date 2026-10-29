-- 개인정보 처리(삭제·열람·정정) 요청 전용 문의 종류 추가, 계정 삭제 요청(유예 후 삭제), 약관 동의 기록.
-- 운영 DB에는 아직 적용하지 않았다. 적용 후 docs/migrations 기록에 남긴다.
-- 이 파일은 출시 점검 20항목(법적·접근성) 작업의 일부다 — 법적 문구는 전문가 검토 전 초안이다.

-- ① 문의 종류 「개인정보·삭제」(privacy)
alter table public.support_tickets drop constraint if exists support_tickets_category_check;
alter table public.support_tickets add constraint support_tickets_category_check
  check (category in ('inquiry','bug','report','privacy','other'));

create or replace function public.submit_ticket(p_category text, p_subject text, p_body text,
  p_reported_uid bigint default null, p_version text default null, p_platform text default null)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare me uuid := (select auth.uid()); tno bigint; tid uuid;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if not exists (select 1 from public.players where id = me) then return jsonb_build_object('ok', false, 'error', 'no_player'); end if;
  if p_category not in ('inquiry','bug','report','privacy','other') then return jsonb_build_object('ok', false, 'error', 'invalid_category'); end if;
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
  if p_category not in ('inquiry','bug','report','privacy','other') then return jsonb_build_object('ok', false, 'error', 'invalid_category'); end if;
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


-- ② 약관·처리방침 동의 기록. 문서 버전과 동의 시각을 계정마다 남기고 지우지 않는다(탈퇴 시에는 계정과 함께 삭제).
create table if not exists public.legal_consents (
  id bigint generated always as identity primary key,
  player_id uuid not null references auth.users(id) on delete cascade,
  terms_version text not null check (char_length(terms_version) between 1 and 64),
  privacy_version text not null check (char_length(privacy_version) between 1 and 64),
  age_14_confirmed boolean not null,
  consented_at timestamptz not null default now()
);
create index if not exists legal_consents_player_idx on public.legal_consents(player_id, consented_at desc);
alter table public.legal_consents enable row level security;

create or replace function public.record_legal_consent(p_terms_version text, p_privacy_version text, p_age_14 boolean)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare me uuid := (select auth.uid());
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  if p_age_14 is not true then return jsonb_build_object('ok', false, 'error', 'age_required'); end if;
  if char_length(coalesce(p_terms_version, '')) not between 1 and 64 or char_length(coalesce(p_privacy_version, '')) not between 1 and 64 then
    return jsonb_build_object('ok', false, 'error', 'invalid_version');
  end if;
  -- 같은 버전의 동의는 한 번만 남긴다(재시도·재설치로 늘지 않게).
  if not exists (select 1 from public.legal_consents where player_id = me and terms_version = p_terms_version and privacy_version = p_privacy_version) then
    insert into public.legal_consents(player_id, terms_version, privacy_version, age_14_confirmed) values (me, p_terms_version, p_privacy_version, true);
  end if;
  return jsonb_build_object('ok', true);
end $fn$;

-- ③ 계정 삭제 요청. 유예 7일([탈퇴 유예 기간] — 운영자 확정, 바꾸면 이 값과 /legal/withdrawal을 함께 고친다).
create table if not exists public.account_deletion_requests (
  user_id uuid primary key references auth.users(id) on delete cascade,
  requested_at timestamptz not null default now(),
  purge_after timestamptz not null,
  cancelled_at timestamptz
);
alter table public.account_deletion_requests enable row level security;

create or replace function public.request_account_deletion()
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare me uuid := (select auth.uid()); due timestamptz := now() + interval '7 days';
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  insert into public.account_deletion_requests(user_id, requested_at, purge_after, cancelled_at)
  values (me, now(), due, null)
  on conflict (user_id) do update set requested_at = now(), purge_after = due, cancelled_at = null
  where public.account_deletion_requests.cancelled_at is not null;
  return jsonb_build_object('ok', true, 'purge_after', (select purge_after from public.account_deletion_requests where user_id = me));
end $fn$;

create or replace function public.cancel_account_deletion()
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare me uuid := (select auth.uid());
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  update public.account_deletion_requests set cancelled_at = now() where user_id = me and cancelled_at is null;
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.get_account_deletion()
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select coalesce((select jsonb_build_object('pending', true, 'purge_after', purge_after)
    from public.account_deletion_requests where user_id = (select auth.uid()) and cancelled_at is null), jsonb_build_object('pending', false));
$fn$;

-- 유예가 지난 요청의 계정을 지운다. 서비스 역할(스케줄러·운영자)만 부른다.
-- auth.users를 지우면 players·저장·친구·길드·아레나 등 계정에 걸린 모든 표가 외래키로 함께 지워진다.
-- 결제·청약철회 기록(5년)·분쟁 기록(3년)은 결제 기능이 붙을 때 별도 분리 보관 표로 옮긴 뒤 이 함수에서 제외한다.
create or replace function public.purge_deleted_accounts()
returns integer language plpgsql security definer set search_path = '' as $fn$
declare n integer;
begin
  with due as (
    select user_id from public.account_deletion_requests where cancelled_at is null and purge_after <= now()
  ), gone as (
    delete from auth.users u using due where u.id = due.user_id returning u.id
  ) select count(*) into n from gone;
  return n;
end $fn$;

revoke all on function public.record_legal_consent(text, text, boolean), public.request_account_deletion(), public.cancel_account_deletion(),
  public.get_account_deletion(), public.purge_deleted_accounts() from public, anon;
grant execute on function public.record_legal_consent(text, text, boolean), public.request_account_deletion(), public.cancel_account_deletion(),
  public.get_account_deletion() to authenticated;
grant execute on function public.purge_deleted_accounts() to service_role;
