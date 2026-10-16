-- 보안 하드닝: 권한 확인 함수를 API 비노출 스키마로 옮기고, 테이블·함수의 기본 권한을 닫는다.
-- 기본 권한이 열려 있으면(Supabase 기본값) RLS 한 겹만이 방벽이 된다. 필요한 권한만 명시해서 연다.
begin;

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- 정책이 함수를 OID로 참조하므로 이동해도 기존 정책은 그대로 동작한다.
do $$
begin
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'is_admin') then
    alter function public.is_admin() set schema private;
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
             where n.nspname = 'public' and p.proname = 'admin_can') then
    alter function public.admin_can(text[]) set schema private;
  end if;
end $$;
revoke execute on function private.is_admin() from public, anon;
revoke execute on function private.admin_can(text[]) from public, anon;
grant execute on function private.is_admin() to authenticated;
grant execute on function private.admin_can(text[]) to authenticated;

-- 감사 기록: 소유자만 읽는다. 쓰기는 서버 함수(보안 정의자)만.
drop policy if exists audit_admin_read on public.admin_audit_log;
create policy audit_owner_read on public.admin_audit_log
  for select to authenticated using (private.admin_can(array['owner']));

-- 서버 전용 테이블은 정책을 명시해 "의도된 잠금"임을 드러낸다(service_role만 접근).
create policy prereg_no_client on public.website_preregistrations
  for all to anon, authenticated using (false) with check (false);
create policy reglimits_no_client on public.website_registration_limits
  for all to anon, authenticated using (false) with check (false);

-- 기본 테이블 권한을 모두 회수한 뒤 필요한 것만 다시 연다. 실제 행 접근은 RLS가 한 번 더 막는다.
revoke all on all tables in schema public from anon, authenticated;
grant select on public.players, public.admin_roles, public.admin_audit_log to authenticated;
grant select, insert, update, delete on public.website_notices, public.website_notice_translations to authenticated;

-- 앞으로 만드는 테이블·함수는 기본적으로 닫혀 있다. 열 때는 마이그레이션에 명시한다.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- 이미 있는 함수도 같은 원칙으로 정리한다.
revoke execute on all functions in schema public from public, anon, authenticated;
grant execute on function public.ping() to anon, authenticated;

commit;
