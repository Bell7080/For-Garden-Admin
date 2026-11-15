import { test } from "node:test";
import assert from "node:assert/strict";
import { SLOTS, recurringOverlap } from "../shared/recurring-slots.js";

const asMail = (s) => ({ send_time: s.time, valid_hours: Number(s.hours), days: [1, 2, 3, 4, 5, 6, 7] });

test("식사·핫타임 기본 시간대는 서로 겹치지 않는다", () => {
  const keys = ["morning", "lunch", "evening", "hottime"];
  for (const a of keys) for (const b of keys) if (a < b) assert.equal(recurringOverlap(asMail(SLOTS[a]), asMail(SLOTS[b])), false, `${a}·${b}`);
});

test("식사 창은 통상 시간대 안에 있다", () => {
  const end = (s) => Number(s.time.slice(0, 2)) + Number(s.hours);
  assert.deepEqual([SLOTS.morning.time, end(SLOTS.morning)], ["07:00", 10]);
  assert.deepEqual([SLOTS.lunch.time, end(SLOTS.lunch)], ["12:00", 14]);
  assert.deepEqual([SLOTS.evening.time, end(SLOTS.evening)], ["18:00", 21]);
});

test("예전 기본값(08·12시 + 6시간)은 겹침으로 잡힌다", () => {
  const m = { send_time: "08:00:00", valid_hours: 6, days: [1, 2, 3, 4, 5, 6, 7] };
  const l = { send_time: "12:00:00", valid_hours: 6, days: [1, 2, 3, 4, 5, 6, 7] };
  assert.equal(recurringOverlap(m, l), true);
});

test("끝과 시작이 맞닿으면 겹침이 아니고, 요일이 다르면 겹치지 않는다", () => {
  assert.equal(recurringOverlap({ send_time: "12:00", valid_hours: 6, days: [1] }, { send_time: "18:00", valid_hours: 3, days: [1] }), false);
  assert.equal(recurringOverlap({ send_time: "08:00", valid_hours: 6, days: [1] }, { send_time: "12:00", valid_hours: 2, days: [2] }), false);
});

test("일요일 밤에서 월요일로 넘어가는 창과 무제한 보관도 본다", () => {
  assert.equal(recurringOverlap({ send_time: "22:00", valid_hours: 10, days: [7] }, { send_time: "07:00", valid_hours: 3, days: [1] }), true);
  assert.equal(recurringOverlap({ send_time: "07:00", valid_hours: null, days: [1] }, { send_time: "18:00", valid_hours: 3, days: [3] }), true);
});
