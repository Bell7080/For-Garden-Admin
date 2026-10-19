import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
test("Postgres migration: atomic save, language expansion, stale-editor rejection, source validation", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema private;
   create function private.is_admin() returns boolean language sql as $$ select true $$;
   create function private.admin_can(text[]) returns boolean language sql as $$ select coalesce(current_setting('test.can_write',true),'yes')='yes' $$;
   create table public.website_notices(id uuid primary key default gen_random_uuid(),slug text unique not null,category text not null,status text not null,published_at timestamptz not null,cover_image text,pinned boolean,template text,updated_at timestamptz default now());
   create table public.website_notice_translations(notice_id uuid references public.website_notices(id) on delete cascade,locale text check(locale in ('ko','en','ja')),title text check(length(title) between 1 and 200),summary text,body text check(length(body) between 1 and 50000),primary key(notice_id,locale));`);
    await db.exec(
      await readFile(
        new URL(
          "../supabase/migrations/20261017090000_notice_editor.sql",
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
    assert(updated.updated_at);
  } finally {
    await db.close();
  }
});

test("Postgres migration: notice styles store cover frame and event meta", async () => {
  const db = new PGlite();
  try {
    await db.exec(`create role anon;create role authenticated;create role service_role;create schema private;
   create function private.is_admin() returns boolean language sql as $$ select true $$;
   create function private.admin_can(text[]) returns boolean language sql as $$ select true $$;
   create table public.website_notices(id uuid primary key default gen_random_uuid(),slug text unique not null,category text not null,status text not null,published_at timestamptz not null,cover_image text,pinned boolean,template text,updated_at timestamptz default now());
   create table public.website_notice_translations(notice_id uuid references public.website_notices(id) on delete cascade,locale text,title text,summary text,body text,primary key(notice_id,locale));`);
    for (const file of [
      "20261017090000_notice_editor.sql",
      "20261024100000_notice_styles.sql",
    ])
      await db.exec(
        await readFile(
          new URL(`../supabase/migrations/${file}`, import.meta.url),
          "utf8",
        ),
      );
    const save = async (n) =>
      (
        await db.query("select public.save_website_notice($1,$2,$3) result", [
          JSON.stringify(n),
          JSON.stringify([
            { locale: "ko", title: "늑대 카페", summary: "", body: "본문" },
          ]),
          null,
        ])
      ).rows[0].result;
    const base = {
      slug: "wolf-cafe",
      category: "event",
      status: "draft",
      published_at: "2026-10-16T10:00:00+09:00",
      template: "event",
      pinned: false,
      source_locale: "ko",
      cover_frame: { zoom: 1.4, x: 30, y: 70 },
      meta: { game_event_id: "wolf-cafe", ends_at: "2026-12-31T14:59:59Z" },
    };
    const { id } = await save(base);
    let row = (
      await db.query(
        "select cover_frame, meta from website_notices where id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(row.cover_frame.zoom, 1.4);
    assert.equal(row.meta.game_event_id, "wolf-cafe");
    await save({
      ...base,
      id,
      cover_frame: null,
      meta: { version: "0.210.0" },
    });
    row = (
      await db.query(
        "select cover_frame, meta from website_notices where id=$1",
        [id],
      )
    ).rows[0];
    assert.equal(row.cover_frame, null);
    assert.deepEqual(row.meta, { version: "0.210.0" });
    await assert.rejects(
      save({ ...base, slug: "bad", meta: { version: "x".repeat(2000) } }),
    );
  } finally {
    await db.close();
  }
});
