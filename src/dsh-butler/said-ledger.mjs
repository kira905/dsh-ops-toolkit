#!/usr/bin/env node
// ============================================================
//  dsh-butler / said-ledger.mjs —— D1b「原话账」
// ------------------------------------------------------------
//  它是什么：把**主人随口说的话**从 `life.db` 里捞回来，逐条判「有没有被某个产物接住」，
//            产出一份 `docs\统筹提示-<日期>.md`（三列：你说了什么 / 落哪了 / 没落的建议怎么办）。
//
//  为什么要有它（真实病根，不是拍脑袋）：
//    主人是**流式说话**（想到什么说什么），一问一答把话刷掉；**话本身没丢**（life.db 全存着），
//    丢的是「捡回来判一次」这一步。落笔能力不缺，缺的是**常设岗位**。
//    真源：`docs\V3.1.0-需求收集-20261022.md` §13.2b（2026-11-01 23:13 主人拍板「需要」）。
//
//  边界（写死，防走偏）：
//    🔴 **只读**：只读 life.db / 会话日志 / 卡台账 / docs / 变更流水；**不写**任何一处。
//    🔴 **只报黄**：不建卡、不改档、不发外部通道、不进告警通道。
//    🔴 **宁可漏，不可错**：判不准的一律进「没落地（建议）」让人划掉，**绝不静默丢弃**
//       —— 被排除的每一条都在文末「已排除」里列名，能查、能翻案。
//
//  用法：
//    node <pkg>/src/dsh-butler/said-ledger.mjs                     # 跑「今天」
//    node <pkg>/src/dsh-butler/said-ledger.mjs --date 2026-11-01   # 跑指定日
//    node <pkg>/src/dsh-butler/said-ledger.mjs --no-llm            # 不调模型（全部进"没落地"，纯规则体检）
//    node <pkg>/src/dsh-butler/said-ledger.mjs --no-tail           # 不读会话日志补未入库的那段
//    node <pkg>/src/dsh-butler/said-ledger.mjs --out <路径>         # 改产出落点
//    node <pkg>/src/dsh-butler/said-ledger.mjs --no-write          # 只打印摘要，不落档
//    node <pkg>/src/dsh-butler/said-ledger.mjs --json              # 只输出结构化结果（给别的器具吃）
//    node <pkg>/src/dsh-butler/said-ledger.mjs --selftest          # 内建夹具（零生产读写）
//    node <pkg>/src/dsh-butler/said-ledger.mjs --verbose           # 打印逐条判定
//
//  退出码：0 正常 / 1 取数失败（life.db 读不到等）/ 2 用法错 / 3 夹具红
//
//  ⚠️ 索引延迟（实测 82 分钟）：`life.db` 的 chunks 不是实时的。跑"今天"时，库内最新块之
//     后的那段话**会漏**⇒ 本器具默认再去 `~\.dsh\sessions\` 读活跃会话日志补那一段
//     （只取 `user/message` 且 `source.kind === 'user'` 的，注入件本来就带别的 kind）。
//     补不上（读不到/解不开）就**在报告里写明补到几点**，绝不假装完整。
// ============================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
// zstd 多帧拆帧：**CLI 侧唯一源**（`tools\lib\zstd-frames.mjs`，与 archive-session / failure-classify 同源）
import { scanZstdFrames } from '../lib/zstd-frames.mjs';

// 本文件真实落点（junction 下 import.meta.url 是物理路径，argv 是逻辑路径 ⇒ 一律以物理为准）
const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));
export const DSH_ROOT = path.resolve(HERE, '..', '..'); // = <workspace>
const TZ_MS = 8 * 3600 * 1000; // Asia/Shanghai 固定偏移（本机不分夏令时）
const MAX_TEXT_CHARS = 800; // 长文粘贴阈值（超过 = 不是"随口一句"）
const DAY_MS = 24 * 3600 * 1000;

const HELP = `D1b「原话账」—— 把主人随口说的话捞回来，判有没有落地（只读 · 只报黄）

用法：node said-ledger.mjs [选项]
  --date <YYYY-MM-DD>  跑指定日（默认今天，+08:00）
  --out <路径>          产出落点（默认 <DSH>\\docs\\统筹提示-<日期>.md）
  --no-write           只打印摘要，不写档
  --no-llm             不调模型（全部进"没落地"，只做取数/排除体检）
  --no-tail            不读会话日志补 life.db 未入库的那一段
  --json               只输出结构化结果（stdout）
  --verbose            打印逐条判定
  --selftest           跑内建夹具（临时目录，零生产读写）
  -h, --help           本帮助

边界：只读 life.db / 会话日志 / 卡台账 / docs / 流水；不建卡、不改档、不外发。
`;

// ─────────────────────────────────────────── 小工具 ───────────────────────────────────────────
const log = (...a) => { if (VERBOSE) console.log(...a); };
let VERBOSE = false;
const pad2 = (n) => String(n).padStart(2, '0');
/** 毫秒 → 北京时间 HH:MM */
const fmtHM = (ms) => { const d = new Date(Number(ms) + TZ_MS); return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`; };
/** 毫秒 → 北京时间 YYYY-MM-DD HH:MM:SS */
const fmtFull = (ms) => { const d = new Date(Number(ms) + TZ_MS); return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`; };
const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length <= n ? t : t.slice(0, n) + '…'; };
/** 一句话压成便于人读的引文（去 markdown 记号，保留原样中文） */
const quote = (s, n = 60) => clip(String(s ?? '').replace(/[`*#>\n]+/g, ' '), n);

/** 'YYYY-MM-DD' + 时区 → [startMs, endMs) */
export function dayWindow(dateStr, tzOffsetMs = TZ_MS) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) throw new Error(`日期格式应为 YYYY-MM-DD，收到「${dateStr}」`);
  const utcMidnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const start = utcMidnight - tzOffsetMs;
  return { start, end: start + DAY_MS, date: dateStr };
}

/** 北京时间"今天" */
export function todayInTz(nowMs = Date.now(), tzOffsetMs = TZ_MS) {
  const d = new Date(nowMs + tzOffsetMs);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

// ──────────────────────────────────── 排除规则（"这些不是她的话"）────────────────────────────────────
// 顺序有意义：
//   ① **先按会话归属认卡指令**（最硬的判据，不看内容）—— 注意必须排在"系统注入"前面：
//      卡 prompt 里常常**原文引用**排除用的正则（2026-11-01 23:15 那张 D1b 卡就是这样，把自己的正则
//      抄进了正文 ⇒ 按内容判会自称"系统注入"，虽然都是排除，但归类错了没人能复盘）。
//   ② 会话注入（交接/接手指令、任务 prompt 落在主会话里）
//   ③ 系统注入（大管家提醒/重启通知/召回注入…）—— 任务书给的正则 + 现查补的几类
//   ④ 长度（长文粘贴）⑤ 文字形态（URL/路径/密钥/图片）
export const EXCLUDE_RULES = [
  {
    reason: (t) => {
      const s = String(t ?? '');
      // 卡 prompt 的第一行就能认出来 ⇒ 标签给"卡指令"（哪怕正文里引用了系统注入的关键词，
      // 例：D1b 那张卡把 `DSH 已按请求重启` 抄进了排除规则说明里）
      if (/^\s*(#\s*任务|【任务】|你是[「【])/.test(s)) return '卡会话指令（不是她打的字）';
      if (/🐳|DSH 已按请求重启|上下文看门提醒|^\[from:\s*session/m.test(s)) return '系统注入';
      return '卡会话指令（不是她打的字）';
    },
    // 判据 = 会话归属，不看内容（内容长得像原话的卡指令很多，看内容会误判）；
    // 但卡会话里也会**落系统注入**（2026-11-01 19:12 的"主动告警"就在画画手卡会话里）⇒ 标签按内容细分，排除动作一致
    test: (_t, prov) => prov.isCardSession,
  },
  {
    reason: '会话注入（交接/接手指令，不是她打的字）',
    // 交接/接力 prompt 是由 session-relay 投进主会话的（不是卡会话 ⇒ 归属判据盖不住），
    // 现网真实形态：「你是「<主线>」这条主线的接手会话…」「开工三步，**严格按此顺序**」「# 任务：…」「【任务】…」
    test: (t) => /^\s*(你是[「【])|开工三步，\*?\*?严格按此顺序|^\s*#\s*任务[:：]|^\s*【任务】|^\s*##\s*你要做的/m.test(t),
  },
  {
    reason: '系统注入',
    // 任务书给的基线正则 + 现查补的三类（大类同一个：不是主人打的字）
    //   · `大管家主动告警`（现网文案是"主动告警"，不是"自动告警"，只写"自动"会漏）
    //   · `^[from: session-`（跨会话投喂的真实前缀是 `[from: session-unknown …]`，`fromsession` 匹配不上）
    //   · 上下文看门 / 坑库提醒 / 召回注入 / 我那边来信 / 时间快照
    test: (t) => /非主人发言|忽略本条|大管家自动(提醒|告警|推进)|大管家主动告警|DSH 已按请求重启|本条为自动通知|fromsession|接力路由|^\[from:\s*session|上下文看门提醒|坑库实时提醒|\[人生记忆·旧会话片段\]|\[相关记忆·指针\]|【我那边来信】|Time sampled while preparing|Current runtime context|<system-reminder>/m.test(t),
  },
  {
    reason: '长文粘贴（>800 字）',
    test: (_t, prov) => prov.chars > MAX_TEXT_CHARS,
  },
  {
    reason: '非文字（URL/路径/密钥/图片）',
    test: (t) => {
      if (/!\[[^\]]*\]\(|<attachment|attachments?\/[\w-]+\.(png|jpe?g|webp|gif)/i.test(t)) return true;
      const hasCjk = /[\u4e00-\u9fa5]/.test(t);
      const bare = t.trim();
      if (hasCjk) return false;
      // 无中文：只有"看起来像纯 URL / 盘符路径 / 密钥 / 代码片段"才排除
      return /^(https?:\/\/|sk-[A-Za-z0-9]|[A-Za-z]:\\|file:\/\/|\/[\w.-]+\/)/.test(bare) || bare.length < 6;
    },
  },
];

/**
 * 单条（已合并的老虎机消息）分类。
 * @returns {{excluded:boolean, reason?:string}}
 */
export function classifyMessage(text, prov) {
  for (const r of EXCLUDE_RULES) {
    let hit = false;
    try { hit = !!r.test(String(text ?? ''), prov); } catch { hit = false; }
    if (hit) {
      const reason = typeof r.reason === 'function' ? r.reason(text, prov) : r.reason;
      return { excluded: true, reason };
    }
  }
  return { excluded: false };
}

// ──────────────────────────────────── 取数①：life.db 原话 ───────────────────────────────────
/**
 * 从 life.db 取窗口内 role=user & kind=text 的块，**按（会话, ts）合并成分条消息**
 * （一条长消息会被切成多块：同 ts、ord 递增 ⇒ 不合并会把"长文粘贴"当成好几条短句）。
 */
export function readSaidFromDb(dbPath, win) {
  if (!fs.existsSync(dbPath)) throw new Error(`life.db 不存在：${dbPath}`);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 8000');
    const maxRow = db.prepare('SELECT MAX(ts) AS m FROM chunks').get();
    const dbMaxTs = Number(maxRow?.m ?? 0) || 0;
    const rows = db.prepare(`
      SELECT c.id, c.session_id, c.ts, c.ord, c.chars, c.text, s.workspace AS ws, s.root AS root, s.dir AS dir
      FROM chunks c LEFT JOIN sessions s ON s.id = c.session_id
      WHERE c.ts >= ? AND c.ts < ? AND c.role = 'user' AND c.kind = 'text'
      ORDER BY c.ts ASC, c.ord ASC
    `).all(win.start, win.end);

    // 合并同一条消息的多块
    const byMsg = new Map();
    for (const r of rows) {
      const k = `${r.session_id}|${r.ts}`;
      if (!byMsg.has(k)) byMsg.set(k, { ts: Number(r.ts), session: String(r.session_id), ws: r.ws ?? null, root: r.root ?? null, dir: r.dir ?? null, parts: [] });
      byMsg.get(k).parts.push({ ord: Number(r.ord ?? 0), text: String(r.text ?? ''), chars: Number(r.chars ?? 0) });
    }
    const out = [];
    for (const m of byMsg.values()) {
      m.parts.sort((a, b) => a.ord - b.ord);
      const text = m.parts.map((p) => p.text).join('\n');
      const chars = m.parts.reduce((s, p) => s + (Number.isFinite(p.chars) ? p.chars : p.text.length), 0) || text.length;
      out.push({ ts: m.ts, session: m.session, ws: m.ws, dir: m.dir, root: m.root, text, chars, origin: 'life.db' });
    }
    return { messages: out, dbMaxTs, rawRows: rows.length, dbPath };
  } finally {
    try { db.close(); } catch { /* 只读句柄，关不掉不算失败 */ }
  }
}

/** 会话归属 → 是不是卡执行会话（卡指令从 runner 注入，role 也是 user，必须按归属剔） */
export function provOf(m) {
  const dir = String(m.dir ?? '');
  const ws = String(m.ws ?? '');
  const isCardSession = /\bcard-sessions\b/i.test(ws) || /[\\/]cards[\\/]/i.test(dir) || /card-sessions/i.test(dir);
  return { isCardSession, chars: Number(m.chars ?? String(m.text ?? '').length), ws, dir };
}

// ──────────────────────────────────── 取数②：日志补尾（绕过索引延迟）────────────────────────────────────
/**
 * life.db 索引有延迟（实测 82 分钟）。窗口尾部还没入库的话，去 `~\.dsh\sessions\` 读活跃会话日志，
 * 取 `user/message` 且 `source.kind === 'user'` 的事件（注入件的 kind 是 time-context / memory-recall / …）。
 * 只读、逐帧解、坏帧跳过；读不开就返回空 + 原因，绝不猜。
 */
export function readSaidTail({ home, win, afterTs, nowMs = Date.now() }) {
  const root = path.join(home, 'sessions');
  const notes = [];
  const out = [];
  if (!fs.existsSync(root)) return { messages: out, notes: [`没有 ${root}`] };
  let scanned = 0, frames = 0, badFrames = 0;
  for (const ws of fs.readdirSync(root)) {
    const wsDir = path.join(root, ws);
    let wsStat; try { wsStat = fs.statSync(wsDir); } catch { continue; }
    if (!wsStat.isDirectory()) continue;
    const isCard = /card-sessions/i.test(ws);
    for (const name of fs.readdirSync(wsDir)) {
      const sessDir = path.join(wsDir, name);
      let st; try { st = fs.statSync(sessDir); } catch { continue; }
      if (!st.isDirectory()) continue;
      if (st.mtimeMs < win.start || st.mtimeMs > Math.max(win.end, nowMs)) continue;
      const file = fs.readdirSync(sessDir).find((n) => n.endsWith('.jsonl.zstd') || n.endsWith('.jsonl'));
      if (!file) continue;
      scanned++;
      let text = '';
      try {
        const full = path.join(sessDir, file);
        const buf = fs.readFileSync(full);
        if (file.endsWith('.zstd')) {
          const { frames: fr } = scanZstdFramesSafe(buf);          frames += fr.length;
          const parts = [];
          for (const f of fr) {
            try { parts.push(zlib.zstdDecompressSync(buf.subarray(f.start, f.end))); } catch { badFrames++; }
          }
          text = Buffer.concat(parts).toString('utf8');
        } else {
          text = buf.toString('utf8');
        }
      } catch (e) { notes.push(`解不开 ${name}: ${e?.message ?? e}`); continue; }
      for (const line of text.split('\n')) {
        if (!line.includes('"user/message"')) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        if (ev.type !== 'user/message') continue;
        const kind = ev?.data?.source?.kind ?? null;
        if (kind !== 'user') continue; // 注入件（time-context / memory-recall / postcard-notice …）不进来
        const t = Number(ev.time ?? 0);
        if (!(t > afterTs) || t < win.start || t >= win.end) continue;
        const txt = (ev?.data?.content ?? []).filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n');
        if (!txt) continue;
        out.push({ ts: t, session: String(name).replace(/^session-/, ''), ws, dir: sessDir, root: 'sessions', text: txt, chars: txt.length, origin: '会话日志', isCardSession: isCard });
      }
    }
  }
  notes.push(`扫 ${scanned} 个活跃会话目录 · 帧 ${frames}（坏帧 ${badFrames}）· 补到 ${out.length} 条`);
  return { messages: out, notes };
}

/** zstd-frames 共享件包装（解不开时不让整只器具哑火；共享件是 CLI 侧唯一源，这里不再自带实现） */
function scanZstdFramesSafe(buf) {
  try { return scanZstdFrames(buf); } catch { return { frames: [] }; }
}
// ──────────────────────────────────── 取数③：同期产物（落地证据）───────────────────────────────
const DOC_HEAD_TTL = new Map();

/**
 * 读文档首标题 + 二级/三级小标题（只读前 12KB，一次跑内缓存）。
 * ⚠️ 小标题必须带出来：2026-11-01 实测，只给文件名时模型判不出「21:41 那句落到了 §13.2b」——
 *    真正能证明"落哪了"的信息在**小节标题**里（§13 / §14 / §14.7），不在文件标题里。
 */
export function docHead(file) {
  if (DOC_HEAD_TTL.has(file)) return DOC_HEAD_TTL.get(file);
  let title = '', heads = [];
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(262144);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, n).toString('utf8');
    const m = /^#\s+(.+)$/m.exec(head);
    title = m ? m[1].trim() : '';
    heads = [...head.matchAll(/^#{2,3}\s+(.+)$/gm)].map((x) => clip(x[1].trim(), 28)).slice(0, 60);
  } catch { title = ''; heads = []; }
  const out = { title, heads };
  DOC_HEAD_TTL.set(file, out);
  return out;
}

/** 兼容旧名（外部/夹具按 docTitle 用过） */
export function docTitle(file) { return docHead(file).title; }

/** 变更流水：取 `## MM-DD` 段下的 `- ` 行 */
export function readChangelog(root, win) {
  const d = new Date(win.start + TZ_MS);
  const ym = `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}`;
  const md = `${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  const file = path.join(root, 'docs', '变更流水', `${ym}.md`);
  if (!fs.existsSync(file)) return { file, lines: [], note: `没有 ${file}` };
  const text = fs.readFileSync(file, 'utf8');
  const lines = [];
  let inSec = false;
  for (const raw of text.split(/\r?\n/)) {
    if (/^##\s+/.test(raw)) { inSec = raw.replace(/^##\s+/, '').trim() === md; continue; }
    if (!inSec) continue;
    if (/^-\s+/.test(raw)) lines.push(raw.replace(/^-\s+/, '').trim());
  }
  return { file, lines, note: null };
}

/** 同期产物：卡（ledger-v2）+ 文档（docs\*.md mtime）+ 记忆（memory.db）+ 变更流水 */
export function collectArtifacts({ root, home, win, maxDocs = 160 }) {
  const arts = [];
  // ① 卡
  const ledgerPath = path.join(home, 'task-board', 'ledger-v2.json');
  let cardCount = 0;
  if (fs.existsSync(ledgerPath)) {
    try {
      const led = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
      for (const t of led.tasks ?? []) {
        const ts = numOf(t.updatedAt) ?? numOf(t.createdAt);
        if (ts == null || ts < win.start || ts >= win.end) continue;
        arts.push({ kind: '卡', id: t.id, ts, label: `卡「${clip(t.title, 70)}」· ${t.status ?? '?'}${t.line ? ` · 线=${t.line}` : ''}` });
        cardCount++;
      }
    } catch (e) { arts.push({ kind: '提示', ts: win.start, label: `卡台账读不出：${e?.message ?? e}` }); }
  }
  // ② 文档
  const docsDir = path.join(root, 'docs');
  let docCount = 0, selfSkipped = 0;
  const walk = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.md')) continue;
      // 🔴 自己的产出不算"落地证据"（否则同日重跑会拿上一轮的报告给自己作证，判据自己喂自己）
      if (/^统筹提示-\d{4}-\d{2}-\d{2}\.md$/.test(e.name)) { selfSkipped++; continue; }
      const rel = path.relative(docsDir, p);
      if (rel.startsWith('管家报告' + path.sep)) continue; // 自动报告不算"被人落的笔"，单独不参与判定（见报告脚注）
      let st; try { st = fs.statSync(p); } catch { continue; }
      if (st.mtimeMs < win.start || st.mtimeMs >= win.end) continue;
      const { title, heads } = docHead(p);
      arts.push({ kind: '档', ts: st.mtimeMs, label: `档 \`${rel.replace(/\\/g, '\\')}\`${title ? ` · ${clip(title, 44)}` : ''}`, heads });
      docCount++;
      if (docCount >= maxDocs) return;
    }
  };
  walk(docsDir);
  // ③ 记忆（§13.2b 的载体清单里"记忆"是合法的落点：写进记忆 = 有人接住了）
  let memCount = 0;
  const memPath = path.join(home, 'memory', 'memory.db');
  if (fs.existsSync(memPath)) {
    let mdb = null;
    try {
      mdb = new DatabaseSync(memPath, { readOnly: true });
      mdb.exec('PRAGMA busy_timeout = 8000');
      const rows = mdb.prepare('SELECT id, updated_at, text FROM memories WHERE updated_at >= ? AND updated_at < ? ORDER BY updated_at ASC LIMIT 200').all(win.start, win.end);
      for (const r of rows) {
        arts.push({ kind: '记忆', ts: Number(r.updated_at), label: `记忆 #${r.id} · ${clip(String(r.text ?? '').replace(/^【[^】]*】/, ''), 120)}` });
        memCount++;
      }
    } catch (e) { arts.push({ kind: '提示', ts: win.start, label: `记忆库读不出：${e?.message ?? e}` }); }
    finally { try { mdb?.close(); } catch { /* 只读句柄 */ } }
  }
  // ④ 变更流水
  const cl = readChangelog(root, win);
  let clCount = 0;
  for (const line of cl.lines) {
    const mm = /^(\d{1,2}:\d{2})/.exec(line);
    const mins = mm ? Number(mm[1].split(':')[0]) * 60 + Number(mm[1].split(':')[1]) : 0;
    arts.push({ kind: '流水', ts: win.start + mins * 60000, label: `流水 ${clip(line, 120)}` });
    clCount++;
  }
  arts.sort((a, b) => a.ts - b.ts);
  arts.forEach((a, i) => { a.ref = `A${i + 1}`; });
  return { artifacts: arts, stats: { cardCount, docCount, memCount, clCount, selfSkipped, ledgerPath, changelog: cl.file } };
}

const numOf = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') { const n = Date.parse(v); return Number.isFinite(n) ? n : null; }
  return null;
};

// ──────────────────────────────────── 检索：给每条原话挑候选产物 ───────────────────────────────────
const CJK = /[\u4e00-\u9fa5]/;
/** 粗粒度分词：中文 bigram + 英文/数字词（够用就行，目的是给模型递候选而不是替它判） */
export function tokensOf(s) {
  const t = String(s ?? '');
  const set = new Set();
  for (const w of t.toLowerCase().match(/[a-z0-9_.-]{3,}/g) ?? []) set.add(w);
  const cjk = t.replace(/[^\u4e00-\u9fa5]/g, ' ');
  for (const seg of cjk.split(/\s+/)) {
    for (let i = 0; i + 2 <= seg.length; i++) set.add(seg.slice(i, i + 2));
  }
  return set;
}

/** 每条原话 → 命中的最可能产物（按 token 交集大小），给模型当候选 */
export function pickCandidates(artTokens, saidTokens, k = 6) {
  const scored = [];
  for (let i = 0; i < artTokens.length; i++) {
    let hit = 0;
    for (const t of saidTokens) if (artTokens[i].has(t)) hit++;
    if (hit > 0) scored.push({ i, hit });
  }
  scored.sort((a, b) => b.hit - a.hit);
  return scored.slice(0, k).map((s) => s.i);
}

// ──────────────────────────────────── 判定层（LLM；失败 fail-open）────────────────────────────────────
const JUDGE_SYSTEM = `你是「原话账」的判定器。给你两样东西：
(A) 主人某天在会话里说过的原话，编号 S1..Sn；
(B) 同一时间窗内确实产生的产物清单（看板卡 / 文档 / 变更流水），编号 A1..An。

任务：对每条 S，判断这句话有没有被某个产物**接住**（= 有人把这句话落成了卡 / 文档 / 流水里的一行）。

判定纪律（严格照做）：
1. 只有产物内容**明显对应**这句话时，才判 landed=true；勉强沾边、只是同主题，判 false。
2. 判不准 ⇒ landed=false（我们宁可漏，不可错：错判会往主人面前塞噪音）。
3. landed=true 时，evidence 必须填**一个 A 编号**（如 "A12"），不要写别的。
4. landed=false 时，suggestion 用一句话说这句话**该落到哪里**（例：补进 docs\\待办-*.md / 建卡 / 写进需求档 §x）。
5. **同一个产物可以接住多条原话**（一份调研/待办档常常一次接住三四句），不要因为 A 已用过就判 false。
6. 原话若是「追问/催落笔」（如「记下来了吗」「都记下来」），只要那件事确实被某个产物（卡/档/记忆/流水）记下了，就判 landed=true。
7. 一句原话若明显是**对话应答**（"需要""干吧""重启吧""换吧"），它本身不需要载体：只有当它对应的决定在产物里能查到时才判 true，否则 false。
8. 只输出 JSON 数组，不要解释、不要 markdown 围栏。元素格式：
{"id":1,"landed":true,"evidence":"A12","suggestion":""}`;

/** 把 LLM 文本解析成 [{id, landed, evidence, suggestion}]（容忍围栏/杂文本；解析不出即 null） */
export function parseJudge(text) {
  if (!text) return null;
  let t = String(text).trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('['), e = t.lastIndexOf(']');
  if (s < 0 || e <= s) return null;
  let arr;
  try { arr = JSON.parse(t.slice(s, e + 1)); } catch { return null; }
  if (!Array.isArray(arr)) return null;
  return arr
    .filter((x) => x && typeof x === 'object' && Number.isFinite(Number(x.id)))
    .map((x) => ({
      id: Number(x.id),
      landed: x.landed === true || String(x.landed).toLowerCase() === 'true',
      evidence: typeof x.evidence === 'string' ? x.evidence.trim() : '',
      suggestion: typeof x.suggestion === 'string' ? x.suggestion.trim() : '',
    }));
}

/**
 * 批量判定。fail-open：任何一块失败 ⇒ 该块全部 landed=false 且标 unknown=true（进"没落地"）。
 * @param {(req:{system:string,user:string,maxTokens:number})=>Promise<{ok:boolean,text?:string,reason?:string,model?:string}>} llmFn
 */
export async function judgeSaid({ said, artifacts, llmFn, batch = 14, maxArtifactsInPrompt = 400, votes: nVotes = 2 }) {
  const artList = artifacts.slice(0, maxArtifactsInPrompt);
  // 索引 token = 标签 + **小节标题**（文档的"落点"证据常在小节里：§14.7 命名歧义、§13.2b D1b …）
  const artTokens = artList.map((a) => {
    const s = tokensOf(a.label);
    if (Array.isArray(a.heads)) for (const h of a.heads) for (const t of tokensOf(h)) s.add(t);
    return s;
  });
  const artBlock = artList.map((a) => `${a.ref} [${fmtHM(a.ts)} ${a.kind}] ${clip(a.label, 150)}`).join('\n');

  const verdicts = new Map();
  const stats = { calls: 0, failed: 0, reasons: [], model: null };
  for (let off = 0; off < said.length; off += batch) {
    const chunk = said.slice(off, off + batch);
    const lines = chunk.map((s, i) => {
      const st = tokensOf(s.text);
      const cand = pickCandidates(artTokens, st, 6).map((idx) => {
        const a = artList[idx];
        // 候选产物再带一句「哪一节最像」：真正能证明"落哪了"的信息常在**小节标题**里（§13 / §14.7），
        // 不在文件名里（2026-11-01 实测：只给文件名时 21:41 与 21:51 会被判成一件事）
        let hint = '';
        if (Array.isArray(a.heads) && a.heads.length) {
          const scored = a.heads
            .map((h) => { const ht = tokensOf(h); let hit = 0; for (const t of st) if (ht.has(t)) hit++; return { h, hit }; })
            .filter((x) => x.hit >= 2)
            .sort((x, y) => y.hit - x.hit)
            .slice(0, 2)
            .map((x) => x.h);
          if (scored.length) hint = `〔最像的小节：${scored.join(' / ')}〕`;
        }
        return `${a.ref}${hint}`;
      });
      return `S${off + i + 1} [${fmtHM(s.ts)}] 「${clip(s.text, 240)}」\n   候选：${cand.length ? cand.join(' / ') : '（无）'}`;
    }).join('\n');
    const user = `(A) 产物清单（编号 / 时刻 / 类型 / 内容）：\n${artBlock}\n\n(B) 待判原话（共 ${chunk.length} 条）：\n${lines}\n\n请输出 JSON 数组，元素 id 用 S 后面的数字（${off + 1}..${off + chunk.length}）。`;
    const votes = [];
    for (let k = 0; k < Math.max(1, nVotes); k++) {
      stats.calls++;
      let res;
      try { res = await llmFn({ system: JUDGE_SYSTEM, user, maxTokens: 2000, temperature: 0 }); } catch (e) { res = { ok: false, reason: `throw:${e?.message ?? e}` }; }
      if (res?.model) stats.model = res.model;
      const parsed = res?.ok ? parseJudge(res.text) : null;
      if (!parsed) { stats.failed++; stats.reasons.push(res?.ok ? 'bad-json' : String(res?.reason ?? 'unknown')); votes.push(null); continue; }
      const byId = new Map(parsed.map((p) => [p.id, p]));
      const got = new Map();
      for (let i = 0; i < chunk.length; i++) {
        const v = byId.get(off + i + 1);
        if (!v) { got.set(off + i + 1, { landed: false, evidence: '', suggestion: '' }); continue; }
        // evidence 必须是一个真实存在的 A 编号 —— 编出来的编号不算证据（宁可漏）
        const ev = /^A\d+$/.test(v.evidence) ? v.evidence : '';
        const landed = v.landed && !!ev && artList.some((a) => a.ref === ev);
        got.set(off + i + 1, { landed, evidence: landed ? ev : '', suggestion: v.suggestion || '' });
      }
      votes.push(got);
    }
    // 多轮共识（默认 2 轮）：**两轮都说落地、且指向同一个产物编号**才算落地 ——
    // 实测同一份输入两轮会漂 1~2 条（17/17/18），所以宁可要"稳的少"，也不要"飘的多"。
    for (let i = 0; i < chunk.length; i++) {
      const id = off + i + 1;
      const valid = votes.filter(Boolean);
      if (!valid.length) { verdicts.set(id, { landed: false, evidence: '', suggestion: '', unknown: true }); continue; }
      const first = valid[0].get(id) ?? { landed: false, evidence: '', suggestion: '' };
      const agree = valid.every((g) => { const x = g.get(id) ?? { landed: false, evidence: '' }; return x.landed === first.landed && x.evidence === first.evidence; });
      if (first.landed && agree) { verdicts.set(id, { landed: true, evidence: first.evidence, suggestion: '', unknown: false }); continue; }
      const sug = first.suggestion || valid.map((g) => (g.get(id) ?? {}).suggestion || '').find(Boolean) || '';
      verdicts.set(id, {
        landed: false, evidence: '', unknown: valid.length < Math.max(1, nVotes),
        suggestion: agree ? sug : `${sug}${sug ? ' ' : ''}（两轮判定不一致，按"没落"处理，人看一眼）`,
      });
    }
  }
  stats.votes = Math.max(1, nVotes);
  return { verdicts, stats };
}

const NO_LLM = async () => ({ ok: false, reason: 'disabled-by-flag' });

// ──────────────────────────────────── 渲染 ───────────────────────────────────
export function renderReport({ win, said, excluded, artifacts, artStats, verdicts, judgeStats, tailNotes, dbMaxTs, opts }) {
  const n = said.length;
  const items = said.map((s, i) => {
    const v = verdicts.get(i + 1) ?? { landed: false, evidence: '', suggestion: '', unknown: true };
    const art = v.evidence ? artifacts.find((a) => a.ref === v.evidence) : null;
    return { idx: i + 1, s, v, art };
  });
  const landed = items.filter((x) => x.v.landed);
  const notLanded = items.filter((x) => !x.v.landed);
  const lagMin = dbMaxTs ? Math.max(0, Math.round((win.end - dbMaxTs) / 60000)) : null;
  const L = [];
  L.push(`# 统筹提示 · ${win.date}`);
  L.push('');
  L.push(`> 生成：${fmtFull(Date.now())}（+08:00）· 器具 \`tools\\dsh-butler\\said-ledger.mjs\` · **只读 · 只报黄**（不建卡 / 不改档 / 不发消息）`);
  L.push(`> 数据源：\`life.db\` 的 \`chunks\`（\`role=user AND kind=text\`）· 库内最新块 ${dbMaxTs ? fmtFull(dbMaxTs) : '(无)'}${lagMin != null ? `（距当日 24:00 差 ${lagMin} 分钟）` : ''}`);
  L.push(`> 同期产物：卡 ${artStats.cardCount} 张 · 文档 ${artStats.docCount} 份${artStats.memCount ? ` · 记忆 ${artStats.memCount} 条` : ''} · 变更流水 ${artStats.clCount} 行（窗 ${fmtFull(win.start)} → ${fmtFull(win.end - 1)}）`);
  if (tailNotes?.length) L.push(`> 补尾（绕索引延迟）：${tailNotes.join(' · ')}`);
  L.push('');
  L.push(`你说过 **${n}** 条，**${landed.length}** 条已落地，**${notLanded.length}** 条没找到载体。`);
  L.push('');
  if (n === 0) {
    L.push('_（本窗没有捞到任何"你说的话"—— 若白天聊过，先看下面「已排除」里是不是全被规则吃掉了。）_');
    L.push('');
  }
  L.push('## 已落地');
  if (!landed.length) L.push('- （无）');
  for (const x of landed) {
    L.push(`- ${fmtHM(x.s.ts)}「${quote(x.s.text, 70)}」→ ${x.art ? `${x.art.ref} ${clip(x.art.label, 110)}` : x.v.evidence}`);
  }
  L.push('');
  L.push('## 没落地（建议）');
  if (!notLanded.length) L.push('- （无 —— 今天说的每一句都有载体）');
  for (const x of notLanded) {
    const sug = x.v.suggestion || '人看一眼：这话要不要落成卡/待办/文档';
    L.push(`- ${fmtHM(x.s.ts)}「${quote(x.s.text, 70)}」→ 建议 ${sug}${x.v.unknown ? '（判定器没跑成，按"没落地"处理）' : ''}`);
  }
  L.push('');
  L.push(`## 已排除（这些不算"你说的话"）· ${excluded.length} 条`);
  if (!excluded.length) L.push('- （无）');
  else {
    L.push('| 时刻 | 归类 | 摘要 |');
    L.push('|---|---|---|');
    for (const e of excluded) L.push(`| ${fmtHM(e.ts)} | ${e.reason} | ${quote(e.text, 60).replace(/\|/g, '\\|')} |`);
  }
  L.push('');
  L.push('## 判定记录');
  L.push(`- 判定器：${judgeStats.model ?? (opts.noLlm ? '未调用（--no-llm）' : '不可用')} · 调用 ${judgeStats.calls} 次 · 失败 ${judgeStats.failed} 次${judgeStats.reasons.length ? `（${judgeStats.reasons.join(', ')}）` : ''}`);
  L.push(`- 判定口径：每块跑 ${judgeStats.votes ?? 1} 轮取共识（**都判落地且指向同一产物编号**才算落地）—— 实测同输入两轮会漂 1~2 条，宁可要"稳的少"。`);
  L.push('- 口径：只有产物**明显对应**这句话才判已落地；判不准一律进「没落地」，宁漏不错。');
  L.push('- 未计入判定的产物：`docs\\管家报告\\*`（自动报告不是"人落的笔"；要算的话在 `--verbose` 里能看到）。');
  L.push(`- 未计入判定的产物：\`docs\\统筹提示-*.md\`（本器具自己的产出${opts.selfSkipped ? `，本次跳过 ${opts.selfSkipped} 份` : ''}，否则同日重跑会拿上一轮的报告给自己作证）。`);
  L.push('');
  L.push('---');
  L.push('> 本档只报黄：**没有自动建卡、没有自动改档、没有发任何消息**。看完把不用的划掉即可。');
  L.push('');
  return L.join('\n');
}

// ──────────────────────────────────── 主流程 ───────────────────────────────────
export async function run(opts = {}) {
  const {
    date = todayInTz(),
    root = DSH_ROOT,
    home = resolveHome(),
    out = null,
    noLlm = false,
    noTail = false,
    write = true,
    llmFn = null,
    nowMs = Date.now(),
  } = opts;
  const win = dayWindow(date);
  const dbPath = path.join(home, 'memory-life', 'life.db');

  // ① 原话（life.db）
  const { messages, dbMaxTs, rawRows } = readSaidFromDb(dbPath, win);
  log(`[say] life.db 命中块 ${rawRows} 条 → 合并成 ${messages.length} 条消息（库内最新 ${fmtFull(dbMaxTs)}）`);

  // ② 补尾（索引延迟）
  let tailNotes = [];
  let tailMsgs = [];
  if (!noTail) {
    const tail = readSaidTail({ home, win, afterTs: dbMaxTs, nowMs });
    tailMsgs = tail.messages;
    tailNotes = tail.notes;
    log(`[say] 补尾 ${tailMsgs.length} 条`);
  }

  // ③ 分类
  const all = [...messages, ...tailMsgs];
  const said = [];
  const excluded = [];
  for (const m of all) {
    const prov = { ...provOf(m), ...(m.isCardSession ? { isCardSession: true } : {}) };
    const cls = classifyMessage(m.text, prov);
    if (cls.excluded) excluded.push({ ts: m.ts, reason: cls.reason, text: m.text });
    else said.push(m);
  }
  said.sort((a, b) => a.ts - b.ts);
  excluded.sort((a, b) => a.ts - b.ts);
  log(`[say] 原话 ${said.length} 条 / 排除 ${excluded.length} 条`);

  // ④ 产物
  const { artifacts, stats: artStats } = collectArtifacts({ root, home, win });
  log(`[art] ${JSON.stringify(artStats)} · 合计 ${artifacts.length} 条`);

  // ⑤ 判定（fail-open）
  let verdicts = new Map();
  let judgeStats = { calls: 0, failed: 0, reasons: [], model: null };
  if (!noLlm && said.length) {
    let fn = llmFn;
    if (!fn) {
      try {
        const mod = await import(path.resolve(root, 'llm-client.mjs').replace(/\\/g, '/').replace(/^([A-Za-z]):/, 'file:///$1:'));
        fn = (req) => mod.llmText(req);
      } catch (e) { fn = null; judgeStats.reasons.push(`llm-client 载入失败:${e?.message ?? e}`); }
    }
    if (fn) {
      const r = await judgeSaid({ said, artifacts, llmFn: fn });
      verdicts = r.verdicts;
      judgeStats = r.stats;
      log(`[judge] ${JSON.stringify(judgeStats)}`);
    } else {
      for (let i = 0; i < said.length; i++) verdicts.set(i + 1, { landed: false, evidence: '', suggestion: '', unknown: true });
    }
  } else {
    for (let i = 0; i < said.length; i++) verdicts.set(i + 1, { landed: false, evidence: '', suggestion: '', unknown: true });
  }

  // ⑥ 渲染 + 落档
  const outPath = out ?? path.join(root, 'docs', `统筹提示-${date}.md`);
  const md = renderReport({ win, said, excluded, artifacts, artStats, verdicts, judgeStats, tailNotes, dbMaxTs, opts: { noLlm, selfSkipped: artStats.selfSkipped } });
  let written = null;
  if (write) {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, md, 'utf8');
    written = outPath;
  }
  const items = said.map((s, i) => {
    const v = verdicts.get(i + 1) ?? { landed: false, unknown: true };
    const art = v.evidence ? artifacts.find((a) => a.ref === v.evidence) : null;
    return { id: i + 1, ts: s.ts, time: fmtHM(s.ts), text: s.text, session: s.session, origin: s.origin, landed: !!v.landed, evidence: v.evidence || null, evidenceLabel: art?.label ?? null, suggestion: v.suggestion || '', unknown: !!v.unknown };
  });
  return {
    ok: true, date, window: win, dbMaxTs, outPath: written, md,
    said: items,
    excluded: excluded.map((e) => ({ time: fmtHM(e.ts), reason: e.reason, text: e.text })),
    stats: { said: said.length, landed: items.filter((x) => x.landed).length, notLanded: items.filter((x) => !x.landed).length, excluded: excluded.length, artifacts: artifacts.length, ...artStats, judge: judgeStats },
  };
}

function resolveHome() {
  const env = (process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || '').trim();
  return env ? path.resolve(env) : path.join(os.homedir(), '.dsh');
}

// ──────────────────────────────────── 夹具 ───────────────────────────────────
async function selftest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'said-ledger-'));
  let pass = 0, fail = 0;
  const check = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ''}`); } };
  try {
    // 夹具 home：life.db + task-board/ledger-v2.json + docs/变更流水
    const home = path.join(tmp, 'home');
    const root = path.join(tmp, 'root');
    fs.mkdirSync(path.join(home, 'memory-life'), { recursive: true });
    fs.mkdirSync(path.join(home, 'task-board'), { recursive: true });
    fs.mkdirSync(path.join(home, 'sessions', '--D-DSH--'), { recursive: true });
    fs.mkdirSync(path.join(home, 'sessions', '--D-DSH-card-sessions--'), { recursive: true });
    fs.mkdirSync(path.join(root, 'docs', '变更流水'), { recursive: true });

    const win = dayWindow('2026-11-01');
    const t = (hhmm) => win.start + (Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5))) * 60000;

    // 建夹具 life.db
    const db = new DatabaseSync(path.join(home, 'memory-life', 'life.db'));
    db.exec(`CREATE TABLE sessions (id TEXT PRIMARY KEY, root TEXT, workspace TEXT, dir TEXT, file TEXT);
             CREATE TABLE chunks (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, turn_no INTEGER, ts INTEGER, role TEXT, kind TEXT, ord INTEGER, text TEXT, chars INTEGER);`);
    const insS = db.prepare('INSERT INTO sessions (id,root,workspace,dir) VALUES (?,?,?,?)');
    insS.run('s-main', 'sessions', '--D-DSH--', 'X:\\x\\sessions\\--D-DSH--\\session-s-main');
    insS.run('s-card', 'sessions', '--D-DSH-card-sessions--', '<sysdrive>\\x\\sessions\\--D-DSH-card-sessions--\\session-s-card');
    const insC = db.prepare('INSERT INTO chunks (session_id,ts,role,kind,ord,text,chars) VALUES (?,?,?,?,?,?,?)');
    // 真原话
    insC.run('s-main', t('21:34'), 'user', 'text', 0, '包括你上面的建议，都记下来', 14);
    insC.run('s-main', t('21:45'), 'user', 'text', 0, '再分出来一个会话专门来管主线', 14);
    // 系统注入（4 种现网真实形态）
    insC.run('s-main', t('19:12'), 'user', 'text', 0, '🐳 大管家主动告警（2026/11/1 19:11:15）长时间无新事件', 30);
    insC.run('s-main', t('20:11'), 'user', 'text', 0, '🐳 大管家自动提醒（队列推进）卡已进待验收', 24);
    insC.run('s-main', t('21:24'), 'user', 'text', 0, '✅ DSH 已按请求重启完成', 15);
    insC.run('s-main', t('21:25'), 'user', 'text', 0, '[from: session-unknown · （无标题） · 2026-11-01T21:25:27+08:00 · new] 投喂线索', 60);
    // 卡指令（同 ts 两块 ⇒ 合并后 > 800，必须判"卡指令"而不是"长文"）
    insC.run('s-card', t('20:31'), 'user', 'text', 0, '# 任务：' + '卡'.repeat(600), 605);
    insC.run('s-card', t('20:31'), 'user', 'text', 1, '续'.repeat(400), 400);
    // 长文粘贴（真会话里的长粘贴）
    insC.run('s-main', t('15:00'), 'user', 'text', 0, '长'.repeat(900), 900);
    // 纯路径 / 短英文
    insC.run('s-main', t('16:00'), 'user', 'text', 0, 'X:\\work\\docs\\abc.md', 20);
    insC.run('s-main', t('16:01'), 'user', 'text', 0, 'ok', 2);
    db.close();

    // 夹具 ledger / docs / 流水
    fs.writeFileSync(path.join(home, 'task-board', 'ledger-v2.json'), JSON.stringify({ tasks: [
      { id: 'c1', title: '【统筹·原话账】D1b 器具', status: 'done', line: '统筹线 · 判据', updatedAt: t('22:00') },
      { id: 'c2', title: '昨天的卡（窗口外）', status: 'done', line: 'x', updatedAt: win.start - 3600000 },
    ] }), 'utf8');
    fs.writeFileSync(path.join(root, 'docs', 'V3.1.0-需求收集-20261022.md'), '# 需求收集\n\n## 13. 文档三件套\n', 'utf8');
    const docFile = path.join(root, 'docs', 'V3.1.0-需求收集-20261022.md');
    fs.utimesSync(docFile, new Date(t('23:14')), new Date(t('23:14')));
    fs.writeFileSync(path.join(root, 'docs', '待办-20261101-统筹线.md'), '# 待办 · 统筹线\n\n- 原话账\n', 'utf8');
    fs.utimesSync(path.join(root, 'docs', '待办-20261101-统筹线.md'), new Date(t('22:59')), new Date(t('22:59')));
    fs.writeFileSync(path.join(root, 'docs', '变更流水', '2026-11.md'), '# 变更流水 · 2026-11\n\n## 11-01\n- 22:00 建原话账器具｜tools\\dsh-butler\\said-ledger.mjs｜\n\n## 10-31\n- 23:00 别的日子\n', 'utf8');
    // ⚠️ 夹具按"真实写盘时间"落 mtime（= 跑夹具那天，也在被测窗口内）⇒ 流水档本身也算一份文档，显式钉到 23:01
    fs.utimesSync(path.join(root, 'docs', '变更流水', '2026-11.md'), new Date(t('23:01')), new Date(t('23:01')));

    // ── A. 窗口与时间
    check('dayWindow 边界（+08:00 零点对齐）', dayWindow('2026-11-01').start === Date.parse('2026-11-01T00:00:00+08:00'));
    check('todayInTz 按 +08:00 取日', todayInTz(Date.parse('2026-10-31T16:30:00Z')) === '2026-11-01');

    // ── B. 排除规则逐条
    const P = (o = {}) => ({ isCardSession: false, chars: 20, ws: '--D--', dir: '', ...o });
    check('系统注入·自动提醒', classifyMessage('🐳 大管家自动提醒（队列推进）…', P()).reason === '系统注入');
    check('系统注入·主动告警（"主动"不是"自动"）', classifyMessage('🐳 大管家主动告警…', P()).reason === '系统注入');
    check('系统注入·重启通知', classifyMessage('✅ DSH 已按请求重启完成', P()).reason === '系统注入');
    check('系统注入·[from: session- 投喂', classifyMessage('[from: session-unknown · 无标题] 投喂线索', P()).reason === '系统注入');
    check('系统注入·上下文看门', classifyMessage('⚠️ 上下文看门提醒（大管家自动投递）…', P()).reason === '系统注入');
    check('卡会话指令（按归属剔，不按长度）', classifyMessage('随便一句话', P({ isCardSession: true })).reason === '卡会话指令（不是她打的字）');
    // 2026-11-01 实测踩到：卡 prompt 会**原文引用**排除正则（D1b 卡把"非主人发言|忽略本条"抄进了正文）
    check('卡指令正文引用正则时，归属优先于内容', classifyMessage('任务：用正则 非主人发言|忽略本条 过滤', P({ isCardSession: true })).reason === '卡会话指令（不是她打的字）');
    check('卡指令正文引用"DSH 已按请求重启"仍算卡指令', classifyMessage('# 任务：D1b 原话账\n排除规则：DSH 已按请求重启 / 大管家自动提醒', P({ isCardSession: true })).reason === '卡会话指令（不是她打的字）');
    check('卡会话里落的系统注入仍标系统注入', classifyMessage('🐳 大管家主动告警（2026/11/1 19:11:15）', P({ isCardSession: true })).reason === '系统注入');
    check('会话注入·交接接手指令（主会话里，不属卡会话）', classifyMessage('你是「会话标题与归档方案」这条主线的接手会话。开工三步，**严格按此顺序**…', P()).reason === '会话注入（交接/接手指令，不是她打的字）');
    check('会话注入·【任务】开头', classifyMessage('【任务】把 3 号灯塔的两处缺陷补上', P()).reason === '会话注入（交接/接手指令，不是她打的字）');
    check('她真问"你是咋想的"不被误伤', classifyMessage('你是咋想的？说说看', P()).excluded === false);
    check('她真说"任务"两个字不被误伤', classifyMessage('这个任务先放着，明天再说', P()).excluded === false);
    check('长文粘贴 >800', classifyMessage('字'.repeat(801), P({ chars: 801 })).reason === '长文粘贴（>800 字）');
    check('纯路径排除', classifyMessage('X:\\work\\docs\\abc.md', P({ chars: 20 })).excluded);
    check('纯 URL 排除', classifyMessage('https://example.com/a/b', P({ chars: 22 })).excluded);
    check('短英文排除', classifyMessage('ok', P({ chars: 2 })).excluded);
    check('正常原话保留', classifyMessage('都记下来吧，还有啥类似的', P()).excluded === false);
    check('中文+表情保留', classifyMessage('换吧', P({ chars: 2 })).excluded === false);

    // ── C. 同 ts 分块合并（不合并就会把长卡指令误判成短句）
    const dbR = readSaidFromDb(path.join(home, 'memory-life', 'life.db'), win);
    check('merge：卡指令两块合并成 1 条', dbR.messages.filter((m) => m.session === 's-card').length === 1);
    check('merge：合并后 chars 累加 = 1005', dbR.messages.find((m) => m.session === 's-card')?.chars === 1005);

    // ── D. 流水/文档/卡取数
    const cl = readChangelog(root, win);
    check('变更流水当日段 = 1 行（不吃隔壁日子）', cl.lines.length === 1 && cl.lines[0].includes('原话账'));
    const { artifacts, stats: artStats } = collectArtifacts({ root, home, win });
    check('产物：卡 1 张（窗口外的卡不吃）', artStats.cardCount === 1);
    check('产物：文档 3 份（需求档 + 待办档 + 流水档自身体）', artStats.docCount === 3, String(artStats.docCount));
    // 自己的产出不能当证据（同日重跑会自证）
    const selfDoc = path.join(root, 'docs', '统筹提示-2026-11-01.md');
    fs.writeFileSync(selfDoc, '# 统筹提示 · 2026-11-01\n\n- 已落地\n', 'utf8');
    fs.utimesSync(selfDoc, new Date(t('23:20')), new Date(t('23:20')));
    const artSelf = collectArtifacts({ root, home, win });
    check('产物：跳过自己的产出（统筹提示-*.md）', artSelf.stats.docCount === 3 && artSelf.stats.selfSkipped === 1, JSON.stringify(artSelf.stats));
    fs.unlinkSync(selfDoc);
    check('产物：文档标题取到 # 行', artifacts.some((a) => a.kind === '档' && a.label.includes('需求收集')));

    // ── E. 判定层：真 JSON / 围栏 / 编造证据 / bad-json
    check('parseJudge 纯 JSON', parseJudge('[{"id":1,"landed":true,"evidence":"A1"}]')?.[0]?.landed === true);
    check('parseJudge 围栏', parseJudge('```json\n[{"id":2,"landed":false}]\n```')?.[0]?.id === 2);
    check('parseJudge 垃圾返回 null', parseJudge('我判不了') === null);
    const said2 = [{ ts: t('21:34'), text: '包括你上面的建议，都记下来', chars: 14 }, { ts: t('21:45'), text: '再分出来一个会话专门来管主线', chars: 14 }];
    const fakeOk = async () => ({ ok: true, text: '[{"id":1,"landed":true,"evidence":"A1","suggestion":""},{"id":2,"landed":true,"evidence":"A99","suggestion":"补进待办"}]', model: 'fixture' });
    const j1 = await judgeSaid({ said: said2, artifacts, llmFn: fakeOk });
    check('判定：合法证据 → landed', j1.verdicts.get(1).landed === true && j1.verdicts.get(1).evidence === 'A1');
    check('判定：编造编号 A99 → 不算落地', j1.verdicts.get(2).landed === false);
    const fakeBad = async () => ({ ok: false, reason: 'timeout' });
    const j2 = await judgeSaid({ said: said2, artifacts, llmFn: fakeBad });
    check('fail-open：调用失败 → 全部 unknown 且不丢条', j2.verdicts.size === 2 && [...j2.verdicts.values()].every((v) => v.landed === false && v.unknown));

    // ── F. 端到端（夹具）：跑 run()，断言三列与排除明细
    const r = await run({ date: '2026-11-01', root, home, write: false, noTail: true, llmFn: fakeOk, nowMs: t('23:30') });
    check('端到端：原话 2 条（注入/卡指令/长文/路径全排除）', r.stats.said === 2, JSON.stringify(r.stats));
    check('端到端：排除 8 条', r.stats.excluded === 8, String(r.stats.excluded));
    check('端到端：已落地 1 / 没落地 1', r.stats.landed === 1 && r.stats.notLanded === 1);
    check('端到端：报告三列齐（已落地 / 没落地 / 已排除）', /## 已落地/.test(r.md) && /## 没落地（建议）/.test(r.md) && /## 已排除/.test(r.md));
    check('端到端：报告写清了库内最新块', /库内最新块/.test(r.md));

    // ── G. 不落档（write:false 不产生文件）
    check('write:false 不写文件', r.outPath === null && !fs.existsSync(path.join(root, 'docs', '统筹提示-2026-11-01.md')));

    // ── H. 真落档路径（写进夹具 docs 里，验证可写）
    const r2 = await run({ date: '2026-11-01', root, home, write: true, noTail: true, llmFn: fakeOk, nowMs: t('23:30') });
    check('write:true 落档成功且非空', !!r2.outPath && fs.existsSync(r2.outPath) && fs.statSync(r2.outPath).size > 500);
  } catch (e) {
    fail++;
    console.log('  ❌ 夹具异常：' + (e?.stack ?? e));
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* temp 清不掉不算失败 */ }
  }
  console.log(`\n夹具结果：${pass} 条通过 / ${fail} 条失败`);
  return fail === 0;
}

// ──────────────────────────────────── 入口 ───────────────────────────────────
const isMain = (() => {
  try {
    const argv1 = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return argv1 && argv1.toLowerCase() === fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
  } catch { return false; }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const has = (k) => argv.includes(k);
  const val = (k, d = null) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
  if (has('--help') || has('-h')) { console.log(HELP); process.exitCode = 0; }
  else if (has('--selftest')) {
    const ok = await selftest();
    process.exitCode = ok ? 0 : 3;
  } else {
    VERBOSE = has('--verbose');
    const unknown = argv.filter((a) => a.startsWith('--') && !['--date', '--out', '--no-write', '--no-llm', '--no-tail', '--json', '--verbose', '--selftest', '--help', '-h'].includes(a));
    if (unknown.length) { console.error(`未知参数：${unknown.join(' ')}\n\n${HELP}`); process.exitCode = 2; }
    else {
      try {
        const res = await run({
          date: val('--date', todayInTz()),
          out: val('--out', null),
          noLlm: has('--no-llm'),
          noTail: has('--no-tail'),
          write: !has('--no-write'),
        });
        if (has('--json')) {
          console.log(JSON.stringify({ date: res.date, outPath: res.outPath, stats: res.stats, said: res.said, excluded: res.excluded }, null, 2));
        } else {
          const s = res.stats;
          console.log(`\n📋 统筹提示 · ${res.date}：你说过 ${s.said} 条 / 已落地 ${s.landed} / 没找到载体 ${s.notLanded}（排除 ${s.excluded} 条）`);
          console.log(`   产物：卡 ${s.cardCount} 张 · 文档 ${s.docCount} 份${s.memCount ? ` · 记忆 ${s.memCount} 条` : ''} · 流水 ${s.clCount} 行 · 判定器 ${s.judge.model ?? '未跑'}（调用 ${s.judge.calls} / 失败 ${s.judge.failed}）`);
          if (res.outPath) console.log(`   报告：${res.outPath}`);
          else console.log('   （--no-write：只打印，未落档）');
          if (VERBOSE) {
            for (const x of res.said) console.log(`   ${x.landed ? '✅' : '🟡'} ${x.time}「${clip(x.text, 50)}」→ ${x.landed ? x.evidenceLabel : (x.suggestion || '(无建议)')}`);
            for (const x of res.excluded) console.log(`   ⛔ ${x.time} [${x.reason}] ${clip(x.text, 44)}`);
          }
          process.exitCode = 0;
        }
      } catch (e) {
        console.error(`取数失败：${e?.message ?? e}`);
        if (VERBOSE) console.error(e?.stack ?? '');
        process.exitCode = 1;
      }
    }
  }
}
