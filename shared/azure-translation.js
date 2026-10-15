import { languageIds } from "./languages.js";
import { prepareContent } from "./translation-text.js";
export function azureConfiguration() {
  const key = process.env.AZURE_TRANSLATOR_KEY;
  if (!key) throw Error("translation_not_configured");
  // Resource tier is chosen in Azure Portal, not by this header. Require explicit
  // F0 configuration and a DB budget; do not silently accept a paid-tier setup.
  if (process.env.AZURE_TRANSLATOR_TIER !== "F0")
    throw Error("translation_free_tier_required");
  const monthlyLimit = Number(
    process.env.AZURE_TRANSLATOR_MONTHLY_LIMIT || 1900000,
  );
  if (
    !Number.isSafeInteger(monthlyLimit) ||
    monthlyLimit < 1 ||
    monthlyLimit > 2000000
  )
    throw Error("translation_budget_unavailable");
  const url = new URL(
    process.env.AZURE_TRANSLATOR_ENDPOINT ||
      "https://api.cognitive.microsofttranslator.com",
  );
  if (
    url.protocol !== "https:" ||
    !(
      /(^|\.)cognitive\.microsofttranslator\.com$/.test(url.hostname) ||
      url.hostname.endsWith(".cognitiveservices.azure.com")
    )
  )
    throw Error("translation_not_configured");
  url.pathname = url.pathname.replace(/\/$/, "") + "/translate";
  url.search = "";
  return {
    key,
    url,
    monthlyLimit,
    region: process.env.AZURE_TRANSLATOR_REGION,
  };
}
export async function translateWithAzure(
  source,
  target,
  fetcher = fetch,
  reserve,
) {
  const config = azureConfiguration();
  if (!languageIds.includes(source.locale) || !languageIds.includes(target))
    throw Error("unsupported_language_pair");
  if (typeof reserve !== "function")
    throw Error("translation_budget_unavailable");
  const locale = (id) => (id === "pt-BR" ? "pt" : id);
  const url = new URL(config.url);
  url.searchParams.set("api-version", "3.0");
  url.searchParams.set("from", locale(source.locale));
  url.searchParams.set("to", locale(target));
  url.searchParams.set("textType", "plain");
  const content = prepareContent(source);
  const pieces = [],
    lengths = [];
  for (const text of content.texts) {
    const chars = Array.from(text);
    let count = 0;
    for (let i = 0; i < chars.length; i += 20000) {
      pieces.push(chars.slice(i, i + 20000).join(""));
      count++;
    }
    lengths.push(count);
  }
  const translated = [];
  const deadline = AbortSignal.timeout(40000);
  for (let at = 0; at < pieces.length; ) {
    const batch = [];
    let characters = 0;
    while (at < pieces.length && batch.length < 1000) {
      const length = pieces[at].length;
      if (batch.length && characters + length > 45000) break;
      characters += length;
      batch.push({ Text: pieces[at++] });
    }
    await reserve(characters);
    const response = await fetcher(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "Ocp-Apim-Subscription-Key": config.key,
        ...(config.region
          ? { "Ocp-Apim-Subscription-Region": config.region }
          : {}),
      },
      body: JSON.stringify(batch),
      signal: deadline,
    });
    if (!response.ok) {
      let code;
      try {
        code = String((await response.json()).error?.code);
      } catch {}
      if (code === "403001") throw Error("translation_quota_exceeded");
      if (response.status === 429) throw Error("translation_rate_limited");
      if (response.status === 401 || response.status === 403)
        throw Error("translation_credentials_invalid");
      throw Error("translation_unavailable");
    }
    const rows = await response.json();
    if (!Array.isArray(rows) || rows.length !== batch.length)
      throw Error("invalid_translation");
    for (const row of rows) {
      const item = row.translations?.find((t) => t.to === locale(target));
      if (typeof item?.text !== "string") throw Error("invalid_translation");
      translated.push(item.text);
    }
  }
  let at = 0;
  const texts = lengths.map((length) => {
    const result = translated.slice(at, at + length).join("");
    at += length;
    return result;
  });
  return content.rebuild(texts);
}
