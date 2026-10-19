import { mkdir, cp, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
await mkdir("dist/shared", { recursive: true });
for (const file of [
  "index.html",
  "admin.css",
  "admin.js",
  "ops.js",
  "catalog.json",
  "catalog",
  "fonts",
  "ui",
])
  await cp(file, `dist/${file}`, { recursive: true });
for (const file of [
  "languages.js",
  "notice-body.js",
  "legacy-save.js",
  "datetime.js",
  "notice-style.js",
  "game-events.js",
])
  await cp(`shared/${file}`, `dist/shared/${file}`);
console.log("Static admin built in dist/.");
