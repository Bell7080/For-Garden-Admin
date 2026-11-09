import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const P = (n) => `00000000-0000-0000-0000-00000000000${n}`;
const save = (steps, stages) => JSON.stringify({ tutorial: { completedStepIds: steps }, clearedStageIds: stages });

async function setup({ withEvents = true } = {}) {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema private;
   create function private.admin_can(r text[]) returns boolean language sql as $$
     select case coalesce(current_setting('test.role',true),'owner') when 'none' then false else coalesce(current_setting('test.role',true),'owner') = any(r) end $$;
   create table public.players(id uuid primary key, status text not null default 'active', created_at timestamptz not null default now(), last_seen_at timestamptz);
   create table public.player_saves(player_id uuid primary key, data jsonb);
   create table public.player_daily_activity(day date, player_id uuid, primary key(day, player_id));
   create table public.purchase_records(transaction_id text primary key, player_id uuid, product_id text, recorded_at timestamptz default now(), refunded_at timestamptz);`);
  if (withEvents) {
    await db.exec(`create table public.game_events(id bigint generated always as identity, player_id uuid, kind text, detail text, amount int, method text, created_at timestamptz default now());
     create table public.game_call_daily(day date, method text, calls bigint, primary key(day, method));`);
  }
  await db.exec(await readFile(new URL("../supabase/migrations/20261122100000_ops_analytics.sql", import.meta.url), "utf8"));
  // 1: 튜토리얼·1-10까지, 결제 · 2: 1-5에서 멈추고 떠남 · 3: 아무것도 안 함, 떠남 · 4: 삭제 계정(빠진다)
  await db.exec(`insert into public.players(id, status, created_at, last_seen_at) values
    ('${P(1)}', 'active', now() - interval '10 days', now()),
    ('${P(2)}', 'active', now() - interval '10 days', now() - interval '5 days'),
    ('${P(3)}', 'active', now() - interval '10 days', now() - interval '9 days'),
    ('${P(4)}', 'deleted', now() - interval '10 days', null);
   insert into public.player_saves values
    ('${P(1)}', '${save(["ultimate", "pull"], ["1-1", "1-5", "1-10"])}'),
    ('${P(2)}', '${save(["ultimate"], ["1-1", "1-4", "1-5", "normal:1-1", "1-8-side-battle"])}'),
    ('${P(3)}', '${save([], [])}');
   insert into public.player_daily_activity
     select ((p.created_at at time zone 'Asia/Seoul')::date + 1), p.id from public.players p where p.id in ('${P(1)}', '${P(2)}');
   insert into public.player_daily_activity
     select ((p.created_at at time zone 'Asia/Seoul')::date + 7), p.id from public.players p where p.id = '${P(1)}';
   insert into public.purchase_records(transaction_id, player_id, product_id, recorded_at) values
     ('t1', '${P(1)}', 'starter', now() - interval '3 days'), ('t2', '${P(1)}', 'gems-big', now());`);
  if (withEvents) {
    await db.exec(`insert into public.game_call_daily values ((now() at time zone 'Asia/Seoul')::date, 'resolveStage', 7), ((now() at time zone 'Asia/Seoul')::date - 20, 'old', 99);
     insert into public.game_events(player_id, kind, detail, amount) values ('${P(1)}', 'research', 'pullRelics', 10), ('${P(2)}', 'research', 'pullRelics', 1);`);
  }
  return db;
}
const one = async (db, sql) => Object.values((await db.query(sql)).rows[0])[0];

test("퍼널은 지금 저장에서 세고 삭제 계정은 빠진다", async () => {
  const db = await setup();
  const r = await one(db, `select public.admin_analytics(30)`);
  assert.deepEqual(r.funnel, { days: 30, signups: 3, tutorial: 1, stage1_5: 2, stage1_10: 1, stage2_10: 0, firstPurchase: 1 });
  assert.deepEqual(r.retention.d1, { cohort: 3, returned: 2 });
  assert.deepEqual(r.retention.d7, { cohort: 3, returned: 1 });
  // 30일째가 아직 오지 않은 가입자는 분모에 들지 않는다.
  assert.deepEqual(r.retention.d30, { cohort: 0, returned: 0 });
});

test("떠난 계정의 마지막 본편 관문을 세고 곁가지·난이도 키는 무시한다", async () => {
  const db = await setup();
  const r = await one(db, `select public.admin_analytics(30)`);
  assert.deepEqual(r.dropoff, [{ stage: "1-5", players: 1 }, { stage: "없음", players: 1 }]);
});

test("첫 결제 상품·최근 7일 호출·연구 횟수를 돌려준다", async () => {
  const db = await setup();
  const r = await one(db, `select public.admin_analytics(30)`);
  assert.deepEqual(r.firstPurchases, [{ product: "starter", players: 1 }]);
  assert.deepEqual(r.calls, [{ method: "resolveStage", calls: 7 }]);
  assert.deepEqual(r.research7d, { pulls: 11, players: 2 });
});

test("게임 계측 마이그레이션 전에도 퍼널은 돌고, 권한 없는 계정은 막힌다", async () => {
  const db = await setup({ withEvents: false });
  const r = await one(db, `select public.admin_analytics(30)`);
  assert.equal(r.funnel.signups, 3);
  assert.deepEqual(r.calls, []);
  assert.equal(r.research7d, null);
  await db.exec(`set test.role = 'none'`);
  await assert.rejects(db.query(`select public.admin_analytics(30)`), /forbidden/);
});
