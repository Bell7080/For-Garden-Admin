import { saveLegacyNotice } from "./shared/legacy-save.js";
import { languages as LOCALES } from "./shared/languages.js";
import { renderBody } from "./shared/notice-body.js";
import { mountOps, resetOps } from "./ops.js";
import { enhanceDateTimes } from "./ui/datetime.js";
import {
  coverSize,
  coverStyle,
  dragFocus,
  eventPhase,
  normalizeFrame,
  normalizeMeta,
  remaining,
  COVER_ZOOM_MAX,
} from "./shared/notice-style.js";
import { GAME_EVENTS } from "./shared/game-events.js";
// 공개(publishable) 키만 사용한다. service_role 키는 이 저장소에 절대 넣지 않는다.
// 토큰은 메모리에만 둔다(새로고침하면 다시 로그인). 권한은 DB의 RLS가 최종 판단한다.
const BASE = "https://udujahnlyhedlrfbaaow.supabase.co";
const KEY = "sb_publishable_JBBgVvVIKSyE6n3jdo9Bwg_Z3peap8U";
const BUCKET = "notice-images";
const GAME_ORIGIN = "https://forgarden.vercel.app";
const CATEGORY = { notice: "공지", development: "개발 소식", event: "이벤트" };
const TEMPLATES = {
  plain: {
    category: "notice",
    pinned: false,
    body: {
      ko: "## 안내 요약\n\n전달할 핵심 내용을 적어 주세요.\n\n## 적용 일정과 대상\n\n- 적용 일시: \n- 대상: \n\n## 상세 안내\n\n자세한 내용을 작성해 주세요.\n\n## 유의 사항\n\n확인이 필요한 내용을 안내해 주세요.",
      en: "Write the announcement here.",
      ja: "お知らせの内容を入力してください。",
    },
  },
  update: {
    category: "development",
    pinned: false,
    body: {
      ko: "## 업데이트 개요\n\n업데이트의 핵심 내용을 안내해 주세요.\n\n## 적용 일정\n\n- 적용 일시: \n- 적용 대상: \n\n## 신규 콘텐츠\n\n- 추가되는 콘텐츠를 적어 주세요.\n\n## 개선 및 수정\n\n- 개선 사항을 적어 주세요.\n- 수정 사항을 적어 주세요.\n\n## 유의 사항\n\n업데이트 전 확인할 내용을 적어 주세요.",
      en: "About this update\n\n- Change 1\n- Change 2\n\nMore details will follow.",
      ja: "今回のアップデートについて\n\n- 変更点 1\n- 変更点 2\n\n詳細は追ってお知らせします。",
    },
  },
  event: {
    category: "event",
    pinned: true,
    body: {
      ko: "## 이벤트 소개\n\n이벤트의 핵심 내용을 안내해 주세요.\n\n## 진행 기간\n\n- 시작: \n- 종료: \n\n## 참여 대상과 방법\n\n- 참여 조건: \n- 참여 방법: \n\n## 보상 및 지급 일정\n\n- 보상: \n- 지급 시점: \n\n## 유의 사항\n\n보상 수령과 참여 시 확인할 내용을 적어 주세요.",
      en: "Event period\n\nHow to join\n\nRewards\n\n* Details may change depending on operations.",
      ja: "イベント期間\n\n参加方法\n\n報酬のご案内\n\n※ 内容は運営状況により変更される場合があります。",
    },
  },
};

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
let session = null; // { access, refresh, email }
let role = "";
let notices = [];
let cur = null; // 편집 중인 공지 { id|null, ...fields, tr: {ko:{title,summary,body},...} }
let lang = "ko";
let dirty = false;
let atomicSaveMissing = false;
let editGeneration = 0;
// False when the database predates 20261024100000_notice_styles.sql (rows lack `meta`).
let styleColumns = true;
const blankTranslations = () =>
  Object.fromEntries(
    LOCALES.map(([id]) => [id, { title: "", summary: "", body: "" }]),
  );
$("sourceLocale").innerHTML = LOCALES.map(
  ([id, name]) => `<option value="${id}" lang="${id}">${name}</option>`,
).join("");
$("timeZone").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
$("gameEvent").innerHTML = [
  `<option value="">연결 안 함</option>`,
  ...GAME_EVENTS.map(
    (e) => `<option value="${e.id}">${e.title} (${e.id})</option>`,
  ),
].join("");
enhanceDateTimes();
function ask(message) {
  const dialog = $("confirmDialog");
  $("confirmText").textContent = message;
  dialog.returnValue = "";
  dialog.showModal();
  return new Promise((resolve) =>
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "ok"),
      { once: true },
    ),
  );
}
function statusOf(n) {
  return n.status === "draft"
    ? "draft"
    : Date.parse(n.published_at) > Date.now()
      ? "scheduled"
      : "published";
}
const STATUS = {
  draft: "임시저장",
  scheduled: "예약 게시",
  published: "게시 중",
};
const dateTime = (value) =>
  new Intl.DateTimeFormat("ko", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
function markDirty() {
  dirty = true;
  $("saveState").textContent = "저장하지 않은 변경";
}

// ---------- 통신 ----------
async function refresh() {
  const r = await fetch(`${BASE}/auth/v1/token?grant_type=refresh_token`, {
    method: "POST",
    headers: { apikey: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: session.refresh }),
  });
  if (!r.ok) {
    logout();
    throw new Error("세션이 만료되었습니다. 다시 로그인하세요.");
  }
  const j = await r.json();
  session.access = j.access_token;
  session.refresh = j.refresh_token;
}
async function call(path, init = {}, retry = true) {
  const r = await fetch(BASE + path, {
    signal: AbortSignal.timeout(20000),
    ...init,
    headers: {
      apikey: KEY,
      Authorization: `Bearer ${session.access}`,
      ...(init.json ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
  });
  if (r.status === 401 && retry) {
    await refresh();
    return call(path, init, false);
  }
  return r;
}
async function rest(path, init) {
  const r = await call("/rest/v1/" + path, init);
  if (!r.ok) {
    const details = await r.text();
    const error = new Error(`요청 실패 (${r.status}) ${details.slice(0, 160)}`);
    error.status = r.status;
    try {
      error.code = JSON.parse(details).code;
    } catch {}
    throw error;
  }
  return r.status === 204 ? null : r.json().catch(() => null);
}

// ---------- 로그인 ----------
$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!$("form").checkValidity()) {
    $("loginMsg").textContent = "올바른 이메일과 비밀번호를 입력해 주세요.";
    $("form").querySelector(":invalid")?.focus();
    return;
  }
  $("loginMsg").textContent = "확인 중…";
  $("loginMsg").className = "msg";
  try {
    const r = await fetch(`${BASE}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: { apikey: KEY, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: $("email").value,
        password: $("pw").value,
      }),
    });
    if (!r.ok) throw new Error("로그인에 실패했습니다.");
    const j = await r.json();
    session = {
      access: j.access_token,
      refresh: j.refresh_token,
      email: $("email").value,
    };
    $("pw").value = "";
    // is_admin 함수는 API에 노출하지 않는다. 자기 역할 행이 보이는지가 곧 권한 확인이다(RLS).
    const roles = await rest("admin_roles?select=role");
    if (!Array.isArray(roles) || !roles.length) {
      session = null;
      throw new Error("이 계정은 관리자 권한이 없습니다.");
    }
    role =
      roles.find((r) => ["owner", "operator"].includes(r.role))?.role ??
      roles[0]?.role ??
      "";
    $("newNotice").disabled = !canWrite();
    $("login").hidden = true;
    $("app").hidden = false;
    $("who").textContent = `${session.email} · ${role}`;
    await loadList();
    await mountOps({ call, ask, esc, role });
  } catch (err) {
    $("loginMsg").textContent = err.message;
    $("loginMsg").className = "msg bad";
  }
});
function logout() {
  session = null;
  cur = null;
  notices = [];
  dirty = false;
  editGeneration++;
  role = "";
  resetOps();
  $("app").hidden = true;
  $("login").hidden = false;
  $("editor").hidden = true;
  $("preview").hidden = true;
  $("empty").hidden = false;
  $("list").innerHTML = "";
  $("who").textContent = "";
}
$("logout").onclick = async () => {
  if (!dirty || (await ask("저장하지 않은 변경이 있습니다. 로그아웃할까요?")))
    logout();
};
const canWrite = () => role === "owner" || role === "operator";

// ---------- 목록 ----------
async function loadList() {
  notices = await rest(
    "website_notices?select=*,website_notice_translations(locale,title,summary,body)&order=pinned.desc,published_at.desc",
  );
  if (notices.length) styleColumns = "meta" in notices[0];
  renderList();
}
function renderList() {
  const c = $("fCat").value,
    s = $("fStatus").value,
    q = $("fText").value.trim().toLowerCase();
  const shown = notices.filter(
    (n) =>
      (!c || n.category === c) &&
      (!s || statusOf(n) === s) &&
      (!q ||
        n.slug.includes(q) ||
        n.website_notice_translations.some((t) =>
          t.title.toLowerCase().includes(q),
        )),
  );
  $("listCount").textContent =
    `${shown.length}개 공지 · 전체 ${notices.length}개`;
  $("stats").innerHTML = [
    ["전체 공지", notices.length],
    ["게시 중", notices.filter((n) => statusOf(n) === "published").length],
    ["예약 게시", notices.filter((n) => statusOf(n) === "scheduled").length],
    ["임시저장", notices.filter((n) => statusOf(n) === "draft").length],
  ]
    .map(
      ([label, count]) =>
        `<div class="stat"><strong>${count}</strong><span>${label}</span></div>`,
    )
    .join("");
  $("list").innerHTML =
    shown
      .map((n) => {
        const t =
          n.website_notice_translations.find(
            (x) => x.locale === (n.source_locale || "ko"),
          ) || n.website_notice_translations[0];
        const state = statusOf(n);
        return `<button class="nrow${cur?.id === n.id ? " on" : ""}" data-id="${esc(n.id)}"><span class="tag ${state === "published" ? "pub" : state}">${STATUS[state]}</span>${n.pinned ? '<span class="tag pin">상단 고정</span>' : ""}<b>${esc(t?.title || "(제목 없음)")}</b><span class="tag">${CATEGORY[n.category]}</span><small>${esc(dateTime(n.published_at))}</small><small>${esc(n.slug)}</small></button>`;
      })
      .join("") || '<p class="hint">조건에 맞는 공지가 없습니다.</p>';
  $("list")
    .querySelectorAll(".nrow")
    .forEach(
      (b) =>
        (b.onclick = () =>
          guard(() => open(notices.find((n) => n.id === b.dataset.id)))),
    );
}
["fCat", "fStatus", "fText"].forEach((id) =>
  $(id).addEventListener("input", renderList),
);
async function guard(fn) {
  if (!dirty || (await ask("저장하지 않은 변경이 사라집니다. 계속할까요?"))) {
    dirty = false;
    fn();
  }
}

// ---------- 편집 ----------
const toLocalInput = (iso) => {
  const d = new Date(iso);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16).replace("T", " ");
};
function blank(templateKey = "plain") {
  const tpl = TEMPLATES[templateKey];
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17);
  return {
    id: null,
    slug: `notice-${stamp}`,
    category: tpl.category,
    status: "draft",
    published_at: new Date().toISOString(),
    cover_image: null,
    cover_frame: null,
    meta: {},
    pinned: tpl.pinned,
    template: templateKey,
    source_locale: "ko",
    tr: {
      ...blankTranslations(),
      ko: { title: "", summary: "", body: tpl.body.ko },
    },
  };
}
function open(n, asCopy = false) {
  if (!n) return;
  const tr = blankTranslations();
  for (const t of n.website_notice_translations ?? [])
    tr[t.locale] = { title: t.title, summary: t.summary, body: t.body };
  editGeneration++;
  cur = {
    source_locale:
      tr[n.source_locale || "ko"]?.title && tr[n.source_locale || "ko"]?.body
        ? n.source_locale || "ko"
        : LOCALES.find(([id]) => tr[id].title && tr[id].body)?.[0] ||
          n.source_locale ||
          "ko",
    updated_at: asCopy ? null : n.updated_at,
    id: asCopy ? null : n.id,
    slug: asCopy ? `${n.slug}-copy`.slice(0, 100) : n.slug,
    category: n.category,
    status: asCopy ? "draft" : n.status,
    published_at: n.published_at,
    cover_image: n.cover_image,
    cover_frame: n.cover_frame ? normalizeFrame(n.cover_frame) : null,
    meta: normalizeMeta(n.meta),
    pinned: n.pinned,
    template: n.template || "plain",
    tr,
  };
  if (n.tr) cur.tr = n.tr;
  lang = cur.source_locale;
  show();
}
function show() {
  $("sourceLocale").value = cur.source_locale;
  $("editorTitle").textContent = cur.id ? "공지 편집" : "새 공지";
  $("editorMode").textContent = cur.id
    ? "EDIT ANNOUNCEMENT"
    : "NEW ANNOUNCEMENT";
  $("saveState").textContent = dirty
    ? "저장하지 않은 변경"
    : cur.id
      ? "저장됨"
      : "작성 중";
  $("empty").hidden = true;
  $("editor").hidden = false;
  $("preview").hidden = false;
  $("category").value = cur.category;
  $("status").value = cur.status;
  $("slug").value = cur.slug;
  $("slug").disabled = !!cur.id;
  $("publishedAt").value = toLocalInput(cur.published_at);
  $("template").value = cur.template;
  $("pinned").value = String(cur.pinned);
  $("version").value = cur.meta.version || "";
  $("gameEvent").value = cur.meta.game_event_id || "";
  $("eventStart").value = cur.meta.starts_at
    ? toLocalInput(cur.meta.starts_at)
    : "";
  $("eventEnd").value = cur.meta.ends_at ? toLocalInput(cur.meta.ends_at) : "";
  showStyleFields();
  [
    "save",
    "dup",
    "remove",
    "pickCover",
    "clearCover",
    "frameReset",
    "frameZoom",
    "insertImg",
    "version",
    "gameEvent",
    "eventStart",
    "eventEnd",
  ].forEach(
    (id) => ($(id).disabled = !canWrite()),
  );
  $("remove").disabled = !canWrite() || !cur.id;
  [
    "category",
    "status",
    "sourceLocale",
    "publishedAt",
    "pinned",
    "title",
    "summary",
    "body",
  ].forEach((id) => ($(id).disabled = !canWrite()));
  $("slug").disabled = !!cur.id || !canWrite();
  $("template").disabled = !canWrite();
  ["insertHeading", "insertList"].forEach(
    (id) => ($(id).disabled = !canWrite()),
  );
  document
    .querySelectorAll("select")
    .forEach((select) => select.dispatchEvent(new Event("fg:sync")));
  renderTabs();
  fillLang();
  renderCover();
  preview();
  renderList();
  $("msg").textContent = canWrite() ? "" : "이 역할은 읽기 전용입니다.";
}
function renderTabs() {
  $("langTabs").innerHTML = LOCALES.map(
    ([id, name]) =>
      `<button type="button" role="tab" id="tab-${id}" aria-selected="${id === lang}" aria-controls="languagePanel" tabindex="${id === lang ? 0 : -1}" lang="${id}" data-l="${id}" class="${id === lang ? "on" : ""}">${name}${id === cur.source_locale ? " · 원문" : cur.tr[id].title && cur.tr[id].body ? " · 직접 작성" : ""}</button>`,
  ).join("");
  $("languagePanel").setAttribute("aria-labelledby", `tab-${lang}`);
  $("langTabs")
    .querySelectorAll("button")
    .forEach((button, index) => {
      button.onclick = () => {
        readLang();
        lang = button.dataset.l;
        renderTabs();
        fillLang();
        preview();
        $("tab-" + lang).focus({ preventScroll: true });
      };
      button.onkeydown = (event) => {
        if (!["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const next =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? LOCALES.length - 1
              : (index +
                  (event.key === "ArrowRight" ? 1 : -1) +
                  LOCALES.length) %
                LOCALES.length;
        $("langTabs").querySelectorAll("button")[next].click();
      };
    });
}
function fillLang() {
  const t = cur.tr[lang];
  $("title").value = t.title;
  $("summary").value = t.summary;
  $("body").value = t.body;
  $("languageStatus").textContent =
    lang === cur.source_locale
      ? "원문 · 공지의 기본 표시 언어입니다."
      : "선택 입력 · 제목과 본문을 직접 작성한 언어만 표시합니다. 비워 두면 원문을 표시합니다.";
  $("titleCount").textContent = `${t.title.length} / 200`;
  ["title", "summary", "body"].forEach((id) => ($(id).lang = lang));
}
function readLang() {
  cur.tr[lang] = {
    title: $("title").value,
    summary: $("summary").value,
    body: $("body").value,
  };
}
function readFields() {
  readLang();
  cur.category = $("category").value;
  cur.status = $("status").value;
  if (!cur.id) cur.slug = $("slug").value.trim();
  const input = $("publishedAt").value.trim().replace(" ", "T");
  const parsed = new Date(input);
  cur.invalidDate =
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(input) ||
    !Number.isFinite(parsed.getTime()) ||
    (Number.isFinite(parsed.getTime()) &&
      toLocalInput(parsed.toISOString()).replace(" ", "T") !== input);
  if (!cur.invalidDate) cur.published_at = parsed.toISOString();
  cur.source_locale = $("sourceLocale").value;
  cur.pinned = $("pinned").value === "true";
  cur.template = $("template").value;
  const when = (id) => {
    const v = $(id).value.trim().replace(" ", "T");
    return v && Number.isFinite(Date.parse(v))
      ? new Date(v).toISOString()
      : undefined;
  };
  // Keep every style field so switching style back and forth loses nothing;
  // the site only reads what the chosen style shows.
  cur.meta = normalizeMeta({
    version: $("version").value,
    game_event_id: $("gameEvent").value,
    starts_at: when("eventStart"),
    ends_at: when("eventEnd"),
  });
  cur.invalidPeriod =
    !!$("eventStart").value &&
    !!$("eventEnd").value &&
    Date.parse(when("eventEnd") ?? 0) < Date.parse(when("eventStart") ?? 0);
}
function showStyleFields() {
  $("updateFields").hidden = cur.template !== "update";
  $("eventFields").hidden = cur.template !== "event";
}
// ---------- 대표 이미지 위치 (홈페이지와 같은 coverStyle로 잘라 보여준다) ----------
function renderCover() {
  const has = !!(cur.cover_image && safeImage(cur.cover_image));
  const frame = normalizeFrame(cur.cover_frame);
  const style = coverStyle(frame);
  const img = $("coverImg");
  img.hidden = !has;
  $("frameEmpty").hidden = has;
  $("frameCrops").hidden = !has;
  if (has) {
    if (img.getAttribute("src") !== cur.cover_image) img.src = cur.cover_image;
    img.setAttribute("style", style);
    document.querySelectorAll("#frameCrops img").forEach((crop) => {
      if (crop.getAttribute("src") !== cur.cover_image)
        crop.src = cur.cover_image;
      crop.setAttribute("style", style);
    });
  }
  $("frameZoom").value = String(frame.zoom);
  $("frameZoom").disabled = !has || !canWrite();
  $("frameReset").disabled = !has || !canWrite();
  $("frameZoomValue").textContent = `${Math.round(frame.zoom * 100)}%`;
  $("frameFocus").textContent = has
    ? `칸 안을 끌어 보이는 부분을 고르세요 · 가로 ${Math.round(frame.x)}% · 세로 ${Math.round(frame.y)}%`
    : "이미지를 고르면 위치와 확대를 조정할 수 있습니다.";
}
function setFrame(next) {
  if (!cur || !canWrite()) return;
  cur.cover_frame = normalizeFrame({ ...normalizeFrame(cur.cover_frame), ...next });
  markDirty();
  renderCover();
  preview();
}
let drag = null;
$("frameStage").addEventListener("pointerdown", (event) => {
  const img = $("coverImg");
  if (!cur || img.hidden || !img.naturalWidth || !canWrite()) return;
  event.preventDefault();
  $("frameStage").setPointerCapture(event.pointerId);
  const box = $("frameStage").getBoundingClientRect();
  drag = {
    id: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    start: normalizeFrame(cur.cover_frame),
    box,
    cover: coverSize(img.naturalWidth / img.naturalHeight, box.width, box.height),
  };
  $("frameStage").classList.add("dragging");
});
$("frameStage").addEventListener("pointermove", (event) => {
  if (!drag || event.pointerId !== drag.id) return;
  const f = drag.start;
  setFrame({
    x: f.x + dragFocus(f, event.clientX - drag.x, drag.box.width, drag.cover.w),
    y: f.y + dragFocus(f, event.clientY - drag.y, drag.box.height, drag.cover.h),
  });
});
const endDrag = () => {
  drag = null;
  $("frameStage").classList.remove("dragging");
};
$("frameStage").addEventListener("pointerup", endDrag);
$("frameStage").addEventListener("pointercancel", endDrag);
$("frameStage").addEventListener("keydown", (event) => {
  if (!cur?.cover_image || !canWrite()) return;
  const f = normalizeFrame(cur.cover_frame);
  const step = event.shiftKey ? 10 : 2;
  const moves = {
    ArrowLeft: { x: f.x - step },
    ArrowRight: { x: f.x + step },
    ArrowUp: { y: f.y - step },
    ArrowDown: { y: f.y + step },
    "+": { zoom: f.zoom + 0.1 },
    "=": { zoom: f.zoom + 0.1 },
    "-": { zoom: f.zoom - 0.1 },
    0: { zoom: 1, x: 50, y: 50 },
  };
  const next = moves[event.key];
  if (!next) return;
  event.preventDefault();
  setFrame(next);
});
$("frameZoom").max = String(COVER_ZOOM_MAX);
$("frameZoom").addEventListener("input", () =>
  setFrame({ zoom: Number($("frameZoom").value) }),
);
$("frameReset").onclick = () => setFrame({ zoom: 1, x: 50, y: 50 });
$("coverImg").addEventListener("load", () => {
  if (cur) renderCover();
});
$("template").addEventListener("change", async () => {
  const next = $("template").value;
  const tpl = TEMPLATES[next];
  const body = cur.tr[cur.source_locale].body;
  const untouched =
    !body.trim() ||
    Object.values(TEMPLATES).some((t) => t.body[cur.source_locale] === body);
  // A fresh template body is swapped for the new style's; written text is kept.
  if (untouched) {
    cur.tr[cur.source_locale].body = tpl.body[cur.source_locale] || "";
    if (!cur.id) {
      cur.category = tpl.category;
      cur.pinned = tpl.pinned;
    }
  }
  cur.template = next;
  dirty = true;
  show();
});
$("gameEvent").addEventListener("change", () => {
  const event = GAME_EVENTS.find((e) => e.id === $("gameEvent").value);
  if (event) {
    $("eventStart").value = toLocalInput(event.starts_at);
    $("eventEnd").value = toLocalInput(event.ends_at);
    if (!cur.tr[cur.source_locale].title.trim() && lang === cur.source_locale) {
      $("title").value = event.title;
      if (!$("summary").value.trim()) $("summary").value = event.subtitle;
    }
  }
  markDirty();
  readFields();
  preview();
});
["version", "eventStart", "eventEnd"].forEach((id) =>
  $(id).addEventListener("input", () => {
    markDirty();
    readFields();
    preview();
  }),
);
[
  "category",
  "status",
  "slug",
  "publishedAt",
  "pinned",
  "title",
  "summary",
  "body",
  "sourceLocale",
].forEach((id) =>
  $(id).addEventListener("input", () => {
    markDirty();
    readFields();
    if (id === "sourceLocale") {
      lang = cur.source_locale;
      renderTabs();
      fillLang();
    }
    if (id === "title")
      $("titleCount").textContent = `${$("title").value.length} / 200`;
    preview();
  }),
);
$("newNotice").onclick = () =>
  guard(() => {
    cur = blank();
    editGeneration++;
    lang = "ko";
    dirty = true;
    show();
  });

// ---------- 미리보기 (홈페이지의 목록 줄·팝업과 같은 구조) ----------
const safeImage = (u) => /^https:\/\/[^\s"'<>]+$/.test(u);
function preview() {
  if (!cur) return;
  const manual = cur.tr[lang].title && cur.tr[lang].body;
  const t = manual ? cur.tr[lang] : cur.tr[cur.source_locale];
  const date = dateTime(cur.published_at);
  const state = statusOf(cur);
  $("publishSummary").textContent = cur.invalidDate
    ? "게시 일시 형식을 확인하세요."
    : state === "draft"
      ? "임시저장 · 독자에게 공개되지 않습니다."
      : `${STATUS[state]} · ${date}부터 공개됩니다.`;
  $("save").textContent =
    state === "draft"
      ? "임시저장"
      : state === "scheduled"
        ? "예약 저장"
        : cur.id
          ? "변경 사항 게시"
          : "공지 게시";
  const cover = cur.cover_image && safeImage(cur.cover_image);
  const title = esc(t.title || "(제목)");
  const coverImg = cover
    ? `<img class="cover-img" src="${esc(cur.cover_image)}" alt="" style="${coverStyle(cur.cover_frame)}">`
    : `<span class="cover-empty" aria-hidden="true">${STAR}</span>`;
  const meta = normalizeMeta(cur.meta);
  const period = periodText(meta);
  const badge = eventBadge(meta);
  $("pvDialog").lang = manual ? lang : cur.source_locale;
  $("pvListLabel").textContent =
    cur.template === "event"
      ? "진행 중인 이벤트 카드"
      : cur.template === "update"
        ? "패치노트 표"
        : "공지 목록";
  $("pvRow").innerHTML =
    cur.template === "event"
      ? `<div class="pv-event"><div class="event-feature"><span class="cover-box">${coverImg}</span><span class="feature-shade"></span><span class="feature-copy">${badge ? `<span class="event-badge ${badge.cls}">${STAR}${esc(badge.label)}</span>` : ""}<strong>${title}</strong>${period ? `<span class="feature-period">${esc(period)}</span>` : ""}${t.summary ? `<span class="feature-summary">${esc(t.summary)}</span>` : ""}</span></div><div class="event-pick"><span class="cover-box">${coverImg}</span>${badge?.d ? `<span class="event-d">${esc(badge.d)}</span>` : ""}<strong>${title}</strong></div></div>`
      : cur.template === "update"
        ? `<div class="patch-table"><div class="patch-head"><span>버전</span><span>제목</span><span>작성일</span></div><div class="patch-row"><span class="patch-version">${meta.version ? esc(meta.version) : STAR}</span><strong>${title}<em class="new-chip">New</em></strong><time>${esc(date.slice(0, 10))}</time></div></div>`
        : `<div class="news-row${cover ? " has-cover" : ""}">${cover ? `<img class="news-thumb" src="${esc(cur.cover_image)}" alt="">` : ""}<span class="news-category">${cur.pinned ? "고정 · " : ""}${CATEGORY[cur.category]}</span><strong>${title}</strong><time>${esc(date)}</time></div>`;
  const hero =
    cur.template === "plain"
      ? ""
      : `<div class="notice-hero kind-${cur.template}${cover ? "" : " no-cover"}"><span class="cover-box">${coverImg}</span><span class="feature-shade"></span><span class="hero-copy">${cur.template === "update" && meta.version ? `<span class="event-badge">${esc(meta.version)}</span>` : ""}${cur.template === "event" && badge ? `<span class="event-badge ${badge.cls}">${STAR}${esc(badge.label)}</span>` : ""}</span></div>`;
  $("pvDialog").innerHTML =
    `${hero}<p class="eyebrow">GARDEN JOURNAL</p><h2>${title}</h2><time>${esc(date)}</time>${cur.template === "event" && period ? `<div class="notice-period"><strong>진행 기간</strong><p>${esc(period)}</p></div>` : ""}${!manual ? `<p class="hint">원문 미리보기</p>` : ""}${cover && cur.template === "plain" ? `<img class="notice-cover" src="${esc(cur.cover_image)}" alt="">` : ""}<div class="notice-body">${renderBody(t.body)}</div>`;
}
const STAR =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="m12 1 2.5 8.5L23 12l-8.5 2.5L12 23l-2.5-8.5L1 12l8.5-2.5z"/></svg>';
const kst = (iso) => {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("ko", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
      timeZone: "Asia/Seoul",
    })
      .formatToParts(new Date(iso))
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}.${p.month}.${p.day} ${p.hour}:${p.minute}`;
};
function periodText(meta) {
  if (!meta.starts_at && !meta.ends_at) return "";
  return `${meta.starts_at ? kst(meta.starts_at) : ""} ~ ${meta.ends_at ? kst(meta.ends_at) : ""} (KST)`;
}
// Same wording as the site badge (Korean preview).
function eventBadge(meta) {
  const phase = eventPhase(meta);
  if (phase === "ended") return { cls: "is-ended", label: "종료", d: "종료" };
  if (phase === "upcoming") {
    const left = meta.starts_at ? remaining(meta.starts_at) : null;
    return {
      cls: "is-soon",
      label: left?.days ? `${left.days}일 뒤 시작` : "곧 시작",
      d: "시작 예정",
    };
  }
  const left = meta.ends_at ? remaining(meta.ends_at) : null;
  if (!left) return null;
  return {
    cls: "",
    label: left.days
      ? `${left.days}일 ${left.hours}시간 남음`
      : `${left.hours}시간 ${left.minutes}분 남음`,
    d: `D-${left.days}`,
  };
}

// ---------- 저장 / 복제 / 삭제 ----------
function validate() {
  if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(cur.slug))
    return "주소(slug)는 영문 소문자·숫자·-만, 첫 글자는 영문/숫자여야 합니다.";
  const filled = LOCALES.filter(
    ([k]) => cur.tr[k].title.trim() && cur.tr[k].body.trim(),
  );
  if (!filled.length) return "한 언어 이상 제목과 본문을 채워야 합니다.";
  for (const [k] of LOCALES) {
    const t = cur.tr[k];
    if ((t.title.trim() || t.body.trim()) && !(t.title.trim() && t.body.trim()))
      return `${k}: 제목과 본문은 함께 채우거나 함께 비워야 합니다.`;
  }
  if (
    !cur.tr[cur.source_locale]?.title.trim() ||
    !cur.tr[cur.source_locale]?.body.trim()
  )
    return "원문 언어의 제목과 본문을 입력해 주세요.";
  if (cur.invalidDate)
    return "게시 일시를 선택해 주세요.";
  if (cur.template === "event" && cur.invalidPeriod)
    return "이벤트 종료 시각이 시작보다 빠릅니다.";
  return "";
}
$("save").onclick = async () => {
  if (!canWrite()) return;
  readFields();
  const bad = validate();
  if (bad) {
    setMsg(bad, true);
    return;
  }
  const generation = editGeneration;
  $("save").disabled = true;
  setMsg("공지와 언어별 원고를 저장하는 중…");
  try {
    const fields = {
      id: cur.id,
      slug: cur.slug,
      category: cur.category,
      status: cur.status,
      published_at: cur.published_at,
      cover_image: cur.cover_image,
      cover_frame: cur.cover_image ? normalizeFrame(cur.cover_frame) : null,
      meta: normalizeMeta(cur.meta),
      pinned: cur.pinned,
      template: cur.template,
      source_locale: cur.source_locale,
    };
    const translations = LOCALES.filter(
      ([id]) => cur.tr[id].title.trim() && cur.tr[id].body.trim(),
    ).map(([locale]) => ({ locale, ...cur.tr[locale] }));
    let saved;
    try {
      if (atomicSaveMissing) {
        const missing = new Error("save_website_notice unavailable");
        missing.code = "PGRST202";
        throw missing;
      }
      saved = await rest("rpc/save_website_notice", {
        method: "POST",
        json: {
          p_notice: fields,
          p_translations: translations,
          p_expected_updated_at: cur.updated_at || null,
        },
      });
    } catch (error) {
      if (error.code !== "PGRST202") throw error;
      atomicSaveMissing = true;
      saved = await saveLegacyNotice(
        rest,
        fields,
        translations,
        notices.find((n) => n.id === fields.id),
        (id) => {
          if (generation === editGeneration) cur.id = id;
        },
      );
    }
    if (generation !== editGeneration) return;
    cur.id = saved.id;
    cur.updated_at = saved.updated_at;
    for (const t of Object.values(cur.tr)) t.title = t.title.trim();
    dirty = false;
    await loadList();
    show();
    if (saved.legacy) {
      $("schemaNotice").hidden = false;
      setMsg(
        "저장했습니다. 기존 3개 언어 작성 모드이며, 동시 편집 보호는 DB 업데이트 후 사용할 수 있습니다.",
      );
    } else {
      $("schemaNotice").hidden = true;
      setMsg(
        styleColumns
          ? "공지를 저장했습니다."
          : "공지를 저장했습니다. 이미지 위치·패치 버전·이벤트 기간은 DB 업데이트(20261024100000_notice_styles.sql) 후 저장됩니다.",
        !styleColumns,
      );
    }
  } catch (error) {
    const message = error.message.includes("409")
      ? "같은 주소의 공지가 이미 있습니다. 주소를 변경해 주세요."
      : error.message === "migration_required"
        ? "추가 언어로 저장하려면 DB 업데이트가 필요합니다. 기존 한국어·영어·일본어 공지는 계속 저장할 수 있습니다."
        : error.message.includes("stale_notice")
          ? "다른 창에서 이 공지가 수정되었습니다. 원고를 복사한 후 목록을 새로 불러와 주세요."
          : error.message.includes("save_website_notice")
            ? "공지 저장 기능을 준비하는 DB 마이그레이션이 필요합니다. 원고는 화면에 유지됩니다."
            : error.message;
    setMsg(message, true);
  } finally {
    if (generation === editGeneration) $("save").disabled = !canWrite();
  }
};
$("dup").onclick = () => {
  readFields();
  const copy = { ...cur };
  guard(() => {
    open(
      {
        ...copy,
        website_notice_translations: [],
        tr: structuredClone(copy.tr),
      },
      true,
    );
    markDirty();
  });
};
$("remove").onclick = async () => {
  if (
    !cur?.id ||
    !(await ask(
      `「${cur.tr[cur.source_locale].title || cur.slug}」을(를) 삭제할까요? 되돌릴 수 없습니다. (게시를 내리기만 하려면 상태를 임시저장으로 바꾸세요)`,
    ))
  )
    return;
  try {
    await rest(`website_notices?id=eq.${cur.id}`, { method: "DELETE" });
    cur = null;
    dirty = false;
    $("editor").hidden = true;
    $("preview").hidden = true;
    $("empty").hidden = false;
    await loadList();
  } catch (e) {
    setMsg(e.message, true);
  }
};
function setMsg(t, bad) {
  $("msg").textContent = t;
  $("msg").className = "msg " + (bad ? "bad" : "ok");
}
window.addEventListener("beforeunload", (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

// ---------- 이미지 선택 (업로드 / 올린 이미지 / 포가든 원본) ----------
let pickCb = null;
let catalog = null;
const publicUrl = (path) =>
  `${BASE}/storage/v1/object/public/${BUCKET}/${path}`;
let pickerFocus;
function openPicker(cb) {
  pickerFocus = document.activeElement;
  pickCb = cb;
  $("picker").hidden = false;
  document.querySelector("#picker button").focus();
  tab("upload").catch((e) => ($("pickerBody").textContent = e.message));
}
function closePicker() {
  $("picker").hidden = true;
  pickCb = null;
  pickerFocus?.focus();
}
$("closePicker").onclick = closePicker;
$("pickCover").onclick = () =>
  openPicker((url) => {
    cur.cover_image = url;
    cur.cover_frame = null;
    markDirty();
    renderCover();
    preview();
  });
$("clearCover").onclick = () => {
  cur.cover_image = null;
  cur.cover_frame = null;
  markDirty();
  renderCover();
  preview();
};
$("insertImg").onclick = () =>
  openPicker((url, name) => {
    const ta = $("body");
    const at = ta.selectionStart ?? ta.value.length;
    const line = `![${name}](${url})`;
    const before = ta.value.slice(0, at).replace(/\s*$/, "");
    const after = ta.value.slice(at).replace(/^\s*/, "");
    ta.value = `${before}${before ? "\n\n" : ""}${line}${after ? "\n\n" : ""}${after}`;
    markDirty();
    readFields();
    preview();
  });
document
  .querySelectorAll("[data-tab]")
  .forEach(
    (b) =>
      (b.onclick = () =>
        tab(b.dataset.tab).catch(
          (e) => ($("pickerBody").textContent = e.message),
        )),
  );
async function tab(name) {
  document
    .querySelectorAll("[data-tab]")
    .forEach((b) => b.classList.toggle("ghost", b.dataset.tab !== name));
  $("gameGroup").hidden = name !== "game";
  const body = $("pickerBody");
  if (name === "upload") {
    body.innerHTML =
      '<p>webp·png·jpg·gif, 5MB 이하. 올리면 공개 저장소에 저장됩니다.</p><input type="file" id="file" accept="image/webp,image/png,image/jpeg,image/gif"><p class="msg" id="upMsg"></p>';
    $("file").onchange = async () => {
      const f = $("file").files[0];
      if (!f) return;
      $("upMsg").textContent = "올리는 중…";
      try {
        const url = await upload(f, f.name);
        finish(url, f.name.replace(/\.[^.]+$/, ""));
      } catch (e) {
        $("upMsg").textContent = e.message;
        $("upMsg").className = "msg bad";
      }
    };
  } else if (name === "recent") {
    body.textContent = "불러오는 중…";
    const r = await call(`/storage/v1/object/list/${BUCKET}`, {
      method: "POST",
      json: {
        prefix: "",
        limit: 100,
        sortBy: { column: "created_at", order: "desc" },
      },
    });
    const files = r.ok ? (await r.json()).filter((f) => f.name) : [];
    body.innerHTML = files.length
      ? `<div class="grid">${files.map((f) => `<button type="button" data-p="${esc(f.name)}"><img src="${esc(publicUrl(f.name))}" alt=""><small>${esc(f.name)}</small></button>`).join("")}</div>`
      : "<p>올린 이미지가 없습니다.</p>";
    body
      .querySelectorAll("[data-p]")
      .forEach(
        (b) =>
          (b.onclick = () =>
            finish(
              publicUrl(b.dataset.p),
              b.dataset.p.replace(/\.[^.]+$/, ""),
            )),
      );
  } else {
    catalog ??= await fetch("/catalog.json").then((r) => r.json());
    const groups = [...new Set(catalog.map((c) => c.group))];
    const label = {
      "game-bg": "배경",
      "game-content": "콘텐츠 원화",
      "game-item": "아이템",
      "game-currency": "재화",
      web: "홈페이지 아트(렐릭·세계관)",
    };
    const sel = $("gameGroup");
    if (!sel.options.length) {
      sel.innerHTML = groups
        .map((g) => `<option value="${g}">${label[g] ?? g}</option>`)
        .join("");
      sel.onchange = () => tab("game");
    }
    const items = catalog.filter((c) => c.group === sel.value);
    body.innerHTML = `<p style="color:var(--muted);font-size:12px">고르면 이미지를 공지 저장소로 복사해 씁니다(게임 파일이 바뀌어도 공지는 그대로). 캐릭터 전신·SD는 Puppet 파일이라 아직 불러올 수 없습니다.</p><div class="grid">${items.map((c, i) => `<button type="button" data-i="${i}"><img loading="lazy" src="${esc(c.url)}" alt=""><small>${esc(c.name)}</small></button>`).join("")}</div><p class="msg" id="gMsg"></p>`;
    body.querySelectorAll("[data-i]").forEach(
      (b) =>
        (b.onclick = async () => {
          const c = items[Number(b.dataset.i)];
          $("gMsg").textContent = "복사하는 중…";
          try {
            const blob = await fetch(c.url).then((r) => {
              if (!r.ok) throw new Error("원본을 불러오지 못했습니다.");
              return r.blob();
            });
            const ext = c.url.split(".").pop();
            finish(
              await upload(blob, `${c.group}-${c.name}.${ext}`, true),
              c.name,
            );
          } catch (e) {
            $("gMsg").textContent = e.message;
            $("gMsg").className = "msg bad";
          }
        }),
    );
  }
}
function finish(url, name) {
  const cb = pickCb;
  closePicker();
  cb?.(url, name);
}
async function upload(fileOrBlob, name, reuse = false) {
  const clean = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+/, "");
  const path = reuse ? clean : `${Date.now().toString(36)}-${clean}`;
  const type = fileOrBlob.type || "image/webp";
  const r = await call(`/storage/v1/object/${BUCKET}/${path}`, {
    method: "POST",
    body: fileOrBlob,
    headers: { "Content-Type": type, "x-upsert": "true" },
  });
  if (!r.ok)
    throw new Error(
      `업로드 실패 (${r.status}) 5MB 이하 이미지인지, 쓰기 권한이 있는지 확인하세요.`,
    );
  return publicUrl(path);
}

$("insertHeading").onclick = () => insertText("## 소제목");
$("insertList").onclick = () => insertText("- 항목 1\n- 항목 2");
function insertText(value) {
  const body = $("body");
  body.setRangeText(
    (body.value ? "\n\n" : "") + value,
    body.selectionStart,
    body.selectionEnd,
    "end",
  );
  markDirty();
  readFields();
  preview();
  body.focus();
}
$("picker").addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    closePicker();
    return;
  }
  if (event.key !== "Tab") return;
  const elements = [
    ...$("picker").querySelectorAll('button,input,[tabindex="0"]'),
  ].filter((e) => e.checkVisibility() && !e.disabled);
  const first = elements[0],
    last = elements.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
});
