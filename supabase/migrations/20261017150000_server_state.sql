-- 5단계: 게임 상태를 서버가 소유한다. 클라이언트는 상태를 직접 쓰지 못하고, 서버 함수(서비스 롤)만
-- 아래 세 함수로 읽고 확정한다. 영수증은 같은 요청의 재전송이 두 번 반영되지 않게 하는 멱등 기록이다.
create table if not exists public.request_receipts (
  player_id uuid not null,
  request_id text not null check (length(request_id) between 8 and 64),
  method text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key (player_id, request_id)
);
create index if not exists request_receipts_created_idx on public.request_receipts (created_at);
alter table public.request_receipts enable row level security;
revoke all on public.request_receipts from anon, authenticated;

create or replace function public.server_load_state(p_player uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare r public.player_saves; st text;
begin
  select status into st from public.players where id = p_player;
  if st is null then raise exception 'player_not_found' using errcode = 'P0002'; end if;
  if st <> 'active' then raise exception 'account_blocked' using errcode = '42501'; end if;
  select * into r from public.player_saves where player_id = p_player;
  if not found then return null; end if;
  return jsonb_build_object('revision', r.revision::text, 'data', r.data);
end $$;

create or replace function public.server_find_receipt(p_player uuid, p_request text)
returns jsonb language sql security definer set search_path = '' stable as $$
  select response from public.request_receipts where player_id = p_player and request_id = p_request;
$$;

-- p_expected_revision이 null이면 "저장이 아직 없어야 한다"는 생성 조건이다. 다르면 PT409로 거절한다.
create or replace function public.server_commit_state(p_player uuid, p_expected_revision bigint, p_data jsonb,
  p_hash text, p_version integer, p_summary jsonb, p_method text, p_request text, p_response jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare r public.player_saves;
begin
  if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'invalid_save' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_player::text, 7));
  select * into r from public.player_saves where player_id = p_player;
  if not found then
    if p_expected_revision is not null then raise exception 'save_conflict' using errcode = 'PT409'; end if;
    insert into public.player_saves(player_id, data, data_hash, save_version, summary)
      values (p_player, p_data, p_hash, p_version, coalesce(p_summary, '{}'::jsonb)) returning * into r;
  else
    if p_expected_revision is distinct from r.revision then raise exception 'save_conflict' using errcode = 'PT409'; end if;
    update public.player_saves set data = p_data, data_hash = p_hash, save_version = p_version,
      summary = coalesce(p_summary, '{}'::jsonb), revision = revision + 1, updated_at = now()
      where player_id = p_player returning * into r;
  end if;
  if p_request is not null then
    insert into public.request_receipts(player_id, request_id, method, response)
      values (p_player, p_request, p_method, coalesce(p_response, '{}'::jsonb) || jsonb_build_object('revision', r.revision::text))
      on conflict (player_id, request_id) do nothing;
  end if;
  return jsonb_build_object('revision', r.revision::text);
end $$;

revoke all on function public.server_load_state(uuid), public.server_find_receipt(uuid, text),
  public.server_commit_state(uuid, bigint, jsonb, text, integer, jsonb, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.server_load_state(uuid), public.server_find_receipt(uuid, text),
  public.server_commit_state(uuid, bigint, jsonb, text, integer, jsonb, text, text, jsonb) to service_role;

-- 클라이언트가 권위 있는 상태를 직접 덮어쓰지 못하게 쓰기 경로를 닫는다. 읽기(메타·내려받기)는 유지한다.
revoke execute on function public.upload_my_save(jsonb, text, integer, jsonb, bigint), public.remove_my_save(bigint) from authenticated;
