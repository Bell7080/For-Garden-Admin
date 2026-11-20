-- 사전예약: 휴대폰 번호에 더해 이메일도 필수(동의 문서 preregistration-v4, 응태 요청 2026-11-21).
-- 번호는 한 사람이 여러 번 신청하지 못하게 하고 보상 때 본인 확인에 쓰며, 이메일은 출시 안내의 기본 수단이다.
-- 홈페이지·어드민 저장소에 같은 사본을 둔다. 20261125000000_preregistration_phone_required.sql 다음에 적용한다.
-- 함수 이름(register_website_interest_v3)은 그대로 두고 몸만 바꾼다 — 적용과 홈페이지 배포 순서가 어느 쪽이어도 접수가 끊기지 않는다.
-- 새 표가 없으므로 출시 초기화 분류는 그대로다.
begin;

-- v4 동의로 들어온(또는 v4로 빠진 연락처를 붙인) 행에만 건다. 예전 한쪽만 적은 행은 그대로 남고 고칠 수도 있다.
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'website_preregistrations_email_required') then
    alter table public.website_preregistrations add constraint website_preregistrations_email_required
      check (email is not null or consent_version is distinct from 'preregistration-v4');
  end if;
  if exists (select 1 from pg_constraint where conname = 'website_preregistrations_phone_required') then
    alter table public.website_preregistrations drop constraint website_preregistrations_phone_required;
  end if;
  alter table public.website_preregistrations add constraint website_preregistrations_phone_required
    check (phone is not null or consent_version not in ('preregistration-v3', 'preregistration-v4'));
end $$;

create or replace function public.register_website_interest_v3(
  p_email text, p_phone text, p_platform text, p_locale text, p_fingerprint text,
  p_marketing boolean, p_source text, p_consent_version text)
returns text language plpgsql security definer set search_path = '' as $$
declare used integer; mail text := nullif(lower(trim(coalesce(p_email, ''))), ''); tel text := nullif(trim(coalesce(p_phone, '')), '');
  ad boolean := coalesce(p_marketing, false); by_tel public.website_preregistrations; by_mail public.website_preregistrations;
begin
  if tel is null or tel !~ '^\+[1-9][0-9]{7,14}$'
     or mail is null or length(mail) > 254 or mail !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
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
  select * into by_tel from public.website_preregistrations w where w.phone = tel order by w.created_at limit 1;
  select * into by_mail from public.website_preregistrations w where lower(w.email) = mail order by w.created_at limit 1;
  -- 둘 다 같은 줄이면(이미 둘 다 적은 신청) 중복. 서로 다른 줄에 걸리면 다른 사람의 연락처와 섞이므로 중복으로 본다.
  if by_tel.id is not null and by_mail.id is not null then return 'duplicate'; end if;
  -- 예전에 한쪽만 적은 신청이면 빠진 연락처를 그 줄에 붙인다. 신청 시각·유입 경로는 두고 동의는 지금 것으로 바꾼다.
  if by_tel.id is not null or by_mail.id is not null then
    begin
      update public.website_preregistrations
         set email = coalesce(email, mail), email_canonical = coalesce(email_canonical, private.canonical_email(mail)),
             phone = coalesce(phone, tel), phone_added_at = case when phone is null then now() else phone_added_at end,
             age_confirmed = true, consent_version = p_consent_version, consented_at = now(),
             marketing_consent = ad, marketing_consented_at = case when ad then now() end,
             fingerprint = coalesce(fingerprint, p_fingerprint)
       where id = coalesce(by_tel.id, by_mail.id)
         and (email is null or phone is null);
      if not found then return 'duplicate'; end if;
    exception when unique_violation then return 'duplicate';
    end;
    return 'accepted';
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

commit;
