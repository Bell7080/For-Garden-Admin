import { saveLegacyNotice } from "./shared/legacy-save.js";
import { languages as LOCALES } from "./shared/languages.js";
import { renderBody } from "./shared/notice-body.js";
// 공개(publishable) 키만 사용한다. service_role 키는 이 저장소에 절대 넣지 않는다.
// 토큰은 메모리에만 둔다(새로고침하면 다시 로그인). 권한은 DB의 RLS가 최종 판단한다.
const BASE = "https://rscxzfdnbdmftortrcqt.supabase.co";
const KEY = "sb_publishable_6GAse3Mlp_cQGukyOiLI7w_tfd4nZDH";
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
const blankTranslations = () =>
  Object.fromEntries(
    LOCALES.map(([id]) => [id, { title: "", summary: "", body: "" }]),
  );
$("sourceLocale").innerHTML = LOCALES.map(
  ([id, name]) => `<option value="${id}" lang="${id}">${name}</option>`,
).join("");
$("timeZone").textContent = Intl.DateTimeFormat().resolvedOptions().timeZone;
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
    const a = await rest("rpc/is_admin", { method: "POST", json: {} });
    if (a !== true) {
      session = null;
      throw new Error("이 계정은 관리자 권한이 없습니다.");
    }
    const roles = await rest("admin_roles?select=role");
    role =
      roles.find((r) => ["owner", "operator"].includes(r.role))?.role ??
      roles[0]?.role ??
      "";
    $("newNotice").disabled = !canWrite();
    $("login").hidden = true;
    $("app").hidden = false;
    $("who").textContent = `${session.email} · ${role}`;
    await loadList();
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
    pinned: n.pinned,
    template: n.template,
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
  $("template").disabled = !!cur.id;
  ["save", "dup", "remove", "pickCover", "clearCover", "insertImg"].forEach(
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
  $("template").disabled = !!cur.id || !canWrite();
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
}
function renderCover() {
  const img = $("coverImg");
  img.hidden = !cur.cover_image;
  if (cur.cover_image) img.src = cur.cover_image;
}
$("template").addEventListener("change", async () => {
  if (cur.id) return;
  const tpl = TEMPLATES[$("template").value];
  if (
    !(await ask("템플릿을 바꾸면 원문 본문과 분류가 바뀝니다. 계속할까요?"))
  ) {
    $("template").value = cur.template;
    return;
  }
  cur.template = $("template").value;
  cur.category = tpl.category;
  cur.pinned = tpl.pinned;
  cur.tr[cur.source_locale].body = tpl.body[cur.source_locale] || "";
  dirty = true;
  show();
});
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
  $("pvDialog").lang = manual ? lang : cur.source_locale;
  $("pvRow").innerHTML =
    `<div class="news-row${cover ? " has-cover" : ""}">${cover ? `<img class="news-thumb" src="${esc(cur.cover_image)}" alt="">` : ""}<span class="news-category">${cur.pinned ? "고정 · " : ""}${CATEGORY[cur.category]}</span><strong>${esc(t.title || "(제목)")}</strong><time>${esc(date)}</time></div>`;
  $("pvDialog").innerHTML =
    `<p class="eyebrow">GARDEN JOURNAL</p><h2>${esc(t.title || "(제목)")}</h2><time>${esc(date)}</time>${!manual ? `<p class="hint">원문 미리보기</p>` : ""}${cover ? `<img class="notice-cover" src="${esc(cur.cover_image)}" alt="">` : ""}<div class="notice-body">${renderBody(t.body)}</div>`;
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
    return "게시 일시는 YYYY-MM-DD HH:mm 형식으로 입력해 주세요.";
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
      setMsg("공지를 저장했습니다.");
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
    markDirty();
    renderCover();
    preview();
  });
$("clearCover").onclick = () => {
  cur.cover_image = null;
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
