// 운영 콘솔의 CSP(vercel.json)가 실제 페이지와 어긋나지 않게 지킨다.
// index.html의 인라인 테마 스크립트는 해시로만 허용되므로, 그 스크립트를 고치면 해시도 함께 바꿔야 한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const vercel = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const csp = vercel.headers
  .flatMap((rule) => rule.headers)
  .find((h) => h.key === "Content-Security-Policy")?.value;

test("모든 경로에 CSP가 선다", () => {
  assert.ok(csp, "vercel.json에 Content-Security-Policy가 없다");
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /'unsafe-eval'/);
  assert.doesNotMatch(csp, /script-src[^;]*'unsafe-inline'/);
});

test("인라인 스크립트는 전부 해시로 허용돼 있다", () => {
  const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  for (const body of inline) {
    const hash = `'sha256-${createHash("sha256").update(body).digest("base64")}'`;
    assert.ok(csp.includes(hash), `인라인 스크립트 해시 ${hash}가 CSP에 없다 — index.html을 고쳤다면 vercel.json도 고친다`);
  }
});

test("인라인 이벤트 처리기(onclick= 등)를 쓰지 않는다", () => {
  assert.doesNotMatch(html, /\son[a-z]+=/i);
});

test("코드가 부르는 외부 출처는 connect-src에 있다", () => {
  const sources = ["admin.js", "ops.js"].map((f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8")).join("\n");
  const origins = new Set([...sources.matchAll(/"(https:\/\/[a-z0-9.-]+)/g)].map((m) => m[1]));
  const connect = csp.split(";").find((d) => d.trim().startsWith("connect-src"));
  for (const origin of origins) assert.ok(connect.includes(origin), `${origin}이 connect-src에 없다`);
});
