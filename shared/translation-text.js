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

export function prepareContent(source) {
  const chunks = [source.title, source.summary || "", source.body].map(
    segmentText,
  );
  const texts = chunks.flatMap((chunk) => chunk.texts);
  return {
    texts,
    rebuild(translated) {
      if (
        !Array.isArray(translated) ||
        translated.length !== texts.length ||
        translated.some((t) => typeof t !== "string")
      )
        throw Error("invalid_translation");
      let at = 0;
      const values = chunks.map((chunk) => {
        const part = translated.slice(at, at + chunk.texts.length);
        at += chunk.texts.length;
        return chunk.rebuild(part);
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
    },
  };
}
