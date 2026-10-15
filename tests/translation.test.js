import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  sourceHash,
  availableTranslation,
  translateWithLibre,
  ensureTranslation,
  segmentText,
} from "../shared/notice-translation.js";
import { renderBody } from "../shared/notice-body.js";
const source = {
  locale: "ko",
  title: "원문",
  summary: "요약",
  body: "## 안내\n\n- 첫 번째\n- 두 번째\n\n![캐릭터](https://assets.example/a.webp)",
};
const notice = {
  id: "00000000-0000-0000-0000-000000000001",
  source_locale: "ko",
  website_notice_translations: [source],
  website_notice_auto_translations: [],
};
afterEach(() => {
  delete process.env.TRANSLATION_API_URL;
  delete process.env.TRANSLATION_LANGUAGE_MAP;
  delete process.env.TRANSLATION_API_KEY;
});
test("manual translation wins; edited source invalidates automatic cache", () => {
  const auto = {
    locale: "en",
    source_hash: sourceHash(source),
    title: "Auto",
    summary: "",
    body: "Text",
  };
  const row = { ...notice, website_notice_auto_translations: [auto] };
  assert.equal(availableTranslation(row, "en").translation, "automatic");
  row.website_notice_translations = [
    source,
    { locale: "en", title: "Reviewed", body: "Reviewed text" },
  ];
  assert.equal(availableTranslation(row, "en").title, "Reviewed");
  row.website_notice_translations = [{ ...source, body: "수정" }];
  assert.equal(availableTranslation(row, "en").translation, "original");
});
test("source language can be any supported language, without requiring Korean", () => {
  const row = {
    ...notice,
    source_locale: "de",
    website_notice_translations: [
      { locale: "de", title: "Titel", summary: "", body: "Text" },
    ],
  };
  assert.equal(availableTranslation(row, "vi").source_locale, "de");
});
test("LibreTranslate preserves image URLs, markup, paragraphs and escapes output at rendering", async () => {
  process.env.TRANSLATION_API_URL = "https://translate.example/";
  let sent;
  const fetcher = async (url, options) => {
    if (String(url).endsWith("languages"))
      return Response.json([{ code: "ko", targets: ["en"] }]);
    sent = JSON.parse(options.body);
    return Response.json({
      translatedText: sent.q.map((text) => `Translated ${text}`),
    });
  };
  const translated = await translateWithLibre(source, "en", fetcher);
  assert.equal(sent.source, "ko");
  assert.equal(sent.target, "en");
  assert(!sent.q.some((text) => text.includes("https://")));
  assert.match(translated.body, /https:\/\/assets.example\/a.webp/);
  assert.match(translated.body, /## Translated/);
  assert.match(translated.body, /- Translated/);
  assert.match(renderBody(translated.body), /<h3>/);
  assert.match(renderBody(translated.body), /<ul>/);
  assert(!renderBody("<script>alert(1)</script>").includes("<script>"));
  assert(!renderBody("![a](javascript:alert(1))").includes("<img"));
});
test("never silently conflates simplified/traditional Chinese or unsupported language pairs", async () => {
  process.env.TRANSLATION_API_URL = "https://translate.example/";
  let calls = 0;
  await assert.rejects(
    translateWithLibre(source, "zh-Hant", async () => {
      calls++;
      return Response.json([{ code: "ko", targets: ["zh"] }]);
    }),
    /unsupported_language_pair/,
  );
  assert.equal(calls, 1);
});
test("no configured engine reports failure instead of inventing a translation", async () => {
  await assert.rejects(
    translateWithLibre(source, "en"),
    /translation_not_configured/,
  );
});
test("malformed output is never cached", async () => {
  process.env.TRANSLATION_API_URL = "https://translate.example/";
  await assert.rejects(
    translateWithLibre(source, "en", async (url) =>
      String(url).endsWith("languages")
        ? Response.json([{ code: "ko", targets: ["en"] }])
        : Response.json({ translatedText: ["incomplete"] }),
    ),
    /invalid_translation/,
  );
});
test("parallel readers deduplicate generation, persist cache and release the lease", async () => {
  let calls = 0;
  const writes = [];
  const db = async (path, init) => {
    writes.push(path);
    return Response.json(path.includes("claim_") ? "claimed" : null);
  };
  const provider = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 10));
    return { title: "Title", summary: "Summary", body: "Body" };
  };
  const [a, b] = await Promise.all([
    ensureTranslation(db, notice, "en", provider),
    ensureTranslation(db, notice, "en", provider),
  ]);
  assert.deepEqual(a, b);
  assert.equal(calls, 1);
  assert.equal(writes.filter((path) => path.includes("claim_")).length, 1);
  assert(
    writes.some((path) => path.startsWith("website_notice_auto_translations")),
  );
  assert(writes.some((path) => path.includes("release_")));
});
test("engine failures release leases without saving false successes", async () => {
  const writes = [];
  const db = async (path) => {
    writes.push(path);
    return Response.json(path.includes("claim_") ? "claimed" : null);
  };
  await assert.rejects(
    ensureTranslation(db, notice, "ja", async () => {
      throw Error("offline");
    }),
    /offline/,
  );
  assert(
    !writes.some((path) => path.startsWith("website_notice_auto_translations")),
  );
  assert(writes.some((path) => path.includes("release_")));
});
test("busy engine does not invoke provider", async () => {
  let called = false;
  await assert.rejects(
    ensureTranslation(
      async () => Response.json("busy"),
      notice,
      "de",
      async () => {
        called = true;
      },
    ),
    /translation_busy/,
  );
  assert.equal(called, false);
});
