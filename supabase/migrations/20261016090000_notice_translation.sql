-- Apply after the website base schema and game's 20261015180000_notice_admin.sql.
-- Separate automatic translations from editorial text: edits never overwrite manual work.
begin;
alter table public.website_notices add column if not exists source_locale text not null default 'ko';
alter table public.website_notices add constraint website_notices_source_locale_check check(source_locale ~ '^[a-z]{2,3}(-[A-Za-z]{2,8})?$');
alter table public.website_notice_translations drop constraint if exists website_notice_translations_locale_check;
alter table public.website_notice_translations add constraint website_notice_translations_locale_check check(locale ~ '^[a-z]{2,3}(-[A-Za-z]{2,8})?$');
create table public.website_notice_auto_translations (
 notice_id uuid not null references public.website_notices(id) on delete cascade,
 locale text not null check(locale ~ '^[a-z]{2,3}(-[A-Za-z]{2,8})?$'),
 source_hash text not null check(length(source_hash)=64),
 title text not null check(length(title) between 1 and 200),
 summary text not null default '',body text not null check(length(body) between 1 and 50000),
 generated_at timestamptz not null default now(),primary key(notice_id,locale)
);
alter table public.website_notice_auto_translations enable row level security;
revoke all on public.website_notice_auto_translations from anon,authenticated;
grant select on public.website_notice_auto_translations to authenticated;
grant all on public.website_notice_auto_translations to service_role;
create policy auto_translation_admin_read on public.website_notice_auto_translations for select to authenticated using(public.is_admin());
create table public.website_translation_leases (
 notice_id uuid not null references public.website_notices(id) on delete cascade,
 locale text not null,source_hash text not null,expires_at timestamptz not null,primary key(notice_id,locale)
);
alter table public.website_translation_leases enable row level security;
revoke all on public.website_translation_leases from anon,authenticated;
grant all on public.website_translation_leases to service_role;
create function public.claim_notice_translation(p_notice_id uuid,p_locale text,p_hash text) returns text
language plpgsql security definer set search_path='' as $$
begin
 perform pg_advisory_xact_lock(170016);
 delete from public.website_translation_leases where expires_at<now();
 -- Concurrency protection for a self-hosted engine; there is no daily usage quota.
 if (select count(*) from public.website_translation_leases)>=4 then return 'busy'; end if;
 insert into public.website_translation_leases values(p_notice_id,p_locale,p_hash,now()+interval '100 seconds') on conflict do nothing;
 if not found then return 'busy'; end if;
 return 'claimed';
end; $$;
create function public.release_notice_translation(p_notice_id uuid,p_locale text,p_hash text) returns void
language sql security definer set search_path='' as $$
 delete from public.website_translation_leases where notice_id=p_notice_id and locale=p_locale and source_hash=p_hash;
$$;
revoke all on function public.claim_notice_translation(uuid,text,text),public.release_notice_translation(uuid,text,text) from public,anon,authenticated;
grant execute on function public.claim_notice_translation(uuid,text,text),public.release_notice_translation(uuid,text,text) to service_role;

-- One transaction for settings and all manual languages. A failed language cannot
-- expose a partially saved announcement; optimistic locking rejects stale editors.
create function public.save_website_notice(p_notice jsonb,p_translations jsonb,p_expected_updated_at timestamptz default null)
returns jsonb language plpgsql security invoker set search_path='' as $$
declare target uuid; stamp timestamptz:=clock_timestamp(); item jsonb; source text;
begin
 if not public.admin_can(array['owner','operator']) then raise exception 'write_not_allowed' using errcode='42501'; end if;
 source:=coalesce(p_notice->>'source_locale','ko');
 if jsonb_typeof(p_translations)<>'array' or jsonb_array_length(p_translations)>30 then raise exception 'invalid_translations'; end if;
 if not exists(select 1 from jsonb_array_elements(p_translations) t where t->>'locale'=source and length(trim(t->>'title'))>0 and length(trim(t->>'body'))>0) then raise exception 'source_required'; end if;
 if nullif(p_notice->>'id','') is null then
  insert into public.website_notices(slug,category,status,published_at,cover_image,pinned,template,source_locale,updated_at)
  values(p_notice->>'slug',p_notice->>'category',p_notice->>'status',(p_notice->>'published_at')::timestamptz,nullif(p_notice->>'cover_image',''),coalesce((p_notice->>'pinned')::boolean,false),p_notice->>'template',source,stamp) returning id into target;
 else
  target:=(p_notice->>'id')::uuid;
  update public.website_notices set category=p_notice->>'category',status=p_notice->>'status',published_at=(p_notice->>'published_at')::timestamptz,cover_image=nullif(p_notice->>'cover_image',''),pinned=(p_notice->>'pinned')::boolean,template=p_notice->>'template',source_locale=source,updated_at=stamp
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
