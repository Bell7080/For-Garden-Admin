import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  azureConfiguration,
  translateWithAzure,
} from "../shared/azure-translation.js";
import { ensureTranslation, sourceHash } from "../shared/notice-translation.js";
import { languageIds } from "../shared/languages.js";
const source = {
  locale: "ko",
  title: "공지",
  summary: "요약",
  body: "## 안내\n\n본문\n\n![토리카](https://assets.example/a.webp)",
};
function config() {
  process.env.AZURE_TRANSLATOR_KEY = "azure-test-only";
  process.env.AZURE_TRANSLATOR_TIER = "F0";
}
afterEach(() => {
  for (const key of [
    "AZURE_TRANSLATOR_KEY",
    "AZURE_TRANSLATOR_TIER",
    "AZURE_TRANSLATOR_REGION",
    "AZURE_TRANSLATOR_ENDPOINT",
    "AZURE_TRANSLATOR_MONTHLY_LIMIT",
    "TRANSLATION_PROVIDER",
  ])
    delete process.env[key];
});
test("requires explicit free-tier setup and a persisted usage reservation", async () => {
  config();
  delete process.env.AZURE_TRANSLATOR_TIER;
  assert.throws(azureConfiguration, /translation_free_tier_required/);
  config();
  await assert.rejects(
    translateWithAzure(source, "en"),
    /translation_budget_unavailable/,
  );
  process.env.AZURE_TRANSLATOR_MONTHLY_LIMIT = "2000001";
  assert.throws(azureConfiguration, /translation_budget_unavailable/);
});
test("translates all 11 targets, preserves Chinese variants and maps Brazilian Portuguese explicitly", async () => {
  config();
  const targets = [];
  const reservations = [];
  for (const locale of languageIds.filter((id) => id !== "ko")) {
    await translateWithAzure(
      source,
      locale,
      async (url, init) => {
        const to = url.searchParams.get("to");
        targets.push(to);
        assert.equal(
          init.headers["Ocp-Apim-Subscription-Key"],
          "azure-test-only",
        );
        const texts = JSON.parse(init.body);
        assert(!texts.some((t) => t.Text.includes("https://")));
        return Response.json(
          texts.map((t) => ({ translations: [{ to, text: t.Text }] })),
        );
      },
      async (count) => reservations.push(count),
    );
  }
  assert.equal(targets.length, 11);
  assert(targets.includes("zh-Hant"));
  assert(targets.includes("zh-Hans"));
  assert(targets.includes("pt"));
  assert(!targets.includes("pt-BR"));
  assert.equal(reservations.length, 11);
});
test("quota exhaustion blocks the outbound API call", async () => {
  config();
  let called = false;
  await assert.rejects(
    translateWithAzure(
      source,
      "ja",
      async () => {
        called = true;
      },
      async () => {
        throw Error("translation_quota_exceeded");
      },
    ),
    /translation_quota_exceeded/,
  );
  assert.equal(called, false);
});
test("reports provider quota/rate/key failures without saving fake results", async () => {
  config();
  for (const [status, code, error] of [
    [403, 403001, "translation_quota_exceeded"],
    [429, 429000, "translation_rate_limited"],
    [401, 401000, "translation_credentials_invalid"],
  ])
    await assert.rejects(
      translateWithAzure(
        source,
        "de",
        async () => Response.json({ error: { code } }, { status }),
        async () => {},
      ),
      new RegExp(error),
    );
});
test("cached translations need no provider credentials, fetches or budget reservations", async () => {
  const notice = {
    id: "cached",
    source_locale: "ko",
    website_notice_translations: [source],
    website_notice_auto_translations: [
      {
        locale: "en",
        source_hash: sourceHash(source),
        title: "Cached title",
        summary: "",
        body: "Cached body",
      },
    ],
  };
  let calls = 0;
  const result = await ensureTranslation(
    async () => {
      calls++;
      throw Error("must not query");
    },
    notice,
    "en",
  );
  assert.equal(result.title, "Cached title");
  assert.equal(calls, 0);
});
test("batches long text within the service request limit without splitting surrogate pairs", async () => {
  config();
  const long = { ...source, body: "a".repeat(46000) };
  let calls = 0,
    total = 0;
  const result = await translateWithAzure(
    long,
    "en",
    async (url, init) => {
      calls++;
      const texts = JSON.parse(init.body);
      assert(texts.reduce((sum, t) => sum + t.Text.length, 0) <= 45000);
      return Response.json(
        texts.map((t) => ({ translations: [{ to: "en", text: t.Text }] })),
      );
    },
    async (count) => {
      total += count;
    },
  );
  assert.equal(result.body, long.body);
  assert(calls > 1);
  assert(total >= 46000);
});
test("production dispatch reserves the shared budget before Azure and persists the result", async () => {
  config();
  process.env.TRANSLATION_PROVIDER = "azure";
  const notice = {
    id: "dispatch",
    source_locale: "ko",
    website_notice_translations: [source],
  };
  const paths = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (url, init) =>
    Response.json(
      JSON.parse(init.body).map((t) => ({
        translations: [{ to: "en", text: t.Text }],
      })),
    );
  try {
    const result = await ensureTranslation(
      async (path, init) => {
        paths.push(path);
        return Response.json(
          path.includes("claim_")
            ? "claimed"
            : path.includes("reserve_")
              ? "reserved"
              : null,
        );
      },
      notice,
      "en",
    );
    assert.equal(result.translation, "automatic");
    assert(
      paths.indexOf("rpc/reserve_translation_characters") <
        paths.findIndex((path) =>
          path.startsWith("website_notice_auto_translations"),
        ),
    );
  } finally {
    globalThis.fetch = previous;
  }
});
