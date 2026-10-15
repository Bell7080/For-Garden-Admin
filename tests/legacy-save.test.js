import { test } from "node:test";
import assert from "node:assert/strict";
import { saveLegacyNotice } from "../shared/legacy-save.js";
const fields = {
  source_locale: "ko",
  slug: "new-post",
  category: "notice",
  status: "published",
  template: "plain",
  published_at: "2026-10-16T00:00:00Z",
};
const translations = [
  { locale: "ko", title: "제목", summary: "", body: "본문" },
];
test("legacy compatibility creates draft, writes original, and only then publishes", async () => {
  const calls = [];
  const result = await saveLegacyNotice(
    async (path, init) => {
      calls.push({ path, init });
      return [{ id: "id" }];
    },
    fields,
    translations,
  );
  assert.equal(calls[0].init.json.status, "draft");
  assert.equal(calls[1].init.json.body, "본문");
  assert.equal(calls.at(-1).init.json.status, "published");
  assert.equal(result.legacy, true);
});
test("legacy compatibility never publishes a new incomplete announcement", async () => {
  const calls = [];
  await assert.rejects(
    saveLegacyNotice(
      async (path, init) => {
        calls.push({ path, init });
        if (path.startsWith("website_notice_translations"))
          throw Error("offline");
        return [{ id: "id" }];
      },
      fields,
      translations,
    ),
  );
  assert.equal(calls.length, 2);
  assert.equal(calls[0].init.json.status, "draft");
});
test("legacy schema cannot silently discard additional languages", async () => {
  let called = false;
  await assert.rejects(
    saveLegacyNotice(
      async () => {
        called = true;
      },
      fields,
      [...translations, { locale: "th", title: "a", body: "b" }],
    ),
    /migration_required/,
  );
  assert.equal(called, false);
});
