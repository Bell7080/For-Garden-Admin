// 날짜·시간 선택기의 순수 규칙(DOM 없음). 값은 늘 기기 시간대의 "YYYY-MM-DD HH:mm"(날짜 전용은 "YYYY-MM-DD") 문자열이다.
const pad = (n) => String(n).padStart(2, "0");

export function formatDateTime(date, mode = "datetime") {
  const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
  return mode === "date" ? day : `${day} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 형식이 맞고 실제로 있는 시각일 때만 Date를 돌려준다. 비었거나 틀리면 null.
export function parseDateTime(text, mode = "datetime") {
  const t = String(text ?? "").trim();
  const m = (mode === "date" ? /^(\d{4})-(\d{2})-(\d{2})$/ : /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})$/).exec(t);
  if (!m) return null;
  const [y, mo, d, h = 0, mi = 0] = m.slice(1).map(Number);
  const date = new Date(y, mo - 1, d, h, mi);
  const ok = date.getFullYear() === y && date.getMonth() === mo - 1 && date.getDate() === d && date.getHours() === h && date.getMinutes() === mi;
  return ok ? date : null;
}

export function shiftMonth(year, month, delta) {
  const index = year * 12 + month + delta;
  return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 };
}

// 일요일 시작 6주(42칸). month는 0~11.
export function monthGrid(year, month) {
  const first = new Date(year, month, 1);
  const start = new Date(year, month, 1 - first.getDay());
  return Array.from({ length: 42 }, (_, i) => {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate(), inMonth: d.getMonth() === month };
  });
}

export const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

export function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60000);
}

// 날짜만 옮기고 시각은 그대로 둔다.
export function withDay(date, year, month, day) {
  return new Date(year, month, day, date.getHours(), date.getMinutes());
}

export function withTime(date, hour, minute) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute);
}

export function clampDate(date, min, max) {
  if (min && date < min) return new Date(min);
  if (max && date > max) return new Date(max);
  return date;
}

// 바로가기 값. now는 분 단위로 내려 쓴다.
export function presetDate(kind, now = new Date()) {
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), now.getMinutes());
  const at = (days, hour, minute) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, hour, minute);
  switch (kind) {
    case "now":
      return base;
    case "+1h":
      return addMinutes(base, 60);
    case "+2h":
      return addMinutes(base, 120);
    case "+6h":
      return addMinutes(base, 360);
    case "+1d":
      return at(1, base.getHours(), base.getMinutes());
    case "+3d":
      return at(3, base.getHours(), base.getMinutes());
    case "+7d":
      return at(7, base.getHours(), base.getMinutes());
    case "+30d":
      return at(30, base.getHours(), base.getMinutes());
    case "+90d":
      return at(90, base.getHours(), base.getMinutes());
    case "tomorrow9":
      return at(1, 9, 0);
    case "today23":
      return at(0, 23, 59);
    case "nextMonday9":
      return at(((8 - base.getDay()) % 7) || 7, 9, 0);
    default:
      throw new Error(`알 수 없는 바로가기: ${kind}`);
  }
}
