import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema private;
   create function private.admin_can(text[]) returns boolean language sql as $$ select coalesce(current_setting('test.can_write',true),'yes')='yes' $$;
   create table public.player_saves(player_id uuid primary key, data jsonb not null, revision bigint not null default 0);
   create table public.player_adjustments(id uuid primary key default gen_random_uuid(), player_id uuid, asset text, delta bigint, applied_at timestamptz);
   create function public.server_commit_state(p_player uuid,p_expected_revision bigint,p_data jsonb,p_hash text,p_version integer,p_summary jsonb,p_method text,p_request text,p_response jsonb)
   returns jsonb language plpgsql as $$ begin
     insert into public.player_saves(player_id,data) values(p_player,p_data) on conflict(player_id) do update set data=excluded.data;
     return '{}'::jsonb; end $$;`);
  await db.exec(await readFile(new URL("../supabase/migrations/20261031000000_currency_log.sql", import.meta.url), "utf8"));
  return db;
}
const P = "11111111-1111-1111-1111-111111111111";
const commit = (db, wallet, method, req = null, player = P) =>
  db.query("select public.server_commit_state($1,null,$2::jsonb,'h',1,'{}'::jsonb,$3,$4,'{}'::jsonb)", [player, JSON.stringify({ wallet }), method, req]);
const log = async (db) => (await db.query("select asset,delta::int,balance_after::int,source,request_id from public.currency_log order by id")).rows;

test("지갑이 바뀐 만큼 출처(호출 이름)와 함께 획득·소모를 남긴다", async () => {
  const db = await setup();
  try {
    await commit(db, { gems: 100, gold: 0 }, "createAccount");
    await commit(db, { gems: 40, gold: 500 }, "pullRelics", "req-1");
    await commit(db, { gems: 40, gold: 500 }, "getMails");
    const rows = await log(db);
    assert.deepEqual(rows.filter((r) => r.source === "pullRelics").map((r) => [r.asset, r.delta, r.balance_after, r.request_id]).sort(),
      [["gems", -60, 40, "req-1"], ["gold", 500, 500, "req-1"]]);
    assert.equal(rows.filter((r) => r.source === "getMails").length, 0, "변화가 없으면 남기지 않는다");
    assert.equal(rows.find((r) => r.source === "createAccount" || r.source === "unknown")?.delta, 100);
  } finally { await db.close(); }
});

test("스테미나는 시간 회복을 남기지 않고 소모와 충전 계열만 남긴다", async () => {
  const db = await setup();
  try {
    await commit(db, { stamina: 50 }, "x");
    await db.query("delete from public.currency_log");
    await commit(db, { stamina: 60 }, "getPlayerState");
    await commit(db, { stamina: 50 }, "enterStage");
    await commit(db, { stamina: 110 }, "rechargeStamina");
    assert.deepEqual((await log(db)).map((r) => [r.source, r.delta]), [["enterStage", -10], ["rechargeStamina", 60]]);
  } finally { await db.close(); }
});

test("어드민 조정은 우편·조회 호출 안에서 반영돼도 admin_adjust 로 갈라 적는다", async () => {
  const db = await setup();
  try {
    await commit(db, { gems: 10 }, "x");
    await db.query("delete from public.currency_log");
    await db.query("insert into public.player_adjustments(player_id,asset,delta) values($1,'gems',300)", [P]);
    await commit(db, { gems: 360 }, "claimMailRewards");
    assert.deepEqual(await log(db), [
      { asset: "gems", delta: 300, balance_after: 310, source: "admin_adjust", request_id: null },
      { asset: "gems", delta: 50, balance_after: 360, source: "claimMailRewards", request_id: null },
    ]);
  } finally { await db.close(); }
});

test("조회: 획득/소모 필터, 큰 수량·단시간 급증 표시, 권한", async () => {
  const db = await setup();
  try {
    await commit(db, { gems: 0 }, "x");
    await commit(db, { gems: 4000 }, "purchaseProduct"); // 기준 3000 이상 → 큰 수량
    await commit(db, { gems: 3900 }, "pullRelics");
    const all = (await db.query("select public.admin_currency_log($1) r", [P])).rows[0].r;
    assert.equal(all.rows.length >= 2, true);
    const big = all.rows.find((r) => r.source === "purchaseProduct");
    assert.equal(big.big, true);
    const spend = (await db.query("select public.admin_currency_log($1,'spend') r", [P])).rows[0].r;
    assert.ok(spend.rows.every((r) => r.delta < 0));
    assert.equal(all.bigCount7d, 1);
    await db.exec("set test.can_write='no'");
    await assert.rejects(db.query("select public.admin_currency_log($1)", [P]), /forbidden/);
  } finally { await db.close(); }
});

test("다른 계정의 지갑이 바뀐 경우 출처에 other: 를 붙인다", async () => {
  const db = await setup();
  try {
    const Q = "22222222-2222-2222-2222-222222222222";
    await commit(db, { gems: 0 }, "x", null, Q);
    await db.query("delete from public.currency_log");
    await db.exec("select set_config('app.ledger_method','resolveDuel',false), set_config('app.ledger_actor','" + P + "',false)");
    await db.query("update public.player_saves set data = jsonb_set(data,'{wallet,gems}','25') where player_id = $1", [Q]);
    assert.deepEqual((await log(db)).map((r) => r.source), ["other:resolveDuel"]);
  } finally { await db.close(); }
});
