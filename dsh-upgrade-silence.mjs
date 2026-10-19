#!/usr/bin/env node
/**
 * 升级静默窗开关 v2（停 / 恢复生产自动化 · 零依赖 · 持有者引用计数）
 *
 * 为什么需要：主包升级期间不能让自动化插手（P0 自动重启会把旧 dsh 拉回来、P2 盯人会把
 * 升级动作记成异常、P5 审计会对搬家中的文件误判）。
 *
 * 为什么是**持有者引用计数**（v2 · 2026-09-20 卡 ③-4 · 方案 §3.5(c)）：
 *   旧版只有一个 `phase` 布尔 —— 一方 `--disable` 会覆盖另一方开的窗，先 `--enable` 的一方
 *   会把另一方还需要的静默窗打开（一个停 tickd、一个放 tickd，两边都以为是自己该管的）。
 *   v2 里"谁开着"= `holders` 的键集合：**最后一个持有者释放时才真恢复自动化**。
 *
 * 覆盖两种形态（2026-09-11 起本机是前者，TUF / 历史形态是后者）：
 *   A. tickd 常驻进程（node butler-tickd.mjs，各 tick 全在里面）→ --stop / --ensure
 *   B. Windows 计划任务 DSH-Butler-*（Daily/Weekly/各 Tick）            → Disable/Enable-ScheduledTask
 *
 * 用法：
 *   node dsh-upgrade-silence.mjs --status                     # 只读：形态 + 静默窗 + 持有者列表
 *   node dsh-upgrade-silence.mjs --disable --holder <id>      # 开静默窗（升级/修复前）
 *   node dsh-upgrade-silence.mjs --enable  --holder <id>      # 释放自己的持有（还有别的持有者就不恢复）
 *   node dsh-upgrade-silence.mjs --check-stale                # 只读判定 + 超期（>4h）告警（alert）
 *   选项：
 *     --holder <id>       持有者标识（护士 = nurse-<caseId>；B3 升级 = upgrade-<sessionId>）
 *                         不传 = `legacy`（兼容旧调用方；输出里会显式提示）
 *     --reason <text>     本次持有/释放的原因（写进 holders 记录；--force-enable 必填）
 *     --force-enable --reason <text>
 *                         逃生舱：无视剩余持有者，强行清空并恢复自动化（审计 + 告警）
 *     --include-reports   连 Daily / Weekly 报告任务一起停（记进本次持有者记录）
 *     --home <dir>        状态文件所在 home（默认 $BUTLER_DSH_HOME / $DSH_HOME / ~/.dsh）
 *     --dry-run           只打印将做的动作（不写盘、不停服务）
 *     --json              机器可读输出（日志只落文件、不上 stdout）
 *
 * 语义（卡 ③-4）：
 *   · 同一 holder 重复 `--disable` = **幂等覆盖**（刷新 at/reason，不累加）；
 *   · `holders` **由空变非空**时才真停 tickd / 计划任务（并记录各自的 before 形态）；
 *   · `--enable --holder X` 只删自己的键；**holders 非空 ⇒ 不恢复**（打印剩余持有者 + 各自 at）；
 *   · **写盘顺序铁律（T13）**：先写 `holders` **再**停 tickd / 计划任务 —— 反过来的半完成态
 *     （服务已停、文件没写）会让后来者以为"没人开窗"，tickd 永久停摆且无人知；
 *   · `--enable` 在「holders 为空但 tickd 不在跑」时**主动 `--ensure` 拉起 + 告警**（同款兜底）；
 *   · 任一 holder 持有 > 4h ⇒ `--check-stale` / `--disable` / `--enable` 触发 alert + 日报段
 *     （日报段由 `lib/cross-lane.mjs` 只读呈现，判定不在日报里复制）；
 *   · 兼容读 v1：无 `holders` 的文件视为单一 holder `legacy`（**下一次写自动升 v2，不迁移历史**）。
 *
 * 安全：enable 只恢复"原本就在跑的东西"；本机原本没跑的形态不会被凭空拉起来
 *       （唯一例外 = T13 兜底：holders 为空而 tickd 不在跑 ⇒ 拉起 + 告警，防"永久停摆无人知"）。
 * 测试注入（只影响测试/隔离环境，生产不设即零差异）：
 *   DSH_SILENCE_TICKD = 替代 tickd 脚本路径 · DSH_SILENCE_TOOLS = 替代 tools 根（找 butler lib）
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));

const argv = process.argv.slice(2);
const has = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null; };

const DRY = has('--dry-run');
const JSON_OUT = has('--json');
const INCLUDE_REPORTS = has('--include-reports');
const HELP = has('--help') || has('-h');
const HOME_ARG = opt('home');
const DSH_HOME = HOME_ARG || process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
// tools 根：生产 = 本脚本所在目录（<DSH_ROOT>\tools）；测试可用 DSH_SILENCE_TOOLS 指到真 tools 复用 butler 库
const TOOLS_DIR = process.env.DSH_SILENCE_TOOLS || HERE;
// tickd 控制脚本可注入（测试/隔离环境用 `DSH_SILENCE_TICKD`；默认生产常驻件）
const TICKD = process.env.DSH_SILENCE_TICKD || path.join(HERE, 'dsh-butler', 'butler-tickd.mjs');
const STATE = path.join(DSH_HOME, 'upgrade-silence-state.json');
const NODE = process.execPath;

const SCHEMA_VERSION = 2;
const STALE_MS = 4 * 3600 * 1000;      // 持有 > 4h = 疑似残留（方案 §3.5(c)）
const LEGACY_HOLDER = 'legacy';        // v1 兼容读的隐含持有者

// 高频 tick 计划任务（升级期间必须停）；Daily/Weekly 属报告类，视窗口用 --include-reports 一并停
const TICK_TASKS = [
  'DSH-Butler-WatchFs', 'DSH-Butler-WatchTick', 'DSH-Butler-RestartTick',
  'DSH-Butler-External', 'DSH-Butler-PitfallTick', 'DSH-Butler-BareWatchTick',
];
const REPORT_TASKS = ['DSH-Butler-Daily', 'DSH-Butler-Weekly'];

const MODE = has('--disable') ? 'disable'
  : has('--enable') ? 'enable'
    : has('--force-enable') ? 'force-enable'
      : has('--check-stale') ? 'check-stale'
        : 'status';

const log = (...a) => { if (!JSON_OUT) console.log(...a); };

function run(file, args, opts = {}) {
  const r = spawnSync(file, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, ...opts });
  return { ok: r.status === 0, code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
// 【2026-10-09 · 卡「360弹窗治本-pwsh7」】pwsh 7 优先（360 企业版 EDR 只对 5.1 弹「命令执行攻击」）；
//   统一工具缺失 ⇒ 兜底 5.1，可用性不下降。
const PS_EXE = await import('./lib/powershell-exe.mjs').then((m) => m.powerShellExe()).catch(() => 'powershell.exe');
const ps = (cmd) => run(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', cmd]);
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };

/**
 * 剥掉内存态标记（`__fromV1` / `__missing`）。
 * ⚠️ 2026-09-20 L2 实测踩到的真坑：归一化视图带的内部标记若被一起写盘，**下一次读**会把
 * 它们当成文件字段 —— v2 分支 `{...raw}` 原样继承 ⇒ `__fromV1:true` 残留 ⇒ `--enable` 误判
 * "磁盘文件是 v1 形态"而拒绝释放持有者（L2 步骤 3/4 实测复现）。故：写盘一律剥内部键。
 */
function pruneInternal(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (!k.startsWith('__')) out[k] = v;
  return out;
}

/** 原子写（同目录 tmp + rename）：状态文件是"谁开着窗"的唯一凭据，不能写半截。 */
function writeState(o) {
  fs.mkdirSync(path.dirname(STATE), { recursive: true });
  const tmp = `${STATE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(pruneInternal(o), null, 2), 'utf8');
  fs.renameSync(tmp, STATE);
}

function pruneUndefined(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined) out[k] = v;
  return out;
}

// ─────────────────────────────────────────────────────────── 状态读写（v2 + v1 兼容读）

function emptyState() {
  return { schemaVersion: SCHEMA_VERSION, phase: 'enabled', holders: {} };
}

/**
 * 把磁盘上的状态归一成 v2 视图。
 * v1（有 `phase`、无 `holders`）⇒ 视为单一 holder `legacy`；**只补视图，不迁移历史**
 * （下一次真正写盘时才升 v2 —— 方案 §3.5(c)「兼容读 v1」+ 拍板项 6 = a 方案）。
 */
function normalizeState(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ...emptyState(), __missing: true };
  }
  const hasHoldersMap = raw.holders && typeof raw.holders === 'object' && !Array.isArray(raw.holders);
  if (Number(raw.schemaVersion) >= 2 || hasHoldersMap) {
    // 剥离内部标记（自愈历史脏文件：早期实现把 `__fromV1` 一起写盘了，见 pruneInternal 注释）
    const { __fromV1: _a, __missing: _b, ...clean } = raw;
    return { ...clean, schemaVersion: SCHEMA_VERSION, holders: { ...(raw.holders || {}) } };
  }
  const holders = {};
  if (raw.phase === 'disabled') {
    holders[LEGACY_HOLDER] = {
      at: raw.disabledAt ?? null,
      reason: 'v1 兼容读（文件无 holders 字段）',
      tickdWasRunning: raw.tickdWasRunning ?? null,
      tickdPid: raw.tickdPid ?? null,
      tasksBefore: Array.isArray(raw.tasksBefore) ? raw.tasksBefore : [],
      includeReports: !!raw.includeReports,
      operator: raw.operator ?? null,
      legacy: true,
    };
  }
  return { ...raw, schemaVersion: SCHEMA_VERSION, holders, __fromV1: true };
}

function readState() {
  const raw = readJson(STATE);
  return { raw, st: normalizeState(raw) };
}

/** 持有者视图（id + at + 年龄 + 是否超期）。 */
function holderList(st, now = Date.now()) {
  return Object.entries(st.holders || {}).map(([id, h]) => {
    const at = h?.at ?? null;
    const t = at ? Date.parse(at) : NaN;
    const ageMs = Number.isFinite(t) ? Math.max(0, now - t) : null;
    return {
      id, at, ageMs, stale: ageMs !== null && ageMs > STALE_MS,
      reason: h?.reason ?? null, tickdWasRunning: h?.tickdWasRunning ?? null,
      legacy: !!h?.legacy,
    };
  }).sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

const fmtAge = (ms) => (ms === null ? '?' : (ms >= 3600000 ? `${(ms / 3600000).toFixed(1)}h` : `${Math.round(ms / 60000)}min`));

// ─────────────────────────────────────────────────────────── 环境探测（tickd / 计划任务）

function tickdStatus() {
  const r = run(NODE, [TICKD, '--status']);
  const j = (() => { try { return JSON.parse(r.out); } catch { return null; } })();
  return j || { ok: false, running: false, reason: r.err || 'status 调用失败' };
}

function listTasks() {
  const wanted = [...TICK_TASKS, ...REPORT_TASKS];
  const filter = wanted.map((n) => `'${n}'`).join(',');
  const r = ps(`$w=@(${filter}); Get-ScheduledTask | Where-Object { $w -contains $_.TaskName } | Select-Object TaskName,State | ConvertTo-Json -Compress`);
  let arr = [];
  try { const j = JSON.parse(r.out || '[]'); arr = Array.isArray(j) ? j : [j]; } catch { arr = []; }
  // 同时报出所有 DSH-* 任务（验收口径：DSH-Butler 匹配到的任务全为 Ready）
  const all = ps(`Get-ScheduledTask | Where-Object { $_.TaskName -like 'DSH-Butler*' } | Select-Object TaskName,State | ConvertTo-Json -Compress`);
  let allArr = [];
  try { const j = JSON.parse(all.out || '[]'); allArr = Array.isArray(j) ? j : [j]; } catch { allArr = []; }
  return { matched: arr, allButler: allArr };
}

function setTasks(names, action) {
  const done = [];
  for (const n of names) {
    if (DRY) { done.push({ name: n, action, dry: true }); continue; }
    const r = ps(action === 'disable' ? `Disable-ScheduledTask -TaskName '${n}' | Out-Null; 'ok'` : `Enable-ScheduledTask -TaskName '${n}' | Out-Null; 'ok'`);
    done.push({ name: n, action, ok: r.ok, err: r.ok ? undefined : (r.err || r.out).split('\n')[0] });
  }
  return done;
}

// ─────────────────────────────────────────────────────────── 告警 / 审计（动态 import，库缺失不阻断）

async function butlerAlert(entry) {
  try {
    const m = await import(pathToFileURL(path.join(TOOLS_DIR, 'dsh-butler', 'lib', 'alert.mjs')).href);
    return m.alert(entry, { home: DSH_HOME, silent: JSON_OUT });
  } catch (e) {
    if (!JSON_OUT) console.error(`[silence] alert 库不可用（告警只落 stderr）：${e?.message ?? e}`);
    else console.error(`[silence] alert 库不可用：${e?.message ?? e}`);
    return { ok: false, file: null };
  }
}

async function butlerAudit(entry) {
  try {
    const m = await import(pathToFileURL(path.join(TOOLS_DIR, 'dsh-butler', 'lib', 'audit.mjs')).href);
    return m.appendAudit(entry, { home: DSH_HOME, silent: JSON_OUT });
  } catch (e) {
    if (!JSON_OUT) console.error(`[silence] audit 库不可用（留痕失败）：${e?.message ?? e}`);
    return { ok: false };
  }
}

// ─────────────────────────────────────────────────────────── 静默动作（停 / 起）

/** 停自动化：计划任务 + tickd。返回动作记录。 */
function silenceActions(t, tasks, { includeReports }) {
  const acts = [];
  const targetNames = [
    ...tasks.matched.filter((x) => TICK_TASKS.includes(x.TaskName) && x.State !== 'Disabled').map((x) => x.TaskName),
    ...(includeReports ? tasks.matched.filter((x) => REPORT_TASKS.includes(x.TaskName) && x.State !== 'Disabled').map((x) => x.TaskName) : []),
  ];
  if (targetNames.length) {
    log(` 计划任务：${targetNames.join(' / ')}`);
    acts.push(...setTasks(targetNames, 'disable'));
  } else {
    log(` 计划任务：无需停（匹配到 ${tasks.matched.length} 个，均已是 Disabled 或不存在）`);
  }
  if (t.running) {
    log(` tickd：stop（pid ${t.pid}）`);
    if (!DRY) acts.push({ name: 'tickd', action: 'stop', ...run(NODE, [TICKD, '--stop']) });
  } else {
    log(` tickd：未在运行，跳过（${t.reason}）`);
  }
  return acts;
}

/**
 * 恢复自动化：计划任务（按 holders 各自的 tasksBefore 取并集）+ tickd。
 * `wantTickd` 只影响文案（"原本就在跑" vs "T13 兜底拉起"）；`preRunning` = 恢复**前** tickd 是否在跑。
 */
function restoreActions(tasks, st, allHolders) {
  const acts = [];
  const before = new Map();
  for (const h of allHolders) for (const x of (h?.tasksBefore || [])) if (x?.name) before.set(x.name, x.state);
  for (const x of (Array.isArray(st.tasksBefore) ? st.tasksBefore : [])) if (x?.name && !before.has(x.name)) before.set(x.name, x.state);
  const toEnable = tasks.matched
    .filter((x) => x.State === 'Disabled' && (before.size === 0 || before.get(x.TaskName) !== 'Disabled'))
    .map((x) => x.TaskName);
  if (toEnable.length) {
    log(` 计划任务：${toEnable.join(' / ')}`);
    acts.push(...setTasks(toEnable, 'enable'));
  } else {
    log(' 计划任务：无需恢复（本机无 DSH-Butler 任务）');
  }

  const wantTickd = allHolders.some((h) => h?.tickdWasRunning === true) || st.tickdWasRunning === true;
  const cur = tickdStatus();
  const preRunning = !!cur.running;
  let bottomOut = false;
  if (preRunning) {
    log(` tickd：已在运行，跳过（pid ${cur.pid}）`);
  } else if (wantTickd) {
    log(' tickd：ensure（原本就在跑 → 拉起常驻进程）');
    if (!DRY) acts.push({ name: 'tickd', action: 'ensure', ...run(NODE, [TICKD, '--ensure']) });
  } else {
    // T13 兜底：holders 已空却没人报告 tickd 在跑 —— 半完成态的典型形态（先停后写 / 文件写丢 / 被手改），
    // 若不主动拉起，tickd 会永久停摆且无人知（方案 §3.5(c) 写盘顺序铁律）。
    bottomOut = true;
    log(' tickd：⚠️ holders 为空但 tickd 不在跑 → 半完成态兜底：主动 ensure 拉起 + 告警');
    if (!DRY) acts.push({ name: 'tickd', action: 'ensure(bottom-out)', ...run(NODE, [TICKD, '--ensure']) });
  }
  return { acts, bottomOut, wantTickd, preRunning };
}

// ─────────────────────────────────────────────────────────── 主模式

function doStatus() {
  const t = tickdStatus();
  const tasks = listTasks();
  const { raw, st } = readState();
  const now = Date.now();
  const holders = holderList(st, now);
  const stale = holders.filter((h) => h.stale);
  const inWindow = st.phase === 'disabled' || holders.length > 0;
  const out = {
    mode: 'status',
    schemaVersion: st.schemaVersion ?? null,
    stateSchemaOnDisk: raw?.schemaVersion ?? null,
    tickd: { running: !!t.running, pid: t.pid ?? null, reason: t.reason || null, jobs: (t.jobs || []).map((j) => `${j.id}:${j.every}`) },
    scheduledTasks: tasks.allButler.map((x) => `${x.TaskName}=${x.State}`),
    scheduledTasksAllReady: tasks.allButler.every((x) => x.State === 'Ready'),
    inSilenceWindow: inWindow,
    holders: holders.map((h) => ({ id: h.id, at: h.at, ageMs: h.ageMs, stale: h.stale, reason: h.reason, legacy: h.legacy })),
    staleHolders: stale.map((h) => h.id),
    stateFile: STATE,
    state: raw ? { phase: st.phase, disabledAt: st.disabledAt ?? null, enabledAt: st.enabledAt ?? null, legacyRead: !!st.__fromV1 } : null,
  };
  out.verdict = out.tickd.running && out.scheduledTasksAllReady ? 'AUTOMATION-LIVE' : 'AUTOMATION-SILENT';
  if (JSON_OUT) { console.log(JSON.stringify(out, null, 2)); return out.verdict === 'AUTOMATION-LIVE' ? 0 : 1; }
  log('=== 自动化形态 ===');
  log(` tickd 常驻      : ${out.tickd.running ? `running (pid ${out.tickd.pid})` : `not running（${out.tickd.reason}）`}`);
  if (out.tickd.jobs.length) log(`   内含 job     : ${out.tickd.jobs.join(' / ')}`);
  log(` DSH-Butler 任务 : ${out.scheduledTasks.length ? out.scheduledTasks.join(' / ') : '0 个（tickd 形态，本机应恒为 0）'}`);
  log(` 任务全 Ready    : ${out.scheduledTasksAllReady ? 'yes' : 'NO'}`);
  log(` 静默窗          : ${out.inSilenceWindow ? `已开启（${st.disabledAt ?? holders[0]?.at ?? '?'}，${holders.length} 个持有者）` : '未开启'}`);
  if (holders.length) {
    log(' 持有者：');
    for (const h of holders) log(`   · ${h.id}${h.legacy ? '（v1 兼容读）' : ''} — 持有 ${fmtAge(h.ageMs)}（at ${h.at}）${h.reason ? `｜${h.reason}` : ''}${h.stale ? '  ⚠️ 超期 >4h' : ''}`);
  }
  if (st.__fromV1) log('   （磁盘文件仍是 v1 形态：无 holders 字段 → 按单一 holder `legacy` 读，下次写盘自动升 v2）');
  if (stale.length) log(` ⚠️ 疑似残留：${stale.map((h) => h.id).join(' / ')} 持有超过 4h（跑 --check-stale 发告警；日报「🔗 跨线契约」段同样呈现）`);
  log(` 判定            : ${out.verdict === 'AUTOMATION-LIVE' ? '自动化在跑（升级前请 --disable）' : '自动化已静默'}`);
  return out.verdict === 'AUTOMATION-LIVE' ? 0 : 1;
}

async function doDisable() {
  const holder = opt('holder') || LEGACY_HOLDER;
  const reason = opt('reason') || null;
  const { st } = readState();
  const wasEmpty = Object.keys(st.holders).length === 0;
  const t = tickdStatus();
  const tasks = listTasks();
  const nowIso = new Date().toISOString();

  log('=== 开启静默窗（升级前） ===');
  log(` 持有者：${holder}${opt('holder') ? '' : `（未传 --holder ⇒ 记为 ${LEGACY_HOLDER}）`}｜原因：${reason ?? '（未填）'}`);
  if (st.holders[holder]) log(' 该持有者已在窗内 → 幂等覆盖（刷新 at/reason，不累加）');
  if (wasEmpty) log(' holders：空 → 非空（本次是真开窗：会真停 tickd / 计划任务）');
  else log(` holders：非空（${Object.keys(st.holders).length} 个持有者）→ 只登记，不重复停服务`);

  // 记录"开窗前形态"（每个 holder 各记一份：谁先开窗，谁记的就是真形态）
  const next = {
    ...st,
    schemaVersion: SCHEMA_VERSION,
    phase: 'disabled',
    disabledAt: (st.phase === 'disabled' && st.disabledAt) ? st.disabledAt : nowIso,
    device: os.hostname(),
    operator: process.env.DSH_SESSION_ID || null,
    holders: {
      ...st.holders,
      [holder]: {
        at: nowIso,
        reason,
        tickdWasRunning: !!t.running,
        tickdPid: t.pid ?? null,
        tasksBefore: tasks.matched.map((x) => ({ name: x.TaskName, state: x.State })),
        includeReports: INCLUDE_REPORTS,
        operator: process.env.DSH_SESSION_ID || null,
        host: os.hostname(),
      },
    },
  };

  // ── T13 写盘顺序铁律：**先写 holders，再停服务**（顺序反了 ⇒ 崩在中途就成"服务已停、
  //    文件里没人开窗"⇒ 后来者以为无持有者 ⇒ tickd 永久停摆无人知）
  if (!DRY) {
    try { writeState(next); log(` ① 先写状态文件（holders 登记完成）：${STATE}`); }
    catch (e) { log(` ✗ 写状态文件失败：${e?.message ?? e}（**不动服务**，直接退出）`); return 1; }
  } else log(` ① (dry-run) 将先写状态文件：${STATE}`);

  // ── 再停服务
  const acts = [];
  if (wasEmpty) {
    acts.push(...silenceActions(t, tasks, { includeReports: INCLUDE_REPORTS }));
  } else if (t.running) {
    // 静默窗内 tickd 竟在跑（异常复活 / 上次半完成）⇒ 补停（窗的语义是"自动化必须静默"）
    log(` ⚠️ 静默窗内 tickd 竟在运行（pid ${t.pid}）→ 补停（异常复活）`);
    acts.push({ name: 'tickd', action: 'stop(resurrected)', ...(DRY ? { dry: true } : run(NODE, [TICKD, '--stop'])) });
  } else {
    log(' ② 停服务：跳过（holders 非空 ⇒ 幂等，不重复停）');
  }

  const after = tickdStatus();
  const afterTasks = listTasks();
  const stillRunning = !!after.running;
  const stillReady = afterTasks.allButler.filter((x) => x.State === 'Ready');
  if (!DRY) {
    const done = { ...next, actions: acts.length ? acts : (next.actions ?? []), disabledVerifiedAt: new Date().toISOString() };
    try { writeState(done); } catch (e) { log(` ⚠️ 补写 actions/校验失败（不影响 holders 已落盘）：${e?.message ?? e}`); }
  }
  log('');
  log(` 校验：tickd ${stillRunning ? '仍在运行 ✗' : '已停 ✓'}｜DSH-Butler 任务 Ready ${stillReady.length}/${afterTasks.allButler.length} ${stillReady.length === 0 ? '✓' : '✗'}`);
  log(` 状态文件：${STATE}`);
  log(` 升级窗口结束后务必（带同一个 holder）：node ${path.join(HERE, 'dsh-upgrade-silence.mjs')} --enable --holder ${holder}`);

  const stale = holderList(readState().st).filter((h) => h.stale);
  if (stale.length) await staleAlert(stale, 'disable');

  const code = (stillRunning || stillReady.length) ? 1 : 0;
  if (JSON_OUT) console.log(JSON.stringify({
    mode: 'disable', holder, reason, wasEmpty, dryRun: DRY, stateFile: STATE,
    holders: Object.keys(readState().st.holders), actions: acts,
    verify: { tickdRunning: stillRunning, tasksReady: stillReady.length, tasksTotal: afterTasks.allButler.length },
    staleHolders: stale.map((h) => h.id), exit: code,
  }, null, 2));
  return code;
}

async function doEnable() {
  const holder = opt('holder') || LEGACY_HOLDER;
  const reason = opt('reason') || null;
  const { raw, st } = readState();
  log('=== 关闭静默窗（升级后） ===');
  if (!raw) log(' ! 没有状态文件（不是本机 disable 的窗口）→ 按当前环境尽力恢复（holders 视为空）');
  if (st.__fromV1 && st.phase === 'disabled' && holder !== LEGACY_HOLDER) {
    log(` ⚠️ 磁盘文件是 v1 形态（无 holders）→ 唯一持有者视为 \`${LEGACY_HOLDER}\`；\`${holder}\` 无权关窗（v1 不迁移历史）`);
    log(`    若确认要恢复：--enable --holder ${LEGACY_HOLDER}（或逃生舱 --force-enable --reason "<原因>"）`);
    return 1;
  }

  const holders = { ...st.holders };
  const mine = holders[holder] ?? null;
  if (mine) { delete holders[holder]; log(` 释放持有者：${holder}（自 ${mine.at ?? '?'} 起持有）`); }
  else log(` 持有者 ${holder} 不在列表（未登记 / 已是半完成态）→ 继续按当前 holders 判定`);

  const remaining = Object.entries(holders);
  if (remaining.length) {
    // 还有别的持有者 ⇒ 不恢复（这正是 v2 的核心：先 enable 的一方不再误开对方的窗）
    const next = pruneUndefined({
      ...st, schemaVersion: SCHEMA_VERSION, phase: 'disabled', holders,
      enabledAt: undefined, device: os.hostname(),
      lastRelease: { holder, at: new Date().toISOString(), reason, by: process.env.DSH_SESSION_ID || null },
    });
    if (!DRY) writeState(next);
    log('');
    log(` 仍静默：还有 ${remaining.length} 个持有者 → **不恢复**（tickd 保持停止）`);
    for (const [id, h] of remaining) log(`   · ${id} — 持有自 ${h?.at ?? '?'}${h?.reason ? `｜${h.reason}` : ''}`);
    log(` 最后一个持有者释放时才恢复：node ${path.join(HERE, 'dsh-upgrade-silence.mjs')} --enable --holder <id>`);
    log(' 判定：PASS — 静默窗按引用计数保持开启（未提前恢复自动化）');
    const stale = holderList({ holders }).filter((h) => h.stale);
    if (stale.length) await staleAlert(stale, 'enable');
    if (JSON_OUT) console.log(JSON.stringify({
      mode: 'enable', holder, reason, dryRun: DRY, stillSilent: true, restored: false,
      remainingHolders: remaining.map(([id, h]) => ({ id, at: h?.at ?? null, reason: h?.reason ?? null })),
      staleHolders: stale.map((h) => h.id), stateFile: STATE, exit: 0,
    }, null, 2));
    return 0;
  }

  // holders 空了 ⇒ 真恢复
  const allHolders = [...Object.values(st.holders)];
  const tasks = listTasks();
  const { acts, bottomOut, wantTickd, preRunning } = restoreActions(tasks, st, allHolders);
  // 卡 ③-4 第 6 条：holders 为空而 tickd 不在跑 ⇒ 拉起 + **告警**（正常恢复记 info，半完成态兜底记 warn）
  if (!DRY && !preRunning) {
    await butlerAlert({
      level: bottomOut ? 'warn' : 'info', source: 'silence-window',
      message: bottomOut
        ? `静默窗 holders 为空但 tickd 不在跑 → 已兜底 --ensure 拉起（T13 半完成态收敛）`
        : `静默窗关闭：holders 为空且 tickd 未在跑 → 已按"原本在跑"记录 --ensure 拉起`,
      detail: { stateFile: STATE, device: os.hostname(), holder, reason, bottomOut },
    });
  }

  const t = DRY ? { running: true, dry: true } : tickdStatus();
  const tk = listTasks();
  const ready = tk.allButler.filter((x) => x.State === 'Ready');
  const allReady = ready.length === tk.allButler.length;
  const pass = (DRY ? true : !!t.running) && allReady;
  if (!DRY) {
    writeState(pruneUndefined({
      ...st, schemaVersion: SCHEMA_VERSION, phase: 'enabled', holders: {},
      enabledAt: new Date().toISOString(), device: os.hostname(),
      lastRelease: { holder, at: new Date().toISOString(), reason, by: process.env.DSH_SESSION_ID || null },
      restoreActions: acts,
      verify: { tickdRunning: !!t.running, tickdPid: t.pid ?? null, tasksReady: ready.length, tasksTotal: tk.allButler.length, bottomOut, preRunning, pass },
    }));
  }
  log('');
  log(` 校验：tickd ${DRY ? '(dry-run)' : (t.running ? `running ✓ (pid ${t.pid})` : 'not running ✗')}`);
  log(`       DSH-Butler 任务 Ready ${ready.length}/${tk.allButler.length} ${allReady ? '✓' : '✗'}`);
  if (t.jobs) log(`       job 数 ${t.jobs.length}`);
  log(`       形态口径：${wantTickd ? '原本就在跑 → 已恢复' : 'holders 空 + tickd 未运行 → 已兜底拉起并告警'}`);
  log(` 判定：${pass ? 'PASS — 自动化已恢复' : 'FAIL — 请人工检查（node ' + TICKD + ' --status）'}`);
  if (JSON_OUT) console.log(JSON.stringify({
    mode: 'enable', holder, reason, dryRun: DRY, stillSilent: false, restored: true,
    wantTickd, bottomOut, actions: acts,
    verify: { tickdRunning: !!t.running, tickdPid: t.pid ?? null, tasksReady: ready.length, tasksTotal: tk.allButler.length, pass },
    stateFile: STATE, exit: pass ? 0 : 1,
  }, null, 2));
  return pass ? 0 : 1;
}

async function doForceEnable() {
  const reason = opt('reason');
  log('=== 逃生舱：强制关闭静默窗（--force-enable） ===');
  if (!reason || !String(reason).trim()) {
    log(' ✗ 用法错误：--force-enable 必须带 --reason <text>（逃生动作要留痕）');
    return 2;
  }
  const { st } = readState();
  const dropped = holderList(st);
  log(` 忽略的持有者（${dropped.length} 个）：${dropped.length ? dropped.map((h) => `${h.id}@${h.at}`).join(' / ') : '（无）'}`);
  log(` 原因：${reason}`);

  const tasks = listTasks();
  const allHolders = [...Object.values(st.holders)];
  const { acts, bottomOut, preRunning } = restoreActions(tasks, st, allHolders);
  const t = DRY ? { running: true, dry: true } : tickdStatus();
  const tk = listTasks();
  const ready = tk.allButler.filter((x) => x.State === 'Ready');
  const allReady = ready.length === tk.allButler.length;
  const pass = (DRY ? true : !!t.running) && allReady;

  if (!DRY) {
    writeState(pruneUndefined({
      ...st, schemaVersion: SCHEMA_VERSION, phase: 'enabled', holders: {},
      enabledAt: new Date().toISOString(), device: os.hostname(),
      restoreActions: acts,
      lastForceEnable: { at: new Date().toISOString(), reason, dropped: dropped.map((h) => ({ id: h.id, at: h.at, ageMs: h.ageMs })), by: process.env.DSH_SESSION_ID || null, device: os.hostname() },
      verify: { tickdRunning: !!t.running, tickdPid: t.pid ?? null, tasksReady: ready.length, tasksTotal: tk.allButler.length, bottomOut, preRunning, pass },
    }));
  }
  const auditRes = await butlerAudit({
    type: 'silence-force-enable', kind: 'silence-window', decision: 'force-enable', reason,
    dropped: dropped.map((h) => ({ id: h.id, at: h.at, ageMs: h.ageMs, reason: h.reason })),
    holder: opt('holder') ?? null, host: os.hostname(), device: os.hostname(), dryRun: DRY,
    tickdRunning: !!t.running, tickdPid: t.pid ?? null, at: new Date().toISOString(),
  });
  await butlerAlert({
    level: 'warn', source: 'silence-window',
    message: `静默窗被 --force-enable 强制关闭（忽略 ${dropped.length} 个持有者）：${reason}`,
    detail: { dropped: dropped.map((h) => `${h.id}@${h.at}`), stateFile: STATE, device: os.hostname() },
  });
  log('');
  log(` 校验：tickd ${DRY ? '(dry-run)' : (t.running ? `running ✓ (pid ${t.pid})` : 'not running ✗')}｜任务 Ready ${ready.length}/${tk.allButler.length} ${allReady ? '✓' : '✗'}`);
  log(` 留痕：审计 ${auditRes?.ok ? 'ok' : 'FAIL'}｜alert 已发`);
  log(` 判定：${pass ? 'PASS — 已强制恢复（审计 + 告警已留痕）' : 'FAIL — 请人工检查'}`);
  return pass ? 0 : 1;
}

// ─────────────────────────────────────────────────────────── 超期告警（>4h 疑似残留）

/** 同一批超期持有者只告警一次（签名 = id@at 排序串）；持有者变化/重新开窗 ⇒ 签名变 ⇒ 再告警一次。 */
async function staleAlert(stale, trigger) {
  const sig = stale.map((h) => `${h.id}@${h.at ?? '?'}`).sort().join('|');
  const { st } = readState();
  if (st.staleAlertSignature === sig) {
    log(` ⚠️ 超期持有者已在册（告警签名未变，不重复发）：${sig}`);
    return { alerted: false, signature: sig };
  }
  await butlerAlert({
    level: 'warn', source: 'silence-window',
    message: `静默窗疑似残留：${stale.length} 个持有者超过 4h（${stale.map((h) => h.id).join(' / ')}）`,
    detail: { holders: stale.map((h) => ({ id: h.id, at: h.at, ageMs: h.ageMs, reason: h.reason })), trigger, stateFile: STATE, device: os.hostname() },
  });
  if (!DRY) {
    try { writeState({ ...st, schemaVersion: SCHEMA_VERSION, staleAlertSignature: sig, lastStaleAlertAt: new Date().toISOString() }); }
    catch (e) { log(` ⚠️ 超期告警签名写盘失败：${e?.message ?? e}`); }
  }
  log(` ⚠️ 超期告警已发（alert）：${sig}`);
  return { alerted: true, signature: sig };
}

async function doCheckStale() {
  const { raw, st } = readState();
  const holders = holderList(st);
  const stale = holders.filter((h) => h.stale);
  const r = stale.length ? await staleAlert(stale, 'check-stale') : { alerted: false };
  const payload = {
    mode: 'check-stale', thresholdMs: STALE_MS,
    holders: holders.map((h) => ({ id: h.id, at: h.at, ageMs: h.ageMs, stale: h.stale })),
    staleHolders: stale.map((h) => h.id), alerted: r.alerted, stateFile: STATE, hasStateFile: !!raw, exit: 0,
  };
  if (JSON_OUT) { console.log(JSON.stringify(payload, null, 2)); return 0; }
  log('=== 静默窗超期检查（>4h ⇒ 疑似残留） ===');
  if (!holders.length) log(' 无持有者（静默窗未开）');
  for (const h of holders) log(` · ${h.id} — 持有 ${fmtAge(h.ageMs)}${h.stale ? '  ⚠️ 超期' : ''}`);
  log(stale.length ? ` 判定：${stale.length} 个超期 → ${payload.alerted ? '本次已发 alert' : '本签名已告过警（未重复发）'}` : ' 判定：无超期持有者（无需告警）');
  return 0;
}

// ─────────────────────────────────────────────────────────── 入口

const HELP_TEXT = `升级静默窗开关 v2（holders 引用计数）· 零依赖

用法：
  node dsh-upgrade-silence.mjs --status [--json]                 只读：形态 + 静默窗 + 持有者列表
  node dsh-upgrade-silence.mjs --disable --holder <id> [--reason <text>] [--include-reports] [--dry-run]
  node dsh-upgrade-silence.mjs --enable  --holder <id> [--reason <text>] [--dry-run]
  node dsh-upgrade-silence.mjs --check-stale [--json]            只读判定 + 超期（>4h）告警
  node dsh-upgrade-silence.mjs --force-enable --reason <text>    逃生舱：无视剩余持有者强制恢复（审计 + 告警）

holder 口径：护士 = nurse-<caseId>；B3 升级 = upgrade-<sessionId>；不传 = legacy（兼容旧调用方）
退出码：status 0=自动化在跑 / 1=已静默；disable 0=已静默 / 1=未达成；enable 0=PASS / 1=FAIL 或 v1 无权限；用法错 2`;

let code = 0;
if (HELP) { console.log(HELP_TEXT); }
else if (MODE === 'disable') code = await doDisable();
else if (MODE === 'enable') code = await doEnable();
else if (MODE === 'force-enable') code = await doForceEnable();
else if (MODE === 'check-stale') code = await doCheckStale();
else code = doStatus();
if (!JSON_OUT && !HELP) log(`\n[exit ${code}]`);
process.exitCode = code;
