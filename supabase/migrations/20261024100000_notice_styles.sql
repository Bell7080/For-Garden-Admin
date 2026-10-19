-- Announcement styles. `template` (plain | update | event) already picks the style:
--   plain  = board post, update = patch note, event = in-game event card.
-- This adds what the two richer styles need: how the cover is cropped, and
-- style metadata (patch version, linked in-game event id, event period).
-- Apply after 20261017090000_notice_editor.sql. Same file lives in both repos; apply once.
begin;
alter table public.website_notices add column if not exists cover_frame jsonb;
alter table public.website_notices add column if not exists meta jsonb not null default '{}'::jsonb;
alter table public.website_notices drop constraint if exists website_notices_cover_frame_check;
alter table public.website_notices add constraint website_notices_cover_frame_check check(cover_frame is null or (jsonb_typeof(cover_frame)='object' and length(cover_frame::text)<=200));
alter table public.website_notices drop constraint if exists website_notices_meta_check;
alter table public.website_notices add constraint website_notices_meta_check check(jsonb_typeof(meta)='object' and length(meta::text)<=1000);
create or replace function public.save_website_notice(p_notice jsonb,p_translations jsonb,p_expected_updated_at timestamptz default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare target uuid; stamp timestamptz:=clock_timestamp(); item jsonb; source text; frame jsonb; style jsonb;
begin
 if not private.admin_can(array['owner','operator']) then raise exception 'write_not_allowed' using errcode='42501'; end if;
 source:=coalesce(p_notice->>'source_locale','ko');
 frame:=case when jsonb_typeof(p_notice->'cover_frame')='object' then p_notice->'cover_frame' else null end;
 style:=case when jsonb_typeof(p_notice->'meta')='object' then p_notice->'meta' else '{}'::jsonb end;
 if jsonb_typeof(p_translations)<>'array' or jsonb_array_length(p_translations)>30 then raise exception 'invalid_translations'; end if;
 if not exists(select 1 from jsonb_array_elements(p_translations) t where t->>'locale'=source and length(trim(t->>'title'))>0 and length(trim(t->>'body'))>0) then raise exception 'source_required'; end if;
 if nullif(p_notice->>'id','') is null then
  insert into public.website_notices(slug,category,status,published_at,cover_image,pinned,template,source_locale,cover_frame,meta,updated_at)
  values(p_notice->>'slug',p_notice->>'category',p_notice->>'status',(p_notice->>'published_at')::timestamptz,nullif(p_notice->>'cover_image',''),coalesce((p_notice->>'pinned')::boolean,false),p_notice->>'template',source,frame,style,stamp) returning id into target;
 else
  target:=(p_notice->>'id')::uuid;
  update public.website_notices set category=p_notice->>'category',status=p_notice->>'status',published_at=(p_notice->>'published_at')::timestamptz,cover_image=nullif(p_notice->>'cover_image',''),pinned=(p_notice->>'pinned')::boolean,template=p_notice->>'template',source_locale=source,cover_frame=frame,meta=style,updated_at=stamp
  where id=target and (p_expected_updated_at is null or updated_at=p_expected_updated_at);
  if not found then raise exception 'stale_notice'; end if;
 end if;
 delete from public.website_notice_translations where notice_id=target;
 for item in select * from jsonb_array_elements(p_translations) loop
  insert into public.website_notice_translations(notice_id,locale,title,summary,body)
  values(target,item->>'locale',trim(item->>'title'),coalesce(item->>'summary',''),item->>'body');
 end loop;
 return jsonb_build_object('id',target,'updated_at',stamp);
end; $$;
revoke all on function public.save_website_notice(jsonb,jsonb,timestamptz) from public,anon;
grant execute on function public.save_website_notice(jsonb,jsonb,timestamptz) to authenticated;
commit;
