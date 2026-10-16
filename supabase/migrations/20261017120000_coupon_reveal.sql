-- 쿠폰 개선: 기한 없음(ends_at null 허용), 발급한 코드를 운영자가 다시 열람.
-- 코드 평문(code_plain)은 테이블 권한에서 빼고, owner/operator만 감사 기록이 남는 함수로 읽는다.
-- 이 마이그레이션 이전에 발급한 코드는 해시만 남아 있어 열람할 수 없다.
begin;

alter table public.coupons alter column ends_at drop not null;
alter table public.coupons drop constraint if exists coupons_check;
alter table public.coupons drop constraint if exists coupons_ends_at_check;
alter table public.coupons add constraint coupons_period_check check (ends_at is null or ends_at > starts_at);

alter table public.coupon_codes add column if not exists code_plain text;
revoke select on public.coupon_codes from authenticated;
grant select (id, coupon_id, code_hint, redeemed_by, redeemed_at) on public.coupon_codes to authenticated;

create or replace function public.admin_create_coupon(p_name text, p_kind text, p_rewards jsonb, p_starts timestamptz,
  p_ends timestamptz, p_max integer default null, p_code text default null, p_count integer default null)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare cid uuid; norm text; raw text; alphabet constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  bytes bytea; made int := 0; tries int := 0; codes text[] := '{}'; i int; hash text;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if p_kind not in ('shared','single') then raise exception 'invalid_kind'; end if;
  if jsonb_typeof(p_rewards) <> 'array' or jsonb_array_length(p_rewards) = 0 or not private.valid_rewards(p_rewards) then raise exception 'invalid_rewards'; end if;
  if p_ends is not null and p_ends <= p_starts then raise exception 'invalid_period'; end if;
  insert into public.coupons(name, kind, rewards, starts_at, ends_at, max_redemptions, created_by)
  values (trim(p_name), p_kind, p_rewards, p_starts, p_ends, p_max, (select auth.uid())) returning id into cid;
  if p_kind = 'shared' then
    norm := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
    if char_length(norm) not between 6 and 32 then raise exception 'invalid_code'; end if;
    insert into public.coupon_codes(coupon_id, code_hash, code_hint, code_plain)
    values (cid, encode(extensions.digest(norm, 'sha256'), 'hex'), left(norm, 2) || '…' || right(norm, 2), norm);
  else
    if p_count is null or p_count not between 1 and 1000 then raise exception 'invalid_count'; end if;
    while made < p_count loop
      tries := tries + 1;
      if tries > p_count * 5 + 20 then raise exception 'code_generation_failed'; end if;
      bytes := extensions.gen_random_bytes(12);
      raw := '';
      for i in 0..11 loop raw := raw || substr(alphabet, (get_byte(bytes, i) % 32) + 1, 1); end loop;
      hash := encode(extensions.digest(raw, 'sha256'), 'hex');
      insert into public.coupon_codes(coupon_id, code_hash, code_hint, code_plain) values (cid, hash, left(raw, 2) || '…' || right(raw, 2), raw) on conflict (code_hash) do nothing;
      if found then
        made := made + 1;
        codes := codes || (substr(raw, 1, 4) || '-' || substr(raw, 5, 4) || '-' || substr(raw, 9, 4));
      end if;
    end loop;
  end if;
  perform private.audit('coupon_create', 'coupons:' || cid, jsonb_build_object('name', p_name, 'kind', p_kind, 'rewards', p_rewards, 'count', p_count, 'max', p_max));
  return jsonb_build_object('ok', true, 'id', cid, 'codes', to_jsonb(codes));
end $fn$;

create or replace function public.redeem_coupon(p_code text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare me uuid := (select auth.uid()); p public.players; norm text; cd public.coupon_codes; cp public.coupons; fails int;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into p from public.players where id = me for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_player'); end if;
  if private.is_restricted(p) then return jsonb_build_object('ok', false, 'error', 'account_restricted'); end if;
  select count(*) into fails from public.coupon_attempts where player_id = me and not ok and at > now() - interval '10 minutes';
  if fails >= 5 then return jsonb_build_object('ok', false, 'error', 'rate_limited'); end if;
  norm := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  if char_length(norm) not between 4 and 32 then return private.coupon_fail(me, 'invalid_code', true); end if;
  select * into cd from public.coupon_codes where code_hash = encode(extensions.digest(norm, 'sha256'), 'hex');
  if not found then return private.coupon_fail(me, 'invalid_code', true); end if;
  select * into cp from public.coupons where id = cd.coupon_id for update;
  if cp.status <> 'active' or now() < cp.starts_at or (cp.ends_at is not null and now() >= cp.ends_at) then return private.coupon_fail(me, 'unavailable', true); end if;
  if exists (select 1 from public.coupon_redemptions where coupon_id = cp.id and player_id = me) then return private.coupon_fail(me, 'already_redeemed', false); end if;
  if cp.kind = 'single' and cd.redeemed_by is not null then return private.coupon_fail(me, 'already_used', true); end if;
  if cp.max_redemptions is not null and cp.redeemed_count >= cp.max_redemptions then return private.coupon_fail(me, 'exhausted', false); end if;
  if cp.kind = 'single' then
    update public.coupon_codes set redeemed_by = me, redeemed_at = now() where id = cd.id;
  end if;
  insert into public.coupon_redemptions(coupon_id, player_id, code_id) values (cp.id, me, cd.id);
  update public.coupons set redeemed_count = redeemed_count + 1 where id = cp.id;
  perform private.grant_rewards(me, cp.rewards, 'coupon', cp.id::text);
  insert into public.coupon_attempts(player_id, ok) values (me, true);
  return jsonb_build_object('ok', true, 'rewards', cp.rewards, 'name', cp.name);
end $fn$;

create or replace function public.admin_reveal_coupon_codes(p_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare result jsonb; k text;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  select kind into k from public.coupons where id = p_id;
  if not found then raise exception 'not_found'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'code', case when c.code_plain is null then null when k = 'single' and char_length(c.code_plain) = 12
                   then substr(c.code_plain, 1, 4) || '-' || substr(c.code_plain, 5, 4) || '-' || substr(c.code_plain, 9, 4) else c.code_plain end,
      'hint', c.code_hint, 'used', c.redeemed_by is not null, 'used_at', c.redeemed_at) order by c.redeemed_by is not null, c.id), '[]'::jsonb)
    into result from public.coupon_codes c where c.coupon_id = p_id;
  perform private.audit('coupon_reveal', 'coupons:' || p_id, '{}'::jsonb);
  return result;
end $fn$;

revoke all on function public.admin_reveal_coupon_codes(uuid) from public, anon, authenticated;
grant execute on function public.admin_reveal_coupon_codes(uuid) to authenticated;
revoke all on function public.admin_create_coupon(text, text, jsonb, timestamptz, timestamptz, integer, text, integer),
  public.redeem_coupon(text) from public, anon;
grant execute on function public.admin_create_coupon(text, text, jsonb, timestamptz, timestamptz, integer, text, integer),
  public.redeem_coupon(text) to authenticated;

commit;
