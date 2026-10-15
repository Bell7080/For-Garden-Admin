const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function renderBody(body) {
  return String(body || "")
    .split(/\n\s*\n/)
    .filter(Boolean)
    .map((block) => {
      const image = /^!\[([^\]]*)\]\((https:\/\/[^\s)"'<>]+)\)$/.exec(
        block.trim(),
      );
      if (image)
        return `<figure><img src="${esc(image[2])}" alt="${esc(image[1])}" loading="lazy"></figure>`;
      if (!/^#{1,3} |^- /m.test(block))
        return `<p>${esc(block).replaceAll("\n", "<br>")}</p>`;
      const lines = block.split("\n");
      let result = "",
        list = false;
      for (const line of lines) {
        if (line.startsWith("- ")) {
          if (!list) {
            result += "<ul>";
            list = true;
          }
          result += `<li>${esc(line.slice(2))}</li>`;
          continue;
        }
        if (list) {
          result += "</ul>";
          list = false;
        }
        const heading = /^#{1,3} (.+)$/.exec(line);
        result += heading
          ? `<h3>${esc(heading[1])}</h3>`
          : `<p>${esc(line)}</p>`;
      }
      return result + (list ? "</ul>" : "");
    })
    .join("");
}
