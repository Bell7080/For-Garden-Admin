import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve, extname } from "node:path";
const root = process.cwd();
const port = Number(process.env.PORT || 5175);
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
};
http
  .createServer(async (req, res) => {
    const path = new URL(req.url, "http://localhost").pathname;
    try {
      const local = path === "/" ? "/index.html" : path;
      if (
        !/^\/(index\.html|admin\.(css|js)|catalog\.json|catalog\/[^.][\w/.-]*|fonts\/[\w.-]+|ui\/[\w.-]+|shared\/(languages|notice-body|legacy-save)\.js)$/.test(
          local,
        )
      ) {
        res.writeHead(404).end();
        return;
      }
      const file = resolve(root, "." + local);
      if (!file.startsWith(root + "/")) {
        res.writeHead(404).end();
        return;
      }
      res.setHeader(
        "Content-Type",
        types[extname(file)] || "application/octet-stream",
      );
      res.end(await readFile(file));
    } catch {
      res.writeHead(404).end();
    }
  })
  .listen(port, "0.0.0.0", () =>
    console.log(`Admin development server listening on ${port}`),
  );
