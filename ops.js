// 운영 도구(문의·계정·우편·쿠폰·운영 설정·감사 로그). 모든 쓰기는 DB의 보안 정의자 함수가 역할을 다시 확인한다.
// 여기서 버튼을 숨기는 것은 편의일 뿐이고, 권한의 최종 판단은 RLS와 함수가 한다.
const STATUS = { open: "접수", in_progress: "처리 중", answered: "답변 완료", closed: "종료" };
const CATEGORY = { inquiry: "문의", bug: "버그", report: "신고", other: "기타" };
const PLAYER_STATUS = { active: "정상", suspended: "정지", banned: "영구 제한" };
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
};
const VIEWS = [
  { id: "notice", label: "공지", roles: ["owner", "operator", "cs", "viewer"], eyebrow: "CONTENT DESK", title: "공지 관리" },
  { id: "tickets", label: "문의·신고", roles: ["owner", "operator", "cs"], eyebrow: "SUPPORT DESK", title: "문의·신고" },
  { id: "players", label: "계정", roles: ["owner", "operator", "cs", "viewer"], eyebrow: "PLAYER DESK", title: "계정 관리" },
  { id: "mails", label: "우편", roles: ["owner", "operator", "cs", "viewer"], eyebrow: "REWARD DESK", title: "우편·보상 발송" },
  { id: "coupons", label: "쿠폰", roles: ["owner", "operator"], eyebrow: "REWARD DESK", title: "쿠폰 관리" },
  { id: "config", label: "운영 설정", roles: ["owner", "operator", "cs", "viewer"], eyebrow: "LIVE OPS", title: "운영 설정" },
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
async function assets() {
  assetsCache ||= await rest("reward_assets?select=asset,label,max_per_grant&enabled=eq.true&order=asset");
  return assetsCache;
}

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
const rewardText = (list) =>
  (list || []).map((r) => `${esc(assetsCache?.find((a) => a.asset === r.asset)?.label ?? r.asset)} ${num(r.amount)}`).join(" · ") || "보상 없음";

// ───────── 문의·신고 ─────────
async function viewTickets() {
  $("opsBody").innerHTML = `<div class="ops-filters"><div><label for="tkStatus">상태</label><select id="tkStatus"><option value="">전체</option><option value="open">접수</option><option value="in_progress">처리 중</option><option value="answered">답변 완료</option><option value="closed">종료</option></select></div><div><label for="tkCat">분류</label><select id="tkCat"><option value="">전체</option><option value="inquiry">문의</option><option value="bug">버그</option><option value="report">신고</option><option value="other">기타</option></select></div></div><div class="ops-cols"><div><p class="hint" id="tkCount" role="status"></p><div id="tkList"></div></div><div class="card" id="tkDetail"><p class="hint">목록에서 문의를 선택하세요.</p></div></div>`;
  const load = async () => {
    const f = [];
    if ($("tkStatus").value) f.push(`status=eq.${$("tkStatus").value}`);
    if ($("tkCat").value) f.push(`category=eq.${$("tkCat").value}`);
    try {
      const rows = await rest(`support_tickets?select=id,ticket_no,source,category,subject,status,created_at&order=created_at.desc&limit=100${f.length ? "&" + f.join("&") : ""}`);
      $("tkCount").textContent = `${rows.length}건`;
      $("tkList").innerHTML = rows.map((t) => `<button class="nrow" data-id="${esc(t.id)}"><span class="tag ${t.status === "open" ? "scheduled" : t.status === "answered" || t.status === "closed" ? "pub" : ""}">${STATUS[t.status]}</span><b>#${t.ticket_no} ${esc(t.subject)}</b><span class="tag">${CATEGORY[t.category]}</span><small>${SOURCE[t.source]} · ${esc(dt(t.created_at))}</small></button>`).join("") || '<p class="hint">조건에 맞는 문의가 없습니다.</p>';
      $("tkList").querySelectorAll(".nrow").forEach((b) => (b.onclick = () => openTicket(b.dataset.id)));
    } catch (e) {
      $("tkCount").textContent = e.message;
    }
  };
  $("tkStatus").onchange = load;
  $("tkCat").onchange = load;
  await load();
}
async function openTicket(id) {
  const box = $("tkDetail");
  box.innerHTML = '<p class="hint">불러오는 중…</p>';
  try {
    const [[t], msgs] = await Promise.all([rest(`support_tickets?id=eq.${id}&select=*`), rest(`support_messages?ticket_id=eq.${id}&select=author_kind,body,created_at&order=id`)]);
    const [p] = t.player_id ? await rest(`players?id=eq.${t.player_id}&select=uid,nickname,status`) : [];
    const who = t.source === "web" ? `이메일 ${esc(t.contact_email)}` : `UID ${esc(p?.uid)} · ${esc(p?.nickname || "닉네임 없음")} · ${PLAYER_STATUS[p?.status] || ""}`;
    box.innerHTML = `<p class="eyebrow">TICKET #${t.ticket_no}</p><h2>${esc(t.subject)}</h2><p class="hint">${SOURCE[t.source]} · ${CATEGORY[t.category]} · ${STATUS[t.status]} · ${esc(dt(t.created_at))}</p><p class="hint">${who}${t.reported_uid ? ` · 신고 대상 UID ${esc(t.reported_uid)}` : ""}${t.app_version ? ` · v${esc(t.app_version)} ${esc(t.platform || "")}` : ""}</p><div class="thread"><div class="bubble player"><b>접수 내용</b><p>${esc(t.body)}</p></div>${msgs.map((m) => `<div class="bubble ${m.author_kind}"><b>${m.author_kind === "staff" ? "운영팀" : "플레이어"} · ${esc(dt(m.created_at))}</b><p>${esc(m.body)}</p></div>`).join("")}</div>${t.source === "web" ? '<p class="hint">홈페이지 접수는 플레이어에게 자동 전달되지 않습니다. 기록해 둔 뒤 이메일로 직접 회신하세요.</p>' : ""}<label for="tkReply">답변</label><textarea id="tkReply" maxlength="4000" placeholder="플레이어에게 보일 답변을 작성하세요."></textarea><label for="tkNext">처리 후 상태</label><select id="tkNext"><option value="answered">답변 완료</option><option value="in_progress">처리 중</option><option value="closed">종료</option></select><div class="actions"><button class="btn primary" id="tkSend" type="button">답변 저장</button><button class="btn ghost" id="tkClose" type="button">답변 없이 종료</button></div><p class="msg" id="tkMsg" role="status"></p>`;
    $("tkSend").onclick = async () => {
      try {
        await rpc("admin_reply_ticket", { p_id: id, p_body: $("tkReply").value, p_status: $("tkNext").value });
        await openTicket(id);
        notify("tkMsg", "답변을 저장했습니다.");
      } catch (e) {
        notify("tkMsg", e.message, true);
      }
    };
    $("tkClose").onclick = async () => {
      if (!(await api.ask("이 문의를 답변 없이 종료할까요?"))) return;
      try {
        await rpc("admin_set_ticket_status", { p_id: id, p_status: "closed" });
        await openTicket(id);
      } catch (e) {
        notify("tkMsg", e.message, true);
      }
    };
  } catch (e) {
    box.innerHTML = `<p class="msg bad">${esc(e.message)}</p>`;
  }
}

// ───────── 계정 ─────────
async function viewPlayers() {
  $("opsBody").innerHTML = `<form class="ops-search" id="plForm"><div><label for="plQuery">계정 검색</label><input id="plQuery" placeholder="UID · 닉네임 · 계정 ID" autocomplete="off" /></div><button class="btn primary" type="submit">검색</button></form><div class="ops-cols"><div><p class="hint" id="plCount" role="status"></p><div id="plList"></div></div><div class="card" id="plDetail"><p class="hint">계정을 검색해 선택하세요.</p></div></div>`;
  $("plForm").onsubmit = async (e) => {
    e.preventDefault();
    const q = $("plQuery").value.trim();
    let filter = "order=created_at.desc";
    if (/^\d{1,15}$/.test(q)) filter = `uid=eq.${q}`;
    else if (/^[0-9a-f-]{36}$/i.test(q)) filter = `id=eq.${q}`;
    else if (q) filter = `nickname=ilike.*${encodeURIComponent(q.replace(/[*,()%]/g, ""))}*`;
    try {
      const rows = await rest(`players?select=id,uid,nickname,status,last_seen_at&limit=30&${filter}`);
      $("plCount").textContent = `${rows.length}명`;
      $("plList").innerHTML = rows.map((p) => `<button class="nrow" data-id="${esc(p.id)}"><span class="tag ${p.status === "active" ? "pub" : "scheduled"}">${PLAYER_STATUS[p.status]}</span><b>UID ${esc(p.uid)} ${esc(p.nickname || "")}</b><small>마지막 접속 ${esc(dt(p.last_seen_at))}</small></button>`).join("") || '<p class="hint">검색 결과가 없습니다.</p>';
      $("plList").querySelectorAll(".nrow").forEach((b) => (b.onclick = () => openPlayer(b.dataset.id)));
    } catch (err) {
      $("plCount").textContent = err.message;
    }
  };
  $("plForm").requestSubmit();
}
async function openPlayer(id) {
  const box = $("plDetail");
  box.innerHTML = '<p class="hint">불러오는 중…</p>';
  try {
    const list = await assets();
    const [[p], held, ledger] = await Promise.all([
      rest(`players?id=eq.${id}&select=*`),
      ["owner", "operator", "cs"].includes(api.role) ? rest(`player_assets?player_id=eq.${id}&select=asset,amount&order=asset`) : [],
      ["owner", "operator", "cs"].includes(api.role) ? rest(`asset_ledger?player_id=eq.${id}&select=asset,delta,balance_after,reason,note,created_at&order=id.desc&limit=15`) : [],
    ]);
    const label = (a) => list.find((x) => x.asset === a)?.label ?? a;
    const canStatus = ["owner", "operator", "cs"].includes(api.role);
    box.innerHTML = `<p class="eyebrow">UID ${esc(p.uid)}</p><h2>${esc(p.nickname || "닉네임 없음")}</h2><p class="hint">${PLAYER_STATUS[p.status]}${p.status_reason ? ` · ${esc(p.status_reason)}` : ""}${p.status_until ? ` · ${esc(dt(p.status_until))}까지` : ""}</p><p class="hint">가입 ${esc(dt(p.created_at))} · 마지막 접속 ${esc(dt(p.last_seen_at))} · ${p.app_version ? `v${esc(p.app_version)} ${esc(p.platform || "")}` : "버전 정보 없음"}</p><p class="hint">계정 ID ${esc(p.id)}</p><h3>보유 재화</h3><div class="stats">${held.map((h) => `<div class="stat"><strong>${num(h.amount)}</strong><span>${esc(label(h.asset))}</span></div>`).join("") || '<p class="hint">서버가 기록한 재화가 없습니다.</p>'}</div><h3>최근 재화 기록</h3><div class="ledger">${ledger.map((l) => `<p><b>${esc(label(l.asset))} ${l.delta > 0 ? "+" : ""}${num(l.delta)}</b> → ${num(l.balance_after)} <small>${esc(l.reason)}${l.note ? ` · ${esc(l.note)}` : ""} · ${esc(dt(l.created_at))}</small></p>`).join("") || '<p class="hint">기록이 없습니다.</p>'}</div>${canStatus ? `<h3>계정 상태</h3><div class="row2"><div><label for="plSt">상태</label><select id="plSt"><option value="active">정상</option><option value="suspended">정지</option>${canWrite() ? '<option value="banned">영구 제한</option>' : ""}</select></div><div><label for="plUntil">정지 해제 시각 <span class="hint">비우면 무기한</span></label><input id="plUntil" placeholder="YYYY-MM-DD HH:mm" /></div></div><label for="plReason">사유 <span class="hint">플레이어에게 안내될 수 있습니다.</span></label><input id="plReason" maxlength="300" /><div class="actions"><button class="btn primary" id="plApply" type="button">상태 적용</button></div>` : ""}${canWrite() ? `<h3>재화 조정</h3><div class="row2"><div><label for="adAsset">재화</label><select id="adAsset">${list.map((a) => `<option value="${esc(a.asset)}">${esc(a.label)}</option>`).join("")}</select></div><div><label for="adDelta">증감 수량 <span class="hint">차감은 -</span></label><input id="adDelta" inputmode="numeric" /></div></div><label for="adReason">사유 (필수)</label><input id="adReason" maxlength="300" /><div class="actions"><button class="btn primary" id="adApply" type="button">조정 적용</button></div>` : ""}<p class="msg" id="plMsg" role="status"></p>`;
    if (canStatus) {
      $("plSt").value = p.status;
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
    if (canWrite()) {
      $("adApply").onclick = async () => {
        try {
          const delta = Number($("adDelta").value.replace(/,/g, ""));
          if (!Number.isInteger(delta) || delta === 0) throw new Error("증감 수량을 정수로 입력하세요.");
          if (!(await api.ask(`${label($("adAsset").value)} ${delta > 0 ? "+" : ""}${num(delta)}을(를) 적용할까요? 기록에 남습니다.`))) return;
          await rpc("admin_adjust_asset", { p_player: id, p_asset: $("adAsset").value, p_delta: delta, p_reason: $("adReason").value });
          await openPlayer(id);
          notify("plMsg", "조정했습니다.");
        } catch (e) {
          notify("plMsg", e.message, true);
        }
      };
    }
  } catch (e) {
    box.innerHTML = `<p class="msg bad">${esc(e.message)}</p>`;
  }
}

// ───────── 우편 ─────────
async function viewMails() {
  const list = await assets();
  $("opsBody").innerHTML = `${canWrite() ? `<section class="card"><h2>새 우편</h2><label for="mlTitle">제목</label><input id="mlTitle" maxlength="80" /><label for="mlBody">내용</label><textarea id="mlBody" maxlength="2000"></textarea><label>첨부 보상 <span class="hint">없으면 알림 우편이 됩니다.</span></label><div id="mlRewards"></div><div class="row2"><div><label for="mlTarget">받는 UID <span class="hint">비우면 전체 발송</span></label><input id="mlTarget" inputmode="numeric" /></div><div><label for="mlDays">보관 기간</label><select id="mlDays"><option value="7">7일</option><option value="14">14일</option><option value="30" selected>30일</option><option value="90">90일</option></select></div></div><label for="mlStart">발송 시각 <span class="hint">비우면 즉시 · YYYY-MM-DD HH:mm</span></label><input id="mlStart" placeholder="YYYY-MM-DD HH:mm" /><div class="actions"><button class="btn primary" id="mlSend" type="button">발송</button></div><p class="msg" id="mlMsg" role="status"></p></section>` : '<p class="hint">조회만 가능한 권한입니다.</p>'}<h2>발송 기록</h2><div id="mlList"></div>`;
  let readRewards = () => [];
  if (canWrite()) {
    readRewards = rewardEditor($("mlRewards"), list);
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
        const expires = new Date(base.getTime() + Number($("mlDays").value) * 86400000).toISOString();
        const rewards = readRewards();
        if (!(await api.ask(`${who}에게 우편을 보낼까요?\n보상: ${rewards.map((r) => `${list.find((a) => a.asset === r.asset)?.label} ${num(r.amount)}`).join(", ") || "없음"}`))) return;
        await rpc("admin_send_mail", { p_title: $("mlTitle").value, p_body: $("mlBody").value, p_rewards: rewards, p_target: target, p_starts: starts, p_expires: expires });
        notify("mlMsg", "발송했습니다.");
        $("mlTitle").value = "";
        $("mlBody").value = "";
        await loadMailList();
      } catch (e) {
        notify("mlMsg", e.message, true);
      }
    };
  }
  await loadMailList();
}
async function loadMailList() {
  try {
    const rows = await rest("mails?select=id,title,rewards,target_player,status,starts_at,expires_at,created_at&order=created_at.desc&limit=50");
    $("mlList").innerHTML = rows.map((m) => `<div class="nrow static"><span class="tag ${m.status === "active" ? "pub" : ""}">${m.status === "active" ? "발송" : "취소"}</span><span class="tag">${m.target_player ? "개인" : "전체"}</span><b>${esc(m.title)}</b><small>${rewardText(m.rewards)} · ${esc(dt(m.starts_at))} ~ ${esc(dt(m.expires_at))}</small>${canWrite() && m.status === "active" ? `<button class="btn ghost" data-cancel="${esc(m.id)}" type="button">발송 취소</button>` : ""}</div>`).join("") || '<p class="hint">기록이 없습니다.</p>';
    $("mlList").querySelectorAll("[data-cancel]").forEach(
      (b) =>
        (b.onclick = async () => {
          if (!(await api.ask("이 우편을 취소할까요? 아직 받지 않은 플레이어는 받을 수 없게 됩니다."))) return;
          try {
            await rpc("admin_cancel_mail", { p_id: b.dataset.cancel });
            await loadMailList();
          } catch (e) {
            notify("mlMsg", e.message, true);
          }
        }),
    );
  } catch (e) {
    $("mlList").innerHTML = `<p class="msg bad">${esc(e.message)}</p>`;
  }
}

// ───────── 쿠폰 ─────────
async function viewCoupons() {
  const list = await assets();
  const now = new Date();
  $("opsBody").innerHTML = `<section class="card"><h2>새 쿠폰</h2><label for="cpName">쿠폰 이름 <span class="hint">운영자만 봅니다.</span></label><input id="cpName" maxlength="80" /><div class="row2"><div><label for="cpKind">종류</label><select id="cpKind"><option value="shared">공용 코드 (여러 명이 같은 코드, 1인 1회)</option><option value="single">일회용 코드 (코드마다 한 명)</option></select></div><div id="cpSharedBox"><label for="cpCode">공용 코드 <span class="hint">영문·숫자 6~32자</span></label><input id="cpCode" maxlength="40" autocomplete="off" spellcheck="false" /></div><div id="cpSingleBox" hidden><label for="cpCount">발급 수량 <span class="hint">1~1000</span></label><input id="cpCount" inputmode="numeric" value="100" /></div></div><label>보상</label><div id="cpRewards"></div><div class="row2"><div><label for="cpStart">시작 시각</label><input id="cpStart" value="${fmtLocal(now)}" /></div><div><label for="cpEnd">종료 시각</label><input id="cpEnd" value="${fmtLocal(new Date(now.getTime() + 30 * 86400000))}" /></div></div><div id="cpMaxBox"><label for="cpMax">총 사용 가능 수 <span class="hint">공용 코드만 · 비우면 제한 없음</span></label><input id="cpMax" inputmode="numeric" /></div><div class="actions"><button class="btn primary" id="cpCreate" type="button">쿠폰 만들기</button></div><p class="msg" id="cpMsg" role="status"></p><div id="cpResult" hidden class="code-result"></div></section><h2>쿠폰 목록</h2><div id="cpList"></div>`;
  const readRewards = rewardEditor($("cpRewards"), list);
  const sync = () => {
    const single = $("cpKind").value === "single";
    $("cpSharedBox").hidden = single;
    $("cpSingleBox").hidden = !single;
    $("cpMaxBox").hidden = single;
  };
  $("cpKind").onchange = sync;
  sync();
  $("cpCreate").onclick = async () => {
    try {
      const single = $("cpKind").value === "single";
      const rewards = readRewards();
      if (!rewards.length) throw new Error("보상을 하나 이상 입력하세요.");
      const max = $("cpMax").value.trim() ? Number($("cpMax").value) : null;
      if (!single && max !== null && (!Number.isInteger(max) || max < 1)) throw new Error("총 사용 가능 수는 1 이상의 정수여야 합니다.");
      if (!(await api.ask(single ? `일회용 코드 ${$("cpCount").value}개를 만들까요?` : "공용 쿠폰을 만들까요? 만든 뒤 코드는 다시 볼 수 없습니다."))) return;
      const r = await rpc("admin_create_coupon", { p_name: $("cpName").value, p_kind: $("cpKind").value, p_rewards: rewards, p_starts: parseLocal($("cpStart").value), p_ends: parseLocal($("cpEnd").value), p_max: single ? null : max, p_code: single ? null : $("cpCode").value, p_count: single ? Number($("cpCount").value) : null });
      notify("cpMsg", "쿠폰을 만들었습니다.");
      if (single) {
        $("cpResult").hidden = false;
        $("cpResult").innerHTML = `<b>일회용 코드 ${r.codes.length}개</b><p class="hint">이 화면을 벗어나면 다시 볼 수 없습니다. 지금 복사해 두세요.</p><textarea readonly rows="8" id="cpCodes">${esc(r.codes.join("\n"))}</textarea><div class="actions"><button class="btn" id="cpCopy" type="button">모두 복사</button></div>`;
        $("cpCopy").onclick = async () => {
          try {
            await navigator.clipboard.writeText(r.codes.join("\n"));
            notify("cpMsg", "복사했습니다.");
          } catch {
            $("cpCodes").select();
            notify("cpMsg", "복사 권한이 없어 선택만 했습니다. 직접 복사하세요.", true);
          }
        };
      } else {
        $("cpResult").hidden = true;
        $("cpCode").value = "";
      }
      await loadCouponList();
    } catch (e) {
      notify("cpMsg", e.message, true);
    }
  };
  await loadCouponList();
}
async function loadCouponList() {
  try {
    const rows = await rest("coupons?select=id,name,kind,rewards,starts_at,ends_at,max_redemptions,redeemed_count,status&order=created_at.desc&limit=50");
    $("cpList").innerHTML = rows.map((c) => `<div class="nrow static"><span class="tag ${c.status === "active" ? "pub" : ""}">${c.status === "active" ? "사용 가능" : "중지"}</span><span class="tag">${c.kind === "shared" ? "공용" : "일회용"}</span><b>${esc(c.name)}</b><small>${rewardText(c.rewards)} · 사용 ${num(c.redeemed_count)}${c.max_redemptions ? ` / ${num(c.max_redemptions)}` : ""} · ${esc(dt(c.starts_at))} ~ ${esc(dt(c.ends_at))}</small><button class="btn ghost" data-toggle="${esc(c.id)}" data-to="${c.status === "active" ? "disabled" : "active"}" type="button">${c.status === "active" ? "중지" : "다시 사용"}</button></div>`).join("") || '<p class="hint">쿠폰이 없습니다.</p>';
    $("cpList").querySelectorAll("[data-toggle]").forEach(
      (b) =>
        (b.onclick = async () => {
          try {
            await rpc("admin_set_coupon_status", { p_id: b.dataset.toggle, p_status: b.dataset.to });
            await loadCouponList();
          } catch (e) {
            notify("cpMsg", e.message, true);
          }
        }),
    );
  } catch (e) {
    $("cpList").innerHTML = `<p class="msg bad">${esc(e.message)}</p>`;
  }
}

// ───────── 운영 설정 ─────────
async function viewConfig() {
  const [c] = await rest("app_config?select=*&id=eq.1");
  const ro = canWrite() ? "" : " disabled";
  $("opsBody").innerHTML = `<section class="card"><h2>점검과 최소 버전</h2><p class="hint">점검 중에는 게임이 시작 화면에서 안내 문구를 보여 줍니다. 최소 버전보다 낮은 앱은 업데이트 안내를 받습니다.</p><label for="cfMaint">점검 상태</label><select id="cfMaint"${ro}><option value="false">정상 운영</option><option value="true">점검 중</option></select><label for="cfMsg">점검 안내 문구</label><textarea id="cfMsg" maxlength="500"${ro}>${esc(c.maintenance_message)}</textarea><label for="cfEnds">점검 종료 예정 <span class="hint">비우면 미정 · YYYY-MM-DD HH:mm</span></label><input id="cfEnds" value="${c.maintenance_ends_at ? fmtLocal(new Date(c.maintenance_ends_at)) : ""}"${ro} /><div class="row2"><div><label for="cfMin">최소 지원 버전</label><input id="cfMin" value="${esc(c.min_app_version)}" placeholder="0.0.0"${ro} /></div><div><label for="cfLatest">최신 버전</label><input id="cfLatest" value="${esc(c.latest_app_version)}" placeholder="0.0.0"${ro} /></div></div>${canWrite() ? '<div class="actions"><button class="btn primary" id="cfSave" type="button">저장</button></div>' : '<p class="hint">조회만 가능한 권한입니다.</p>'}<p class="msg" id="cfNote" role="status">마지막 수정 ${esc(dt(c.updated_at))}</p></section>`;
  $("cfMaint").value = String(c.maintenance);
  if (!canWrite()) return;
  $("cfSave").onclick = async () => {
    try {
      const re = /^\d+\.\d+\.\d+$/;
      if (!re.test($("cfMin").value) || !re.test($("cfLatest").value)) throw new Error("버전은 1.2.3 형식으로 입력하세요.");
      const on = $("cfMaint").value === "true";
      if (!(await api.ask(on ? "점검을 시작할까요? 모든 플레이어에게 점검 안내가 표시됩니다." : "설정을 저장할까요?"))) return;
      await rpc("admin_set_config", { p_maintenance: on, p_message: $("cfMsg").value, p_ends_at: parseLocal($("cfEnds").value), p_min_version: $("cfMin").value, p_latest_version: $("cfLatest").value });
      notify("cfNote", "저장했습니다.");
    } catch (e) {
      notify("cfNote", e.message, true);
    }
  };
}

// ───────── 감사 로그 ─────────
async function viewAudit() {
  const rows = await rest("admin_audit_log?select=id,actor,action,target,detail,at&order=id.desc&limit=100");
  $("opsBody").innerHTML = `<p class="hint">최근 100건 · 소유자만 볼 수 있습니다.</p>${rows.map((r) => `<div class="nrow static"><span class="tag">${esc(r.action)}</span><b>${esc(r.target)}</b><small>${esc(dt(r.at))} · 담당 ${esc(String(r.actor || "").slice(0, 8))}</small><small class="detail">${esc(JSON.stringify(r.detail || {})).slice(0, 300)}</small></div>`).join("") || '<p class="hint">기록이 없습니다.</p>'}`;
}

const RENDER = { tickets: viewTickets, players: viewPlayers, mails: viewMails, coupons: viewCoupons, config: viewConfig, audit: viewAudit };

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
  $("opsBody").innerHTML = '<p class="hint">불러오는 중…</p>';
  try {
    await RENDER[id]();
  } catch (e) {
    if (current === id) $("opsBody").innerHTML = `<p class="msg bad">${esc(e.message)}</p>`;
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
