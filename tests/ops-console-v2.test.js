import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const ME = "00000000-0000-0000-0000-0000000000aa";
const OTHER = "00000000-0000-0000-0000-0000000000bb";

async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema private;create schema auth;
   create function auth.uid() returns uuid language sql as $$ select '${ME}'::uuid $$;
   create function private.admin_can(text[]) returns boolean language sql as $$ select coalesce(current_setting('test.can_write',true),'yes')='yes' $$;
   create table auth.users(id uuid primary key, email text, last_sign_in_at timestamptz);
   create table public.admin_roles(user_id uuid primary key, role text not null, created_at timestamptz not null default now());
   create table public.admin_audit_log(id bigint generated always as identity primary key, actor uuid, action text, target text, detail jsonb, at timestamptz default now());
   create function private.audit(p_action text, p_target text, p_detail jsonb default '{}') returns void language sql as $$
     insert into public.admin_audit_log(actor, action, target, detail) values (auth.uid(), p_action, p_target, p_detail) $$;
   create function private.valid_rewards(jsonb) returns boolean language sql as $$ select jsonb_typeof($1)='array' $$;
   create table public.players(id uuid primary key default gen_random_uuid(), uid bigint unique, nickname text, status text not null default 'active',
     created_at timestamptz not null default now(), last_seen_at timestamptz, app_version text, platform text);
   create table public.support_tickets(id uuid primary key default gen_random_uuid(), status text, category text, created_at timestamptz default now(), deleted_at timestamptz);
   create table public.app_config(id smallint primary key, maintenance boolean);
   insert into public.app_config values (1, false);
   create table public.coupons(id uuid primary key default gen_random_uuid(), status text, ends_at timestamptz, deleted_at timestamptz);
   create table public.mails(id uuid primary key default gen_random_uuid(),title text not null,body text not null,rewards jsonb not null default '[]',
     target_player uuid,status text not null default 'active',starts_at timestamptz not null default now(),
     expires_at timestamptz,created_by uuid,created_at timestamptz default now(),
     include_new_accounts boolean not null default false,deleted_at timestamptz);`);
  await db.exec(await readFile(new URL("../supabase/migrations/20261119000000_ops_console_v2.sql", import.meta.url), "utf8"));
  return db;
}

test("접속 시각이 바뀌면 그날 활성 한 줄이 생기고, 대시보드가 DAU·신규·D1 잔존을 센다", async () => {
  const db = await setup();
  try {
    // 어제 가입, 어제·오늘 접속 → 어제 코호트 D1 100%
    await db.exec(`insert into public.players(id, uid, created_at, last_seen_at, platform, app_version)
      values ('${OTHER}', 1, now() - interval '1 day', now() - interval '1 day', 'web', '0.400.0');`);
    await db.exec(`update public.players set last_seen_at = now() where id = '${OTHER}';`);
    await db.exec(`update public.players set last_seen_at = now() where id = '${OTHER}';`); // 같은 날 두 번은 한 줄
    await db.exec(`insert into public.players(uid, created_at) values (2, now());`); // 오늘 가입, 접속 없음
    await db.exec(`insert into public.support_tickets(status, category) values ('open','report'), ('closed','inquiry');`);
    const { rows } = await db.query("select public.admin_dashboard() d");
    const d = rows[0].d;
    assert.equal(d.players.total, 2);
    assert.equal(d.players.newToday, 1);
    assert.equal(d.players.dau, 1);
    assert.equal(d.series.length, 14);
    const yesterday = d.series[12];
    assert.equal(yesterday.new, 1);
    assert.equal(Number(yesterday.d1), 100);
    assert.equal(d.series[13].d1, null, "오늘 코호트는 다음 날이 오지 않아 잔존을 계산하지 않는다");
    assert.equal(d.support.open, 1);
    assert.equal(d.support.reports, 1);
    assert.equal(d.errors, null, "client_errors 표가 없으면 null");
    assert.deepEqual(d.platforms, { web: 1 });
  } finally {
    await db.close();
  }
});

test("권한 관리: 부여·변경·해제를 기록하고, 자기 자신과 마지막 소유자는 막는다", async () => {
  const db = await setup();
  try {
    await db.exec(`insert into auth.users values ('${ME}','me@x.io',now()), ('${OTHER}','Op@x.io',null);
      insert into public.admin_roles(user_id, role) values ('${ME}','owner');`);
    await db.query("select public.admin_set_staff_role('op@X.io','cs')");
    assert.equal((await db.query(`select role from public.admin_roles where user_id='${OTHER}'`)).rows[0].role, "cs");
    await db.query("select public.admin_set_staff_role('op@x.io','operator')");
    const staff = (await db.query("select * from public.admin_list_staff()")).rows;
    assert.deepEqual(staff.map((s) => s.role), ["owner", "operator"]);
    await assert.rejects(db.query("select public.admin_set_staff_role('me@x.io','viewer')"), /cannot_change_self/);
    await assert.rejects(db.query("select public.admin_set_staff_role('none@x.io','cs')"), /staff_user_not_found/);
    await db.query("select public.admin_set_staff_role('op@x.io',null)");
    assert.equal((await db.query("select count(*)::int n from public.admin_roles")).rows[0].n, 1);
    const log = (await db.query("select detail from public.admin_audit_log where action='staff_role' order by id")).rows;
    assert.deepEqual(log.map((l) => [l.detail.from, l.detail.to]), [[null, "cs"], ["cs", "operator"], ["operator", null]]);
    // 다른 소유자를 내리는 것은 소유자가 둘 이상일 때만
    await db.query("select public.admin_set_staff_role('op@x.io','owner')");
    await db.query("select public.admin_set_staff_role('op@x.io','cs')");
    await db.exec(`delete from public.admin_roles where user_id='${ME}'; update public.admin_roles set role='owner' where user_id='${OTHER}';`);
    await db.exec(`insert into public.admin_roles(user_id, role) values ('${ME}','operator');`);
    await assert.rejects(db.query("select public.admin_set_staff_role('op@x.io','viewer')"), /last_owner/);
    await db.exec("set test.can_write = 'no'");
    await assert.rejects(db.query("select * from public.admin_list_staff()"), /forbidden/);
  } finally {
    await db.close();
  }
});

test("UID 묶음 우편: 있는 계정마다 한 통, 없는 UID는 돌려주고, 상한·기간을 지킨다", async () => {
  const db = await setup();
  try {
    await db.exec(`insert into public.players(uid) values (10),(11); insert into public.players(uid, status) values (12,'deleted');`);
    const r = (await db.query("select public.admin_send_mail_many(array[10,11,12,99,10]::bigint[],'장애 보상','죄송합니다','[]'::jsonb) r")).rows[0].r;
    assert.equal(r.sent, 2);
    assert.deepEqual(r.missing.sort(), [12, 99]);
    assert.equal((await db.query("select count(*)::int n from public.mails where target_player is not null")).rows[0].n, 2);
    await assert.rejects(db.query("select public.admin_send_mail_many(array[]::bigint[],'x','y')"), /invalid_count/);
    await assert.rejects(db.query("select public.admin_send_mail_many(array[10]::bigint[],'x','y','[]',now(),now()-interval '1 day')"), /invalid_period/);
    await assert.rejects(db.query("select public.admin_send_mail_many(array[10]::bigint[],'','y')"), /invalid_text/);
  } finally {
    await db.close();
  }
});

test("제재 이력은 그 계정의 상태 변경·삭제·재화 조정만 담당자 이메일과 함께 돌려준다", async () => {
  const db = await setup();
  try {
    await db.exec(`insert into auth.users values ('${ME}','me@x.io',now());
      insert into public.admin_audit_log(actor, action, target, detail) values
        ('${ME}','player_status','players:${OTHER}','{"status":"suspended"}'),
        ('${ME}','mail_send','mails:1','{}'),
        ('${ME}','player_status','players:other','{}');`);
    const rows = (await db.query(`select * from public.admin_player_sanctions('${OTHER}')`)).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].actor_email, "me@x.io");
  } finally {
    await db.close();
  }
});

test("FAQ: 원문과 수동 원고만 저장하고, 형식이 틀린 원고는 거절한다", async () => {
  const db = await setup();
  try {
    const save = (p) => db.query("select public.admin_save_faq($1) r", [JSON.stringify(p)]).then((x) => x.rows[0].r);
    const { id } = await save({ category: "account", question: "계정 연동은?", answer: "설정에서 합니다.", published: true, translations: { en: { question: "Link?", answer: "In settings." } } });
    await save({ id, category: "account", question: "계정 연동은 어떻게 하나요?", answer: "설정 > 계정에서 합니다.", published: true, translations: {} });
    const row = (await db.query("select question, translations from public.website_faqs")).rows[0];
    assert.equal(row.question, "계정 연동은 어떻게 하나요?");
    assert.deepEqual(row.translations, {});
    await assert.rejects(save({ question: "q", answer: "a", translations: { en: { question: "" } } }), /invalid_text/);
    await assert.rejects(save({ question: "q", answer: "a", category: "nope" }), /check/);
    await db.query("select public.admin_delete_faq($1)", [id]);
    await assert.rejects(db.query("select public.admin_delete_faq($1)", [id]), /not_found/);
  } finally {
    await db.close();
  }
});
