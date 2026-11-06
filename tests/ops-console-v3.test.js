import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";

const ME = "00000000-0000-0000-0000-0000000000aa";
const P1 = "00000000-0000-0000-0000-000000000001";
const P2 = "00000000-0000-0000-0000-000000000002";
const P3 = "00000000-0000-0000-0000-000000000003";
const G = "00000000-0000-0000-0000-0000000000f1";

// 게임 저장소(20261120000000_ops_moderation.sql)가 만드는 표는 필요한 모양만 옮겨 세운다.
async function setup() {
  const db = new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema private;create schema auth;
   create function auth.uid() returns uuid language sql as $$ select '${ME}'::uuid $$;
   create function private.admin_can(text[]) returns boolean language sql as $$ select coalesce(current_setting('test.can_write',true),'yes')='yes' $$;
   create table auth.users(id uuid primary key, email text);
   create table public.admin_audit_log(id bigint generated always as identity primary key, actor uuid, action text, target text, detail jsonb, at timestamptz default now());
   create function private.audit(p_action text, p_target text, p_detail jsonb default '{}') returns void language sql as $$
     insert into public.admin_audit_log(actor, action, target, detail) values (auth.uid(), p_action, p_target, p_detail) $$;
   create table public.players(id uuid primary key, uid bigint unique, nickname text, status text not null default 'active');
   insert into public.players(id, uid, nickname) values ('${P1}', 100000001, '하나'), ('${P2}', 100000002, '둘'), ('${P3}', 100000003, '셋');
   create table public.reward_assets(asset text primary key);
   insert into public.reward_assets values ('gems'), ('item:stamina-tonic');
   create table public.player_adjustments(id uuid primary key default gen_random_uuid(), player_id uuid not null references public.players(id),
     asset text not null references public.reward_assets(asset), delta bigint not null check (delta <> 0), note text, created_by uuid,
     created_at timestamptz not null default now(), applied_at timestamptz);
   create table public.purchase_records(transaction_id text primary key, player_id uuid not null references public.players(id), product_id text not null,
     granted jsonb not null default '[]', first_bonus boolean not null default false, recorded_at timestamptz not null default now(),
     refunded_at timestamptz, refund_reason text, refunded_by uuid, clawback jsonb);
   create table public.banned_words(word text primary key, created_by uuid, created_at timestamptz not null default now());
   create table public.player_profile_actions(id uuid primary key default gen_random_uuid(), player_id uuid not null references public.players(id),
     kind text not null, reason text not null default '', created_by uuid, created_at timestamptz not null default now(), applied_at timestamptz);
   create table public.server_competitive_scores(board text, period date, player_id uuid references public.players(id), score bigint, achieved_at timestamptz default now(),
     primary key (board, period, player_id));
   create table public.server_competitive_bans(board text, period date, player_id uuid references public.players(id), reason text not null default '',
     created_by uuid, created_at timestamptz not null default now(), primary key (board, period, player_id));
   create table public.guilds(id uuid primary key, name text not null, name_key text not null unique, join_mode text not null default 'open',
     notice text not null default '', prosperity int not null default 0, created_at timestamptz not null default now());
   create table public.guild_members(player_id uuid primary key references public.players(id), guild_id uuid not null references public.guilds(id) on delete cascade,
     role text not null, name text not null, level int not null default 1, joined_at timestamptz not null default now(), last_active_at timestamptz not null default now(),
     contribution_week int not null default 0, contribution_total int not null default 0);
   create unique index guild_members_one_leader on public.guild_members(guild_id) where role = 'leader';
   create table public.guild_left(player_id uuid primary key references public.players(id), left_at timestamptz not null);
   create table public.ops_banners(id uuid primary key default gen_random_uuid(), title text not null check (length(trim(title)) between 1 and 60),
     body text not null, translations jsonb not null default '{}', starts_at timestamptz not null default now(), ends_at timestamptz not null,
     created_by uuid, created_at timestamptz not null default now(), deleted_at timestamptz, check (ends_at > starts_at));`);
  // v2가 먼저 만든 제재 이력 함수와 같은 반환 모양이어야 v3을 그 위에 덮어쓸 수 있다.
  await db.exec(`create function public.admin_player_sanctions(p_player uuid) returns table(action text, detail jsonb, at timestamptz, actor_email text)
    language sql as $$ select null::text, null::jsonb, null::timestamptz, null::text where false $$;`);
  await db.exec(await readFile(new URL("../supabase/migrations/20261120100000_ops_console_v3.sql", import.meta.url), "utf8"));
  return db;
}
const one = async (db, sql, params) => (await db.query(sql, params)).rows[0];
const json = async (db, sql, params) => Object.values(await one(db, sql, params))[0];
const rejects = (p, code) => assert.rejects(p, (e) => String(e.message).includes(code));

test("환불은 한 번만 되고, 회수는 등록된 재화·아이템만 음수 조정으로 올린다", async () => {
  const db = await setup();
  try {
    await db.exec(`insert into public.purchase_records(transaction_id, player_id, product_id, granted) values
      ('tx-1', '${P1}', 'gem-pack', '[{"kind":"currency","currency":"gems","amount":500},{"kind":"item","itemId":"stamina-tonic","amount":2},{"kind":"pass","passId":"p"},{"kind":"currency","currency":"seasonCoin","amount":3}]');`);
    const list = await json(db, "select public.admin_list_purchases('100000001', null, 50)");
    assert.equal(list.length, 1);
    assert.equal(list[0].uid, 100000001);
    await rejects(db.query("select public.admin_refund_purchase('tx-1', '  ', true)"), "reason_required");
    const r = await json(db, "select public.admin_refund_purchase('tx-1', '구글 환불', true)");
    assert.equal(r.clawback.length, 3);
    assert.deepEqual(r.clawback.filter((c) => c.skipped).map((c) => c.asset), ["seasonCoin"]);
    const adj = (await db.query("select asset, delta from public.player_adjustments order by asset")).rows;
    assert.deepEqual(adj, [{ asset: "gems", delta: -500 }, { asset: "item:stamina-tonic", delta: -2 }]);
    await rejects(db.query("select public.admin_refund_purchase('tx-1', '다시', false)"), "already_refunded");
    const refunded = await json(db, "select public.admin_list_purchases('', true, 50)");
    assert.equal(refunded.length, 1);
    const summary = await json(db, "select public.admin_purchase_summary(30)");
    assert.equal(summary.count, 1);
    assert.equal(summary.refunded, 1);
    const sanctions = (await db.query(`select action from public.admin_player_sanctions('${P1}')`)).rows;
    assert.deepEqual(sanctions.map((x) => x.action), ["purchase_refund"]);
  } finally {
    await db.close();
  }
});

test("쓰기 권한이 없으면 환불·금칙어·길드 조치를 거절한다", async () => {
  const db = await setup();
  try {
    await db.exec("set test.can_write = 'no'");
    await rejects(db.query("select public.admin_set_banned_word('나쁜말', true)"), "forbidden");
    await rejects(db.query("select public.admin_refund_purchase('x', 'r', false)"), "forbidden");
    await rejects(db.query(`select public.admin_guild_action('${G}', 'disband', null, null, 'r')`), "forbidden");
  } finally {
    await db.close();
  }
});

test("금칙어는 공백을 지우고 소문자로 저장하며, 프로필 초기화는 같은 종류가 대기 중이면 거절한다", async () => {
  const db = await setup();
  try {
    const r = await json(db, "select public.admin_set_banned_word(' Bad  Word ', true)");
    assert.equal(r.word, "badword");
    assert.deepEqual((await json(db, "select public.admin_list_banned_words()")).map((w) => w.word), ["badword"]);
    await json(db, "select public.admin_set_banned_word('BADWORD', false)");
    assert.deepEqual(await json(db, "select public.admin_list_banned_words()"), []);
    await rejects(db.query("select public.admin_set_banned_word('   ', true)"), "invalid_word");

    await json(db, `select public.admin_reset_profile('${P2}', 'nickname_reset', '부적절한 닉네임')`);
    await rejects(db.query(`select public.admin_reset_profile('${P2}', 'nickname_reset', '또')`), "already_pending");
    await json(db, `select public.admin_reset_profile('${P2}', 'bio_reset', '소개')`);
    await rejects(db.query(`select public.admin_reset_profile('${P2}', 'avatar', '소개')`), "invalid_kind");
    assert.equal((await json(db, `select public.admin_profile_actions('${P2}')`)).length, 2);
    const sanctions = (await db.query(`select action from public.admin_player_sanctions('${P2}')`)).rows;
    assert.equal(sanctions.filter((x) => x.action === "profile_reset").length, 2);
  } finally {
    await db.close();
  }
});

test("랭킹 기록을 제외하면 점수가 지워지고 제외 목록에 남으며, 해제하면 목록에서 빠진다", async () => {
  const db = await setup();
  try {
    await db.exec(`insert into public.server_competitive_scores(board, period, player_id, score) values
      ('duel', '2026-11-02', '${P1}', 900), ('duel', '2026-11-02', '${P2}', 1200), ('duel', '2026-10-26', '${P1}', 50);`);
    assert.deepEqual(await json(db, "select public.admin_competitive_periods('duel')"), ["2026-11-02", "2026-10-26"]);
    let s = await json(db, "select public.admin_competitive_scores('duel', '2026-11-02', 100)");
    assert.deepEqual(s.rows.map((r) => [r.rank, r.uid]), [[1, 100000002], [2, 100000001]]);
    await rejects(db.query(`select public.admin_remove_competitive_score('duel', '2026-11-02', '${P2}', '', true)`), "reason_required");
    const r = await json(db, `select public.admin_remove_competitive_score('duel', '2026-11-02', '${P2}', '비정상 점수', true)`);
    assert.equal(Number(r.removedScore), 1200);
    s = await json(db, "select public.admin_competitive_scores('duel', '2026-11-02', 100)");
    assert.deepEqual(s.rows.map((x) => x.uid), [100000001]);
    assert.deepEqual(s.bans.map((x) => x.uid), [100000002]);
    const sanctions = (await db.query(`select action from public.admin_player_sanctions('${P2}')`)).rows;
    assert.deepEqual(sanctions.map((x) => x.action), ["ranking_remove"]);
    await json(db, `select public.admin_remove_competitive_score('duel', '2026-11-02', '${P2}', '', false)`);
    s = await json(db, "select public.admin_competitive_scores('duel', '2026-11-02', 100)");
    assert.deepEqual(s.bans, []);
  } finally {
    await db.close();
  }
});

test("길드 관리: 추방·위임·이름 변경·공지 비우기·해산", async () => {
  const db = await setup();
  try {
    await db.exec(`insert into public.guilds(id, name, name_key, notice) values ('${G}', '포가든 수호대', '포가든수호대', '공지'),
        ('00000000-0000-0000-0000-0000000000f2', '다른 길드', '다른길드', '');
      insert into public.guild_members(player_id, guild_id, role, name) values ('${P1}', '${G}', 'leader', '하나'), ('${P2}', '${G}', 'member', '둘'), ('${P3}', '${G}', 'member', '셋');`);
    assert.equal((await json(db, "select public.admin_list_guilds('수호')")).length, 1);
    assert.equal((await json(db, "select public.admin_list_guilds('100000002')"))[0].members, 3);
    const act = (action, player, name, reason = "신고") =>
      db.query("select public.admin_guild_action($1, $2, $3, $4, $5)", [G, action, player, name, reason]);
    await rejects(act("kick", P2, null, ""), "reason_required");
    await rejects(act("kick", P1, null), "leader_cannot_be_kicked");
    await act("kick", P3, null);
    assert.ok(await one(db, `select 1 from public.guild_left where player_id = '${P3}'`));
    await rejects(act("kick", P3, null), "not_member");
    await act("transfer", P2, null);
    const d = await json(db, `select public.admin_guild_detail('${G}')`);
    assert.deepEqual(d.members.map((m) => [m.name, m.role]), [["둘", "leader"], ["하나", "vice"]]);
    await rejects(act("rename", null, "다른 길드"), "guild_name_taken");
    await rejects(act("rename", null, "!"), "invalid_guild_name");
    await act("rename", null, "새  이름");
    await act("reset_notice", null, null);
    const g = await one(db, `select name, name_key, notice from public.guilds where id = '${G}'`);
    assert.deepEqual(g, { name: "새 이름", name_key: "새이름", notice: "" });
    await act("disband", null, null);
    assert.equal(await one(db, `select 1 from public.guilds where id = '${G}'`), undefined);
    assert.equal((await one(db, "select count(*)::int as n from public.guild_members")).n, 0);
    assert.equal((await one(db, "select count(*)::int as n from public.guild_left")).n, 3);
    const audit = (await db.query("select action from public.admin_audit_log order by id")).rows.map((r) => r.action);
    assert.deepEqual(audit, ["guild_kick", "guild_transfer", "guild_rename", "guild_reset_notice", "guild_disband"]);
  } finally {
    await db.close();
  }
});

test("공지 배너: 영어·일본어 원고만 받고, 저장·수정·삭제한다", async () => {
  const db = await setup();
  try {
    const save = (p) => db.query("select public.admin_save_banner($1::jsonb) as r", [JSON.stringify(p)]);
    const base = { title: "점검 안내", body: "본문", startsAt: "2026-11-06T00:00:00Z", endsAt: "2026-11-08T00:00:00Z" };
    await rejects(save({ ...base, translations: { fr: { title: "x" } } }), "invalid_translations");
    const id = (await save({ ...base, translations: { en: { title: "Maintenance", body: "" } } })).rows[0].r.id;
    await save({ ...base, id, title: "점검 안내 (수정)", translations: {} });
    let list = await json(db, "select public.admin_list_banners()");
    assert.equal(list.length, 1);
    assert.equal(list[0].title, "점검 안내 (수정)");
    await json(db, `select public.admin_delete_banner('${id}')`);
    list = await json(db, "select public.admin_list_banners()");
    assert.deepEqual(list, []);
    await rejects(db.query(`select public.admin_delete_banner('${id}')`), "banner_not_found");
  } finally {
    await db.close();
  }
});
