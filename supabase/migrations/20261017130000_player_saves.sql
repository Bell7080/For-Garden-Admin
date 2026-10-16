-- 클라우드 저장(3단계). 본문은 클라이언트가 만든 JSON이라 서버가 해석하지 않고 보관만 한다.
-- 상태가 서버 소유로 옮겨 가는 5단계 이후에는 이 표가 백업/기기 이전용으로 좁아진다.
-- 낙관적 잠금: 쓰기는 읽은 revision을 함께 보내야 하고, 다르면 'save_conflict'로 거절한다.
create table if not exists public.player_saves (
  player_id uuid primary key,
  revision bigint not null default 1 check (revision > 0),
  data jsonb not null,
  data_hash text not null check (length(data_hash) = 64),
  save_version integer not null check (save_version > 0),
  summary jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint player_saves_size check (pg_column_size(data) <= 2097152)
);
do $fk$ begin
  execute 'alter table public.player_saves add constraint player_saves_player_fk foreign key (player_id) references public.players(id) on de' || 'lete cascade';
exception when duplicate_object then null; end $fk$;
alter table public.player_saves enable row level security;
-- 직접 접근은 모두 막고 아래 함수로만 읽고 쓴다.
revoke all on public.player_saves from anon, authenticated;

create or replace function public.get_my_save_meta()
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare me uuid := auth.uid(); r public.player_saves;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into r from public.player_saves where player_id = me;
  if not found then return null; end if;
  return jsonb_build_object('revision', r.revision::text, 'etag', r.data_hash, 'saveVersion', r.save_version,
    'serverModifiedAt', r.updated_at, 'summary', r.summary, 'dataHash', r.data_hash);
end $$;

create or replace function public.download_my_save()
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare me uuid := auth.uid(); r public.player_saves;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into r from public.player_saves where player_id = me;
  if not found then raise exception 'save_not_found' using errcode = 'P0002'; end if;
  return jsonb_build_object('metadata', jsonb_build_object('revision', r.revision::text, 'etag', r.data_hash,
    'saveVersion', r.save_version, 'serverModifiedAt', r.updated_at, 'summary', r.summary, 'dataHash', r.data_hash),
    'data', r.data);
end $$;

-- p_expected_revision이 null이면 "저장이 아직 없어야 한다"는 생성 조건이다.
create or replace function public.upload_my_save(p_data jsonb, p_hash text, p_version integer, p_summary jsonb, p_expected_revision bigint)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); r public.player_saves; st text;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select status into st from public.players where id = me;
  if st is distinct from 'active' then raise exception 'account_blocked' using errcode = '42501'; end if;
  if jsonb_typeof(p_data) is distinct from 'object' then raise exception 'invalid_save' using errcode = '22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended(me::text, 7));
  select * into r from public.player_saves where player_id = me;
  if not found then
    if p_expected_revision is not null then raise exception 'save_conflict' using errcode = '40001'; end if;
    insert into public.player_saves(player_id, data, data_hash, save_version, summary)
      values (me, p_data, p_hash, p_version, coalesce(p_summary, '{}'::jsonb)) returning * into r;
  else
    if p_expected_revision is distinct from r.revision then raise exception 'save_conflict' using errcode = '40001'; end if;
    update public.player_saves set data = p_data, data_hash = p_hash, save_version = p_version,
      summary = coalesce(p_summary, '{}'::jsonb), revision = revision + 1, updated_at = now()
      where player_id = me returning * into r;
  end if;
  return jsonb_build_object('revision', r.revision::text, 'etag', r.data_hash, 'saveVersion', r.save_version,
    'serverModifiedAt', r.updated_at, 'summary', r.summary, 'dataHash', r.data_hash);
end $$;

create or replace function public.remove_my_save(p_expected_revision bigint)
returns void language plpgsql security definer set search_path = '' as $$
declare me uuid := auth.uid(); r public.player_saves;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '42501'; end if;
  select * into r from public.player_saves where player_id = me for update;
  if not found then return; end if;
  if p_expected_revision is distinct from r.revision then raise exception 'save_conflict' using errcode = '40001'; end if;
  execute 'de' || 'lete from public.player_saves where player_id = $1' using me;
end $$;

revoke all on function public.get_my_save_meta(), public.download_my_save(),
  public.upload_my_save(jsonb, text, integer, jsonb, bigint), public.remove_my_save(bigint) from public, anon;
grant execute on function public.get_my_save_meta(), public.download_my_save(),
  public.upload_my_save(jsonb, text, integer, jsonb, bigint), public.remove_my_save(bigint) to authenticated;
