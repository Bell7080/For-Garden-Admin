import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const ME = "00000000-0000-0000-0000-0000000000aa";
const P1 = "00000000-0000-0000-0000-000000000001";
const P2 = "00000000-0000-0000-0000-000000000002";
const P3 = "00000000-0000-0000-0000-000000000003";
const P4 = "00000000-0000-0000-0000-000000000004";

async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema private;create schema auth;
   create function auth.uid() returns uuid language sql as $$ select '${ME}'::uuid $$;
   create function private.admin_can(r text[]) returns boolean language sql as $$
     select case coalesce(current_setting('test.role',true),'owner') when 'none' then false else coalesce(current_setting('test.role',true),'owner') = any(r) end $$;
   create function private.valid_rewards(p jsonb) returns boolean language sql as $$ select jsonb_typeof(p) = 'array' $$;
   create table auth.users(id uuid primary key, email text);
   insert into auth.users values ('${ME}', 'ops@example.com');
   create table public.admin_audit_log(id bigint generated always as identity primary key, actor uuid, action text, target text, detail jsonb, at timestamptz default now());
   create function private.audit(p_action text, p_target text, p_detail jsonb default '{}') returns void language sql as $$
     insert into public.admin_audit_log(actor, action, target, detail) values (auth.uid(), p_action, p_target, p_detail) $$;
   create table public.players(id uuid primary key, uid bigint unique, nickname text, status text not null default 'active', level int,
     created_at timestamptz not null default now(), last_seen_at timestamptz);
   insert into public.players(id, uid, nickname, level, created_at, last_seen_at, status) values
     ('${P1}', 100000001, '하나', 5, now() - interval '40 days', now() - interval '1 hour', 'active'),
     ('${P2}', 100000002, '둘', 30, now() - interval '40 days', now() - interval '20 days', 'active'),
     ('${P3}', 100000003, '셋', 30, now() - interval '2 days', now() - interval '1 day', 'suspended'),
     ('${P4}', 100000004, '넷', 40, now() - interval '2 days', now(), 'banned');
   create table public.mails(id uuid primary key default gen_random_uuid(), title text, body text, rewards jsonb, target_player uuid,
     starts_at timestamptz, expires_at timestamptz, created_by uuid, include_new_accounts boolean);
   create table public.currency_log(id bigint generated always as identity, player_id uuid, asset text, delta bigint, balance_after bigint, source text, request_id text, created_at timestamptz default now());
   create table public.player_adjustments(id uuid primary key default gen_random_uuid(), player_id uuid, asset text, delta bigint, note text, created_by uuid, created_at timestamptz default now(), applied_at timestamptz);
   create table public.client_errors(id bigint generated always as identity primary key, code text, message text, occurrences int, affected_players int, status text default 'open',
     first_seen timestamptz default now(), last_seen timestamptz default now());
   create table public.purchase_records(transaction_id text primary key, player_id uuid, refunded_at timestamptz);
   create table public.support_tickets(id uuid primary key default gen_random_uuid(), ticket_no bigint generated always as identity, subject text, status text default 'open',
     player_id uuid, reported_uid bigint, created_at timestamptz default now(), deleted_at timestamptz);`);
  await db.exec(await readFile(new URL("../supabase/migrations/20261121000000_ops_console_v4.sql", import.meta.url), "utf8"));
  return db;
}
const json = async (db, sql, params) => Object.values((await db.query(sql, params)).rows[0])[0];
const rejects = (p, code) => assert.rejects(p, (e) => String(e.message).includes(code));

test("대상 우편은 조건에 맞는 활성 계정에만 한 통씩 가고, 영구 제한 계정은 늘 빠진다", async () => {
  const db = await setup();
  const seg = { levelMin: 20 };
  assert.equal((await json(db, `select public.admin_mail_segment_preview($1::jsonb)`, [JSON.stringify(seg)])).count, 1);
  const withSuspended = await json(db, `select public.admin_mail_segment_preview($1::jsonb)`, [JSON.stringify({ ...seg, includeSuspended: true })]);
  assert.equal(withSuspended.count, 2);
  const r = await json(db, `select public.admin_send_mail_segment($1::jsonb, '복귀 선물', '어서 와요', '[]'::jsonb)`, [JSON.stringify({ inactiveDays: 14 })]);
  assert.equal(r.sent, 1);
  const mails = (await db.query(`select target_player from public.mails`)).rows;
  assert.deepEqual(mails.map((m) => m.target_player), [P2]);
  const audit = (await db.query(`select action, detail from public.admin_audit_log`)).rows;
  assert.equal(audit[0].action, "mail_send_segment");
  assert.deepEqual(audit[0].detail.segment, { inactiveDays: 14 });
});

test("대상 우편 조건이 비었거나 틀리면 거절하고, 아무도 없으면 보내지 않는다", async () => {
  const db = await setup();
  await rejects(db.query(`select public.admin_mail_segment_preview('{}'::jsonb)`), "invalid_segment");
  await rejects(db.query(`select public.admin_mail_segment_preview('{"levelMin":30,"levelMax":10}'::jsonb)`), "invalid_segment");
  await rejects(db.query(`select public.admin_mail_segment_preview('{"activeWithinDays":3,"inactiveDays":3}'::jsonb)`), "invalid_segment");
  await rejects(db.query(`select public.admin_mail_segment_preview('{"country":"KR"}'::jsonb)`), "invalid_segment");
  await rejects(db.query(`select public.admin_send_mail_segment('{"levelMin":900}'::jsonb, '제목', '', '[]'::jsonb)`), "segment_empty");
  await db.exec(`set test.role = 'cs'`);
  await rejects(db.query(`select public.admin_send_mail_segment('{"levelMin":1}'::jsonb, '제목', '', '[]'::jsonb)`), "forbidden");
});

test("이상 징후는 하루 획득 급증·큰 수동 조정·오류 확산·환불 급증을 잡고, 확인하면 숨긴다", async () => {
  const db = await setup();
  await db.exec(`insert into public.currency_log(player_id, asset, delta, source) values ('${P1}', 'gems', 30000, 'claimMail'), ('${P1}', 'gems', 25000, 'completeStage'), ('${P2}', 'gems', 100, 'completeStage');
    insert into public.player_adjustments(player_id, asset, delta, note, created_by) values ('${P2}', 'gold', 5000000, '보상 정정', '${ME}'), ('${P2}', 'gold', 100, '소액', '${ME}');
    insert into public.client_errors(code, message, occurrences, affected_players) values ('E1', '새 오류', 10, 4), ('E2', '조용한 오류', 2, 1), ('E3', '터지는 오류', 900, 2);
    insert into public.purchase_records(transaction_id, player_id, refunded_at) select 'tx' || g, '${P1}', now() from generate_series(1, 5) g;`);
  const a = await json(db, `select public.admin_anomalies()`);
  const kinds = a.items.map((i) => `${i.kind}:${i.asset ?? i.code ?? ""}`).sort();
  assert.deepEqual(kinds, ["adjust:gold", "error_hot:E3", "error_new:E1", "gain:gems", "refund:"].sort());
  const gain = a.items.find((i) => i.kind === "gain");
  assert.equal(Number(gain.amount), 55000);
  assert.equal(gain.uid, 100000001);
  assert.equal(gain.sources[0].source, "claimMail");
  assert.equal(a.items.find((i) => i.kind === "adjust").actor, "ops@example.com");

  await json(db, `select public.admin_ack_anomaly($1, '이벤트 보상')`, [gain.key]);
  const after = await json(db, `select public.admin_anomalies()`);
  assert.equal(after.items.some((i) => i.key === gain.key), false);
  const all = await json(db, `select public.admin_anomalies(true)`);
  assert.equal(all.items.find((i) => i.key === gain.key).acked, true);
});

test("이상 징후 문턱은 소유자만 바꾸고 감사 로그에 남긴다", async () => {
  const db = await setup();
  await db.exec(`insert into public.currency_log(player_id, asset, delta, source) values ('${P1}', 'gold', 1000000, 'completeStage')`);
  assert.equal((await json(db, `select public.admin_anomalies()`)).items.length, 0);
  await json(db, `select public.admin_set_anomaly_rule('gain:gold', 500000)`);
  assert.equal((await json(db, `select public.admin_anomalies()`)).items.length, 1);
  await rejects(db.query(`select public.admin_set_anomaly_rule('drop table', 1)`), "invalid_rule");
  await db.exec(`set test.role = 'operator'`);
  await rejects(db.query(`select public.admin_set_anomaly_rule('gain:gold', 1)`), "forbidden");
  const log = (await db.query(`select detail from public.admin_audit_log where action = 'anomaly_rule'`)).rows;
  assert.equal(Number(log[0].detail.to), 500000);
});

test("계정의 받은 신고 수는 지운 신고를 빼고 센다", async () => {
  const db = await setup();
  await db.exec(`insert into public.support_tickets(subject, player_id, reported_uid, status) values ('욕설', '${P2}', 100000001, 'open'), ('도배', '${P3}', 100000001, 'closed'), ('지움', '${P2}', 100000001, 'open');
    update public.support_tickets set deleted_at = now() where subject = '지움';`);
  const r = await json(db, `select public.admin_player_reports(100000001)`);
  assert.equal(Number(r.total), 2);
  assert.equal(Number(r.open), 1);
  assert.equal(Number(r.reporters), 2);
  assert.equal(r.recent.length, 2);
});
