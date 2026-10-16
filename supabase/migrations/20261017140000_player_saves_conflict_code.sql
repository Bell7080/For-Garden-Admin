-- 충돌을 40001(직렬화 실패)로 알리면 API 게이트웨이가 요청을 붙잡아 두는 것이 확인되어 PostgREST 사용자 정의 코드 PT409(HTTP 409)로 바꾼다.
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
    if p_expected_revision is not null then raise exception 'save_conflict' using errcode = 'PT409'; end if;
    insert into public.player_saves(player_id, data, data_hash, save_version, summary)
      values (me, p_data, p_hash, p_version, coalesce(p_summary, '{}'::jsonb)) returning * into r;
  else
    if p_expected_revision is distinct from r.revision then raise exception 'save_conflict' using errcode = 'PT409'; end if;
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
  if p_expected_revision is distinct from r.revision then raise exception 'save_conflict' using errcode = 'PT409'; end if;
  execute 'de' || 'lete from public.player_saves where player_id = $1' using me;
end $$;

