import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

// v2 → v3 → v4(이메일도 필수). 운영 DB에 적용하는 순서와 같다. 예전 이메일만의 행과 번호만의 행을 하나씩 둔다.
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
  for (const f of ["20261124000000_preregistration_phone.sql", "20261125000000_preregistration_phone_required.sql", "20261126000000_preregistration_email_required.sql"])
    await db.exec(await readFile(new URL(`../supabase/migrations/${f}`, import.meta.url), "utf8"));
  await db.exec(`insert into public.website_preregistrations(email, phone, platform, locale, consent_version) values (null, '+821077770000', 'ios', 'ko', 'preregistration-v2')`);
  return db;
}
const one = async (db, sql, params) => Object.values((await db.query(sql, params)).rows[0])[0];
let n = 0;
const fp = (c) => (c ?? (n++).toString(16)).padStart(64, "0");
const reg = (db, email, phone, marketing = false, f = fp(), source = null) =>
  one(db, `select public.register_website_interest_v3($1, $2, 'both', 'ko', $3, $4, $5, 'preregistration-v4')`, [email, phone, f, marketing, source]);


test("v4: 이메일과 번호 둘 다 필수, 하나씩 한 건", async () => {
  const db = await setup();
  await assert.rejects(reg(db, null, "+821027418853"));
  await assert.rejects(reg(db, "a@example.com", null));
  assert.equal(await reg(db, "a@example.com", "+821027418853"), "accepted");
  assert.equal(await reg(db, "a@example.com", "+821058392047"), "duplicate");
  assert.equal(await reg(db, "b@example.com", "+821027418853"), "duplicate");
  assert.equal(await reg(db, "A@Example.com", "+821027418853"), "duplicate");
  await assert.rejects(db.query(`insert into public.website_preregistrations(email, phone, platform, locale, consent_version) values (null, '+821011112222','ios','ko','preregistration-v4')`));
  await assert.rejects(db.query(`insert into public.website_preregistrations(email, platform, locale, consent_version) values ('z@example.com','ios','ko','preregistration-v4')`));
});

test("v4: 예전 한쪽만 적은 신청에는 빠진 연락처를 붙인다", async () => {
  const db = await setup();
  assert.equal(await one(db, `select count(*)::int from public.website_preregistrations`), 2);
  // 번호만 적었던 신청 + 새 이메일
  assert.equal(await reg(db, "phone.only@example.com", "+821077770000"), "accepted");
  // 이메일만 적었던 신청(대소문자 달라도) + 새 번호
  assert.equal(await reg(db, "old.mail+x@gmail.com", "+821044448888"), "accepted");
  assert.equal(await one(db, `select count(*)::int from public.website_preregistrations`), 2);
  assert.equal(await one(db, `select count(*)::int from public.website_preregistrations where email is not null and phone is not null and consent_version = 'preregistration-v4'`), 2);
  // 서로 다른 신청의 번호와 이메일을 섞으면 중복
  assert.equal(await reg(db, "phone.only@example.com", "+821044448888"), "duplicate");
  // 예전 행은 고칠 수 있다
  await db.query(`update public.website_preregistrations set locale = 'en'`);
});
