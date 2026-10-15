import { ensureTranslation } from "../shared/notice-translation.js";
import { languageIds } from "../shared/languages.js";
export const config = { maxDuration: 60 };
export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "method_not_allowed" });
  }
  const base = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!base || !key)
    return res.status(503).json({ error: "translation_not_configured" });
  const token = req.headers.authorization;
  if (
    typeof token !== "string" ||
    !/^Bearer [A-Za-z0-9._-]{20,5000}$/.test(token)
  )
    return res.status(401).json({ error: "unauthorized" });
  try {
    const origin = new URL(base);
    if (origin.protocol !== "https:") throw Error("invalid_configuration");
    const auth = await fetch(`${origin.origin}/auth/v1/user`, {
      headers: { apikey: key, Authorization: token },
      signal: AbortSignal.timeout(8000),
    });
    if (!auth.ok) return res.status(401).json({ error: "unauthorized" });
    const roleResponse = await fetch(`${origin.origin}/rest/v1/rpc/admin_can`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ roles: ["owner", "operator"] }),
      signal: AbortSignal.timeout(8000),
    });
    if (!roleResponse.ok || (await roleResponse.json()) !== true)
      return res.status(403).json({ error: "forbidden" });
    let body = req.body;
    if (typeof body === "string") body = JSON.parse(body);
    const { id, locale } = body || {};
    if (
      !/^[\da-f]{8}(-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id || "") ||
      !languageIds.includes(locale)
    )
      return res.status(400).json({ error: "invalid_input" });
    const db = async (path, init = {}) => {
      const response = await fetch(`${origin.origin}/rest/v1/${path}`, {
        ...init,
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          ...init.headers,
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw Error("database_unavailable");
      return response;
    };
    const notices = await db(
      `website_notices?id=eq.${id}&select=*,website_notice_translations(*),website_notice_auto_translations(*)`,
    ).then((r) => r.json());
    if (!notices[0]) return res.status(404).json({ error: "notice_missing" });
    const translation = await ensureTranslation(db, notices[0], locale);
    return res.status(200).json({ translation });
  } catch (error) {
    const errors = [
      "translation_not_configured",
      "unsupported_language_pair",
      "translation_busy",
      "translation_unavailable",
      "source_missing",
      "invalid_translation",
      "content_too_large",
    ];
    return res.status(503).json({
      error: errors.includes(error.message)
        ? error.message
        : "translation_unavailable",
    });
  }
}
