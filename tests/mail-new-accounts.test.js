import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

test("전체 우편: 신규 가입 계정 포함 옵션은 우편별로 수신 조건을 가른다", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema private;create schema auth;create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
      create table public.players(id uuid primary key, created_at timestamptz not null);
      create table public.mails(id uuid primary key default gen_random_uuid(), title text, body text, rewards jsonb default '[]', target_player uuid,
        status text not null default 'active', starts_at timestamptz not null, expires_at timestamptz not null, created_by uuid, deleted_at timestamptz);
      create table public.mail_claims(mail_id uuid, player_id uuid, primary key(mail_id, player_id));
      create table public.player_adjustments(id uuid primary key, player_id uuid, created_at timestamptz, applied_at timestamptz, asset text, delta bigint, note text, created_by uuid);
      create table public.asset_ledger(player_id uuid, asset text, delta bigint, balance_after bigint, reason text, ref text, note text, actor uuid);
      create function private.admin_can(text[]) returns boolean language sql as $$ select true $$;
      create function private.valid_rewards(jsonb) returns boolean language sql as $$ select true $$;
      create function private.audit(text, text, jsonb) returns void language sql as $$ select $$;
      create function private.is_restricted(public.players) returns boolean language sql as $$ select false $$;
      create function private.grant_rewards(uuid, jsonb, text, text) returns void language sql as $$ select $$;`);
    await db.exec(await readFile(new URL("../supabase/migrations/20261025000000_mail_include_new_accounts.sql", import.meta.url), "utf8"));
    const old = "00000000-0000-0000-0000-000000000001";
    const fresh = "00000000-0000-0000-0000-000000000002";
    await db.exec(`insert into public.players values ('${old}', now() - interval '3 days'), ('${fresh}', now() + interval '0 seconds');`);
    await db.exec(`select public.admin_send_mail('기존만', 'b', '[]', null, now() - interval '1 day', now() + interval '1 day');
      select public.admin_send_mail('신규포함', 'b', '[]', null, now() - interval '1 day', now() + interval '1 day', true);
      select public.admin_send_mail('지정', 'b', '[]', '${old}', now() - interval '1 day', now() + interval '1 day', true);`);
    const titles = async (id) => (await db.query(`select (m->>'title') t from jsonb_array_elements(public.server_ops_inbox('${id}')->'mails') m order by 1`)).rows.map((r) => r.t);
    assert.deepEqual(await titles(old), ["기존만", "신규포함", "지정"]);
    assert.deepEqual(await titles(fresh), ["신규포함"]);
    const flag = (await db.query(`select title, include_new_accounts from public.mails order by title`)).rows;
    assert.equal(flag.find((r) => r.title === "지정").include_new_accounts, false);
  } finally {
    await db.close();
  }
});
