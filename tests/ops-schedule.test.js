import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const ME = "00000000-0000-0000-0000-0000000000aa";

// 게임 저장소(20261123000000_live_schedule.sql)의 표는 그 모양 그대로 옮겨 세운다.
async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema private;create schema auth;
   create function auth.uid() returns uuid language sql as $$ select '${ME}'::uuid $$;
   create function private.admin_can(r text[]) returns boolean language sql as $$
     select case coalesce(current_setting('test.role',true),'owner') when 'none' then false else coalesce(current_setting('test.role',true),'owner') = any(r) end $$;
   create table public.admin_audit_log(id bigint generated always as identity primary key, actor uuid, action text, target text, detail jsonb, at timestamptz default now());
   create function private.audit(p_action text, p_target text, p_detail jsonb default '{}') returns void language sql as $$
     insert into public.admin_audit_log(actor, action, target, detail) values (auth.uid(), p_action, p_target, p_detail) $$;
   create table public.live_schedule (kind text not null check (kind in ('banner', 'product', 'event', 'lobby')), id text not null check (char_length(id) between 1 and 96),
     starts_at timestamptz, ends_at timestamptz, enabled boolean not null default true, note text not null default '' check (char_length(note) <= 200),
     updated_at timestamptz not null default now(), updated_by uuid, primary key (kind, id), check (starts_at is null or ends_at is null or ends_at > starts_at));`);
  await db.exec(await readFile(new URL("../supabase/migrations/20261123100000_ops_schedule.sql", import.meta.url), "utf8"));
  return db;
}
const one = async (db, sql, params) => Object.values((await db.query(sql, params)).rows[0])[0];

test("일정을 넣고 고치고 지우며 감사 로그에 남긴다", async () => {
  const db = await setup();
  await one(db, `select public.admin_set_schedule($1)`, [{ kind: "banner", id: "amber", startsAt: "2026-11-10T00:00:00Z", endsAt: null, enabled: true, note: "앞당김" }]);
  await one(db, `select public.admin_set_schedule($1)`, [{ kind: "banner", id: "amber", startsAt: "", endsAt: "2026-12-01T00:00:00Z", enabled: false }]);
  const rows = await one(db, `select public.admin_list_schedule()`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].startsAt, null);
  assert.equal(rows[0].enabled, false);
  assert.equal(rows[0].note, "");
  await one(db, `select public.admin_clear_schedule('banner', 'amber')`);
  assert.deepEqual(await one(db, `select public.admin_list_schedule()`), []);
  const actions = (await db.query(`select action, target from public.admin_audit_log order by id`)).rows;
  assert.deepEqual(actions.map((r) => r.action), ["schedule_set", "schedule_set", "schedule_clear"]);
  assert.equal(actions[0].target, "live_schedule:banner:amber");
});

test("모르는 종류·빈 ID·거꾸로 된 기간을 거절하고, 조회 전용 권한은 고치지 못한다", async () => {
  const db = await setup();
  await assert.rejects(db.query(`select public.admin_set_schedule($1)`, [{ kind: "skin", id: "x" }]), /invalid_schedule_kind/);
  await assert.rejects(db.query(`select public.admin_set_schedule($1)`, [{ kind: "product", id: "  " }]), /invalid_schedule_id/);
  await assert.rejects(db.query(`select public.admin_set_schedule($1)`, [{ kind: "product", id: "x", startsAt: "2026-11-10T00:00:00Z", endsAt: "2026-11-09T00:00:00Z" }]), /invalid_period/);
  await assert.rejects(db.query(`select public.admin_clear_schedule('product', 'x')`), /schedule_not_found/);
  await db.exec(`set test.role = 'viewer'`);
  assert.deepEqual(await one(db, `select public.admin_list_schedule()`), []);
  await assert.rejects(db.query(`select public.admin_set_schedule($1)`, [{ kind: "product", id: "x" }]), /forbidden/);
});
