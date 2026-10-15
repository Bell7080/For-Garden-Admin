import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import handler from "../api/translate.js";
const original = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = original;
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
});
const response = () => ({
  code: 0,
  body: null,
  setHeader() {},
  status(code) {
    this.code = code;
    return this;
  },
  json(body) {
    this.body = body;
  },
});
test("translation endpoint is POST-only and never returns false success without configuration", async () => {
  const res = response();
  await handler({ method: "GET" }, res);
  assert.equal(res.code, 405);
  await handler({ method: "POST" }, res);
  assert.equal(res.code, 503);
});
test("translation endpoint rejects anonymous requests", async () => {
  process.env.SUPABASE_URL = "https://db.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "secret";
  const res = response();
  await handler({ method: "POST", headers: {} }, res);
  assert.equal(res.code, 401);
});
test("read-only administrators cannot trigger translations", async () => {
  process.env.SUPABASE_URL = "https://db.example";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "secret";
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return Response.json(calls.length === 1 ? { id: "user" } : false);
  };
  const res = response();
  await handler(
    {
      method: "POST",
      headers: { authorization: "Bearer " + "x".repeat(30) },
      body: { id: "00000000-0000-0000-0000-000000000001", locale: "en" },
    },
    res,
  );
  assert.equal(res.code, 403);
  assert.equal(calls.length, 2);
});
