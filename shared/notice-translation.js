import { createHash } from "node:crypto";
import { languageIds } from "./languages.js";

export function sourceOf(notice) {
  const rows = notice.website_notice_translations || [];
  return (
    rows.find(
      (t) =>
        t.locale === notice.source_locale && t.title?.trim() && t.body?.trim(),
    ) ||
    rows.find((t) => t.locale === "ko" && t.title?.trim() && t.body?.trim()) ||
    rows.find((t) => t.title?.trim() && t.body?.trim())
  );
}
export function sourceHash(source) {
  return createHash("sha256")
    .update(
      JSON.stringify([
        source.locale,
        source.title,
        source.summary || "",
        source.body,
      ]),
    )
    .digest("hex");
}
export function availableTranslation(notice, target) {
  const source = sourceOf(notice);
  if (!source) return null;
  const manual = (notice.website_notice_translations || []).find(
    (t) => t.locale === target && t.title?.trim() && t.body?.trim(),
  );
  if (manual)
    return {
      ...manual,
      translation: "manual",
      source_locale: source.locale,
      content_locale: target,
    };
  const cached = (notice.website_notice_auto_translations || []).find(
    (t) => t.locale === target && t.source_hash === sourceHash(source),
  );
  if (cached)
    return {
      ...cached,
      translation: "automatic",
      source_locale: source.locale,
      content_locale: target,
    };
  return {
    ...source,
    translation: "original",
    source_locale: source.locale,
    content_locale: source.locale,
  };
}

// Preserve URLs, markup tokens and paragraph breaks. Translate only text, never
// send image URLs/HTML to a translation engine or render its output as HTML.
export function segmentText(value) {
  const parts = String(value || "").split(
    /(https:\/\/[^\s)"'<>]+|\n+|^#{1,3} |^- |!\[|\]\(|\))/gm,
  );
  const indexes = [];
  const texts = [];
  parts.forEach((part, i) => {
    if (
      part.trim() &&
      !/^https:\/\//.test(part) &&
      !/^(#{1,3} |\- |!\[|\]\(|\))$/.test(part)
    ) {
      indexes.push(i);
      texts.push(part);
    }
  });
  return {
    texts,
    rebuild: (translated) => {
      if (translated.length !== texts.length)
        throw Error("invalid_translation");
      indexes.forEach((index, i) => (parts[index] = translated[i]));
      return parts.join("");
    },
  };
}
export async function translateWithLibre(source, target, fetcher = fetch) {
  const endpoint = process.env.TRANSLATION_API_URL;
  if (!endpoint) throw Error("translation_not_configured");
  const url = new URL(endpoint);
  if (
    url.protocol !== "https:" &&
    !(
      process.env.NODE_ENV === "development" &&
      ["localhost", "127.0.0.1"].includes(url.hostname)
    )
  )
    throw Error("invalid_translation_endpoint");
  const headers = { "Content-Type": "application/json" };
  const deadline = AbortSignal.timeout(45000);
  const signal = () => deadline;
  const supportedResponse = await fetcher(
    new URL("languages", url.href.endsWith("/") ? url.href : url.href + "/"),
    { signal: signal() },
  );
  if (!supportedResponse.ok) throw Error("translation_unavailable");
  const supported = await supportedResponse.json();
  // Use only explicit language mappings supported by the configured server.
  // Never silently treat traditional and simplified Chinese as equivalent.
  let mapping = {};
  try {
    mapping = JSON.parse(process.env.TRANSLATION_LANGUAGE_MAP || "{}");
  } catch {
    throw Error("invalid_language_map");
  }
  const from = mapping[source.locale] || source.locale;
  const to = mapping[target] || target;
  const pair = supported.find((language) => language.code === from);
  if (!pair || !pair.targets?.includes(to))
    throw Error("unsupported_language_pair");
  const chunks = [source.title, source.summary || "", source.body].map(
    segmentText,
  );
  const q = chunks.flatMap((c) => c.texts);
  if (q.length > 1000 || q.join("").length > 55000)
    throw Error("content_too_large");
  const response = await fetcher(
    new URL("translate", url.href.endsWith("/") ? url.href : url.href + "/"),
    {
      method: "POST",
      headers,
      signal: signal(),
      body: JSON.stringify({
        q,
        source: from,
        target: to,
        format: "text",
        ...(process.env.TRANSLATION_API_KEY
          ? { api_key: process.env.TRANSLATION_API_KEY }
          : {}),
      }),
    },
  );
  if (!response.ok) throw Error("translation_unavailable");
  const result = (await response.json()).translatedText;
  if (
    !Array.isArray(result) ||
    result.length !== q.length ||
    result.some((text) => typeof text !== "string")
  )
    throw Error("invalid_translation");
  let at = 0;
  const values = chunks.map((chunk) => {
    const slice = result.slice(at, at + chunk.texts.length);
    at += chunk.texts.length;
    return chunk.rebuild(slice);
  });
  const [title, summary, body] = values;
  if (
    !title.trim() ||
    title.length > 200 ||
    summary.length > 2000 ||
    !body.trim() ||
    body.length > 50000
  )
    throw Error("invalid_translation");
  return { title, summary, body };
}

const inFlight = new Map();
export async function ensureTranslation(
  db,
  notice,
  target,
  provider = translateWithLibre,
) {
  if (!languageIds.includes(target)) throw Error("unsupported_locale");
  const existing = availableTranslation(notice, target);
  if (!existing) throw Error("source_missing");
  if (existing.translation !== "original") return existing;
  if (!process.env.TRANSLATION_API_URL && provider === translateWithLibre)
    throw Error("translation_not_configured");
  const source = sourceOf(notice);
  const hash = sourceHash(source);
  const key = `${notice.id}:${target}:${hash}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const job = (async () => {
    // Cross-instance concurrency lease are enforced in Postgres, not memory.
    const claim = await db("rpc/claim_notice_translation", {
      method: "POST",
      body: JSON.stringify({
        p_notice_id: notice.id,
        p_locale: target,
        p_hash: hash,
      }),
    }).then((r) => r.json());
    if (claim !== "claimed") throw Error("translation_busy");
    try {
      const translated = await provider(source, target);
      await db(
        "website_notice_auto_translations?on_conflict=notice_id,locale",
        {
          method: "POST",
          headers: { Prefer: "resolution=merge-duplicates" },
          body: JSON.stringify({
            notice_id: notice.id,
            locale: target,
            source_hash: hash,
            ...translated,
            generated_at: new Date().toISOString(),
          }),
        },
      );
      return {
        ...translated,
        translation: "automatic",
        source_locale: source.locale,
        content_locale: target,
      };
    } finally {
      await db("rpc/release_notice_translation", {
        method: "POST",
        body: JSON.stringify({
          p_notice_id: notice.id,
          p_locale: target,
          p_hash: hash,
        }),
      }).catch(() => {});
    }
  })();
  inFlight.set(key, job);
  try {
    return await job;
  } finally {
    inFlight.delete(key);
  }
}
