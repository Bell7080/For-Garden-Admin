-- 사전예약 v3: 휴대폰 번호 필수 · 번호 하나에 한 건 · 중복 의심 확인.
-- 가짜 이메일을 여러 개 적어 달성 인원을 부풀리는 일을 막으려고 번호를 반드시 받는다.
-- 이메일은 선택으로 함께 받고(적으면 그 이메일도 한 번만), 광고성 정보 수신 동의는 다시 선택으로 돌린다 —
-- 번호가 필수가 되었으니 번호에 광고 동의를 묶으면 선택 동의를 강제하는 셈이 된다(개인정보 보호법 제22조 제5항).
-- 번호는 「한 사람 한 건」 확인과 출시 뒤 보상 지급 대상 확인에 쓰고, 문자는 광고 수신 동의자에게만 보낸다.
--
-- 예전(v2) 이메일만 있는 신청은 지우지 않는다. 다만 달성 인원에는 번호가 있는 신청만 센다.
-- 같은 이메일로 번호를 적어 다시 신청하면 그 행에 번호를 붙여 준다(번호가 아직 없는 행만).
--
-- 홈페이지·어드민 저장소에 같은 사본을 둔다. 20261124000000_preregistration_phone.sql 다음에 적용한다.
-- 새 표를 만들지 않으므로 출시 초기화 분류(keep)는 그대로다.
begin;

alter table public.website_preregistrations
  add column if not exists fingerprint text,
  add column if not exists email_canonical text,
  add column if not exists phone_added_at timestamptz;

-- 번호 필수. v3 동의로 들어온(또는 v3로 번호를 붙인) 행에만 건다 — 예전 이메일만 있는 행은 남고,
-- NOT VALID와 달리 예전 행을 고치는 일(철회·정리)도 막지 않는다.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'website_preregistrations_phone_required') then
    alter table public.website_preregistrations add constraint website_preregistrations_phone_required
      check (phone is not null or consent_version is distinct from 'preregistration-v3');
  end if;
  if exists (select 1 from pg_constraint where conname = 'website_preregistrations_phone_marketing') then
    alter table public.website_preregistrations drop constraint website_preregistrations_phone_marketing;
  end if;
  if not exists (select 1 from pg_constraint where conname = 'website_preregistrations_fingerprint_format') then
    alter table public.website_preregistrations add constraint website_preregistrations_fingerprint_format
      check (fingerprint is null or fingerprint ~ '^[0-9a-f]{64}$');
  end if;
end $$;

-- 별칭 메일(a.b+x@gmail.com = ab@gmail.com)을 한 주소로 읽는다. 막지는 않고 중복 의심으로만 보여 준다.
create or replace function private.canonical_email(v text) returns text language sql immutable set search_path = '' as $$
  select case when v is null or position('@' in v) = 0 then null else (
    with p as (select lower(split_part(v, '@', 1)) l, lower(split_part(v, '@', 2)) d)
    select case when d in ('gmail.com', 'googlemail.com')
                then replace(split_part(l, '+', 1), '.', '') || '@gmail.com'
                else split_part(l, '+', 1) || '@' || d end
      from p) end
$$;
revoke all on function private.canonical_email(text) from public, anon, authenticated;

update public.website_preregistrations set email_canonical = private.canonical_email(email)
 where email is not null and email_canonical is null;

create index if not exists website_preregistrations_fingerprint on public.website_preregistrations (fingerprint) where fingerprint is not null;
create index if not exists website_preregistrations_email_canonical on public.website_preregistrations (email_canonical) where email_canonical is not null;
create index if not exists website_preregistrations_counted on public.website_preregistrations (created_at) where phone is not null;

-- 접수. 결과: accepted · duplicate · rate_limited.
-- 번호가 이미 있으면 duplicate(아무것도 바꾸지 않는다). 이메일이 이미 있으면, 그 행에 번호가 없을 때만 번호를 붙이고
-- accepted, 번호가 있으면 duplicate. 지문(접속 IP의 HMAC)은 시간당 5회 · 하루 신청 10건까지 받는다.
create or replace function public.register_website_interest_v3(
  p_email text, p_phone text, p_platform text, p_locale text, p_fingerprint text,
  p_marketing boolean, p_source text, p_consent_version text)
returns text language plpgsql security definer set search_path = '' as $$
declare used integer; mail text := nullif(lower(trim(coalesce(p_email, ''))), ''); tel text := nullif(trim(coalesce(p_phone, '')), '');
  ad boolean := coalesce(p_marketing, false); existing public.website_preregistrations;
begin
  if tel is null or tel !~ '^\+[1-9][0-9]{7,14}$'
     or (mail is not null and (length(mail) > 254 or mail !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'))
     or p_platform not in ('android', 'ios', 'both') or p_locale not in ('ko', 'en', 'ja')
     or p_fingerprint is null or p_fingerprint !~ '^[0-9a-f]{64}$'
     or (p_source is not null and p_source !~ '^[a-z0-9_-]{1,32}$')
     or p_consent_version is null or p_consent_version !~ '^[a-z0-9.-]{1,40}$' then
    raise exception 'invalid input';
  end if;
  insert into public.website_registration_limits(fingerprint, bucket) values (p_fingerprint, date_trunc('hour', now()))
    on conflict (fingerprint, bucket) do update set attempts = public.website_registration_limits.attempts + 1 returning attempts into used;
  if used > 5 then return 'rate_limited'; end if;
  delete from public.website_registration_limits where bucket < now() - interval '2 days';
  if (select count(*) from public.website_preregistrations w
       where w.fingerprint = p_fingerprint and w.created_at > now() - interval '1 day') >= 10 then
    return 'rate_limited';
  end if;
  if exists (select 1 from public.website_preregistrations w where w.phone = tel) then
    return 'duplicate';
  end if;
  if mail is not null then
    select * into existing from public.website_preregistrations w where lower(w.email) = mail order by w.created_at limit 1;
    if found then
      if existing.phone is not null then return 'duplicate'; end if;
      -- 예전 이메일만의 신청에 번호를 붙인다. 신청 시각·유입 경로는 그대로 두고 동의는 지금 것으로 바꾼다.
      begin
        update public.website_preregistrations
           set phone = tel, phone_added_at = now(), age_confirmed = true, consent_version = p_consent_version,
               consented_at = now(), marketing_consent = ad, marketing_consented_at = case when ad then now() end,
               fingerprint = coalesce(fingerprint, p_fingerprint)
         where id = existing.id and phone is null;
      exception when unique_violation then return 'duplicate';
      end;
      return 'accepted';
    end if;
  end if;
  begin
    insert into public.website_preregistrations(email, email_canonical, phone, platform, locale, consent_version, age_confirmed,
                                                marketing_consent, marketing_consented_at, source, fingerprint)
      values (mail, private.canonical_email(mail), tel, p_platform, p_locale, p_consent_version, true, ad,
              case when ad then now() end, p_source, p_fingerprint);
  exception when unique_violation then return 'duplicate';
  end;
  return 'accepted';
end;
$$;
revoke all on function public.register_website_interest_v3(text, text, text, text, text, boolean, text, text) from public, anon, authenticated;
grant execute on function public.register_website_interest_v3(text, text, text, text, text, boolean, text, text) to service_role;

-- v2(번호 없이도 받는 함수)는 이 파일에서 닫지 않는다 — 적용과 홈페이지 재배포 사이에 접수가 끊기지 않게 하려는 것이다.
-- 새 홈페이지가 v3만 부르는 것을 확인한 뒤 아래 한 줄을 따로 실행한다(docs/preregistration-launch-plan.md 「v3 전환」).
--   revoke all on function public.register_website_interest_v2(text, text, text, text, text, boolean, text, text) from service_role;
-- 홈페이지 게이지는 표를 직접 센다: website_preregistrations?phone=not.is.null (번호가 있는 신청만).

-- ───────── 운영 콘솔 ─────────

create or replace function public.admin_preregistration_stats()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not private.admin_can(array['owner', 'operator', 'cs', 'viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  select jsonb_build_object(
    'total', count(*),
    'counted', count(*) filter (where phone is not null),
    'legacyEmailOnly', count(*) filter (where phone is null),
    'email', count(*) filter (where email is not null),
    'phone', count(*) filter (where phone is not null),
    'both', count(*) filter (where email is not null and phone is not null),
    'marketing', count(*) filter (where marketing_consent),
    'smsTargets', count(*) filter (where phone is not null and marketing_consent),
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

-- 목록: 줄마다 같은 접속지·같은 별칭 메일 건수를 함께 낸다(자기 포함, 2 이상이면 의심).
-- p_channel: all · email · phone · marketing · legacy(번호 없는 예전 신청) · suspect(같은 접속지 3건↑ 또는 별칭 메일 2건↑).
create or replace function public.admin_preregistrations(p_query text default null, p_channel text default 'all', p_before timestamptz default null, p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare full_view boolean; q text := nullif(trim(coalesce(p_query, '')), ''); digits text; result jsonb;
begin
  if not private.admin_can(array['owner', 'operator', 'cs']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if coalesce(p_channel, 'all') not in ('all', 'email', 'phone', 'marketing', 'legacy', 'suspect') then raise exception 'invalid_action'; end if;
  full_view := private.admin_can(array['owner', 'operator']);
  digits := nullif(regexp_replace(coalesce(q, ''), '[^0-9]', '', 'g'), '');
  if digits is not null and left(digits, 1) = '0' then digits := substr(digits, 2); end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', id,
      'email', case when full_view then email else private.mask_email(email) end,
      'phone', case when full_view then phone else private.mask_phone(phone) end,
      'platform', platform, 'locale', locale, 'source', source,
      'marketing', marketing_consent, 'consentVersion', consent_version, 'createdAt', created_at,
      'phoneAddedAt', phone_added_at, 'sameIp', same_ip, 'sameEmail', same_email
    ) order by created_at desc), '[]'::jsonb) into result
  from (
    select w.*,
      case when w.fingerprint is null then 1 else (select count(*) from public.website_preregistrations o where o.fingerprint = w.fingerprint) end same_ip,
      case when w.email_canonical is null then 1 else (select count(*) from public.website_preregistrations o where o.email_canonical = w.email_canonical) end same_email
      from public.website_preregistrations w
     where (p_before is null or w.created_at < p_before)
       and (coalesce(p_channel, 'all') = 'all'
            or (p_channel = 'email' and w.email is not null)
            or (p_channel = 'phone' and w.phone is not null)
            or (p_channel = 'marketing' and w.marketing_consent)
            or (p_channel = 'legacy' and w.phone is null)
            or (p_channel = 'suspect' and (
                 (w.fingerprint is not null and (select count(*) from public.website_preregistrations o where o.fingerprint = w.fingerprint) >= 3)
                 or (w.email_canonical is not null and (select count(*) from public.website_preregistrations o where o.email_canonical = w.email_canonical) >= 2))))
       and (q is null or w.email ilike '%' || replace(replace(q, '%', ''), '_', '\_') || '%'
            or (digits is not null and length(digits) >= 4 and w.phone like '%' || digits || '%'))
     order by w.created_at desc
     limit greatest(1, least(coalesce(p_limit, 100), 500))
  ) w;
  return jsonb_build_object('rows', result, 'masked', not full_view);
end;
$$;

-- 중복 의심 묶음. 원문 연락처는 내주지 않는다(가린 값만) — 묶음을 보고 목록의 「중복 의심」 필터로 들어간다.
--  ip: 같은 접속지(지문)에서 3건 이상 · email: 별칭 메일(점·+태그)로 같은 주소가 2건 이상 ·
--  sequence: 같은 앞자리에서 끝번호가 1~3 차이로 이어진 번호가 3개 이상(번호 생성 의심).
create or replace function public.admin_preregistration_suspects()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare result jsonb;
begin
  if not private.admin_can(array['owner', 'operator', 'cs', 'viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  with ip as (
    select fingerprint, count(*) n, min(created_at) first_at, max(created_at) last_at,
           jsonb_agg(coalesce(private.mask_phone(phone), private.mask_email(email)) order by created_at) contacts
      from public.website_preregistrations where fingerprint is not null
     group by fingerprint having count(*) >= 3 order by count(*) desc limit 50),
  mail as (
    select email_canonical k, count(*) n, min(created_at) first_at, max(created_at) last_at,
           jsonb_agg(private.mask_email(email) order by created_at) contacts
      from public.website_preregistrations where email_canonical is not null
     group by email_canonical having count(*) >= 2 order by count(*) desc limit 50),
  nums as (
    select phone, created_at, left(phone, length(phone) - 4) head, right(phone, 4)::int tail
      from public.website_preregistrations where phone ~ '[0-9]{4}$'),
  steps as (
    select *, case when tail - lag(tail) over (partition by head order by tail) between 1 and 3 then 0 else 1 end brk from nums),
  runs as (
    select *, sum(brk) over (partition by head order by tail) grp from steps),
  seq as (
    select head, grp, count(*) n, min(created_at) first_at, max(created_at) last_at,
           jsonb_agg(private.mask_phone(phone) order by tail) contacts
      from runs group by head, grp having count(*) >= 3 order by count(*) desc limit 50)
  select jsonb_build_object(
    'ip', (select coalesce(jsonb_agg(jsonb_build_object('n', n, 'firstAt', first_at, 'lastAt', last_at, 'contacts', contacts) order by n desc), '[]'::jsonb) from ip),
    'email', (select coalesce(jsonb_agg(jsonb_build_object('n', n, 'firstAt', first_at, 'lastAt', last_at, 'contacts', contacts) order by n desc), '[]'::jsonb) from mail),
    'sequence', (select coalesce(jsonb_agg(jsonb_build_object('n', n, 'firstAt', first_at, 'lastAt', last_at, 'contacts', contacts) order by n desc), '[]'::jsonb) from seq)
  ) into result;
  return result;
end;
$$;

-- 내보내기(원문). phone은 문자 발송용이라 광고 수신 동의자만 담는다.
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
  where coalesce(p_channel, 'all') = 'all' or (p_channel = 'email' and w.email is not null)
     or (p_channel = 'phone' and w.phone is not null and w.marketing_consent);
  perform private.audit('prereg_export', 'website_preregistrations', jsonb_build_object('channel', coalesce(p_channel, 'all'), 'rows', n));
  return result;
end;
$$;

revoke all on function public.admin_preregistration_suspects() from public, anon;
grant execute on function public.admin_preregistration_suspects() to authenticated;

commit;
