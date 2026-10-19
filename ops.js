// 운영 도구(문의·계정·우편·쿠폰·운영 설정·감사 로그). 모든 쓰기는 DB의 보안 정의자 함수가 역할을 다시 확인한다.
// 여기서 버튼을 숨기는 것은 편의일 뿐이고, 권한의 최종 판단은 RLS와 함수가 한다.
import { enhanceDateTimes } from "./ui/datetime.js";

const STATUS = { open: "접수", in_progress: "처리 중", answered: "답변 완료", closed: "종료" };
const CATEGORY = { inquiry: "문의", bug: "버그", report: "신고", other: "기타" };
const PLAYER_STATUS = { active: "정상", suspended: "정지", banned: "영구 제한", deleted: "삭제됨" };
const prevNames = (p) => (Array.isArray(p.nickname_history) ? p.nickname_history.map((h) => h.name).filter(Boolean).reverse() : []);
const SOURCE = { game: "게임", web: "홈페이지" };
const ERRORS = {
  forbidden: "이 작업을 할 권한이 없습니다.",
  invalid_rewards: "보상 목록이 올바르지 않습니다. 종류·수량 상한을 확인하세요.",
  invalid_period: "종료 시각이 시작 시각보다 늦어야 합니다.",
  invalid_code: "쿠폰 코드는 영문·숫자 6~32자로 입력하세요.",
  invalid_count: "발급 수량은 1~1000 사이여야 합니다.",
  invalid_amount: "수량이 0이거나 한 번에 조정할 수 있는 상한을 넘었습니다.",
  invalid_status: "올바르지 않은 상태입니다.",
  invalid_text: "내용 길이를 확인하세요.",
  reason_required: "사유를 입력해야 합니다.",
  unknown_asset: "지급할 수 없는 재화입니다.",
  insufficient_balance: "보유량보다 많이 차감할 수 없습니다.",
  player_not_found: "계정을 찾을 수 없습니다.",
  not_found: "대상을 찾을 수 없습니다.",
  code_generation_failed: "코드 생성에 실패했습니다. 다시 시도하세요.",
  cannot_delete_staff: "운영진 계정은 삭제할 수 없습니다.",
  player_deleted: "이미 삭제된 계정입니다.",
  already_deleted: "이미 삭제된 계정입니다.",
};
const VIEWS = [
  { id: "notice", label: "공지", roles: ["owner", "operator", "cs", "viewer"], eyebrow: "CONTENT DESK", title: "공지 관리" },
  { id: "tickets", label: "문의·신고", roles: ["owner", "operator", "cs"], eyebrow: "SUPPORT DESK", title: "문의·신고" },
  { id: "players", label: "계정", roles: ["owner", "operator", "cs", "viewer"], eyebrow: "PLAYER DESK", title: "계정 관리" },
  { id: "mails", label: "우편", roles: ["owner", "operator", "cs", "viewer"], eyebrow: "REWARD DESK", title: "우편·보상 발송" },
  { id: "coupons", label: "쿠폰", roles: ["owner", "operator"], eyebrow: "REWARD DESK", title: "쿠폰 관리" },
  { id: "config", label: "운영 설정", roles: ["owner", "operator", "cs", "viewer"], eyebrow: "LIVE OPS", title: "운영 설정" },
  { id: "trash", label: "휴지통", roles: ["owner", "operator"], eyebrow: "ARCHIVE", title: "휴지통" },
  { id: "audit", label: "감사 로그", roles: ["owner"], eyebrow: "SECURITY", title: "감사 로그" },
];

let api = null; // { call, ask, esc, role }
let current = "notice";
let assetsCache = null;
const $ = (id) => document.getElementById(id);
const esc = (s) => api.esc(s);
const canWrite = () => ["owner", "operator"].includes(api.role);
const dt = (v) => (v ? new Intl.DateTimeFormat("ko", { dateStyle: "medium", timeStyle: "short" }).format(new Date(v)) : "—");
const num = (v) => Number(v).toLocaleString("ko");

function fmtLocal(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}
// "YYYY-MM-DD HH:mm"(기기 시간대) → ISO. 비었으면 null, 틀렸으면 예외.
function parseLocal(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  if (!/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(t)) throw new Error("시각은 YYYY-MM-DD HH:mm 형식으로 입력하세요.");
  const d = new Date(t.replace(" ", "T") + (t.length === 10 ? "T00:00" : ""));
  if (Number.isNaN(d.getTime())) throw new Error("올바르지 않은 시각입니다.");
  return d.toISOString();
}

async function rest(path) {
  const r = await api.call("/rest/v1/" + path);
  if (!r.ok) throw new Error(`불러오지 못했습니다 (${r.status})`);
  return r.json();
}
async function rpc(name, args) {
  const r = await api.call(`/rest/v1/rpc/${name}`, { method: "POST", json: args });
  const text = await r.text();
  let j = null;
  try {
    j = JSON.parse(text);
  } catch {}
  if (!r.ok) throw new Error(ERRORS[j?.message] || j?.message || `요청 실패 (${r.status})`);
  return j;
}
const notify = (id, text, bad = false) => {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.className = bad ? "msg bad" : "msg";
};
// 꾸밈 셀렉트(ui/controls.js)는 값을 코드로 바꾸면 다시 맞춰 주어야 한다.
const setVal = (el, value) => {
  el.value = value;
  el.dispatchEvent(new Event("fg:sync"));
};
async function assets() {
  if (!assetsCache) {
    const rows = await rest("reward_assets?select=asset,label,max_per_grant&enabled=eq.true&order=asset");
    // 재화가 먼저, 아이템(item:…)이 뒤에 선다.
    assetsCache = [...rows.filter((a) => !isItem(a.asset)), ...rows.filter((a) => isItem(a.asset))];
  }
  return assetsCache;
}
const isItem = (a) => String(a).startsWith("item:");
const assetLabel = (a) => assetsCache?.find((x) => x.asset === a)?.label ?? a;
const chips = (list) =>
  (list || []).map((r) => `<span class="chip">${esc(assetLabel(r.asset))} <b>${num(r.amount)}</b></span>`).join("") || '<span class="hint">보상 없음</span>';
const rewardPlain = (list) => (list || []).map((r) => `${assetLabel(r.asset)} ${num(r.amount)}`).join(", ") || "없음";

// 왼쪽 목록 + 오른쪽 상세. 공지 화면과 같은 틀이다.
function shell({ title, action = "", filters = "", hintId = "opsCount" }) {
  $("opsBody").innerHTML = `<div class="app ops-app"><aside class="side"><div class="side-heading"><h2>${esc(title)}</h2>${action}</div>${filters}<p class="hint" id="${hintId}" role="status"></p><div id="opsList"></div></aside><main class="ops-main" id="opsDetail"></main></div>`;
}
const placeholder = (text) => `<div class="empty-state ops-empty"><span class="archive-mark" aria-hidden="true">·</span><p class="hint">${esc(text)}</p></div>`;
function markSelected(id) {
  $("opsList")?.querySelectorAll(".nrow").forEach((b) => b.classList.toggle("on", b.dataset.id === id));
}
const TRASH_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="miter"><path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9.5h6.6L12 4M6.8 6.5v4.5M9.2 6.5v4.5"/></svg>';
const trashBtn = (id, label = "휴지통으로") => `<button class="btn danger" id="${id}" type="button">${TRASH_ICON} ${label}</button>`;
// 휴지통으로 보낸 뒤 목록에서 빼고 상세를 비운다.
async function sendToTrash(kind, id, name, reload, msgId) {
  if (!(await api.ask(`「${name}」을(를) 휴지통으로 보낼까요? 휴지통 탭에서 되살릴 수 있습니다.`))) return;
  try {
    await rpc("admin_trash_item", { p_kind: kind, p_id: id });
    $("opsDetail").innerHTML = placeholder("휴지통으로 보냈습니다.");
    await reload();
  } catch (e) {
    notify(msgId, e.message, true);
  }
}
const fail = (box, e) => (box.innerHTML = `<section class="card"><p class="msg bad">${esc(e.message)}</p></section>`);

// ───────── 보상 행 편집기 ─────────
function rewardEditor(host, list) {
  host.innerHTML = `<div class="reward-rows"></div><button class="btn ghost" type="button" data-add>+ 재화 추가</button>`;
  const rows = host.querySelector(".reward-rows");
  const add = (asset = list[0]?.asset, amount = "") => {
    const row = document.createElement("div");
    row.className = "reward-row";
    row.innerHTML = `<select aria-label="재화">${list.map((a) => `<option value="${esc(a.asset)}"${a.asset === asset ? " selected" : ""}>${esc(a.label)}</option>`).join("")}</select><input type="text" inputmode="numeric" aria-label="수량" placeholder="수량" value="${esc(amount)}" /><button class="btn ghost" type="button" data-rm>제거</button>`;
    row.querySelector("[data-rm]").onclick = () => row.remove();
    rows.append(row);
  };
  host.querySelector("[data-add]").onclick = () => add();
  add();
  return () =>
    [...rows.querySelectorAll(".reward-row")]
      .map((row) => ({ asset: row.querySelector("select").value, amount: Number(row.querySelector("input").value.replace(/,/g, "")) }))
      .filter((r) => r.amount > 0);
}

// ───────── 문의·신고 ─────────
async function viewTickets() {
  shell({
    title: "문의·신고",
    filters: `<input id="tkQuery" placeholder="번호(#12) 또는 제목 검색" autocomplete="off" aria-label="문의 검색" /><div class="filters"><select id="tkStatus" aria-label="상태"><option value="">상태 전체</option><option value="open">접수</option><option value="in_progress">처리 중</option><option value="answered">답변 완료</option><option value="closed">종료</option></select><select id="tkCat" aria-label="분류"><option value="">분류 전체</option><option value="inquiry">문의</option><option value="bug">버그</option><option value="report">신고</option><option value="other">기타</option></select></div><select id="tkSource" aria-label="접수 경로"><option value="">경로 전체</option><option value="game">게임</option><option value="web">홈페이지</option></select>`,
  });
  $("opsDetail").innerHTML = placeholder("목록에서 문의를 선택하세요.");
  const load = async () => {
    const f = [];
    for (const [id, col] of [["tkStatus", "status"], ["tkCat", "category"], ["tkSource", "source"]]) if ($(id).value) f.push(`${col}=eq.${$(id).value}`);
    const q = $("tkQuery").value.trim();
    if (/^#?\d{1,12}$/.test(q)) f.push(`ticket_no=eq.${q.replace("#", "")}`);
    else if (q) f.push(`subject=ilike.*${encodeURIComponent(q.replace(/[*,()%]/g, ""))}*`);
    try {
      const rows = await rest(`support_tickets?select=id,ticket_no,source,category,subject,status,created_at&deleted_at=is.null&order=created_at.desc&limit=100${f.length ? "&" + f.join("&") : ""}`);
      $("opsCount").textContent = `${rows.length}건`;
      $("opsList").innerHTML = rows.map((t) => `<button class="nrow" data-id="${esc(t.id)}"><span class="tag ${t.status === "open" ? "scheduled" : t.status === "answered" || t.status === "closed" ? "pub" : ""}">${STATUS[t.status]}</span><span class="tag">${CATEGORY[t.category]}</span><b>#${t.ticket_no} ${esc(t.subject)}</b><small>${SOURCE[t.source]} · ${esc(dt(t.created_at))}</small></button>`).join("") || '<p class="hint">조건에 맞는 문의가 없습니다.</p>';
      $("opsList").querySelectorAll(".nrow").forEach((b) => (b.onclick = () => openTicket(b.dataset.id)));
    } catch (e) {
      $("opsCount").textContent = e.message;
    }
  };
  ["tkStatus", "tkCat", "tkSource"].forEach((id) => ($(id).onchange = load));
  let timer;
  $("tkQuery").oninput = () => {
    clearTimeout(timer);
    timer = setTimeout(load, 300);
  };
  await load();
}
async function openTicket(id) {
  const box = $("opsDetail");
  markSelected(id);
  box.innerHTML = '<section class="card"><p class="hint">불러오는 중…</p></section>';
  try {
    const [[t], msgs] = await Promise.all([rest(`support_tickets?id=eq.${id}&select=*`), rest(`support_messages?ticket_id=eq.${id}&select=author_kind,body,created_at&order=id`)]);
    const [p] = t.player_id ? await rest(`players?id=eq.${t.player_id}&select=uid,nickname,status`) : [];
    const who = t.source === "web" ? `이메일 ${esc(t.contact_email)}` : `UID ${esc(p?.uid)} · ${esc(p?.nickname || "닉네임 없음")} · ${PLAYER_STATUS[p?.status] || ""}`;
    box.innerHTML = `<section class="card"><p class="eyebrow">TICKET #${t.ticket_no}</p><h2>${esc(t.subject)}</h2><p class="hint">${SOURCE[t.source]} · ${CATEGORY[t.category]} · ${STATUS[t.status]} · ${esc(dt(t.created_at))}</p><p class="hint">${who}${t.reported_uid ? ` · 신고 대상 UID ${esc(t.reported_uid)}` : ""}${t.app_version ? ` · v${esc(t.app_version)} ${esc(t.platform || "")}` : ""}</p><div class="thread"><div class="bubble player"><b>접수 내용</b><p>${esc(t.body)}</p></div>${msgs.map((m) => `<div class="bubble ${m.author_kind}"><b>${m.author_kind === "staff" ? "운영팀" : "플레이어"} · ${esc(dt(m.created_at))}</b><p>${esc(m.body)}</p></div>`).join("")}</div></section><section class="card">${t.source === "web" ? '<p class="hint">홈페이지 접수는 플레이어에게 자동 전달되지 않습니다. 기록해 둔 뒤 이메일로 직접 회신하세요.</p>' : ""}<label for="tkReply">답변</label><textarea id="tkReply" maxlength="4000" placeholder="플레이어에게 보일 답변을 작성하세요."></textarea><label for="tkNext">처리 후 상태</label><select id="tkNext"><option value="answered">답변 완료</option><option value="in_progress">처리 중</option><option value="closed">종료</option></select><div class="actions"><button class="btn primary" id="tkSend" type="button">답변 저장</button><button class="btn ghost" id="tkClose" type="button">답변 없이 종료</button><span class="spacer"></span>${canWrite() ? trashBtn("tkTrash") : ""}</div><p class="msg" id="tkMsg" role="status"></p></section>`;
    const refresh = async (text) => {
      await openTicket(id);
      if (text) notify("tkMsg", text);
      const row = $("opsList").querySelector(`[data-id="${id}"]`);
      if (row) {
        const [n] = await rest(`support_tickets?id=eq.${id}&select=status`);
        const tag = row.querySelector(".tag");
        tag.textContent = STATUS[n.status];
        tag.className = `tag ${n.status === "open" ? "scheduled" : n.status === "answered" || n.status === "closed" ? "pub" : ""}`;
      }
    };
    $("tkSend").onclick = async () => {
      try {
        await rpc("admin_reply_ticket", { p_id: id, p_body: $("tkReply").value, p_status: $("tkNext").value });
        await refresh("답변을 저장했습니다.");
      } catch (e) {
        notify("tkMsg", e.message, true);
      }
    };
    if ($("tkTrash")) $("tkTrash").onclick = () => sendToTrash("ticket", id, `#${t.ticket_no} ${t.subject}`, () => $("tkStatus").onchange(), "tkMsg");
    $("tkClose").onclick = async () => {
      if (!(await api.ask("이 문의를 답변 없이 종료할까요?"))) return;
      try {
        await rpc("admin_set_ticket_status", { p_id: id, p_status: "closed" });
        await refresh();
      } catch (e) {
        notify("tkMsg", e.message, true);
      }
    };
  } catch (e) {
    fail(box, e);
  }
}

// ───────── 계정 ─────────
async function viewPlayers() {
  shell({ title: "계정", filters: `<form class="ops-search" id="plForm"><input id="plQuery" placeholder="UID · 닉네임(이전 이름 포함) · 계정 ID" autocomplete="off" aria-label="계정 검색" /><button class="btn primary" type="submit">검색</button></form><select id="plStatus" aria-label="상태"><option value="">상태 전체</option><option value="active">정상</option><option value="suspended">정지</option><option value="banned">영구 제한</option><option value="deleted">삭제됨</option></select>` });
  $("opsDetail").innerHTML = placeholder("계정을 검색해 선택하세요.");
  $("plForm").onsubmit = async (e) => {
    e.preventDefault();
    const q = $("plQuery").value.trim();
    let filter = "order=created_at.desc";
    if (/^\d{1,15}$/.test(q)) filter = `uid=eq.${q}`;
    else if (/^[0-9a-f-]{36}$/i.test(q)) filter = `id=eq.${q}`;
    else if (q) {
      const term = encodeURIComponent(q.replace(/[*,()%]/g, "").toLowerCase());
      filter = `or=(nickname.ilike.*${term}*,search_names.ilike.*${term}*)`;
    }
    // 삭제된 계정은 상태를 「삭제됨」으로 고르거나 휴지통에서만 본다.
    filter += $("plStatus").value ? `&status=eq.${$("plStatus").value}` : "&status=neq.deleted";
    try {
      const rows = await rest(`players?select=id,uid,nickname,status,last_seen_at,level,nickname_history&limit=30&${filter}`);
      $("opsCount").textContent = `${rows.length}명`;
      $("opsList").innerHTML = rows.map((p) => `<button class="nrow" data-id="${esc(p.id)}"><span class="tag ${p.status === "active" ? "pub" : "scheduled"}">${PLAYER_STATUS[p.status]}</span><b>UID ${esc(p.uid)} ${esc(p.nickname || "이름 없음")}${p.level ? ` · Lv.${num(p.level)}` : ""}</b><small>마지막 접속 ${esc(dt(p.last_seen_at))}${prevNames(p).length ? ` · 이전 이름 ${esc(prevNames(p).slice(0, 3).join(", "))}` : ""}</small></button>`).join("") || '<p class="hint">검색 결과가 없습니다.</p>';
      $("opsList").querySelectorAll(".nrow").forEach((b) => (b.onclick = () => openPlayer(b.dataset.id)));
    } catch (err) {
      $("opsCount").textContent = err.message;
    }
  };
  $("plStatus").onchange = () => $("plForm").requestSubmit();
  $("plForm").requestSubmit();
}
async function openPlayer(id) {
  const box = $("opsDetail");
  markSelected(id);
  box.innerHTML = '<section class="card"><p class="hint">불러오는 중…</p></section>';
  try {
    const list = await assets();
    const staff = ["owner", "operator", "cs"].includes(api.role);
    const [[p], held, ledger, tickets, detail] = await Promise.all([
      rest(`players?id=eq.${id}&select=*`),
      staff ? rest(`player_assets?player_id=eq.${id}&select=asset,amount&order=asset`) : [],
      staff ? rest(`asset_ledger?player_id=eq.${id}&select=asset,delta,balance_after,reason,note,created_at&order=id.desc&limit=15`) : [],
      staff ? rest(`support_tickets?player_id=eq.${id}&select=ticket_no,subject,status&order=created_at.desc&limit=5`) : [],
      rpc("admin_player_detail", { p_player: id }).catch(() => null),
    ]);
    const deleted = p.status === "deleted";
    const names = prevNames(p);
    const targetStaff = detail?.staff === true;
    const wallet = detail?.hasSave ? Object.entries(detail.wallet || {}).filter(([, v]) => Number.isFinite(Number(v))) : [];
    // 가방의 아이템은 재화 뒤에 함께 세운다(키는 지급 목록과 같은 item:<ID>).
    const bag = detail?.hasSave ? (detail.items || []).filter((x) => x && Number(x.quantity) > 0).map((x) => [`item:${x.itemId}`, x.quantity]) : [];
    const pending = detail?.pending || [];
    box.innerHTML = `<section class="card"><p class="eyebrow">UID ${esc(p.uid)}</p><h2>${esc(p.nickname || "닉네임 없음")}</h2><p class="hint"><span class="tag ${p.status === "active" ? "pub" : "scheduled"}">${PLAYER_STATUS[p.status]}</span>${p.status_reason ? ` ${esc(p.status_reason)}` : ""}${p.status_until ? ` · ${esc(dt(p.status_until))}까지` : ""}</p><p class="hint">가입 ${esc(dt(p.created_at))} · 마지막 접속 ${esc(dt(p.last_seen_at))} · ${p.app_version ? `v${esc(p.app_version)} ${esc(p.platform || "")}` : "버전 정보 없음"}</p><p class="hint">${p.level ? `연구원 레벨 ${num(p.level)} · ` : ""}${names.length ? `이전 이름 ${esc(names.join(" → "))}` : "이름 변경 기록 없음"}</p>${deleted ? `<p class="hint">${esc(dt(p.deleted_at))} 삭제 · 사유 ${esc(p.deleted_reason || "-")}</p>` : ""}<p class="hint">계정 ID ${esc(p.id)}</p>${tickets.length ? `<h3>최근 문의</h3><div class="ledger">${tickets.map((t) => `<p><b>#${t.ticket_no}</b> ${esc(t.subject)} <small>${STATUS[t.status]}</small></p>`).join("")}</div>` : ""}</section><section class="card"><h3>보유 재화 <span class="hint">게임 저장 기준${detail?.savedAt ? ` · ${esc(dt(detail.savedAt))}` : ""}</span></h3><div class="stats">${[...wallet, ...bag].map(([k, v]) => `<div class="stat"><strong>${num(v)}</strong><span>${esc(assetLabel(k))}</span></div>`).join("") || (held.map((h) => `<div class="stat"><strong>${num(h.amount)}</strong><span>${esc(assetLabel(h.asset))}</span></div>`).join("")) || '<p class="hint">게임 저장이 없습니다.</p>'}</div>${pending.length ? `<h3>반영 대기</h3><div class="ledger">${pending.map((a) => `<p><b>${esc(assetLabel(a.asset))} ${a.delta > 0 ? "+" : ""}${num(a.delta)}</b> <small>${esc(a.note || "")} · ${esc(dt(a.createdAt))} · 접속 중이면 15초 안에 반영</small></p>`).join("")}</div>` : ""}<h3>최근 재화 기록</h3><div class="ledger">${ledger.map((l) => `<p><b>${esc(assetLabel(l.asset))} ${l.delta > 0 ? "+" : ""}${num(l.delta)}</b> → ${num(l.balance_after)} <small>${esc(l.reason)}${l.note ? ` · ${esc(l.note)}` : ""} · ${esc(dt(l.created_at))}</small></p>`).join("") || '<p class="hint">기록이 없습니다.</p>'}</div></section>${staff && !deleted ? `<section class="card"><h3>계정 상태</h3><div class="row2"><div><label for="plSt">상태</label><select id="plSt"><option value="active">정상</option><option value="suspended">정지</option>${canWrite() ? '<option value="banned">영구 제한</option>' : ""}</select></div><div><label for="plUntil">정지 해제 시각</label><input id="plUntil" data-datetime data-clearable data-presets="+1d,+3d,+7d,+30d" data-empty="비워두면 무기한" aria-label="정지 해제 시각" /></div></div><label for="plReason">사유 <span class="hint">플레이어에게 안내될 수 있습니다.</span></label><input id="plReason" maxlength="300" /><div class="actions"><button class="btn primary" id="plApply" type="button">상태 적용</button></div></section>` : ""}${canWrite() && !deleted ? `<section class="card"><h3>재화 조정</h3><div class="row2"><div><label for="adAsset">재화·아이템</label><select id="adAsset">${list.map((a) => `<option value="${esc(a.asset)}">${esc(a.label)}${isItem(a.asset) ? " (아이템)" : ""}</option>`).join("")}</select></div><div><label for="adDelta">수량</label><div class="amount-row"><div class="sign-toggle" role="group" aria-label="지급 또는 차감"><button type="button" class="on" data-sign="1" aria-pressed="true">+ 지급</button><button type="button" data-sign="-1" aria-pressed="false">− 차감</button></div><input id="adDelta" inputmode="numeric" placeholder="수량" /></div></div></div><label for="adReason">사유 (필수)</label><input id="adReason" maxlength="300" /><p class="hint">접속 중인 계정은 15초 안에, 아닌 계정은 다음 접속 때 반영되고 안내 팝업이 뜹니다.</p><div class="actions"><button class="btn primary" id="adApply" type="button">조정 적용</button></div></section>` : ""}${canWrite() && !deleted && targetStaff ? '<section class="card"><h3>계정 삭제</h3><p class="hint">운영진 계정은 삭제할 수 없습니다. 먼저 운영진 권한을 해제해야 합니다.</p></section>' : ""}${canWrite() && deleted ? `<section class="card"><h3>삭제된 계정</h3><p class="hint">되살리면 진행 데이터 없이 빈 계정으로 돌아오고, 영구 삭제하면 UID·이름 기록까지 지워 목록에서 사라집니다.</p><div class="actions"><button class="btn" id="plRestore" type="button">되살리기</button><span class="spacer"></span>${trashBtn("plPurge", "영구 삭제")}</div></section>` : ""}${canWrite() && !deleted && !targetStaff ? `<section class="card"><h3>계정 삭제</h3><p class="hint">진행 데이터·친구·길드 흔적을 지우고 복구할 수 없습니다. 접속 중이면 「계정이 삭제되었습니다」 팝업 후 타이틀로 돌아갑니다. UID·이름은 기록용으로 남습니다.</p><label for="dlReason">삭제 사유 (필수)</label><input id="dlReason" maxlength="300" placeholder="예: 테스트 계정" /><div class="actions"><button class="btn danger" id="dlApply" type="button">계정 삭제</button></div></section>` : ""}<p class="msg" id="plMsg" role="status"></p>`;
    if (staff && !deleted) {
      setVal($("plSt"), p.status);
      $("plApply").onclick = async () => {
        try {
          const until = parseLocal($("plUntil").value);
          if (!(await api.ask(`계정 상태를 「${PLAYER_STATUS[$("plSt").value]}」(으)로 바꿀까요?`))) return;
          await rpc("admin_set_player_status", { p_player: id, p_status: $("plSt").value, p_reason: $("plReason").value, p_until: until });
          await openPlayer(id);
          notify("plMsg", "적용했습니다.");
        } catch (e) {
          notify("plMsg", e.message, true);
        }
      };
    }
    enhanceDateTimes(box);
    if (canWrite() && deleted) {
      $("plRestore").onclick = async () => {
        try {
          if (!(await api.ask(`UID ${p.uid} 계정을 빈 계정으로 되살릴까요? 지워진 진행 데이터는 돌아오지 않습니다.`))) return;
          await rpc("admin_restore_item", { p_kind: "player", p_id: id });
          await openPlayer(id);
          notify("plMsg", "되살렸습니다.");
        } catch (e) {
          notify("plMsg", e.message, true);
        }
      };
      $("plPurge").onclick = async () => {
        try {
          if (!(await api.ask(`UID ${p.uid} ${p.nickname || ""} 기록을 영구 삭제할까요? 되돌릴 수 없습니다.`))) return;
          await rpc("admin_purge_item", { p_kind: "player", p_id: id });
          $("opsDetail").innerHTML = placeholder("영구 삭제했습니다.");
          $("plForm").requestSubmit();
        } catch (e) {
          notify("plMsg", e.message, true);
        }
      };
    }
    if (canWrite() && !deleted && !targetStaff) {
      $("dlApply").onclick = async () => {
        try {
          const reason = $("dlReason").value.trim();
          if (!reason) throw new Error("삭제 사유를 입력하세요.");
          if (!(await api.ask(`UID ${p.uid} ${p.nickname || ""} 계정을 삭제할까요? 되돌릴 수 없습니다.`))) return;
          await rpc("admin_delete_player", { p_player: id, p_reason: reason });
          await openPlayer(id);
          notify("plMsg", "삭제했습니다.");
        } catch (e) {
          notify("plMsg", e.message, true);
        }
      };
    }
    if (canWrite() && !deleted) {
      let sign = 1;
      box.querySelectorAll(".sign-toggle button").forEach((b) => {
        b.onclick = () => {
          sign = Number(b.dataset.sign);
          box.querySelectorAll(".sign-toggle button").forEach((o) => {
            o.classList.toggle("on", o === b);
            o.setAttribute("aria-pressed", String(o === b));
          });
        };
      });
      $("adApply").onclick = async () => {
        try {
          const amount = Number($("adDelta").value.replace(/,/g, ""));
          if (!Number.isInteger(amount) || amount <= 0) throw new Error("수량을 1 이상의 정수로 입력하세요.");
          const delta = amount * sign;
          if (!(await api.ask(`${assetLabel($("adAsset").value)} ${delta > 0 ? "+" : ""}${num(delta)}을(를) 적용할까요? 기록에 남습니다.`))) return;
          await rpc("admin_adjust_asset", { p_player: id, p_asset: $("adAsset").value, p_delta: delta, p_reason: $("adReason").value });
          await openPlayer(id);
          notify("plMsg", "조정을 대기열에 올렸습니다. 접속 중이면 곧 반영됩니다.");
        } catch (e) {
          notify("plMsg", e.message, true);
        }
      };
    }
  } catch (e) {
    fail(box, e);
  }
}

// ───────── 우편 ─────────
async function viewMails() {
  await assets();
  shell({ title: "우편", action: canWrite() ? '<button class="btn primary" id="opsNew" type="button">새 우편</button>' : "", filters: `<select id="mlFilter" aria-label="상태"><option value="">상태 전체</option><option value="active">발송</option><option value="cancelled">취소</option></select>` });
  $("opsDetail").innerHTML = placeholder(canWrite() ? "목록에서 우편을 선택하거나 새 우편을 작성하세요." : "목록에서 우편을 선택하세요.");
  if (canWrite()) $("opsNew").onclick = composeMail;
  $("mlFilter").onchange = loadMailList;
  await loadMailList();
}
async function loadMailList(selectId) {
  try {
    const f = $("mlFilter")?.value;
    const rows = await rest(`mails?select=id,title,rewards,target_player,status,starts_at,expires_at,created_at&deleted_at=is.null&order=created_at.desc&limit=60${f ? `&status=eq.${f}` : ""}`);
    $("opsCount").textContent = `${rows.length}건`;
    $("opsList").innerHTML = rows.map((m) => `<button class="nrow" data-id="${esc(m.id)}"><span class="tag ${m.status === "active" ? "pub" : ""}">${m.status === "active" ? "발송" : "취소"}</span><span class="tag">${m.target_player ? "개인" : "전체"}</span><b>${esc(m.title)}</b><small>${esc(dt(m.created_at))}</small></button>`).join("") || '<p class="hint">기록이 없습니다.</p>';
    $("opsList").querySelectorAll(".nrow").forEach((b) => (b.onclick = () => openMail(b.dataset.id)));
    markSelected(selectId);
  } catch (e) {
    $("opsList").innerHTML = `<p class="msg bad">${esc(e.message)}</p>`;
  }
}
async function openMail(id) {
  const box = $("opsDetail");
  markSelected(id);
  box.innerHTML = '<section class="card"><p class="hint">불러오는 중…</p></section>';
  try {
    await assets();
    const [[m], claims] = await Promise.all([rest(`mails?id=eq.${id}&select=*`), rest(`mail_claims?mail_id=eq.${id}&select=player_id&limit=1000`)]);
    let target = "전체 플레이어";
    if (m.target_player) {
      const [p] = await rest(`players?id=eq.${m.target_player}&select=uid,nickname`);
      target = `UID ${p?.uid ?? "?"} ${p?.nickname || ""}`;
    }
    box.innerHTML = `<section class="card"><p class="eyebrow">MAIL</p><h2>${esc(m.title)}</h2><p class="hint"><span class="tag ${m.status === "active" ? "pub" : ""}">${m.status === "active" ? "발송" : "취소"}</span> ${esc(target)} · ${esc(dt(m.starts_at))} ~ ${esc(dt(m.expires_at))}${!m.target_player ? (m.include_new_accounts ? " · 신규 가입 계정 포함" : " · 기존 계정만") : ""}</p><p class="mail-body">${esc(m.body)}</p><h3>첨부 보상</h3><div class="chips">${chips(m.rewards)}</div><p class="hint">수령 ${num(claims.length)}${claims.length >= 1000 ? "명 이상" : "명"}</p>${canWrite() ? `<div class="actions">${m.status === "active" ? '<button class="btn ghost" id="mlCancel" type="button">발송 취소</button>' : ""}<span class="spacer"></span>${trashBtn("mlTrash")}</div>` : ""}<p class="msg" id="mlMsg" role="status"></p></section>`;
    if ($("mlTrash")) $("mlTrash").onclick = () => sendToTrash("mail", id, m.title, () => loadMailList(), "mlMsg");
    if ($("mlCancel"))
      $("mlCancel").onclick = async () => {
        if (!(await api.ask("이 우편을 취소할까요? 아직 받지 않은 플레이어는 받을 수 없게 됩니다."))) return;
        try {
          await rpc("admin_cancel_mail", { p_id: id });
          await loadMailList(id);
          await openMail(id);
        } catch (e) {
          notify("mlMsg", e.message, true);
        }
      };
  } catch (e) {
    fail(box, e);
  }
}
async function composeMail() {
  markSelected(null);
  const list = await assets();
  $("opsDetail").innerHTML = `<section class="card"><h2>새 우편</h2><label for="mlTitle">제목</label><input id="mlTitle" maxlength="80" /><label for="mlBody">내용</label><textarea id="mlBody" maxlength="2000"></textarea><label>첨부 보상 <span class="hint">없으면 알림 우편이 됩니다.</span></label><div id="mlRewards"></div><div class="row2"><div><label for="mlTarget">받는 UID</label><input id="mlTarget" inputmode="numeric" autocomplete="off" placeholder="비워두면 전체 발송" /></div><div><label for="mlDays">보관 기간</label><select id="mlDays"><option value="7">7일</option><option value="14">14일</option><option value="30" selected>30일</option><option value="90">90일</option><option value="custom">날짜 직접 지정</option></select><input id="mlExpire" data-datetime data-presets="+7d,+30d,+90d,today23" data-empty="만료 일시를 고르세요" aria-label="우편 만료 일시" hidden /></div></div><label for="mlStart">발송 시각</label><input id="mlStart" data-datetime data-clearable data-presets="now,+1h,tomorrow9,nextMonday9" data-empty="비워두면 즉시 발송" aria-label="발송 시각" /><div id="mlNewBox"><label class="check"><input type="checkbox" id="mlNew" /> 발송 이후 만료 전까지 새로 가입한 계정도 받기</label><p class="hint">끄면 우편이 시작되기 전에 만들어진 계정만 받습니다. 특정 UID 발송에는 적용되지 않습니다.</p></div><div class="actions"><button class="btn primary" id="mlSend" type="button">발송</button></div><p class="msg" id="mlMsg" role="status"></p></section>`;
  const readRewards = rewardEditor($("mlRewards"), list);
  enhanceDateTimes($("opsDetail"));
  const customExpire = () => $("mlDays").value === "custom";
  const syncExpire = () => {
    const host = $("mlExpire").closest(".fg-dt") || $("mlExpire");
    host.hidden = !customExpire();
  };
  $("mlDays").onchange = syncExpire;
  syncExpire();
  const syncNew = () => ($("mlNewBox").hidden = $("mlTarget").value.trim() !== "");
  $("mlTarget").oninput = syncNew;
  syncNew();
  $("mlSend").onclick = async () => {
    try {
      const uid = $("mlTarget").value.trim();
      let target = null;
      let who = "전체 플레이어";
      if (uid) {
        if (!/^\d{1,15}$/.test(uid)) throw new Error("UID는 숫자로 입력하세요.");
        const [p] = await rest(`players?uid=eq.${uid}&select=id,nickname`);
        if (!p) throw new Error("해당 UID의 계정이 없습니다.");
        target = p.id;
        who = `UID ${uid} ${p.nickname || ""}`;
      }
      const starts = parseLocal($("mlStart").value);
      const base = starts ? new Date(starts) : new Date();
      let expires;
      if (customExpire()) {
        expires = parseLocal($("mlExpire").value);
        if (!expires) throw new Error("우편 만료 일시를 고르세요.");
        if (new Date(expires) <= base) throw new Error("만료 일시는 발송 시각보다 늦어야 합니다.");
      } else {
        expires = new Date(base.getTime() + Number($("mlDays").value) * 86400000).toISOString();
      }
      const rewards = readRewards();
      if (!(await api.ask(`${who}에게 우편을 보낼까요?\n보상: ${rewardPlain(rewards)}`))) return;
      await rpc("admin_send_mail", { p_title: $("mlTitle").value, p_body: $("mlBody").value, p_rewards: rewards, p_target: target, p_starts: starts, p_expires: expires, p_include_new: !uid && $("mlNew").checked });
      await loadMailList();
      $("opsDetail").innerHTML = `<section class="card"><p class="msg">발송했습니다.</p></section>`;
    } catch (e) {
      notify("mlMsg", e.message, true);
    }
  };
}

// ───────── 쿠폰 ─────────
async function viewCoupons() {
  await assets();
  shell({ title: "쿠폰", action: '<button class="btn primary" id="opsNew" type="button">새 쿠폰</button>', filters: `<select id="cpFilter" aria-label="상태"><option value="">상태 전체</option><option value="active">사용 가능</option><option value="disabled">중지</option></select>` });
  $("opsDetail").innerHTML = placeholder("목록에서 쿠폰을 선택하거나 새 쿠폰을 만드세요.");
  $("opsNew").onclick = composeCoupon;
  $("cpFilter").onchange = () => loadCouponList();
  await loadCouponList();
}
const couponPeriod = (c) => `${esc(dt(c.starts_at))} ~ ${c.ends_at ? esc(dt(c.ends_at)) : "제한 없음"}`;
async function loadCouponList(selectId) {
  try {
    const f = $("cpFilter")?.value;
    const rows = await rest(`coupons?select=id,name,kind,rewards,starts_at,ends_at,max_redemptions,redeemed_count,status&deleted_at=is.null&order=created_at.desc&limit=60${f ? `&status=eq.${f}` : ""}`);
    $("opsCount").textContent = `${rows.length}개`;
    $("opsList").innerHTML = rows.map((c) => `<button class="nrow" data-id="${esc(c.id)}"><span class="tag ${c.status === "active" ? "pub" : ""}">${c.status === "active" ? "사용 가능" : "중지"}</span><span class="tag">${c.kind === "shared" ? "공용" : "일회용"}</span><b>${esc(c.name)}</b><small>사용 ${num(c.redeemed_count)}${c.max_redemptions ? ` / ${num(c.max_redemptions)}` : ""} · ${c.ends_at ? esc(dt(c.ends_at)) + " 종료" : "기한 없음"}</small></button>`).join("") || '<p class="hint">쿠폰이 없습니다.</p>';
    $("opsList").querySelectorAll(".nrow").forEach((b) => (b.onclick = () => openCoupon(b.dataset.id)));
    markSelected(selectId);
  } catch (e) {
    $("opsList").innerHTML = `<p class="msg bad">${esc(e.message)}</p>`;
  }
}
async function openCoupon(id, { created = false } = {}) {
  const box = $("opsDetail");
  markSelected(id);
  box.innerHTML = '<section class="card"><p class="hint">불러오는 중…</p></section>';
  try {
    const [c] = await rest(`coupons?id=eq.${id}&select=*`);
    const total = (await rest(`coupon_codes?coupon_id=eq.${id}&select=id,redeemed_by&limit=1000`));
    const used = total.filter((x) => x.redeemed_by).length;
    box.innerHTML = `<section class="card"><p class="eyebrow">COUPON · ${c.kind === "shared" ? "공용 코드" : "일회용 코드"}</p><h2>${esc(c.name)}</h2><p class="hint"><span class="tag ${c.status === "active" ? "pub" : ""}">${c.status === "active" ? "사용 가능" : "중지"}</span> ${couponPeriod(c)}</p><h3>보상</h3><div class="chips">${chips(c.rewards)}</div><p class="hint">${c.kind === "shared" ? `사용 ${num(c.redeemed_count)}${c.max_redemptions ? ` / ${num(c.max_redemptions)}` : " (총 횟수 제한 없음)"} · 1인 1회` : `코드 ${num(total.length)}개 중 ${num(used)}개 사용`}</p><div class="actions"><button class="btn" id="cpReveal" type="button">코드 보기</button><button class="btn ghost" id="cpToggle" type="button">${c.status === "active" ? "중지" : "다시 사용"}</button><span class="spacer"></span>${trashBtn("cpTrash")}</div><p class="msg" id="cpMsg" role="status"></p><div id="cpCodesBox"></div></section>`;
    $("cpTrash").onclick = () => sendToTrash("coupon", id, c.name, () => loadCouponList(), "cpMsg");
    $("cpToggle").onclick = async () => {
      try {
        await rpc("admin_set_coupon_status", { p_id: id, p_status: c.status === "active" ? "disabled" : "active" });
        await loadCouponList(id);
        await openCoupon(id);
      } catch (e) {
        notify("cpMsg", e.message, true);
      }
    };
    const reveal = async () => {
      try {
        const rows = await rpc("admin_reveal_coupon_codes", { p_id: id });
        const known = rows.filter((r) => r.code);
        const unknown = rows.length - known.length;
        $("cpCodesBox").innerHTML = `<div class="code-result"><p class="hint">열람은 감사 로그에 기록됩니다.${unknown ? ` 이전 방식으로 발급된 ${num(unknown)}개는 코드를 확인할 수 없습니다.` : ""}</p><ul class="code-list">${known.map((r) => `<li class="${r.used ? "used" : ""}"><code>${esc(r.code)}</code>${r.used ? `<small>사용됨 · ${esc(dt(r.used_at))}</small>` : ""}</li>`).join("")}</ul>${known.length ? '<div class="actions"><button class="btn" id="cpCopy" type="button">모두 복사</button><button class="btn ghost" id="cpCopyLeft" type="button">미사용만 복사</button></div>' : ""}</div>`;
        const copy = async (items) => {
          try {
            await navigator.clipboard.writeText(items.map((r) => r.code).join("\n"));
            notify("cpMsg", `${items.length}개를 복사했습니다.`);
          } catch {
            notify("cpMsg", "복사 권한이 없습니다. 코드를 직접 선택해 복사하세요.", true);
          }
        };
        if ($("cpCopy")) {
          $("cpCopy").onclick = () => copy(known);
          $("cpCopyLeft").onclick = () => copy(known.filter((r) => !r.used));
        }
        $("cpReveal").textContent = "코드 숨기기";
        $("cpReveal").onclick = () => {
          $("cpCodesBox").innerHTML = "";
          $("cpReveal").textContent = "코드 보기";
          $("cpReveal").onclick = reveal;
        };
      } catch (e) {
        notify("cpMsg", e.message, true);
      }
    };
    $("cpReveal").onclick = reveal;
    if (created) {
      notify("cpMsg", "쿠폰을 만들었습니다.");
      await reveal();
    }
  } catch (e) {
    fail(box, e);
  }
}
async function composeCoupon() {
  markSelected(null);
  const list = await assets();
  const now = new Date();
  $("opsDetail").innerHTML = `<section class="card"><h2>새 쿠폰</h2><label for="cpName">쿠폰 이름 <span class="hint">운영자만 봅니다.</span></label><input id="cpName" maxlength="80" /><div class="row2"><div><label for="cpKind">종류</label><select id="cpKind"><option value="shared">공용 코드 (1인 1회)</option><option value="single">일회용 코드 (코드마다 한 명)</option></select></div><div id="cpSharedBox"><label for="cpCode">공용 코드 <span class="hint">영문·숫자 6~32자</span></label><input id="cpCode" maxlength="40" autocomplete="off" spellcheck="false" /></div><div id="cpSingleBox" hidden><label for="cpCount">발급 수량 <span class="hint">1~1000</span></label><input id="cpCount" inputmode="numeric" value="100" /></div></div><label>보상</label><div id="cpRewards"></div><div class="row2"><div><label for="cpStart">시작 시각</label><input id="cpStart" value="${fmtLocal(now)}" data-datetime data-clearable data-presets="now,+1h,tomorrow9" data-empty="비워두면 지금 시작" aria-label="쿠폰 시작 시각" /></div><div><label for="cpEnd">종료 시각</label><input id="cpEnd" value="${fmtLocal(new Date(now.getTime() + 30 * 86400000))}" data-datetime data-presets="+7d,+30d,+90d,today23" aria-label="쿠폰 종료 시각" /><label class="check"><input type="checkbox" id="cpNoEnd" /> 기한 제한 없음</label></div></div><div id="cpMaxBox"><label for="cpMax">총 사용 가능 수 <span class="hint">공용 코드만</span></label><input id="cpMax" inputmode="numeric" placeholder="비워두면 제한 없음" /></div><div class="actions"><button class="btn primary" id="cpCreate" type="button">쿠폰 만들기</button></div><p class="msg" id="cpMsg" role="status"></p></section>`;
  const readRewards = rewardEditor($("cpRewards"), list);
  enhanceDateTimes($("opsDetail"));
  const sync = () => {
    const single = $("cpKind").value === "single";
    $("cpSharedBox").hidden = single;
    $("cpSingleBox").hidden = !single;
    $("cpMaxBox").hidden = single;
    $("cpEnd").disabled = $("cpNoEnd").checked;
  };
  $("cpKind").onchange = sync;
  $("cpNoEnd").onchange = sync;
  sync();
  $("cpCreate").onclick = async () => {
    try {
      const single = $("cpKind").value === "single";
      const rewards = readRewards();
      if (!rewards.length) throw new Error("보상을 하나 이상 입력하세요.");
      const max = $("cpMax").value.trim() ? Number($("cpMax").value) : null;
      if (!single && max !== null && (!Number.isInteger(max) || max < 1)) throw new Error("총 사용 가능 수는 1 이상의 정수여야 합니다.");
      const ends = $("cpNoEnd").checked ? null : parseLocal($("cpEnd").value);
      if (!$("cpNoEnd").checked && !ends) throw new Error("종료 시각을 입력하거나 '기한 제한 없음'을 선택하세요.");
      if (!(await api.ask(single ? `일회용 코드 ${$("cpCount").value}개를 만들까요?` : "공용 쿠폰을 만들까요?"))) return;
      const r = await rpc("admin_create_coupon", { p_name: $("cpName").value, p_kind: $("cpKind").value, p_rewards: rewards, p_starts: parseLocal($("cpStart").value), p_ends: ends, p_max: single ? null : max, p_code: single ? null : $("cpCode").value, p_count: single ? Number($("cpCount").value) : null });
      await loadCouponList(r.id);
      await openCoupon(r.id, { created: true });
    } catch (e) {
      notify("cpMsg", e.message, true);
    }
  };
}

// ───────── 운영 설정 ─────────
async function viewConfig() {
  const [c] = await rest("app_config?select=*&id=eq.1");
  const ro = canWrite() ? "" : " disabled";
  $("opsBody").innerHTML = `<div class="ops-single"><section class="card"><p class="eyebrow">LIVE OPS</p><h2>점검과 최소 버전</h2><p class="hint"><span class="tag ${c.maintenance ? "scheduled" : "pub"}">${c.maintenance ? "점검 중" : "정상 운영"}</span> 점검 중에는 게임이 시작 화면에서 안내 문구를 보여 줍니다. 최소 버전보다 낮은 앱은 업데이트 안내를 받습니다.</p><label for="cfMaint">점검 상태</label><select id="cfMaint"${ro}><option value="false">정상 운영</option><option value="true">점검 중</option></select><label for="cfMsg">점검 안내 문구</label><textarea id="cfMsg" maxlength="500"${ro}>${esc(c.maintenance_message)}</textarea><label for="cfEnds">점검 종료 예정</label><input id="cfEnds" data-datetime data-clearable data-presets="+1h,+2h,+6h,tomorrow9" data-empty="비워두면 미정" aria-label="점검 종료 예정" value="${c.maintenance_ends_at ? fmtLocal(new Date(c.maintenance_ends_at)) : ""}"${ro} /><div class="row2"><div><label for="cfMin">최소 지원 버전</label><input id="cfMin" value="${esc(c.min_app_version)}" placeholder="0.0.0"${ro} /></div><div><label for="cfLatest">최신 버전</label><input id="cfLatest" value="${esc(c.latest_app_version)}" placeholder="0.0.0"${ro} /></div></div>${canWrite() ? '<div class="actions"><button class="btn primary" id="cfSave" type="button">저장</button></div>' : '<p class="hint">조회만 가능한 권한입니다.</p>'}<p class="msg" id="cfNote" role="status">마지막 수정 ${esc(dt(c.updated_at))}</p></section></div>`;
  setVal($("cfMaint"), String(c.maintenance));
  enhanceDateTimes($("opsBody"));
  if (!canWrite()) return;
  $("cfSave").onclick = async () => {
    try {
      const re = /^\d+\.\d+\.\d+$/;
      if (!re.test($("cfMin").value) || !re.test($("cfLatest").value)) throw new Error("버전은 1.2.3 형식으로 입력하세요.");
      const on = $("cfMaint").value === "true";
      if (!(await api.ask(on ? "점검을 시작할까요? 모든 플레이어에게 점검 안내가 표시됩니다." : "설정을 저장할까요?"))) return;
      await rpc("admin_set_config", { p_maintenance: on, p_message: $("cfMsg").value, p_ends_at: parseLocal($("cfEnds").value), p_min_version: $("cfMin").value, p_latest_version: $("cfLatest").value });
      await viewConfig();
      notify("cfNote", "저장했습니다.");
    } catch (e) {
      notify("cfNote", e.message, true);
    }
  };
}

// ───────── 휴지통 ─────────
const TRASH_KIND = { ticket: "문의·신고", notice: "공지", mail: "우편", player: "계정", coupon: "쿠폰" };
async function viewTrash() {
  const rows = await rpc("admin_trash_list", {});
  $("opsBody").innerHTML = `<div class="ops-single"><section class="card"><p class="eyebrow">ARCHIVE</p><h2>휴지통</h2><p class="hint">지운 문의·공지·우편·쿠폰·계정이 모입니다. 되살리거나 영구 삭제할 수 있습니다. 되살린 쿠폰은 중지, 공지는 임시저장 상태로 돌아옵니다.</p><div class="filters"><select id="trFilter" aria-label="종류"><option value="">종류 전체</option>${Object.entries(TRASH_KIND).map(([k, v]) => `<option value="${k}">${v}</option>`).join("")}</select></div><p class="hint" id="trCount" role="status"></p><div id="trList"></div><p class="msg" id="trMsg" role="status"></p></section></div>`;
  const draw = () => {
    const f = $("trFilter").value;
    const shown = rows.filter((r) => !f || r.kind === f);
    $("trCount").textContent = `${shown.length}건`;
    $("trList").innerHTML = shown.map((r) => `<div class="trash-row" data-kind="${esc(r.kind)}" data-id="${esc(r.id)}"><span class="tag">${esc(TRASH_KIND[r.kind] || r.kind)}</span><div class="trash-text"><b>${esc(r.title)}</b><small>${esc(dt(r.deletedAt))} 삭제${r.sub ? ` · ${esc(r.sub)}` : ""}</small></div><button class="btn" type="button" data-restore>되살리기</button>${trashBtn("", "영구 삭제").replace(' id=""', " data-purge")}</div>`).join("") || '<p class="hint">휴지통이 비어 있습니다.</p>';
    $("trList").querySelectorAll(".trash-row").forEach((row) => {
      const { kind, id } = row.dataset;
      const item = rows.find((r) => r.id === id);
      const done = (text) => {
        rows.splice(rows.indexOf(item), 1);
        draw();
        notify("trMsg", text);
      };
      row.querySelector("[data-restore]").onclick = async () => {
        try {
          await rpc("admin_restore_item", { p_kind: kind, p_id: id });
          done("되살렸습니다.");
        } catch (e) {
          notify("trMsg", e.message, true);
        }
      };
      row.querySelector("[data-purge]").onclick = async () => {
        try {
          if (!(await api.ask(`「${item.title}」을(를) 영구 삭제할까요? 되돌릴 수 없습니다.`))) return;
          await rpc("admin_purge_item", { p_kind: kind, p_id: id });
          done("영구 삭제했습니다.");
        } catch (e) {
          notify("trMsg", e.message, true);
        }
      };
    });
  };
  $("trFilter").onchange = draw;
  draw();
}

// ───────── 감사 로그 ─────────
const AUDIT_LABEL = { ticket_reply: "문의 답변", ticket_status: "문의 상태", coupon_create: "쿠폰 생성", coupon_status: "쿠폰 상태", coupon_reveal: "쿠폰 코드 열람", config_update: "운영 설정", mail_send: "우편 발송", mail_cancel: "우편 취소", player_status: "계정 상태", asset_adjust: "재화 조정", player_delete: "계정 삭제", trash_move: "휴지통 이동", trash_restore: "휴지통 복구", trash_purge: "영구 삭제" };
async function viewAudit() {
  const rows = await rest("admin_audit_log?select=id,actor,action,target,detail,at&order=id.desc&limit=200");
  const actions = [...new Set(rows.map((r) => r.action))];
  $("opsBody").innerHTML = `<div class="ops-single"><section class="card"><p class="eyebrow">SECURITY</p><h2>감사 로그</h2><p class="hint">최근 200건 · 소유자만 볼 수 있습니다.</p><select id="auFilter" aria-label="작업 종류"><option value="">작업 전체</option>${actions.map((a) => `<option value="${esc(a)}">${esc(AUDIT_LABEL[a] || a)}</option>`).join("")}</select><div id="auList"></div></section></div>`;
  const draw = () => {
    const f = $("auFilter").value;
    $("auList").innerHTML = rows.filter((r) => !f || r.action === f).map((r) => `<div class="nrow static"><span class="tag">${esc(AUDIT_LABEL[r.action] || r.action)}</span><b>${esc(r.target)}</b><small>${esc(dt(r.at))} · 담당 ${esc(String(r.actor || "").slice(0, 8))}</small><small class="detail">${esc(JSON.stringify(r.detail || {})).slice(0, 300)}</small></div>`).join("") || '<p class="hint">기록이 없습니다.</p>';
  };
  $("auFilter").onchange = draw;
  draw();
}

const RENDER = { tickets: viewTickets, players: viewPlayers, mails: viewMails, coupons: viewCoupons, config: viewConfig, trash: viewTrash, audit: viewAudit };

export async function openView(id) {
  const view = VIEWS.find((v) => v.id === id && v.roles.includes(api.role));
  if (!view) return;
  current = id;
  $("deskEyebrow").textContent = view.eyebrow;
  $("deskTitle").textContent = view.title;
  $("viewNotice").hidden = id !== "notice";
  $("viewOps").hidden = id === "notice";
  $("mainNav").querySelectorAll("button").forEach((b) => {
    b.classList.toggle("on", b.dataset.view === id);
    b.setAttribute("aria-selected", String(b.dataset.view === id));
  });
  if (id === "notice") return;
  $("opsBody").innerHTML = '<p class="hint ops-loading">불러오는 중…</p>';
  try {
    await RENDER[id]();
  } catch (e) {
    if (current === id) $("opsBody").innerHTML = `<p class="msg bad ops-loading">${esc(e.message)}</p>`;
  }
}

export function mountOps(options) {
  api = options;
  assetsCache = null;
  const allowed = VIEWS.filter((v) => v.roles.includes(api.role));
  $("mainNav").innerHTML = allowed.map((v) => `<button type="button" role="tab" data-view="${v.id}">${v.label}</button>`).join("");
  $("mainNav").querySelectorAll("button").forEach((b) => (b.onclick = () => openView(b.dataset.view)));
  return openView("notice");
}
export function resetOps() {
  api = null;
  current = "notice";
  assetsCache = null;
  $("mainNav").innerHTML = "";
  $("opsBody").innerHTML = "";
  $("viewOps").hidden = true;
  $("viewNotice").hidden = false;
  $("deskEyebrow").textContent = "CONTENT DESK";
  $("deskTitle").textContent = "공지 관리";
}
