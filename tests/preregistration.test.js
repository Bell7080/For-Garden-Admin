import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const FP = "a".repeat(64);
async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema private;
   create function private.admin_can(r text[]) returns boolean language sql as $$
     select coalesce(current_setting('test.role',true),'owner') = any(r) $$;
   create table public.admin_audit_log(id bigint generated always as identity, action text, target text, detail jsonb);
   create function private.audit(p_action text, p_target text, p_detail jsonb default '{}'::jsonb) returns void language sql as $$
     insert into public.admin_audit_log(action, target, detail) values (p_action, p_target, p_detail) $$;
   create table public.website_preregistrations (id uuid primary key default gen_random_uuid(),email text not null unique,platform text not null check(platform in ('android','ios','both')),locale text not null check(locale in ('ko','en','ja')),consent_version text not null default 'launch-notification-v1',consented_at timestamptz not null default now(),created_at timestamptz not null default now());
   create table public.website_registration_limits (fingerprint text not null,bucket timestamptz not null,attempts integer not null default 1,primary key(fingerprint,bucket));
   insert into public.website_preregistrations(email, platform, locale) values ('old@example.com', 'android', 'ko');`);
  await db.exec(await readFile(new URL("../supabase/migrations/20261124000000_preregistration_phone.sql", import.meta.url), "utf8"));
  return db;
}
const one = async (db, sql, params) => Object.values((await db.query(sql, params)).rows[0])[0];
const reg = (db, email, phone, marketing = true, fp = FP, source = null) =>
  one(db, `select public.register_website_interest_v2($1, $2, 'both', 'ko', $3, $4, $5, 'preregistration-v2')`, [email, phone, fp, marketing, source]);

test("이메일·번호 각각 접수하고 같은 이메일·번호는 중복으로 돌려준다", async () => {
  const db = await setup();
  assert.equal(await reg(db, "A@Example.com", null, false), "accepted");
  assert.equal(await reg(db, null, "+821012345678", true, "b".repeat(64), "gstar"), "accepted");
  assert.equal(await reg(db, "a@example.com", null, false, "c".repeat(64)), "duplicate");
  assert.equal(await reg(db, "new@example.com", "+821012345678", true, "d".repeat(64)), "duplicate");
  assert.equal(await reg(db, "OLD@example.com", null, false, "e".repeat(64)), "duplicate");
  // 중복이면 기존 행을 바꾸지 않는다.
  assert.equal(await one(db, `select count(*)::int from public.website_preregistrations where email = 'new@example.com'`), 0);
  const row = (await db.query(`select age_confirmed, marketing_consent, marketing_consented_at is not null as at, source from public.website_preregistrations where phone = '+821012345678'`)).rows[0];
  assert.deepEqual(row, { age_confirmed: true, marketing_consent: true, at: true, source: "gstar" });
});

test("광고 수신 동의 없는 번호·연락처 없음·잘못된 번호는 거부한다", async () => {
  const db = await setup();
  await assert.rejects(reg(db, null, "+821011112222", false));
  await assert.rejects(reg(db, null, null));
  await assert.rejects(reg(db, null, "01011112222"));
  await assert.rejects(reg(db, "x@example.com", null, false, FP, "Bad Source"));
});

test("같은 지문은 한 시간에 다섯 번까지", async () => {
  const db = await setup();
  for (let i = 0; i < 5; i++) assert.equal(await reg(db, `r${i}@example.com`, null, false), "accepted");
  assert.equal(await reg(db, "r9@example.com", null, false), "rate_limited");
});

test("운영 콘솔: 통계·가린 목록·내보내기·삭제와 권한", async () => {
  const db = await setup();
  await reg(db, "researcher@example.com", "+821098765432", true, "b".repeat(64), "gstar");
  const stats = await one(db, `select public.admin_preregistration_stats()`);
  assert.equal(stats.total, 2);
  assert.equal(stats.phone, 1);
  assert.equal(stats.both, 1);
  assert.equal(stats.source.gstar, 1);
  const full = await one(db, `select public.admin_preregistrations('010-9876', 'all', null, 100)`);
  assert.equal(full.rows.length, 1);
  assert.equal(full.rows[0].phone, "+821098765432");
  await db.exec(`set test.role = 'cs'`);
  const masked = await one(db, `select public.admin_preregistrations(null, 'phone', null, 100)`);
  assert.equal(masked.masked, true);
  assert.equal(masked.rows[0].email, "re********@example.com");
  assert.equal(masked.rows[0].phone, "+8210****5432");
  await assert.rejects(db.query(`select public.admin_export_preregistrations('all')`));
  await assert.rejects(db.query(`select public.admin_delete_preregistration('${full.rows[0].id}', '철회')`));
  await db.exec(`set test.role = 'viewer'`);
  await assert.rejects(db.query(`select public.admin_preregistrations(null, 'all', null, 100)`));
  assert.equal((await one(db, `select public.admin_preregistration_stats()`)).total, 2);
  await db.exec(`set test.role = 'owner'`);
  const exported = await one(db, `select public.admin_export_preregistrations('phone')`);
  assert.equal(exported.length, 1);
  await assert.rejects(db.query(`select public.admin_delete_preregistration('${full.rows[0].id}', '')`));
  await db.query(`select public.admin_delete_preregistration('${full.rows[0].id}', '본인 철회 요청')`);
  assert.equal(await one(db, `select count(*)::int from public.website_preregistrations`), 1);
  const audit = (await db.query(`select action, detail from public.admin_audit_log order by id`)).rows;
  assert.deepEqual(audit.map((a) => a.action), ["prereg_export", "prereg_delete"]);
  assert.equal(audit[1].detail.phone, "+8210****5432");
});
