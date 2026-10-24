import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema private;create schema auth;
   create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
   create function private.admin_can(text[]) returns boolean language sql as $$ select coalesce(current_setting('test.can_write',true),'yes')='yes' $$;
   create function private.audit(text,text,jsonb default '{}') returns void language sql as $$ select 1 $$;
   create function private.valid_rewards(jsonb) returns boolean language sql as $$ select jsonb_typeof($1)='array' $$;
   create table public.players(id uuid primary key default gen_random_uuid(), created_at timestamptz default now());
   create table public.mails(id uuid primary key default gen_random_uuid(),title text not null,body text not null,rewards jsonb not null default '[]',
     target_player uuid,status text not null default 'active',starts_at timestamptz not null default now(),
     expires_at timestamptz not null default (now()+interval '30 days'),created_by uuid,created_at timestamptz default now(),
     include_new_accounts boolean not null default false,deleted_at timestamptz,check(expires_at>starts_at));`);
  await db.exec(await readFile(new URL("../supabase/migrations/20261026000000_recurring_ops.sql", import.meta.url), "utf8"));
  return db;
}
const save = (db, p) => db.query("select public.admin_save_recurring_mail($1) r", [JSON.stringify(p)]).then((r) => r.rows[0].r);
const base = { slot: "lunch", name: "점심", title: "점심 보급", body: "점심 시간 보상입니다.", rewards: [{ asset: "stamina", amount: 60 }], send_time: "12:00", valid_hours: 6, days: [1, 2, 3, 4, 5, 6, 7] };

test("우편 무제한: expires_at 이 null 이면 계속 보이고, 만료 시각이 시작보다 빠르면 거절", async () => {
  const db = await setup();
  try {
    await db.query("select public.admin_send_mail('공지','본문','[]'::jsonb,null,now()-interval '1 year',null,false,true)");
    const { rows } = await db.query("select expires_at, private.mail_visible_to(m, gen_random_uuid(), now()-interval '2 years') v from public.mails m");
    assert.equal(rows[0].expires_at, null);
    assert.equal(rows[0].v, true);
    await assert.rejects(db.query("select public.admin_send_mail('x','y','[]'::jsonb,null,now(),now()-interval '1 day')"), /invalid_period/);
  } finally {
    await db.close();
  }
});

test("정기 우편: 시각 전·유예 후에는 보내지 않고, 하루 한 통만 보낸다", async () => {
  const db = await setup();
  try {
    const { id } = await save(db, base);
    const run = async (iso) => (await db.query("select private.run_recurring_mails($1::timestamptz) n", [iso])).rows[0].n;
    assert.equal(await run("2026-10-26T02:59:00Z"), 0, "11:59 KST 는 아직");
    assert.equal(await run("2026-10-26T03:00:30Z"), 1, "12:00 KST 에 발송");
    assert.equal(await run("2026-10-26T03:01:30Z"), 0, "같은 날 두 번째 점검은 중복 발송 없음");
    assert.equal(await run("2026-10-26T06:30:00Z"), 0, "유예 3시간을 넘기면 건너뛴다");
    const { rows } = await db.query("select starts_at, expires_at, fire_date from public.mails where recurring_id=$1", [id]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].starts_at.toISOString(), "2026-10-26T03:00:00.000Z");
    assert.equal(rows[0].expires_at.toISOString(), "2026-10-26T09:00:00.000Z");
    assert.equal(await run("2026-10-27T03:00:10Z"), 1, "다음 날 다시 발송");
  } finally {
    await db.close();
  }
});

test("정기 우편: 요일·기간·꺼짐·무제한·삭제", async () => {
  const db = await setup();
  try {
    const run = async (iso) => (await db.query("select private.run_recurring_mails($1::timestamptz) n", [iso])).rows[0].n;
    const wk = await save(db, { ...base, name: "평일", days: [1, 2, 3, 4, 5], valid_hours: null });
    assert.equal(await run("2026-10-24T03:00:10Z"), 0, "토요일은 평일 전용");
    assert.equal(await run("2026-10-26T03:00:10Z"), 1);
    assert.equal((await db.query("select expires_at from public.mails")).rows[0].expires_at, null, "valid_hours 가 없으면 무제한");
    await save(db, { ...base, id: wk.id, days: [1, 2, 3, 4, 5], valid_hours: null, active_until: "2026-10-26" });
    assert.equal(await run("2026-10-27T03:00:10Z"), 0, "활성 기간이 끝난 뒤에는 보내지 않는다");
    await save(db, { ...base, id: wk.id, enabled: false });
    assert.equal(await run("2026-10-28T03:00:10Z"), 0, "꺼진 우편은 보내지 않는다");
    await db.query("select public.admin_set_recurring_mail($1, null, true)", [wk.id]);
    assert.equal((await db.query("select count(*)::int c from public.recurring_mails where deleted_at is null")).rows[0].c, 0);
    await assert.rejects(save(db, { ...base, days: [] }));
    await db.exec("set test.can_write='no'");
    await assert.rejects(save(db, base), /forbidden/);
  } finally {
    await db.close();
  }
});

test("패치노트: 1.0.0 이전 버전과 잘못된 항목 거절, 같은 버전 중복 거절", async () => {
  const db = await setup();
  try {
    const sv = (p) => db.query("select public.admin_save_patch_note($1) r", [JSON.stringify(p)]);
    await sv({ version: "1.0.1", title: "첫 패치", items: [{ kind: "fix", text: "버그 수정" }] });
    await assert.rejects(sv({ version: "0.9.9", items: [] }), /before_launch/);
    await assert.rejects(sv({ version: "1.0.2", items: [{ kind: "wat", text: "x" }] }), /invalid_text/);
    await assert.rejects(sv({ version: "1.0.1", items: [] }), /duplicate|unique/);
  } finally {
    await db.close();
  }
});

test("정기 이벤트: 보상표 검증, 주 편성, 현재 주 조회, 편성 중 삭제 거절", async () => {
  const db = await setup();
  try {
    const sv = (p) => db.query("select public.admin_save_event_content($1) r", [JSON.stringify(p)]).then((r) => r.rows[0].r);
    const ev = { kind: "wheel", variant: 2, name: "행운의 돌림판 2", currency: "eventCoin", cost_per_play: 10, reward_table: [{ weight: 70, rewards: [{ asset: "gold", amount: 1000 }] }, { weight: 30, rewards: [{ asset: "gems", amount: 50 }] }] };
    const { id } = await sv(ev);
    await assert.rejects(sv({ ...ev, reward_table: [{ weight: 0, rewards: [] }] }), /invalid_rewards/);
    const monday = (await db.query("select date_trunc('week', (now() at time zone 'Asia/Seoul'))::date d")).rows[0].d;
    const iso = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, "0")}-${String(monday.getDate()).padStart(2, "0")}`;
    await assert.rejects(db.query("select public.admin_set_event_rotation($1)", [JSON.stringify([{ week_start: "2026-10-27", content_id: id }])]), /invalid_period/);
    await db.query("select public.admin_set_event_rotation($1)", [JSON.stringify([{ week_start: iso, content_id: id }])]);
    const cur = (await db.query("select public.get_regular_event() r")).rows[0].r;
    assert.equal(cur.name, "행운의 돌림판 2");
    assert.equal(cur.rewardTable.length, 2);
    await assert.rejects(db.query("select public.admin_delete_event_content($1)", [id]), /in_rotation/);
    await db.query("select public.admin_set_event_rotation($1)", [JSON.stringify([{ week_start: iso, content_id: null }])]);
    assert.equal((await db.query("select public.get_regular_event() r")).rows[0].r, null);
    await db.query("select public.admin_delete_event_content($1)", [id]);
  } finally {
    await db.close();
  }
});
