-- 운영 콘솔 · 운영 일정(live_schedule) 편집. 게임 마이그레이션 20261123000000_live_schedule 다음에 적용한다.
-- 배너·상품·이벤트·로비 카드의 「언제 여는가」만 덮는다 — 무엇이 나오고 얼마인지는 게임 정의가 갖는다.
-- 줄이 없으면 게임 정의의 기간 그대로이고, 줄을 지우면 정의 기간으로 돌아간다. 게임 서버는 1분 캐시로 읽는다.
-- 조회는 모든 운영진, 고치기는 owner·operator. 모든 변경은 감사 로그에 남는다. 자세한 내용은 docs/ops-schedule.md.

create or replace function public.admin_list_schedule()
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('kind', s.kind, 'id', s.id, 'startsAt', s.starts_at, 'endsAt', s.ends_at,
      'enabled', s.enabled, 'note', s.note, 'updatedAt', s.updated_at) order by s.kind, s.id)
    from public.live_schedule s), '[]'::jsonb);
end $fn$;

create or replace function public.admin_set_schedule(p jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare
  k text := p->>'kind';
  i text := trim(coalesce(p->>'id', ''));
  s timestamptz := nullif(p->>'startsAt', '')::timestamptz;
  e timestamptz := nullif(p->>'endsAt', '')::timestamptz;
  on_ boolean := coalesce((p->>'enabled')::boolean, true);
  n text := left(trim(coalesce(p->>'note', '')), 200);
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if k is null or k not in ('banner', 'product', 'event', 'lobby') then raise exception 'invalid_schedule_kind'; end if;
  if char_length(i) not between 1 and 96 then raise exception 'invalid_schedule_id'; end if;
  if s is not null and e is not null and e <= s then raise exception 'invalid_period'; end if;
  insert into public.live_schedule(kind, id, starts_at, ends_at, enabled, note, updated_at, updated_by)
  values (k, i, s, e, on_, n, now(), (select auth.uid()))
  on conflict (kind, id) do update set starts_at = excluded.starts_at, ends_at = excluded.ends_at, enabled = excluded.enabled,
    note = excluded.note, updated_at = now(), updated_by = excluded.updated_by;
  perform private.audit('schedule_set', 'live_schedule:' || k || ':' || i,
    jsonb_build_object('startsAt', s, 'endsAt', e, 'enabled', on_, 'note', n));
  return jsonb_build_object('ok', true);
end $fn$;

create or replace function public.admin_clear_schedule(p_kind text, p_id text)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  delete from public.live_schedule where kind = p_kind and id = p_id;
  if not found then raise exception 'schedule_not_found'; end if;
  perform private.audit('schedule_clear', 'live_schedule:' || p_kind || ':' || p_id, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end $fn$;

revoke all on function public.admin_list_schedule(), public.admin_set_schedule(jsonb), public.admin_clear_schedule(text, text) from public, anon;
grant execute on function public.admin_list_schedule(), public.admin_set_schedule(jsonb), public.admin_clear_schedule(text, text) to authenticated;
