-- 사전예약 v2: 휴대폰 번호 접수 · 만 14세 확인 · 광고성 정보(문자) 수신 동의 · 유입 경로 · 운영 콘솔 조회.
-- 기존 표(website_preregistrations)에 열만 더한다. 새 표를 만들지 않으므로 출시 초기화 분류(keep)는 그대로다.
-- 이메일·휴대폰 중 하나 이상이 있어야 하고, 둘 다 각자 중복을 막는다(같은 번호·같은 메일은 한 번만).
-- 휴대폰으로 받는 출시·보상 안내 문자는 광고성 정보로 보고 수신 동의 없이는 번호를 받지 않는다.
-- 홈페이지·어드민 저장소에 같은 사본을 둔다. 게임 20261017080000 보안 강화(private.admin_can · private.audit) 다음에 적용한다.
begin;

alter table public.website_preregistrations alter column email drop not null;
alter table public.website_preregistrations
  add column if not exists phone text,
  add column if not exists age_confirmed boolean not null default false,
  add column if not exists marketing_consent boolean not null default false,
  add column if not exists marketing_consented_at timestamptz,
  add column if not exists source text;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'website_preregistrations_phone_key') then
    alter table public.website_preregistrations add constraint website_preregistrations_phone_key unique (phone);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'website_preregistrations_contact') then
    alter table public.website_preregistrations add constraint website_preregistrations_contact
      check (email is not null or phone is not null);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'website_preregistrations_phone_format') then
    alter table public.website_preregistrations add constraint website_preregistrations_phone_format
      check (phone is null or phone ~ '^\+[1-9][0-9]{7,14}$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'website_preregistrations_phone_marketing') then
    alter table public.website_preregistrations add constraint website_preregistrations_phone_marketing
      check (phone is null or marketing_consent);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'website_preregistrations_source_format') then
    alter table public.website_preregistrations add constraint website_preregistrations_source_format
      check (source is null or source ~ '^[a-z0-9_-]{1,32}$');
  end if;
end $$;

create index if not exists website_preregistrations_created on public.website_preregistrations (created_at desc);

-- 접수. 결과: accepted · duplicate(이메일이나 번호가 이미 있다 — 아무것도 바꾸지 않는다) · rate_limited.
-- 중복일 때 기존 행을 고치지 않는다: 남의 메일·번호를 알면 그 신청의 연락처를 바꿀 수 있게 되기 때문이다.
create or replace function public.register_website_interest_v2(
  p_email text, p_phone text, p_platform text, p_locale text, p_fingerprint text,
  p_marketing boolean, p_source text, p_consent_version text)
returns text language plpgsql security definer set search_path = '' as $$
declare used integer; mail text := nullif(lower(trim(coalesce(p_email, ''))), ''); tel text := nullif(trim(coalesce(p_phone, '')), '');
begin
  if (mail is null and tel is null)
     or (mail is not null and (length(mail) > 254 or mail !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
     or (tel is not null and (tel !~ '^\+[1-9][0-9]{7,14}$' or not coalesce(p_marketing, false)))
     or p_platform not in ('android', 'ios', 'both') or p_locale not in ('ko', 'en', 'ja')
     or length(p_fingerprint) <> 64
     or (p_source is not null and p_source !~ '^[a-z0-9_-]{1,32}$')
     or p_consent_version is null or p_consent_version !~ '^[a-z0-9.-]{1,40}$' then
    raise exception 'invalid input';
  end if;
  insert into public.website_registration_limits(fingerprint, bucket) values (p_fingerprint, date_trunc('hour', now()))
    on conflict (fingerprint, bucket) do update set attempts = public.website_registration_limits.attempts + 1 returning attempts into used;
  if used > 5 then return 'rate_limited'; end if;
  delete from public.website_registration_limits where bucket < now() - interval '2 days';
  if exists (select 1 from public.website_preregistrations w where (mail is not null and w.email = mail) or (tel is not null and w.phone = tel)) then
    return 'duplicate';
  end if;
  begin
    insert into public.website_preregistrations(email, phone, platform, locale, consent_version, age_confirmed, marketing_consent, marketing_consented_at, source)
      values (mail, tel, p_platform, p_locale, p_consent_version, true, coalesce(p_marketing, false),
              case when coalesce(p_marketing, false) then now() end, p_source);
  exception when unique_violation then return 'duplicate';
  end;
  return 'accepted';
end;
$$;
revoke all on function public.register_website_interest_v2(text, text, text, text, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.register_website_interest_v2(text, text, text, text, text, boolean, text, text) to service_role;

-- ───────── 운영 콘솔 ─────────
-- 개인정보라 화면마다 권한을 가른다: 통계는 모든 운영진, 목록은 CS 이상(CS는 가린 값),
-- 원문 내보내기는 소유자만, 삭제(철회 요청 처리)는 소유자·운영자. 원문을 보거나 내보내거나 지우면 감사 기록에 남는다.

create or replace function private.mask_email(v text) returns text language sql immutable set search_path = '' as $$
  select case when v is null then null
    else left(split_part(v, '@', 1), 2) || repeat('*', greatest(length(split_part(v, '@', 1)) - 2, 1)) || '@' || split_part(v, '@', 2) end
$$;
create or replace function private.mask_phone(v text) returns text language sql immutable set search_path = '' as $$
  select case when v is null then null else left(v, length(v) - 8) || '****' || right(v, 4) end
$$;

create or replace function public.admin_preregistration_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not private.admin_can(array['owner', 'operator', 'cs', 'viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  select jsonb_build_object(
    'total', count(*),
    'email', count(*) filter (where email is not null),
    'phone', count(*) filter (where phone is not null),
    'both', count(*) filter (where email is not null and phone is not null),
    'marketing', count(*) filter (where marketing_consent),
    'today', count(*) filter (where (created_at at time zone 'Asia/Seoul')::date = (now() at time zone 'Asia/Seoul')::date),
    'platform', (select coalesce(jsonb_object_agg(platform, n), '{}'::jsonb) from (select platform, count(*) n from public.website_preregistrations group by 1) x),
    'locale', (select coalesce(jsonb_object_agg(locale, n), '{}'::jsonb) from (select locale, count(*) n from public.website_preregistrations group by 1) x),
    'source', (select coalesce(jsonb_object_agg(coalesce(source, '(직접)'), n), '{}'::jsonb) from (select source, count(*) n from public.website_preregistrations group by 1 order by 2 desc limit 30) x),
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', d, 'n', n) order by d), '[]'::jsonb) from (
       select (created_at at time zone 'Asia/Seoul')::date d, count(*) n from public.website_preregistrations
        where created_at > now() - interval '30 days' group by 1) x)
  ) into result from public.website_preregistrations;
  return result;
end;
$$;

-- 목록: 최근 신청부터 p_before 이전 p_limit건. p_channel: all · email · phone · marketing. 검색은 이메일·번호 일부.
create or replace function public.admin_preregistrations(p_query text default null, p_channel text default 'all', p_before timestamptz default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare full_view boolean; q text := nullif(trim(coalesce(p_query, '')), ''); digits text; result jsonb;
begin
  if not private.admin_can(array['owner', 'operator', 'cs']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_channel, 'all') not in ('all', 'email', 'phone', 'marketing') then raise exception 'invalid_action'; end if;
  full_view := private.admin_can(array['owner', 'operator']);
  digits := nullif(regexp_replace(coalesce(q, ''), '[^0-9]', '', 'g'), '');
  -- 한국 번호를 010…로 찾으면 +8210…에도 맞도록 앞의 0을 뗀다.
  if digits is not null and left(digits, 1) = '0' then digits := substr(digits, 2); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'email', case when full_view then email else private.mask_email(email) end,
      'phone', case when full_view then phone else private.mask_phone(phone) end,
      'platform', platform, 'locale', locale, 'source', source,
      'marketing', marketing_consent, 'consentVersion', consent_version, 'createdAt', created_at
    ) order by created_at desc), '[]'::jsonb) into result
  from (
    select * from public.website_preregistrations w
     where (p_before is null or w.created_at < p_before)
       and (coalesce(p_channel, 'all') = 'all'
            or (p_channel = 'email' and w.email is not null)
            or (p_channel = 'phone' and w.phone is not null)
            or (p_channel = 'marketing' and w.marketing_consent))
       and (q is null or w.email ilike '%' || replace(replace(q, '%', ''), '_', '\_') || '%'
            or (digits is not null and length(digits) >= 4 and w.phone like '%' || digits || '%'))
     order by w.created_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  ) w;
  return jsonb_build_object('rows', result, 'masked', not full_view);
end;
$$;

-- 내보내기(원문). 문자·메일 발송 업체에 넘길 명단을 만드는 용도라 소유자만 부르고 매번 감사 기록을 남긴다.
-- p_channel: email(이메일 있는 전부) · phone(번호 있는 전부 — 모두 광고 수신 동의가 있다) · all.
create or replace function public.admin_export_preregistrations(p_channel text default 'all')
returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb; n integer;
begin
  if not private.admin_can(array['owner']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_channel, 'all') not in ('all', 'email', 'phone') then raise exception 'invalid_action'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'email', email, 'phone', phone, 'platform', platform, 'locale', locale, 'source', source,
      'marketing', marketing_consent, 'consentVersion', consent_version, 'consentedAt', consented_at,
      'marketingConsentedAt', marketing_consented_at, 'createdAt', created_at
    ) order by created_at), '[]'::jsonb), count(*) into result, n
  from public.website_preregistrations w
  where coalesce(p_channel, 'all') = 'all' or (p_channel = 'email' and w.email is not null) or (p_channel = 'phone' and w.phone is not null);
  perform private.audit('prereg_export', 'website_preregistrations', jsonb_build_object('channel', coalesce(p_channel, 'all'), 'rows', n));
  return result;
end;
$$;

-- 삭제(동의 철회·삭제 요청). 지운 행의 내용은 감사 기록에 남기지 않는다 — 가린 값과 사유만 둔다.
create or replace function public.admin_delete_preregistration(p_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare row public.website_preregistrations;
begin
  if not private.admin_can(array['owner', 'operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(length(trim(p_reason)), 0) = 0 then raise exception 'reason_required'; end if;
  delete from public.website_preregistrations where id = p_id returning * into row;
  if not found then raise exception 'not_found'; end if;
  perform private.audit('prereg_delete', 'website_preregistrations:' || p_id,
    jsonb_build_object('email', private.mask_email(row.email), 'phone', private.mask_phone(row.phone), 'reason', left(p_reason, 200)));
end;
$$;

revoke all on function public.admin_preregistration_stats() from public, anon;
revoke all on function public.admin_preregistrations(text, text, timestamptz, integer) from public, anon;
revoke all on function public.admin_export_preregistrations(text) from public, anon;
revoke all on function public.admin_delete_preregistration(uuid, text) from public, anon;
revoke all on function private.mask_email(text) from public, anon, authenticated;
revoke all on function private.mask_phone(text) from public, anon, authenticated;
grant execute on function public.admin_preregistration_stats() to authenticated;
grant execute on function public.admin_preregistrations(text, text, timestamptz, integer) to authenticated;
grant execute on function public.admin_export_preregistrations(text) to authenticated;
grant execute on function public.admin_delete_preregistration(uuid, text) to authenticated;

commit;
