import { test } from "node:test";
import assert from "node:assert/strict";
import { renderBody } from "../shared/notice-body.js";
test("editorial markup keeps headings, lists and images", () => {
  const html = renderBody(
    "## 제목\n\n- 항목\n\n![이미지](https://assets.example/a.webp)",
  );
  assert.match(html, /<h3>/);
  assert.match(html, /<ul>/);
  assert.match(html, /https:\/\/assets.example\/a.webp/);
});
test("manual announcements cannot inject script HTML or unsafe image URLs", () => {
  assert(!renderBody("<script>alert(1)</script>").includes("<script>"));
  assert(!renderBody("![a](javascript:alert(1))").includes("<img"));
});
