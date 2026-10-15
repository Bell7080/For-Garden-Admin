begin;
create table public.website_translation_usage(
 provider text not null check(provider='azure'),month_bucket date not null,
 characters bigint not null check(characters>=0),primary key(provider,month_bucket)
);
alter table public.website_translation_usage enable row level security;
revoke all on public.website_translation_usage from public,anon,authenticated;
grant all on public.website_translation_usage to service_role;
create function public.reserve_translation_characters(p_provider text,p_characters integer,p_limit integer) returns text
language plpgsql security definer set search_path='' as $$
declare bucket date:=(date_trunc('month',now() at time zone 'UTC'))::date; used bigint;
begin
 if p_provider<>'azure' or p_characters<1 or p_limit<1 or p_limit>2000000 then raise exception 'invalid_translation_budget'; end if;
 if p_characters>p_limit then return 'quota'; end if;
 insert into public.website_translation_usage(provider,month_bucket,characters) values(p_provider,bucket,p_characters)
 on conflict(provider,month_bucket) do update set characters=public.website_translation_usage.characters+p_characters
 where public.website_translation_usage.characters+p_characters<=p_limit returning characters into used;
 if not found then return 'quota'; end if;
 return 'reserved';
end; $$;
revoke all on function public.reserve_translation_characters(text,integer,integer) from public,anon,authenticated;
grant execute on function public.reserve_translation_characters(text,integer,integer) to service_role;
commit;
