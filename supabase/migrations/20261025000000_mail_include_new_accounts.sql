-- 전체 우편: 발송 이후 기간 안에 새로 만들어진 계정도 받게 할지 우편마다 고른다.
-- 기본(false)은 기존 동작 — 우편이 시작되기 전에 만들어진 계정만 받는다.
alter table public.mails add column if not exists include_new_accounts boolean not null default false;

-- 받을 수 있는 우편의 조건을 한 곳에서 판정한다(목록·수령·게임 서버 수신함이 모두 같은 규칙을 읽는다).
create or replace function private.mail_visible_to(m public.mails, p_player uuid, p_created timestamptz)
returns boolean language sql immutable set search_path = '' as $$
  select m.status = 'active' and m.deleted_at is null and m.starts_at <= now() and m.expires_at > now()
    and (m.target_player = p_player
         or (m.target_player is null and (m.include_new_accounts or m.starts_at >= p_created)));
$$;
revoke all on function private.mail_visible_to(public.mails, uuid, timestamptz) from public, anon, authenticated;
grant execute on function private.mail_visible_to(public.mails, uuid, timestamptz) to service_role;

create or replace function public.list_my_mails()
returns jsonb language sql stable security definer set search_path = '' as $fn$
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title, 'body', m.body, 'rewards', m.rewards,
    'sent_at', m.starts_at, 'expires_at', m.expires_at, 'claimed', c.mail_id is not null) order by m.starts_at desc), '[]'::jsonb)
  from (
    select mm.* from public.mails mm
    where private.mail_visible_to(mm, (select auth.uid()), (select pl.created_at from public.players pl where pl.id = (select auth.uid())))
    order by mm.starts_at desc limit 100
  ) m
  left join public.mail_claims c on c.mail_id = m.id and c.player_id = (select auth.uid());
$fn$;

create or replace function public.claim_mail(p_mail_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare me uuid := (select auth.uid()); p public.players; m public.mails;
begin
  if me is null then raise exception 'not_authenticated' using errcode = '28000'; end if;
  select * into p from public.players where id = me for update;
  if not found then return jsonb_build_object('ok', false, 'error', 'no_player'); end if;
  if private.is_restricted(p) then return jsonb_build_object('ok', false, 'error', 'account_restricted'); end if;
  select * into m from public.mails mm where mm.id = p_mail_id and private.mail_visible_to(mm, me, p.created_at);
  if not found then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  insert into public.mail_claims(mail_id, player_id) values (m.id, me) on conflict do nothing;
  if not found then return jsonb_build_object('ok', false, 'error', 'already_claimed'); end if;
  perform private.grant_rewards(me, m.rewards, 'mail', m.id::text);
  return jsonb_build_object('ok', true, 'rewards', m.rewards);
end $fn$;

create or replace function public.server_ops_inbox(p_player uuid)
returns jsonb language plpgsql security definer set search_path = '' stable as $$
declare created timestamptz;
begin
  select created_at into created from public.players where id = p_player;
  if created is null then return jsonb_build_object('mails', '[]'::jsonb, 'adjustments', '[]'::jsonb); end if;
  return jsonb_build_object(
    'mails', coalesce((select jsonb_agg(jsonb_build_object('id', m.id, 'title', m.title, 'body', m.body, 'rewards', m.rewards,
        'sentAt', m.starts_at, 'expiresAt', m.expires_at) order by m.starts_at desc)
      from (select mm.* from public.mails mm
            where private.mail_visible_to(mm, p_player, created)
            order by mm.starts_at desc limit 50) m), '[]'::jsonb),
    'adjustments', coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'asset', a.asset, 'delta', a.delta, 'note', a.note, 'createdAt', a.created_at) order by a.created_at)
      from (select * from public.player_adjustments where player_id = p_player and applied_at is null order by created_at limit 50) a), '[]'::jsonb));
end $$;

-- 서버 수신함이 수령 처리할 우편도 같은 조건으로만 인정한다(보이지 않는 우편을 수령 처리하지 못하게).
create or replace function public.server_ops_ack(p_player uuid, p_applied jsonb, p_claimed_mails uuid[])
returns void language plpgsql security definer set search_path = '' as $$
declare e jsonb; adj public.player_adjustments; created timestamptz;
begin
  select created_at into created from public.players where id = p_player;
  for e in select value from jsonb_array_elements(coalesce(p_applied, '[]'::jsonb)) loop
    update public.player_adjustments set applied_at = now() where id = (e->>'id')::uuid and player_id = p_player and applied_at is null returning * into adj;
    if found then
      insert into public.asset_ledger(player_id, asset, delta, balance_after, reason, ref, note, actor)
      values (p_player, adj.asset, coalesce((e->>'applied')::bigint, 0), coalesce((e->>'balance')::bigint, 0), 'admin_adjust', adj.id::text, adj.note, adj.created_by);
    end if;
  end loop;
  insert into public.mail_claims(mail_id, player_id)
    select m.id, p_player from public.mails m
    where m.id = any(coalesce(p_claimed_mails, '{}'::uuid[])) and created is not null
      and (m.target_player = p_player or m.target_player is null)
    on conflict do nothing;
end $$;

drop function if exists public.admin_send_mail(text, text, jsonb, uuid, timestamptz, timestamptz);
create or replace function public.admin_send_mail(p_title text, p_body text, p_rewards jsonb default '[]'::jsonb,
  p_target uuid default null, p_starts timestamptz default null, p_expires timestamptz default null,
  p_include_new boolean default false)
returns jsonb language plpgsql security definer set search_path = '' as $fn$
declare mid uuid; inc boolean := coalesce(p_include_new, false) and p_target is null;
begin
  if not private.admin_can(array['owner','operator']) then raise exception 'forbidden' using errcode = '42501'; end if;
  if not private.valid_rewards(p_rewards) then raise exception 'invalid_rewards'; end if;
  if p_target is not null and not exists (select 1 from public.players where id = p_target) then raise exception 'player_not_found'; end if;
  insert into public.mails(title, body, rewards, target_player, starts_at, expires_at, created_by, include_new_accounts)
  values (trim(p_title), trim(p_body), p_rewards, p_target, coalesce(p_starts, now()), coalesce(p_expires, coalesce(p_starts, now()) + interval '30 days'), (select auth.uid()), inc)
  returning id into mid;
  perform private.audit('mail_send', 'mails:' || mid, jsonb_build_object('title', p_title, 'target', p_target, 'rewards', p_rewards, 'includeNewAccounts', inc));
  return jsonb_build_object('ok', true, 'id', mid);
end $fn$;

revoke all on function public.admin_send_mail(text, text, jsonb, uuid, timestamptz, timestamptz, boolean) from public, anon, authenticated;
grant execute on function public.admin_send_mail(text, text, jsonb, uuid, timestamptz, timestamptz, boolean) to authenticated;
