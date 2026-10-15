// Compatibility with the already deployed 3-language schema. Remove only after
// the transactional RPC is present in production. This is explicitly NOT atomic.
export async function saveLegacyNotice(
  rest,
  fields,
  translations,
  original,
  onCreated = () => {},
) {
  if (
    !["ko", "en", "ja"].includes(fields.source_locale) ||
    translations.some((t) => !["ko", "en", "ja"].includes(t.locale))
  )
    throw Error("migration_required");
  const row = {
    slug: fields.slug,
    category: fields.category,
    status: fields.status,
    published_at: fields.published_at,
    cover_image: fields.cover_image,
    pinned: fields.pinned,
    template: fields.template,
    updated_at: new Date().toISOString(),
  };
  let id = fields.id;
  if (!id) {
    const created = await rest("website_notices?select=id", {
      method: "POST",
      json: { ...row, status: "draft" },
      headers: { Prefer: "return=representation" },
    });
    id = created[0].id;
    onCreated(id);
  }
  const old = original?.website_notice_translations || [];
  try {
    for (const locale of ["ko", "en", "ja"]) {
      const text = translations.find((t) => t.locale === locale);
      if (text)
        await rest("website_notice_translations?on_conflict=notice_id,locale", {
          method: "POST",
          json: { notice_id: id, ...text },
          headers: { Prefer: "resolution=merge-duplicates" },
        });
      else
        await rest(
          `website_notice_translations?notice_id=eq.${id}&locale=eq.${locale}`,
          { method: "DELETE" },
        );
    }
    // New announcements cannot become public before their original is saved.
    await rest(`website_notices?id=eq.${id}`, { method: "PATCH", json: row });
    return { id, updated_at: row.updated_at, legacy: true };
  } catch (error) {
    // Best-effort restore of the existing editorial text; never call this a DB transaction.
    let restored = true;
    if (original)
      for (const locale of ["ko", "en", "ja"])
        try {
          const text = old.find((t) => t.locale === locale);
          if (text)
            await rest(
              "website_notice_translations?on_conflict=notice_id,locale",
              {
                method: "POST",
                json: {
                  notice_id: id,
                  locale,
                  title: text.title,
                  summary: text.summary || "",
                  body: text.body,
                },
                headers: { Prefer: "resolution=merge-duplicates" },
              },
            );
          else
            await rest(
              `website_notice_translations?notice_id=eq.${id}&locale=eq.${locale}`,
              { method: "DELETE" },
            );
        } catch {
          restored = false;
        }
    throw Error(
      restored
        ? "기존 호환 저장에 실패했습니다. 공지와 원고를 확인한 후 다시 저장해 주세요."
        : "저장과 이전 원고 복원에 실패했습니다. 현재 게시 내용을 확인해 주세요.",
    );
  }
}
