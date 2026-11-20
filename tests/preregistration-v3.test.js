import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// v2 위에 v3(휴대폰 필수 · 번호당 한 건 · 중복 의심)를 얹는다. 운영 DB에 적용하는 순서와 같다.
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
   insert into public.website_preregistrations(email, platform, locale) values ('Old.Mail+x@gmail.com', 'android', 'ko');`);
  for (const f of ["20261124000000_preregistration_phone.sql", "20261125000000_preregistration_phone_required.sql"])
    await db.exec(await readFile(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8"));
  return db;
}
const one = async (db, sql, params) => Object.values((await db.query(sql, params)).rows[0])[0];
let n = 0;
const fp = (c) => (c ?? (n++).toString(16)).padStart(64, "0");
const reg = (db, email, phone, marketing = false, f = fp(), source = null) =>
  one(db, `select public.register_website_interest_v3($1, $2, 'both', 'ko', $3, $4, $5, 'preregistration-v3')`, [email, phone, f, marketing, source]);

test("번호는 필수이고 번호 하나에 한 건, 광고 동의는 선택", async () => {
  const db = await setup();
  await assert.rejects(reg(db, "a@example.com", null));
  await assert.rejects(reg(db, "a@example.com", "01027418853"));
  assert.equal(await reg(db, null, "+821027418853"), "accepted");
  assert.equal(await reg(db, "b@example.com", "+821027418853"), "duplicate");
  assert.equal(await reg(db, "c@example.com", "+821058392047", true), "accepted");
  assert.equal(await reg(db, "c@example.com", "+821033334444"), "duplicate");
  const row = (await db.query(`select marketing_consent, email_canonical, fingerprint is not null as fp from public.website_preregistrations where phone = '+821027418853'`)).rows[0];
  assert.deepEqual(row, { marketing_consent: false, email_canonical: null, fp: true });
  // v3 동의로는 번호 없이 새 행을 넣을 수 없다. 예전 동의의 행은 고칠 수 있다(철회·정리).
  await assert.rejects(db.query(`insert into public.website_preregistrations(email, platform, locale, consent_version) values ('z@example.com','ios','ko','preregistration-v3')`));
  await db.query(`update public.website_preregistrations set locale = 'en' where phone is null`);
});

test("예전 이메일만의 신청에는 같은 이메일로 번호를 한 번 붙인다", async () => {
  const db = await setup();
  const before = await one(db, `select public.admin_preregistration_stats()`);
  assert.equal(before.counted, 0);
  assert.equal(before.legacyEmailOnly, 1);
  assert.equal(await reg(db, "old.mail+x@gmail.com", "+821044448888"), "accepted");
  assert.equal(await one(db, `select count(*)::int from public.website_preregistrations`), 1);
  assert.equal(await reg(db, "old.mail+x@gmail.com", "+821055559999"), "duplicate");
  const after = await one(db, `select public.admin_preregistration_stats()`);
  assert.equal(after.counted, 1);
  assert.equal(after.legacyEmailOnly, 0);
  assert.equal(await one(db, `select public.preregistration_public_count()`).catch(() => "none"), "none");
});

test("같은 접속지는 하루 10건까지", async () => {
  const db = await setup();
  const same = fp("ab");
  // 시간당 5회 제한을 피하려고 앞선 신청을 하루 안의 다른 시각으로 옮긴다.
  for (let i = 0; i < 10; i++) {
    assert.equal(await reg(db, null, `+82105000${String(1000 + i * 7)}`, false, same), "accepted");
    await db.exec(`delete from public.website_registration_limits`);
  }
  assert.equal(await reg(db, null, "+821060007777", false, same), "rate_limited");
});

test("중복 의심: 같은 접속지 · 별칭 메일 · 이어진 번호", async () => {
  const db = await setup();
  const same = fp("cd");
  for (const p of ["+821071230001", "+821071230002", "+821071230004"]) await reg(db, null, p, false, same);
  await reg(db, "o.ld.mail@gmail.com", "+821088886666");
  const s = await one(db, `select public.admin_preregistration_suspects()`);
  assert.equal(s.ip.length, 1);
  assert.equal(s.ip[0].n, 3);
  assert.equal(s.email.length, 1);
  assert.equal(s.email[0].n, 2);
  assert.equal(s.sequence.length, 1);
  assert.deepEqual(s.sequence[0].contacts, ["+8210****0001", "+8210****0002", "+8210****0004"]);
  const list = await one(db, `select public.admin_preregistrations(null, 'suspect', null, 100)`);
  assert.equal(list.rows.length, 5);
  assert.ok(list.rows.every((r) => r.sameIp >= 3 || r.sameEmail >= 2));
  const legacy = await one(db, `select public.admin_preregistrations(null, 'legacy', null, 100)`);
  assert.equal(legacy.rows.length, 1);
  await db.exec(`set test.role = 'viewer'`);
  assert.equal((await one(db, `select public.admin_preregistration_suspects()`)).ip[0].contacts[0], "+8210****0001");
  await db.exec(`set test.role = 'owner'`);
});

test("휴대폰 명단 내보내기는 광고 수신 동의자만", async () => {
  const db = await setup();
  await reg(db, null, "+821027418853", false);
  await reg(db, null, "+821058392047", true);
  const rows = await one(db, `select public.admin_export_preregistrations('phone')`);
  assert.deepEqual(rows.map((r) => r.phone), ["+821058392047"]);
});
