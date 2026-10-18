import test from "node:test";
import assert from "node:assert/strict";
import { formatDateTime, parseDateTime, monthGrid, shiftMonth, presetDate, clampDate } from "../shared/datetime.js";

test("형식 왕복과 엄격한 해석", () => {
  const d = parseDateTime("2026-10-18 21:05");
  assert.equal(formatDateTime(d), "2026-10-18 21:05");
  assert.equal(formatDateTime(d, "date"), "2026-10-18");
  assert.equal(parseDateTime("2026-02-30 10:00"), null);
  assert.equal(parseDateTime("2026-10-18"), null);
  assert.equal(parseDateTime("2026-10-18", "date").getDate(), 18);
  assert.equal(parseDateTime("2026-10-18 24:00"), null);
  assert.equal(parseDateTime(""), null);
});

test("달력은 일요일 시작 42칸이고 이웃 달을 채운다", () => {
  const g = monthGrid(2026, 9);
  assert.equal(g.length, 42);
  assert.equal(new Date(g[0].year, g[0].month, g[0].day).getDay(), 0);
  assert.equal(g.filter((c) => c.inMonth).length, 31);
  assert.deepEqual(g.find((c) => c.inMonth), { year: 2026, month: 9, day: 1, inMonth: true });
});

test("달 이동은 해를 넘긴다", () => {
  assert.deepEqual(shiftMonth(2026, 11, 1), { year: 2027, month: 0 });
  assert.deepEqual(shiftMonth(2026, 0, -1), { year: 2025, month: 11 });
  assert.deepEqual(shiftMonth(2026, 5, -17), { year: 2025, month: 0 });
});

test("바로가기와 범위 제한", () => {
  const now = new Date(2026, 9, 18, 21, 5); // 일요일
  assert.equal(formatDateTime(presetDate("+1h", now)), "2026-10-18 22:05");
  assert.equal(formatDateTime(presetDate("tomorrow9", now)), "2026-10-19 09:00");
  assert.equal(formatDateTime(presetDate("nextMonday9", now)), "2026-10-19 09:00");
  assert.equal(formatDateTime(presetDate("nextMonday9", new Date(2026, 9, 19, 8, 0))), "2026-10-26 09:00");
  assert.equal(formatDateTime(presetDate("+30d", now)), "2026-11-17 21:05");
  assert.equal(formatDateTime(clampDate(new Date(2026, 0, 1), now, null)), "2026-10-18 21:05");
  assert.throws(() => presetDate("x"));
});
