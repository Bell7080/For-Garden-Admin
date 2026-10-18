// 날짜·시간 선택기. 입력 칸은 읽기 전용 글자 칸으로 남아 값("YYYY-MM-DD HH:mm")을 그대로 들고 있고,
// 눌러서 여는 달력 + 굴리는 시·분 바퀴가 값을 바꾼다. 브라우저 기본 달력 팝업은 쓰지 않는다.
// 입력 칸의 value를 코드로 바꿔도 칸 자체가 보여 주므로 따로 맞출 것이 없다.
import { formatDateTime, parseDateTime, monthGrid, shiftMonth, sameDay, withDay, withTime, clampDate, presetDate } from "../shared/datetime.js";

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];
const PRESET_LABEL = {
  now: "지금",
  "+1h": "1시간 뒤",
  "+2h": "2시간 뒤",
  "+6h": "6시간 뒤",
  "+1d": "내일 이 시각",
  "+3d": "3일 뒤",
  "+7d": "7일 뒤",
  "+30d": "30일 뒤",
  "+90d": "90일 뒤",
  tomorrow9: "내일 09:00",
  today23: "오늘 23:59",
  nextMonday9: "다음 월요일 09:00",
};
const ITEM = 36; // 바퀴 한 칸 높이(px) — CSS와 같다
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

let open = null; // 지금 열린 선택기 하나만 둔다

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function wheel(label, count, value, onPick) {
  const column = el("div", "fg-wheel");
  column.setAttribute("role", "listbox");
  column.setAttribute("aria-label", label);
  column.tabIndex = 0;
  const items = Array.from({ length: count }, (_, i) => {
    const item = el("button", "fg-wheel-item", String(i).padStart(2, "0"));
    item.type = "button";
    item.tabIndex = -1;
    item.setAttribute("role", "option");
    item.onclick = () => {
      pick(i);
      column.scrollTo({ top: i * ITEM, behavior: reduced() ? "auto" : "smooth" });
    };
    return item;
  });
  column.append(...items);
  let current = value;
  let settle = 0;
  function mark() {
    items.forEach((item, i) => {
      item.classList.toggle("is-on", i === current);
      item.setAttribute("aria-selected", String(i === current));
    });
  }
  function pick(i) {
    if (i === current) return;
    current = i;
    mark();
    onPick(i);
  }
  column.addEventListener("scroll", () => {
    clearTimeout(settle);
    const i = Math.min(count - 1, Math.max(0, Math.round(column.scrollTop / ITEM)));
    pick(i);
    settle = setTimeout(() => column.scrollTo({ top: i * ITEM, behavior: "auto" }), 120);
  });
  column.addEventListener("keydown", (event) => {
    const step = { ArrowUp: -1, ArrowDown: 1, PageUp: -5, PageDown: 5, Home: -count, End: count }[event.key];
    if (!step) return;
    event.preventDefault();
    const i = Math.min(count - 1, Math.max(0, current + step));
    pick(i);
    column.scrollTo({ top: i * ITEM, behavior: "auto" });
  });
  mark();
  return {
    column,
    set(i) {
      current = i;
      mark();
      column.scrollTop = i * ITEM;
    },
  };
}

function close(apply) {
  if (!open) return;
  const state = open;
  open = null;
  document.removeEventListener("pointerdown", state.outside, true);
  document.removeEventListener("keydown", state.keys, true);
  window.removeEventListener("resize", state.place);
  state.pop.remove();
  state.input.setAttribute("aria-expanded", "false");
  if (apply) state.commit();
  state.input.focus({ preventScroll: true });
}

function openPicker(input, options) {
  if (open?.input === input) return close(false);
  close(false);
  const mode = options.mode;
  const min = options.min ? options.min() : null;
  const max = options.max ? options.max() : null;
  const initial = parseDateTime(input.value, mode);
  let selected = clampDate(initial || options.defaultValue?.() || presetDate("now"), min, max);
  if (mode === "date") selected = new Date(selected.getFullYear(), selected.getMonth(), selected.getDate());
  let view = { year: selected.getFullYear(), month: selected.getMonth() };
  const today = new Date();

  const pop = el("div", "fg-dt-pop");
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", options.label || "날짜와 시간 선택");

  const head = el("div", "fg-dt-head");
  const prev = el("button", "fg-dt-nav", "‹");
  const next = el("button", "fg-dt-nav", "›");
  prev.type = next.type = "button";
  prev.setAttribute("aria-label", "이전 달");
  next.setAttribute("aria-label", "다음 달");
  const title = el("strong", "fg-dt-title");
  title.setAttribute("aria-live", "polite");
  const todayBtn = el("button", "fg-dt-today", "오늘");
  todayBtn.type = "button";
  head.append(prev, title, next, todayBtn);

  const week = el("div", "fg-dt-week");
  WEEKDAYS.forEach((w, i) => week.append(el("span", i === 0 ? "sun" : i === 6 ? "sat" : "", w)));
  const grid = el("div", "fg-dt-grid");
  grid.setAttribute("role", "grid");

  const dayOk = (c) => {
    const start = new Date(c.year, c.month, c.day);
    const end = new Date(c.year, c.month, c.day, 23, 59);
    return !((min && end < min) || (max && start > max));
  };
  function paint() {
    title.textContent = `${view.year}년 ${view.month + 1}월`;
    grid.replaceChildren(
      ...monthGrid(view.year, view.month).map((c) => {
        const cell = el("button", "fg-dt-day", String(c.day));
        cell.type = "button";
        const date = new Date(c.year, c.month, c.day);
        cell.classList.toggle("dim", !c.inMonth);
        cell.classList.toggle("today", sameDay(date, today));
        cell.classList.toggle("on", sameDay(date, selected));
        cell.setAttribute("aria-label", `${c.year}년 ${c.month + 1}월 ${c.day}일`);
        cell.setAttribute("aria-pressed", String(sameDay(date, selected)));
        cell.disabled = !dayOk(c);
        cell.onclick = () => {
          selected = clampDate(withDay(selected, c.year, c.month, c.day), min, max);
          view = { year: c.year, month: c.month };
          paint();
          sync();
        };
        return cell;
      }),
    );
  }
  prev.onclick = () => ((view = shiftMonth(view.year, view.month, -1)), paint());
  next.onclick = () => ((view = shiftMonth(view.year, view.month, 1)), paint());
  todayBtn.onclick = () => {
    selected = clampDate(withDay(selected, today.getFullYear(), today.getMonth(), today.getDate()), min, max);
    view = { year: selected.getFullYear(), month: selected.getMonth() };
    paint();
    sync();
  };

  let hourWheel = null;
  let minuteWheel = null;
  const readout = el("output", "fg-dt-readout");
  readout.setAttribute("aria-live", "polite");
  function sync() {
    readout.textContent = initial === null && !touched ? "" : formatDateTime(selected, mode).replace(" ", "  ");
    hourWheel?.set(selected.getHours());
    minuteWheel?.set(selected.getMinutes());
  }
  let touched = initial !== null;

  pop.append(head, week, grid);

  if (mode === "datetime") {
    const time = el("div", "fg-dt-time");
    const wheels = el("div", "fg-wheels");
    hourWheel = wheel("시", 24, selected.getHours(), (h) => {
      touched = true;
      selected = clampDate(withTime(selected, h, selected.getMinutes()), min, max);
      readout.textContent = formatDateTime(selected, mode).replace(" ", "  ");
    });
    minuteWheel = wheel("분", 60, selected.getMinutes(), (m) => {
      touched = true;
      selected = clampDate(withTime(selected, selected.getHours(), m), min, max);
      readout.textContent = formatDateTime(selected, mode).replace(" ", "  ");
    });
    wheels.append(hourWheel.column, el("span", "fg-wheel-colon", ":"), minuteWheel.column);
    wheels.append(el("span", "fg-wheel-band"));
    time.append(el("span", "fg-dt-label", "시각"), wheels);
    pop.append(time);
  }

  const kinds = options.presets || [];
  if (kinds.length) {
    const row = el("div", "fg-dt-presets");
    kinds.forEach((kind) => {
      const chip = el("button", "fg-dt-chip", PRESET_LABEL[kind] || kind);
      chip.type = "button";
      chip.onclick = () => {
        let d = presetDate(kind);
        if (mode === "date") d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
        selected = clampDate(d, min, max);
        touched = true;
        view = { year: selected.getFullYear(), month: selected.getMonth() };
        paint();
        sync();
      };
      row.append(chip);
    });
    pop.append(row);
  }

  const foot = el("div", "fg-dt-foot");
  const clear = el("button", "fg-dt-clear", "비우기");
  clear.type = "button";
  clear.hidden = !options.clearable;
  clear.onclick = () => {
    input.value = "";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    close(false);
  };
  const cancel = el("button", "fg-dt-cancel", "취소");
  cancel.type = "button";
  cancel.onclick = () => close(false);
  const apply = el("button", "fg-dt-apply", "적용");
  apply.type = "button";
  apply.onclick = () => close(true);
  foot.append(clear, readout, cancel, apply);
  pop.append(foot);

  paint();
  sync();

  const host = input.closest(".fg-dt") || input.parentElement;
  host.append(pop);
  input.setAttribute("aria-expanded", "true");
  // 아래 공간이 모자라면 위로 연다.
  const place = () => {
    pop.classList.remove("up");
    const room = window.innerHeight - input.getBoundingClientRect().bottom;
    if (room < pop.offsetHeight + 12 && input.getBoundingClientRect().top > pop.offsetHeight + 12) pop.classList.add("up");
    const rect = pop.getBoundingClientRect();
    pop.style.marginLeft = rect.right > window.innerWidth - 8 ? `${window.innerWidth - 8 - rect.right}px` : "";
  };
  place();
  if (hourWheel) {
    hourWheel.set(selected.getHours());
    minuteWheel.set(selected.getMinutes());
  }
  window.addEventListener("resize", place);

  const state = {
    input,
    pop,
    place,
    commit() {
      input.value = formatDateTime(selected, mode);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    },
    outside: (event) => {
      if (!pop.contains(event.target) && !host.contains(event.target)) close(false);
    },
    keys: (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close(false);
      } else if (event.key === "Enter" && pop.contains(document.activeElement) && document.activeElement.tagName !== "BUTTON") {
        event.preventDefault();
        close(true);
      }
    },
  };
  open = state;
  document.addEventListener("pointerdown", state.outside, true);
  document.addEventListener("keydown", state.keys, true);
  pop.querySelector(".fg-dt-day.on, .fg-dt-day.today")?.focus({ preventScroll: true });
}

// input[data-datetime]을 선택기로 바꾼다. data-datetime="date"는 날짜만, 그 밖에는 날짜+시각.
// data-presets="now,+1h", data-empty="비워두면 즉시 발송", data-clearable는 비울 수 있는 칸이다.
export function enhanceDateTime(input, extra = {}) {
  if (input.dataset.dtReady) return;
  input.dataset.dtReady = "true";
  const options = {
    mode: input.dataset.datetime === "date" ? "date" : "datetime",
    presets: (input.dataset.presets || "").split(",").map((s) => s.trim()).filter(Boolean),
    clearable: input.hasAttribute("data-clearable"),
    label: input.getAttribute("aria-label") || undefined,
    ...extra,
  };
  if (input.dataset.empty) input.placeholder = input.dataset.empty;
  input.readOnly = true;
  input.autocomplete = "off";
  input.setAttribute("aria-haspopup", "dialog");
  input.setAttribute("aria-expanded", "false");
  const host = el("div", "fg-dt");
  input.replaceWith(host);
  const icon = el("button", "fg-dt-icon");
  icon.type = "button";
  icon.tabIndex = -1;
  icon.setAttribute("aria-label", "달력 열기");
  icon.innerHTML =
    '<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" d="M3.5 5h13v11.5h-13zM3.5 8.5h13M7 3v3M13 3v3"/></svg>';
  host.append(input, icon);
  const toggle = () => !input.disabled && openPicker(input, options);
  input.addEventListener("click", toggle);
  icon.addEventListener("click", toggle);
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " " || event.key === "ArrowDown") {
      event.preventDefault();
      toggle();
    } else if ((event.key === "Backspace" || event.key === "Delete") && options.clearable && input.value) {
      event.preventDefault();
      input.value = "";
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  });
}

export function enhanceDateTimes(root = document) {
  root.querySelectorAll("input[data-datetime]").forEach((input) => enhanceDateTime(input));
}
