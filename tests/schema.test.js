import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
test("Postgres migration: atomic save, language expansion, stale-editor rejection, source validation and leases", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;
   create function public.is_admin() returns boolean language sql as $$ select true $$;
   create function public.admin_can(text[]) returns boolean language sql as $$ select coalesce(current_setting('test.can_write',true),'yes')='yes' $$;
   create table public.website_notices(id uuid primary key default gen_random_uuid(),slug text unique not null,category text not null,status text not null,published_at timestamptz not null,cover_image text,pinned boolean,template text,updated_at timestamptz default now());
   create table public.website_notice_translations(notice_id uuid references public.website_notices(id) on delete cascade,locale text check(locale in ('ko','en','ja')),title text check(length(title) between 1 and 200),summary text,body text check(length(body) between 1 and 50000),primary key(notice_id,locale));`);
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/20261016090000_notice_translation.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const fields = {
      slug: "test",
      category: "notice",
      status: "draft",
      published_at: "2026-10-16T10:00:00+09:00",
      template: "plain",
      pinned: false,
      source_locale: "th",
    };
    const translations = [
      { locale: "th", title: "ประกาศ", summary: "", body: "รายละเอียด" },
    ];
    const save = async (n, t, stamp = null) =>
      (
        await db.query("select public.save_website_notice($1,$2,$3) result", [
          JSON.stringify(n),
          JSON.stringify(t),
          stamp,
        ])
      ).rows[0].result;
    const created = await save(fields, translations);
    assert(created.id);
    for (const locale of [
      "zh-Hant",
      "zh-Hans",
      "vi",
      "id",
      "es",
      "pt-BR",
      "de",
      "ru",
    ])
      await db.query(
        "insert into website_notice_translations values($1,$2,$3,$4,$5)",
        [created.id, locale, "Title", "", "Body"],
      );
    const bad = [
      ...translations,
      { locale: "en", title: "x".repeat(201), summary: "", body: "bad" },
    ];
    await assert.rejects(
      save(
        { ...fields, id: created.id, status: "published" },
        bad,
        created.updated_at,
      ),
    );
    assert.equal(
      (await db.query("select status from website_notices")).rows[0].status,
      "draft",
      "failed translation rolls back publication",
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int count from website_notice_translations",
        )
      ).rows[0].count,
      9,
      "failed transaction preserves all old translations",
    );
    const updated = await save(
      { ...fields, id: created.id, status: "published" },
      translations,
      created.updated_at,
    );
    await assert.rejects(
      save({ ...fields, id: created.id }, translations, created.updated_at),
      /stale_notice/,
    );
    await assert.rejects(
      save({ ...fields, source_locale: "de" }, translations),
      /source_required/,
    );
    await db.exec("set test.can_write='no'");
    await assert.rejects(
      save({ ...fields, slug: "denied" }, translations),
      /write_not_allowed/,
    );
    await db.exec("set test.can_write='yes'");
    const hash = "a".repeat(64);
    const claim = async (locale) =>
      (
        await db.query("select claim_notice_translation($1,$2,$3) result", [
          created.id,
          locale,
          hash,
        ])
      ).rows[0].result;
    assert.equal(await claim("en"), "claimed");
    assert.equal(await claim("en"), "busy");
    for (const locale of ["ja", "de", "ru"])
      assert.equal(await claim(locale), "claimed");
    assert.equal(await claim("vi"), "busy");
    await db.query("select release_notice_translation($1,$2,$3)", [
      created.id,
      "en",
      hash,
    ]);
    assert.equal(await claim("vi"), "claimed");
    assert(updated.updated_at);
  } finally {
    await db.close();
  }
});
