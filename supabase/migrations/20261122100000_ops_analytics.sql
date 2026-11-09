-- 운영 콘솔 · 행동·결제 퍼널(admin_analytics). 게임 마이그레이션 20261122000000_game_events 다음에 적용한다.
-- 무엇을 보나: 가입 → 튜토리얼 완료 → 1-5 → 1-10 → 첫 결제 퍼널, D1·D7·D30 잔존, 떠난 계정이 마지막으로 깬 관문,
-- 최근 7일 호출 수(어떤 콘텐츠가 실제로 돌아가는가)와 연구 횟수. 날짜는 한국 시간 기준이다.
-- 퍼널은 사건 기록이 아니라 지금 저장(player_saves)에서 읽는다 — 계측 이전에 가입한 계정도 같은 잣대로 센다.
-- 읽기 전용이며 모든 운영진(viewer 포함)이 본다. 자세한 내용은 docs/ops-analytics.md.

create or replace function public.admin_analytics(p_days integer default 30)
returns jsonb language plpgsql stable security definer set search_path = '' as $fn$
declare
  days int := greatest(1, least(coalesce(p_days, 30), 180));
  today date := (now() at time zone 'Asia/Seoul')::date;
  -- 튜토리얼의 마지막 칸(게임 src/core/tutorial.ts의 TUTORIAL_STEPS 끝). 칸이 늘면 이 값만 고친다.
  last_step constant text := 'pull';
  has_purchases boolean := to_regclass('public.purchase_records') is not null;
  has_events boolean := to_regclass('public.game_events') is not null;
  has_calls boolean := to_regclass('public.game_call_daily') is not null;
  funnel jsonb; retention jsonb; dropoff jsonb; calls jsonb := '[]'::jsonb; research jsonb := 'null'::jsonb; firsts jsonb := '[]'::jsonb;
  paid_ids uuid[] := '{}';
begin
  if not private.admin_can(array['owner','operator','cs','viewer']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if has_purchases then
    execute 'select coalesce(array_agg(distinct player_id), ''{}'') from public.purchase_records where refunded_at is null' into paid_ids;
  end if;

  -- 퍼널: 최근 N일 가입(삭제 제외) 계정.
  with cohort as (
    select p.id, s.data from public.players p left join public.player_saves s on s.player_id = p.id
     where p.status <> 'deleted' and (p.created_at at time zone 'Asia/Seoul')::date > today - days
  )
  select jsonb_build_object(
    'days', days,
    'signups', count(*),
    'tutorial', count(*) filter (where coalesce(data->'tutorial'->'completedStepIds', '[]'::jsonb) ? last_step),
    'stage1_5', count(*) filter (where coalesce(data->'clearedStageIds', '[]'::jsonb) ? '1-5'),
    'stage1_10', count(*) filter (where coalesce(data->'clearedStageIds', '[]'::jsonb) ? '1-10'),
    'stage2_10', count(*) filter (where coalesce(data->'clearedStageIds', '[]'::jsonb) ? '2-10'),
    'firstPurchase', count(*) filter (where id = any(paid_ids))
  ) into funnel from cohort;

  -- 잔존: 가입일로부터 N일째에 접속한 비율. 그날이 아직 오지 않은 가입자는 분모에서 뺀다.
  select jsonb_object_agg(k, v) into retention from (
    select 'd' || n as k, (
      select jsonb_build_object('cohort', count(*), 'returned', count(*) filter (where exists (
        select 1 from public.player_daily_activity a where a.player_id = p.id and a.day = (p.created_at at time zone 'Asia/Seoul')::date + n)))
        from public.players p
       where p.status <> 'deleted'
         and (p.created_at at time zone 'Asia/Seoul')::date > today - days - n
         and (p.created_at at time zone 'Asia/Seoul')::date + n < today
    ) as v
    from unnest(array[1, 7, 30]) n
  ) r;

  -- 떠난 계정(3일 넘게 접속 없음)이 마지막으로 깬 본편 관문. 막힌 자리일수록 줄이 길다.
  with gone as (
    select s.data from public.players p join public.player_saves s on s.player_id = p.id
     where p.status <> 'deleted' and (p.created_at at time zone 'Asia/Seoul')::date > today - days
       and (p.last_seen_at is null or p.last_seen_at < now() - interval '3 days')
  ), last_stage as (
    select coalesce((
      select st from jsonb_array_elements_text(coalesce(g.data->'clearedStageIds', '[]'::jsonb)) st
       where st ~ '^[0-9]+-[0-9]+$'
       order by split_part(st, '-', 1)::int desc, split_part(st, '-', 2)::int desc limit 1), '없음') as stage
    from gone g
  )
  select coalesce(jsonb_agg(jsonb_build_object('stage', stage, 'players', n) order by n desc, stage), '[]'::jsonb) into dropoff
    from (select stage, count(*) n from last_stage group by stage order by count(*) desc limit 12) x;

  if has_calls then
    execute 'select coalesce(jsonb_agg(jsonb_build_object(''method'', method, ''calls'', calls) order by calls desc), ''[]''::jsonb)
               from (select method, sum(calls)::bigint calls from public.game_call_daily where day > $1 - 7 group by method order by 2 desc limit 20) x'
      into calls using today;
  end if;
  if has_events then
    execute 'select jsonb_build_object(''pulls'', coalesce(sum(amount), 0), ''players'', count(distinct player_id))
               from public.game_events where kind = ''research'' and created_at > now() - interval ''7 days'''
      into research;
  end if;
  -- 첫 결제가 어느 상품에서 일어나는가(계정마다 가장 이른 결제 한 건).
  if has_purchases then
    execute 'select coalesce(jsonb_agg(jsonb_build_object(''product'', product_id, ''players'', n) order by n desc), ''[]''::jsonb)
               from (select product_id, count(*) n from (
                 select distinct on (player_id) player_id, product_id from public.purchase_records where refunded_at is null order by player_id, recorded_at) f
               group by product_id order by 2 desc limit 10) x'
      into firsts;
  end if;

  return jsonb_build_object('today', today, 'funnel', funnel, 'retention', retention, 'dropoff', dropoff,
    'calls', calls, 'research7d', research, 'firstPurchases', firsts);
end $fn$;

revoke all on function public.admin_analytics(integer) from public, anon;
grant execute on function public.admin_analytics(integer) to authenticated;
