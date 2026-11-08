#!/usr/bin/env node
/**
 * schtask-overview.mjs —— 一条命令看全本机所有定时任务（Windows 计划任务 + tickd 常驻 job）
 *
 * 由来：2026-10-31 主人提「计划任务进度条」；拆两步，本器具是第 1 步（只读清单 + 该跑没跑判红）。
 *      第 2 步 GUI 浮钮不在本器具范围（见 docs\V3.1.0-需求收集-20261022.md 的 V31-017）。
 *
 * 🔴 纯只读：不注册/不修改/不删除/不启动任何计划任务，不写任何配置文件。
 *    唯一的两个外部调用是 `pwsh -Command Get-ScheduledTask(...)` 与
 *    `node butler-tickd.mjs --status`，两个都是只读查询。
 *
 * 用法：
 *   node <pkg>/src/dsh-butler/schtask-overview.mjs
 *   node ... --json
 *   node ... --only schtask|tickd
 *   node ... --filter "postcard|明信片"
 *   node ... --all              # Windows 侧不筛 DSH- 前缀（含别人家的任务）
 *   node ... --help
 *   node ... --selftest         # 内建夹具，证明判红不是摆设
 *
 * 退出码：0 全绿 / 2 有 🟡 / 3 有 🔴（或某一侧取数失败）/ 1 用法错
 */

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0.0';
const SELF = 'schtask-overview.mjs';
/** tickd 入口：环境变量 `DSH_TICKD_SCRIPT` 优先；缺省取同目录同名文件（引擎包与本文具可分装）。 */
const TICKD_SCRIPT = process.env.DSH_TICKD_SCRIPT
  || path.join(path.dirname(fileURLToPath(import.meta.url)), 'butler-tickd.mjs');
/** Windows 侧任务名前缀（缺省只取这些） */
const TASK_PREFIX = 'DSH-';
/** 别人家的任务：名字也带 DSH- 前缀，但不是咱的活 ⇒ 缺省跳过（不静默，表尾会写明；--all 可看） */
const EXTERNAL_TASKS = new Map([
  ['DSH-OpenUU', '网易游戏启动器（GameViewer.exe），非自家任务'],
]);
/** Windows「该跑没跑」的宽限（卡面口径） */
const MISS_GRACE_MS = 5 * 60 * 1000;
/** 本机别名（主机短码 → 人话名字；部署方按自己机器改这张表即可） */
const HOST_ALIAS = { 'HOST-A': '工作机', 'HOST-B': '备用机' };

const LEVEL_ORDER = { fail: 0, warn: 1, ok: 2, off: 3, unknown: 4 };
const LEVEL_MARK = { fail: '🔴', warn: '🟡', ok: '✔', off: '⚪', unknown: '❔' };

/* ────────────────────────────── 小工具 ────────────────────────────── */

const CJK = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u3000-\u303F]/;

/** 终端显示宽度（CJK 全角算 2，emoji 算 2） */
function dispWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x1f000 && cp <= 0x1faff) w += 2;
    else if (cp >= 0x2600 && cp <= 0x27bf) w += 2;
    else if (CJK.test(ch)) w += 2;
    else w += 1;
  }
  return w;
}

/** 按显示宽度右填充 */
function padW(s, width) {
  const pad = width - dispWidth(s);
  return pad > 0 ? s + ' '.repeat(pad) : s;
}

/** 显示宽度截断（超长用 … 结尾） */
function clipW(s, width) {
  s = String(s);
  if (dispWidth(s) <= width) return s;
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cw = dispWidth(ch);
    if (w + cw > width - 1) break;
    out += ch;
    w += cw;
  }
  return out + '…';
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 本机时区的 HH:MM:SS */
function fmtHms(d) {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 本地时间戳 → 人话；同一天只给时分秒，跨天给月-日，跨年给年月日 */
function fmtStamp(d, now = new Date()) {
  if (!d || Number.isNaN(d.getTime())) return '—';
  const sameDay =
    d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (sameDay) return fmtHms(d);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  const isYesterday = d.getFullYear() === y.getFullYear() && d.getMonth() === y.getMonth() && d.getDate() === y.getDate();
  if (isYesterday) return `昨天 ${fmtHms(d)}`;
  if (d.getFullYear() === now.getFullYear()) return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtHms(d)}`;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtHms(d)}`;
}

/** 毫秒 → "3h12m" / "14m" / "8s" */
function fmtDur(ms) {
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60 ? ` ${s % 60}s` : ''}`;
  const h = Math.floor(m / 60);
  return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
}

/** 解析 PT15M / P1D / PT1H30M / P3650D → 毫秒（不认识返回 null） */
export function parseIsoDuration(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(s);
  if (!m) return null;
  const [, d, h, mi, sec] = m;
  if (!d && !h && !mi && !sec) return null;
  const ms =
    (Number(d || 0) * 86400 + Number(h || 0) * 3600 + Number(mi || 0) * 60 + Number(sec || 0)) * 1000;
  return Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** 毫秒 → "每 15 分钟" / "每小时" / "每 4 小时" / "每天" */
export function humanInterval(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const min = ms / 60000;
  if (Math.abs(min - Math.round(min)) > 1e-9) {
    const sec = Math.round(ms / 1000);
    return `每 ${sec} 秒`;
  }
  const m = Math.round(min);
  if (m === 1) return '每分钟';
  if (m < 60) return `每 ${m} 分钟`;
  if (m === 60) return '每小时';
  if (m % 60 === 0 && m < 1440) return `每 ${m / 60} 小时`;
  if (m === 1440) return '每天';
  if (m % 1440 === 0) return `每 ${m / 1440} 天`;
  return `每 ${m} 分钟`;
}

/** ISO StartBoundary → {hh, mm}（本地时区口径；解析不了返回 null） */
function startClock(startBoundary) {
  const s = String(startBoundary ?? '').trim();
  if (!s) return null;
  const m = /T(\d{2}):(\d{2})/.exec(s);
  if (!m) return null;
  return { hh: m[1], mm: m[2], clock: `${m[1]}:${m[2]}` };
}

const WEEK_CN = { MON: '一', TUE: '二', WED: '三', THU: '四', FRI: '五', SAT: '六', SUN: '日' };
const WEEK_ORDER = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'];

/* ────────────────────── Windows 侧：频率翻译 ────────────────────── */

/**
 * 把一条 Trigger 翻成人话 + 可参与「停摆」判定的间隔毫秒。
 * 翻不出来（未知类型/缺字段）→ human 给原始值、ms 给 null（**不瞎猜**）。
 * 字段名双写法都认：长名（repetitionInterval/startBoundary/daysOfWeek/daysInterval）
 * 与 pwsh 侧短名（rep/start/doweek/dayint）—— selftest 用长名、真实取数用短名。
 */
export function humanTrigger(t) {
  const kind = String(t?.kind ?? '');
  const repMs = parseIsoDuration(t?.repetitionInterval ?? t?.rep);
  const start = startClock(t?.startBoundary ?? t?.start);
  const days = String(t?.daysOfWeek ?? t?.doweek ?? '')
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter(Boolean);
  const daysInterval = Number(t?.daysInterval ?? t?.dayint) || 0;

  if (!kind) return { human: '仅手动（无触发器）', ms: null };

  if (kind === 'MSFT_TaskTimeTrigger') {
    if (repMs) {
      const dayMs = 864e5;
      if (start && repMs % dayMs === 0) {
        const d = repMs / dayMs;
        return { human: `${d > 1 ? `每 ${d} 天` : '每天'} ${start.clock}`, ms: repMs };
      }
      // 间隔型（PT1M / PT15M / PT4H）：start 只是"首次起点"，不属于节奏，别印出来误导
      return { human: humanInterval(repMs), ms: repMs };
    }
    if (start) return { human: `仅一次 ${start.clock}`, ms: null };
    return { human: '时间触发（无重复）', ms: null };
  }

  if (kind === 'MSFT_TaskDailyTrigger') {
    const every = daysInterval > 1 ? `每 ${daysInterval} 天` : '每天';
    if (repMs && start) return { human: `${humanInterval(repMs)}（${every} ${start.clock} 起）`, ms: repMs };
    if (start) {
      return { human: `${every} ${start.clock}`, ms: 24 * 3600 * 1000 * (daysInterval > 1 ? daysInterval : 1) };
    }
    if (repMs) return { human: humanInterval(repMs), ms: repMs };
    return { human: `${every}（起点未知）`, ms: 24 * 3600 * 1000 };
  }

  if (kind === 'MSFT_TaskWeeklyTrigger') {
    const sorted = days.slice().sort((a, b) => WEEK_ORDER.indexOf(a) - WEEK_ORDER.indexOf(b));
    const wd = sorted.map((d) => WEEK_CN[d] ?? d).join('、');
    const every = daysInterval > 1 ? `每 ${daysInterval} 周` : '每';
    const human = wd ? `${every}周${wd}${start ? ` ${start.clock}` : ''}` : `${every}周（星期未知）`;
    return { human, ms: 7 * 24 * 3600 * 1000 * (daysInterval > 1 ? daysInterval : 1) };
  }

  if (kind === 'MSFT_TaskBootTrigger') return { human: '开机时', ms: null, eventish: true };
  if (kind === 'MSFT_TaskLogonTrigger') return { human: '登录时', ms: null, eventish: true };
  if (kind === 'MSFT_TaskEventTrigger') return { human: '事件触发', ms: null, eventish: true };
  if (kind === 'MSFT_TaskIdleTrigger') return { human: '空闲时', ms: null, eventish: true };
  if (kind === 'MSFT_TaskSessionStateChangeTrigger') return { human: '会话状态变化（登录/注销）', ms: null, eventish: true };
  // Windows 自身的通用 TaskTrigger（多见于系统/商店组件）
  if (kind === 'MSFT_TaskTrigger') return { human: '事件触发（通用）', ms: null, eventish: true };

  // 不认识的类型：如实打原始，别编
  return { human: `原始：${kind}`, ms: null };
}

/**
 * 合并多条触发器的人话（多条用 " / " 连）；间隔取最短的那条。
 * 额外给三个标记，供「下次未知」判据区分：
 *   manual   = 干脆没有触发器（仅手动）⇒ 没有"下次"是正常的
 *   eventish = 全是事件型（开机/登录/事件/空闲）⇒ 同样没有固定下次时间
 *   timed    = 至少有一条是按时钟/间隔跑的 ⇒ 算不出下次才可疑
 */
export function humanTriggers(triggers) {
  const list = (Array.isArray(triggers) ? triggers : []).filter(Boolean);
  if (!list.length) return { human: '仅手动（无触发器）', ms: null, raw: '(none)', manual: true, eventish: false, timed: false };
  const parts = list.map(humanTrigger);
  const human = parts.map((p) => p.human).join(' / ');
  const msList = parts.map((p) => p.ms).filter((x) => Number.isFinite(x) && x > 0);
  const ms = msList.length ? Math.min(...msList) : null;
  const eventish = parts.every((p) => p.eventish === true);
  const raw = list
    .map((t) =>
      [
        t.kind,
        t.repetitionInterval ?? t.rep ?? '-',
        t.startBoundary ?? t.start ?? '-',
        t.daysOfWeek ?? t.doweek ?? '-',
      ].join('|'),
    )
    .join(' ;; ');
  return { human, ms, raw, manual: false, eventish, timed: !eventish };
}

/* ────────────────────────── tickd every 翻译 ────────────────────────── */

/**
 * tickd 的 `every` 是 butler-tickd#describeSchedule 的输出，形态：
 *   '1m' / '60m' / '60m · 窗 08:30-18:00' / '09:00' / 'MON 09:05' /
 *   '08:30 · 工作日(MON,TUE,WED,THU,FRI)' / '13:00 · 每周(MON,FRI)'
 * 返回 { human, ms }；解析不出来 → human 原样、ms null（不判停摆）。
 */
export function humanEvery(every) {
  const raw = String(every ?? '').trim();
  if (!raw) return { human: '—（节奏未知）', ms: null };

  const segs = raw.split('·').map((s) => s.trim());
  const head = segs[0] ?? '';
  const tail = segs.slice(1).join(' · ');

  let human = null;
  let ms = null;

  let m = /^(\d+)m$/.exec(head);
  if (m) {
    ms = Number(m[1]) * 60000;
    human = humanInterval(ms);
  }
  if (!human) {
    m = /^(MON|TUE|WED|THU|FRI|SAT|SUN)\s+(\d{2}:\d{2})$/.exec(head);
    if (m) {
      ms = 7 * 24 * 3600 * 1000;
      human = `每周${WEEK_CN[m[1]] ?? m[1]} ${m[2]}`;
    }
  }
  if (!human) {
    m = /^(\d{2}:\d{2})$/.exec(head);
    if (m) {
      ms = 24 * 3600 * 1000;
      human = `每天 ${m[1]}`;
    }
  }
  if (!human) return { human: raw, ms: null }; // 不瞎猜

  if (tail) {
    const w = /工作日\(([^)]*)\)/.exec(tail);
    const wk = /每周\(([^)]*)\)/.exec(tail);
    if (w) human += `（工作日）`;
    else if (wk) human += `（每周${wk[1].split(',').map((d) => WEEK_CN[d.trim()] ?? d).join('、')}）`;
    else human += `（${tail}）`;
  }
  return { human, ms };
}

/* ────────────────────────── Windows 取数 ────────────────────────── */

const PS_SNIPPET = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$all = ($env:SCHOV_ALL -eq '1')
$tasks = @(Get-ScheduledTask)
if (-not $all) { $tasks = @($tasks | Where-Object { $_.TaskName -like 'DSH-*' }) }
$out = @()
foreach ($t in $tasks) {
  $info = $null
  try { $info = $t | Get-ScheduledTaskInfo } catch { $info = $null }
  $trigs = @()
  foreach ($tr in @($t.Triggers)) {
    if ($null -eq $tr) { continue }
    $trigs += [pscustomobject]@{
      kind     = [string]$tr.CimClass.CimClassName
      rep      = [string]$tr.Repetition.Interval
      duration = [string]$tr.Repetition.Duration
      start    = [string]$tr.StartBoundary
      doweek   = (@($tr.DaysOfWeek) | ForEach-Object { [string]$_ }) -join ','
      dayint   = [string]$tr.DaysInterval
      enabled  = [string]$tr.Enabled
    }
  }
  $act = @($t.Actions)
  $a0 = if ($act.Count -gt 0 -and $null -ne $act[0]) { $act[0] } else { $null }
  $lastRun = ''
  $nextRun = ''
  $lastRes = $null
  if ($null -ne $info) {
    if ($null -ne $info.LastRunTime -and $info.LastRunTime -ne [datetime]::MinValue -and $info.LastRunTime -ne [datetime]::MaxValue) {
      $lastRun = $info.LastRunTime.ToString('yyyy-MM-ddTHH:mm:ss')
    }
    if ($null -ne $info.NextRunTime -and $info.NextRunTime -ne [datetime]::MinValue -and $info.NextRunTime -ne [datetime]::MaxValue) {
      $nextRun = $info.NextRunTime.ToString('yyyy-MM-ddTHH:mm:ss')
    }
    if ($null -ne $info.LastTaskResult) { $lastRes = [int64]$info.LastTaskResult }
  }
  $out += [pscustomobject]@{
    name        = [string]$t.TaskName
    path        = [string]$t.TaskPath
    state       = [string]$t.State
    description = [string]$t.Description
    exec        = if ($a0) { [string]$a0.Execute } else { '' }
    args        = if ($a0) { [string]$a0.Arguments } else { '' }
    triggers    = $trigs
    lastRun     = $lastRun
    nextRun     = $nextRun
    lastResult  = $lastRes
    infoOk      = ($null -ne $info)
  }
}
$out | ConvertTo-Json -Depth 6 -Compress
`;

/** 跑 pwsh 取 Windows 计划任务（纯只读） */
export function fetchWindows({ all = false, timeoutMs = 60000 } = {}) {
  const r = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', PS_SNIPPET], {
    encoding: 'utf8',
    timeout: timeoutMs,
    env: { ...process.env, SCHOV_ALL: all ? '1' : '0' },
    windowsHide: true,
  });
  if (r.error) {
    return { ok: false, error: `起 pwsh 失败：${r.error.message}`, items: [], rawCount: 0 };
  }
  if (r.status !== 0) {
    const msg = String(r.stderr || r.stdout || '').trim().split(/\r?\n/).slice(0, 6).join(' | ');
    return { ok: false, error: `pwsh 退出码 ${r.status}：${msg}`, items: [], rawCount: 0 };
  }
  const text = String(r.stdout || '').trim();
  if (!text) return { ok: false, error: 'pwsh 输出为空（Get-ScheduledTask 没回任何任务）', items: [], rawCount: 0 };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { ok: false, error: `解析 pwsh JSON 失败：${e.message}；前 200 字：${text.slice(0, 200)}`, items: [], rawCount: 0 };
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  return { ok: true, error: null, raw: arr };
}

/* ────────────────────────── tickd 取数 ────────────────────────── */

/** 跑 butler-tickd --status（纯只读），拿它的 stdout JSON */
export function fetchTickd({ timeoutMs = 60000 } = {}) {
  const r = spawnSync(process.execPath || 'node', [TICKD_SCRIPT, '--status'], {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
  });
  if (r.error) return { ok: false, error: `起 node 失败：${r.error.message}` };
  const out = String(r.stdout || '').trim();
  if (r.status !== 0) {
    const msg = String(r.stderr || out || '').trim().split(/\r?\n/).slice(0, 6).join(' | ');
    return { ok: false, error: `butler-tickd --status 退出码 ${r.status}：${msg}` };
  }
  if (!out) return { ok: false, error: 'butler-tickd --status 没回任何 stdout' };
  let j;
  try {
    j = JSON.parse(out);
  } catch (e) {
    return { ok: false, error: `解析 tickd JSON 失败：${e.message}；前 200 字：${out.slice(0, 200)}` };
  }
  if (!j || !Array.isArray(j.jobs)) return { ok: false, error: 'tickd JSON 里没有 jobs 数组（格式变了？）' };
  return { ok: true, error: null, data: j };
}

/* ────────────────────────── 归一化 + 判红 ────────────────────────── */

function hexRes(n) {
  if (!Number.isFinite(n)) return null;
  return '0x' + (n >>> 0).toString(16).padStart(8, '0');
}

/**
 * Windows 计划任务结果码里的「信息码」（SCHED_S_* 系列）—— 它们是成功码，**不是失败**。
 * 🔴 为什么必须豁免：实测 DSH-MailboxQ-host 常年 `LastTaskResult=0x00041301`（任务正在运行），
 *    只按「≠0 就红」会每分钟把「正常在跑」报成「失败」⇒ 判红立刻变成噪声、整套白做。
 */
const WIN_INFO_CODES = new Map([
  [0x00041300, '任务就绪'],
  [0x00041301, '运行中'],
  [0x00041302, '任务已禁用'],
  [0x00041303, '没有更多运行计划'],
  [0x00041304, '任务从未运行'],
  [0x00041305, '任务当前未运行'],
  [0x00041306, '任务被用户终止'],
  [0x00041307, '任务没有触发器'],
  [0x00041308, '任务由事件触发'],
]);
const WIN_TERMINATED = 0x00041306; // 被终止：算 🟡（没跑完，但也不是脚本失败）

/**
 * Windows 任务 → 统一条目。判红规则（卡面口径 + 信息码豁免，见报告「与卡面差异」）：
 *   State == Disabled                        → ⚪ 已禁用
 *   LastTaskResult 是信息码（0x4130x）        → 不算失败（正在运行 / 从未运行 等）
 *   LastTaskResult = 0x41306（被终止）        → 🟡
 *   LastTaskResult 其它 ≠ 0                   → 🔴 失败
 *   NextRunTime 空（且不是已禁用）            → 🟡 下次未知
 *   NextRunTime < now - 5min                 → 🔴 该跑没跑
 */
export function normalizeWindowsTask(t, now = new Date()) {
  const tr = humanTriggers(t.triggers);
  const execLine = [t.exec, t.args].filter((x) => x && String(x).trim()).join(' ').trim();
  const descEmpty = !String(t.description || '').trim();
  const content = descEmpty ? execLine || '（无说明、无命令）' : String(t.description).trim();

  const lastRunMs = t.lastRun ? Date.parse(t.lastRun) : NaN;
  const nextRunMs = t.nextRun ? Date.parse(t.nextRun) : NaN;
  const lastResult = Number.isFinite(t.lastResult) ? Number(t.lastResult) >>> 0 : null;
  const infoWord = lastResult === null ? null : WIN_INFO_CODES.get(lastResult) ?? null;

  let level = 'ok';
  let reason = null;

  if (String(t.state) === 'Disabled') {
    level = 'off';
    reason = '已禁用' + (lastResult !== null && !infoWord ? `（上次结果 ${hexRes(lastResult)}）` : '');
  } else if (lastResult !== null && lastResult === WIN_TERMINATED) {
    level = 'warn';
    reason = '上次被终止（0x00041306）：没跑完，但也不是脚本自身失败';
  } else if (lastResult !== null && lastResult !== 0 && !infoWord) {
    level = 'fail';
    reason = `上次结果 ${hexRes(lastResult)}（≠0，不是已知信息码）`;
  } else if (!Number.isFinite(nextRunMs)) {
    // 「下次未知」只在**本该有下次**时才可疑：仅手动 / 事件型触发的任务本来就没有下次
    if (tr.manual) {
      level = 'ok';
      reason = '仅手动（无触发器）：没有"下次"是正常的';
    } else if (tr.eventish) {
      level = 'ok';
      reason = '开机/登录/事件型触发：没有固定"下次"时间是正常的';
    } else {
      level = 'warn';
      reason = 'NextRunTime 为空：有定时触发器却算不出下次 ⇒ 触发器可能已过期';
    }
  } else if (nextRunMs < now.getTime() - MISS_GRACE_MS) {
    level = 'fail';
    reason = `该跑没跑：下次时间已过 ${fmtDur(now.getTime() - nextRunMs)}（宽限 5 分钟）`;
  } else if (infoWord && lastResult !== 0) {
    reason = `结果码 ${hexRes(lastResult)} = ${infoWord}（信息码，不是失败）`;
  }

  return {
    side: 'windows',
    name: String(t.name),
    content,
    descEmpty,
    freq: tr.human,
    freqRaw: tr.raw,
    lastRun: Number.isFinite(lastRunMs) ? new Date(lastRunMs).toISOString() : null,
    lastRunText: Number.isFinite(lastRunMs) ? fmtStamp(new Date(lastRunMs), now) : null,
    lastResult,
    lastResultHex: hexRes(lastResult),
    lastResultWord: lastResult === 0 ? '成功' : infoWord ?? (lastResult === null ? '未知' : '失败'),
    nextRun: Number.isFinite(nextRunMs) ? new Date(nextRunMs).toISOString() : null,
    nextRunText: Number.isFinite(nextRunMs) ? fmtStamp(new Date(nextRunMs), now) : null,
    level,
    mark: LEVEL_MARK[level],
    reason,
    intervalMs: tr.ms,
    command: execLine || null,
    state: String(t.state),
    raw: t,
  };
}

/**
 * tickd job → 统一条目。判红规则（卡面口径 + 两处如实收窄，见报告「与卡面差异」）：
 *   enabled == false                          → ⚪ 默认关（switchReason 进说明）
 *   lastStatus 为空（从没跑过）                → 🟡 从未运行（不判失败）
 *   lastStatus == 'deferred'                  → 🟡 跳过本轮（不是失败，别天天报红）
 *   lastStatus ∉ {'ok','deferred'}            → 🔴 上次失败
 *   staleRunning/running 超阈值                → 🟡 疑似卡住
 *   now > lastEndAt + 2×间隔                  → 🔴 停摆（间隔解析不出来 = 不判）
 */
export function normalizeTickdJob(j, now = new Date(), tickdMeta = {}) {
  const ev = humanEvery(j.every);
  const lastEndMs = j.lastEndAt ? Date.parse(j.lastEndAt) : NaN;
  const status = String(j.lastStatus ?? '').trim();
  const enabled = j.enabled !== false;

  let level = 'ok';
  let reason = null;

  const lastLine = Number.isFinite(lastEndMs)
    ? `上次 ${fmtStamp(new Date(lastEndMs), now)} ${status || '无状态'}`
    : '从未运行过';

  if (!enabled) {
    level = 'off';
    reason = `默认关（${j.switchReason || j.switchSource || '开关关'}）`;
  } else if (!status) {
    level = 'warn';
    reason = '从未运行（lastStatus 为空）';
  } else if (status === 'deferred') {
    level = 'warn';
    reason = `上轮跳过（deferred，不是失败）${Number.isFinite(lastEndMs) ? ` @ ${fmtStamp(new Date(lastEndMs), now)}` : ''}`;
  } else if (status !== 'ok') {
    level = 'fail';
    reason = `上次失败（lastStatus=${status}）${Number.isFinite(lastEndMs) ? ` @ ${fmtStamp(new Date(lastEndMs), now)}` : ''}`;
  }

  // 疑似卡住（只在没有更坏的情况下升级成 🟡）
  const staleFlag = j.staleRunning === true;
  const runningTooLong =
    j.running === true &&
    Number.isFinite(ev.ms) &&
    Number.isFinite(lastEndMs) &&
    now.getTime() - lastEndMs > 2 * ev.ms;
  if (level === 'ok' && (staleFlag || runningTooLong)) {
    level = 'warn';
    reason = staleFlag
      ? 'staleRunning=true：残留 running 标记'
      : `running=true 且距上次结束 ${fmtDur(now.getTime() - lastEndMs)} > 2×间隔`;
  }

  // 停摆（只在 ⚪/🔴 以外、且间隔可解析时才判；⚪ 关着的 job 不算停摆）
  if (level === 'ok' && Number.isFinite(ev.ms) && Number.isFinite(lastEndMs)) {
    const overdue = now.getTime() - lastEndMs - 2 * ev.ms;
    if (overdue > 0) {
      level = 'fail';
      reason = `停摆：距上次结束 ${fmtDur(now.getTime() - lastEndMs)} > 2×间隔（${ev.human}）`;
    }
  }

  return {
    side: 'tickd',
    name: String(j.id),
    content: String(j.label || '').trim() || '（无 label）',
    freq: ev.human,
    freqRaw: String(j.every ?? ''),
    lastRun: Number.isFinite(lastEndMs) ? new Date(lastEndMs).toISOString() : null,
    lastRunText: Number.isFinite(lastEndMs) ? fmtStamp(new Date(lastEndMs), now) : null,
    lastResult: status || null,
    lastResultHex: null,
    nextRun: null,
    nextRunText: null,
    level,
    mark: LEVEL_MARK[level],
    reason,
    intervalMs: ev.ms,
    enabled,
    runs: Number(j.runs ?? 0),
    failures: Number(j.failures ?? 0),
    switchReason: j.switchReason ?? null,
    lastLine,
    tickdMeta,
    raw: j,
  };
}

/* ────────────────────────── 渲染 ────────────────────────── */

function sortItems(items) {
  return items.slice().sort((a, b) => {
    const d = (LEVEL_ORDER[a.level] ?? 9) - (LEVEL_ORDER[b.level] ?? 9);
    return d !== 0 ? d : a.name.localeCompare(b.name, 'en');
  });
}

export function renderText({ now, host, windows, tickd, only, filter, all }) {
  const L = [];
  const showWin = only !== 'tickd';
  const showTickd = only !== 'schtask';

  const wItems = sortItems(windows.items || []);
  const tItems = sortItems(tickd.items || []);
  const wc = countLevels(windows.items || []);
  const tc = countLevels(tickd.items || []);
  const tEn = (tickd.items || []).filter((x) => x.enabled).length;
  const tDis = (tickd.items || []).length - tEn;

  L.push(`=== 计划任务总览 · ${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${fmtHms(now)}（本机 ${host.name} / ${host.alias}） ===`);

  const sumParts = [];
  if (showWin) {
    const w = windows.ok
      ? `Windows ${(windows.items || []).length} 个（🔴${wc.fail} 🟡${wc.warn} ⚪${wc.off}）`
      : `Windows 取数失败`;
    sumParts.push(w);
  }
  if (showTickd) {
    const t = tickd.ok
      ? `tickd ${(tickd.items || []).length} 个（开 ${tEn} / 关 ${tDis} / 🔴${tc.fail} 🟡${tc.warn}）`
      : `tickd 取数失败`;
    sumParts.push(t);
  }
  L.push(`汇总：${sumParts.join(' · ')}`);
  if (filter) L.push(`筛选：/${filter}/`);
  L.push('');

  if (showWin) {
    L.push(`【Windows 计划任务】${(windows.items || []).length} 个${windows.ok ? '' : ' · 🔴 取数失败'}`);
    if (!windows.ok) {
      L.push(`  🔴 这一侧取数失败：${windows.error}`);
      L.push('  （不是"0 个任务" —— 是没读到。先手跑一次 pwsh Get-ScheduledTask 看看。）');
    } else if (!wItems.length) {
      L.push('  （没有命中任务）');
    } else {
      const nameW = Math.min(34, Math.max(...wItems.map((x) => dispWidth(x.name))) + 2);
      const freqW = Math.min(30, Math.max(...wItems.map((x) => dispWidth(x.freq))) + 2);
      for (const it of wItems) {
        const base = ` ${padW(it.mark, 2)} ${padW(clipW(it.name, nameW), nameW)}${padW(clipW(it.freq, freqW), freqW)}`;
        const tail =
          it.level === 'off'
            ? `已禁用（上次 ${it.lastRunText || '—'}）`
            : `上次 ${it.lastRunText || '—'} ${it.lastResultWord}   下次 ${it.nextRunText || '—'}`;
        L.push(base + tail);
        L.push(`       ${clipW(it.content, 170)}${it.descEmpty ? '（Description 为空，退回命令）' : ''}`);
        if (it.command && it.command !== it.content) L.push(`       → ${clipW(it.command, 170)}`);
        if (it.reason) L.push(`       ⚠ ${it.reason}`);
      }
    }
    L.push('');
  }

  if (showTickd) {
    L.push(`【tickd 常驻 job】${(tickd.items || []).length} 个${tickd.ok ? '' : ' · 🔴 取数失败'}`);
    if (!tickd.ok) {
      L.push(`  🔴 这一侧取数失败：${tickd.error}`);
      L.push('  （不是"0 个 job" —— 是没读到。先手跑一次 node ' + TICKD_SCRIPT + ' --status 看看。）');
    } else if (!tItems.length) {
      L.push('  （没有命中 job）');
    } else {
      const nameW = Math.min(30, Math.max(...tItems.map((x) => dispWidth(x.name))) + 2);
      const contentW = Math.min(46, Math.max(...tItems.map((x) => dispWidth(x.content))) + 2);
      const freqW = Math.min(30, Math.max(...tItems.map((x) => dispWidth(x.freq))) + 2);
      for (const it of tItems) {
        const base = ` ${padW(it.mark, 2)} ${padW(clipW(it.name, nameW), nameW)}${padW(clipW(it.content, contentW), contentW)}${padW(clipW(it.freq, freqW), freqW)}`;
        let tail;
        if (it.level === 'off') tail = '默认关';
        else if (!it.lastLine || it.lastLine === '从未运行过') tail = '从未运行';
        else {
          const word = it.lastResult === 'ok' ? '成功' : it.lastResult === 'deferred' ? '跳过' : `失败(${it.lastResult})`;
          tail = `上次 ${it.lastRunText} ${word}   跑 ${it.runs} / 失败 ${it.failures}`;
        }
        L.push(base + tail);
        if (it.reason) L.push(`       ⚠ ${it.reason}`);
      }
    }
    if (tickd.ok && tickd.data) {
      const d = tickd.data;
      L.push('');
      L.push(
        `tickd 本体：${d.running ? '在跑' : '没跑'} · pid ${d.pid ?? '—'} · v${d.version ?? '?'} · 心跳 ${d.lastLoopAt ? fmtStamp(new Date(d.lastLoopAt), now) : '—'} · loop ${d.loopCount ?? '—'}`,
      );
    }
    L.push('');
  }

  const skipped = windows.skipped || [];
  if (showWin && skipped.length) {
    L.push(`（已跳过 ${skipped.length} 个非自家任务：${skipped.map((s) => s.name).join('、')}；--all 可看）`);
    L.push('');
  }

  if (!all && showWin && windows.ok && (windows.items || []).length === 0 && !filter) {
    L.push('提示：Windows 侧一个 DSH- 任务都没有？先确认任务名前缀，或加 --all 看全机。');
    L.push('');
  }

  return L.join('\n').replace(/\n+$/, '') + '\n';
}

function countLevels(items) {
  const c = { ok: 0, warn: 0, fail: 0, off: 0, unknown: 0 };
  for (const it of items) c[it.level] = (c[it.level] ?? 0) + 1;
  return c;
}

function worstLevel(items) {
  let w = 0; // 0 = 全绿
  for (const it of items) {
    if (it.level === 'fail') w = Math.max(w, 3);
    else if (it.level === 'warn') w = Math.max(w, 2);
  }
  return w;
}

/* ────────────────────────── 主流程 ────────────────────────── */

const HELP = `schtask-overview.mjs v${VERSION} —— 一条命令看全本机所有定时任务（纯只读）

用法：
  node <pkg>/src/dsh-butler/schtask-overview.mjs [选项]

选项：
  --json                 机器可读输出（一个对象：generatedAt / host / windows / tickd / summary）
  --only schtask|tickd   只看一侧（schtask = Windows 计划任务，tickd = 常驻 job）
  --filter <正则>        按名字筛（Windows 用 TaskName，tickd 用 id；不区分大小写）
  --all                  Windows 侧不筛 "${TASK_PREFIX}" 前缀（含别人家的任务）
  --selftest             跑内建夹具，验证判红规则真的生效
  --help, -h             这份说明
  --version              打版本号

退出码：
  0  全绿
  2  有 🟡（要留意，但没坏）
  3  有 🔴（坏了），或某一侧取数失败
  1  用法错（未知参数 / 参数值非法）

判红规则：
  Windows  State == Disabled                → ⚪ 已禁用
           LastTaskResult 是信息码(0x4130x)  → 不算失败（"正在运行/从未运行"等 Windows 成功码）
           LastTaskResult = 0x00041306       → 🟡 被用户终止（没跑完）
           LastTaskResult 其它 ≠ 0           → 🔴 失败
           NextRunTime 为空 + 有定时触发器    → 🟡 下次未知（触发器可能过期）
                                              （仅手动/开机/登录/事件型不算 —— 它们本就没有下次）
           NextRunTime < 现在 - 5 分钟       → 🔴 该跑没跑
  tickd    enabled == false                  → ⚪ 默认关（switchReason 进说明）
           lastStatus ∉ {ok, deferred}       → 🔴 上次失败
           lastStatus == deferred            → 🟡 跳过本轮
           lastStatus 为空                   → 🟡 从未运行
           staleRunning / running 超阈值      → 🟡 疑似卡住
           现在 > lastEndAt + 2×间隔         → 🔴 停摆（间隔解析不出来不判）

说明：
  · Windows 侧数据来自 \`pwsh -Command Get-ScheduledTask + Get-ScheduledTaskInfo\`；
    tickd 侧来自 \`node ${TICKD_SCRIPT} --status\`（不读它的内部状态文件）。
  · 时间一律按本机时区显示；tickd 的 lastEndAt 是 UTC，已换算。
  · 纯只读：不注册 / 不修改 / 不删除 / 不启动任何计划任务。
  · 别人家的同名前缀任务（${[...EXTERNAL_TASKS.keys()].join('、')}）缺省跳过，--all 可看。
`;

function parseArgs(argv) {
  const o = { json: false, only: null, filter: null, all: false, help: false, version: false, selftest: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--version') o.version = true;
    else if (a === '--json') o.json = true;
    else if (a === '--all') o.all = true;
    else if (a === '--selftest') o.selftest = true;
    else if (a === '--only') {
      const v = argv[++i];
      if (v === undefined) throw new UsageError('--only 需要一个值：schtask 或 tickd');
      if (v !== 'schtask' && v !== 'tickd') throw new UsageError(`--only 只认 schtask / tickd，不认 "${v}"`);
      o.only = v;
    } else if (a.startsWith('--only=')) {
      const v = a.slice(7);
      if (v !== 'schtask' && v !== 'tickd') throw new UsageError(`--only 只认 schtask / tickd，不认 "${v}"`);
      o.only = v;
    } else if (a === '--filter') {
      const v = argv[++i];
      if (v === undefined) throw new UsageError('--filter 需要一个正则');
      o.filter = v;
    } else if (a.startsWith('--filter=')) {
      o.filter = a.slice(9);
    } else {
      // fail-closed：拼错一律拒跑（--helpp / --jsno 之类）
      throw new UsageError(`不认识的参数 "${a}"` + (a.toLowerCase().includes('help') ? '（是不是想写 --help？）' : ''));
    }
  }
  if (o.filter) {
    try {
      o.filterRe = new RegExp(o.filter, 'i');
    } catch (e) {
      throw new UsageError(`--filter 正则写坏了：${e.message}`);
    }
  }
  return o;
}

class UsageError extends Error {}

function buildPayload({ now, opts }) {
  const host = {
    name: os.hostname().toUpperCase(),
    alias: HOST_ALIAS[os.hostname().toUpperCase()] ?? '本机',
    platform: `${os.platform()} ${os.release()}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'local',
    tzOffsetMin: -new Date().getTimezoneOffset(),
  };

  const windows = { ok: false, error: null, items: [], skipped: [], total: 0 };
  const tickd = { ok: false, error: null, items: [], total: 0, data: null };

  if (opts.only !== 'tickd') {
    const w = fetchWindows({ all: opts.all });
    if (!w.ok) {
      windows.error = w.error;
    } else {
      const raw = w.raw || [];
      const kept = [];
      const skipped = [];
      for (const t of raw) {
        if (!opts.all && EXTERNAL_TASKS.has(t.name)) {
          skipped.push({ name: t.name, why: EXTERNAL_TASKS.get(t.name) });
          continue;
        }
        kept.push(t);
      }
      windows.ok = true;
      windows.total = kept.length;
      windows.skipped = skipped;
      windows.items = kept
        .map((t) => normalizeWindowsTask(t, now))
        .filter((it) => !opts.filterRe || opts.filterRe.test(it.name));
    }
  }

  if (opts.only !== 'schtask') {
    const t = fetchTickd();
    if (!t.ok) {
      tickd.error = t.error;
    } else {
      tickd.ok = true;
      tickd.data = {
        running: t.data.running,
        pid: t.data.pid,
        version: t.data.version,
        lastLoopAt: t.data.lastLoopAt ?? null,
        loopCount: t.data.loopCount ?? null,
      };
      tickd.total = t.data.jobs.length;
      tickd.items = t.data.jobs
        .map((j) => normalizeTickdJob(j, now, {}))
        .filter((it) => !opts.filterRe || opts.filterRe.test(it.name));
    }
  }

  const all = [...windows.items, ...tickd.items];
  const wc = countLevels(windows.items);
  const tc = countLevels(tickd.items);
  const code = !windows.ok && opts.only !== 'tickd' ? 3 : !tickd.ok && opts.only !== 'schtask' ? 3 : worstLevel(all);

  return {
    generatedAt: now.toISOString(),
    generatedAtLocal: `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${fmtHms(now)}`,
    host,
    options: { only: opts.only, filter: opts.filter, all: opts.all },
    windows,
    tickd,
    summary: {
      windows: { ...wc, total: windows.items.length, ok: windows.ok, error: windows.error, skipped: windows.skipped.length },
      tickd: { ...tc, total: tickd.items.length, ok: tickd.ok, error: tickd.error,
        enabled: tickd.items.filter((x) => x.enabled).length,
        disabled: tickd.items.filter((x) => !x.enabled).length },
      level: code === 3 ? 'fail' : code === 2 ? 'warn' : 'ok',
      exitCode: code,
    },
    exitCode: code,
  };
}

function toJsonPayload(p) {
  const shape = (it) => ({
    name: it.name,
    content: it.content,
    freq: it.freq,
    freqRaw: it.freqRaw,
    lastRun: it.lastRun,
    lastResult: it.lastResult,
    nextRun: it.nextRun,
    level: it.level,
    reason: it.reason,
    // 补充字段
    side: it.side,
    lastResultHex: it.lastResultHex ?? null,
    lastRunLocal: it.lastRunText ?? null,
    nextRunLocal: it.nextRunText ?? null,
    intervalMs: it.intervalMs ?? null,
    ...(it.side === 'windows'
      ? { state: it.state, command: it.command, lastResultWord: it.lastResultWord }
      : { enabled: it.enabled, runs: it.runs, failures: it.failures, switchReason: it.switchReason }),
  });
  return {
    generatedAt: p.generatedAt,
    generatedAtLocal: p.generatedAtLocal,
    host: p.host,
    options: p.options,
    windows: {
      ok: p.windows.ok,
      error: p.windows.error,
      total: p.windows.items.length,
      skipped: p.windows.skipped,
      items: p.windows.items.map(shape),
    },
    tickd: {
      ok: p.tickd.ok,
      error: p.tickd.error,
      total: p.tickd.items.length,
      info: p.tickd.data,
      items: p.tickd.items.map(shape),
    },
    summary: p.summary,
  };
}

/* ────────────────────────── 自测（夹具在脚本内，不落生产目录） ────────────────────────── */

export function selftest({ log = console.log } = {}) {
  const results = [];
  const now = new Date('2026-10-31T11:20:00+08:00');
  const check = (name, cond, detail) => {
    results.push({ name, pass: !!cond, detail });
    log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ← ${detail}` : ''}`);
  };

  // ── 夹具 1：Windows 任务 LastTaskResult = 1 ⇒ 🔴 ──
  const wFail = normalizeWindowsTask(
    {
      name: 'DSH-Fake-Failed',
      state: 'Ready',
      description: '夹具：上次返回 1',
      exec: 'node.exe',
      args: 'x.mjs',
      triggers: [{ kind: 'MSFT_TaskTimeTrigger', rep: 'PT15M', start: '2026-10-31T00:00:00', doweek: '', dayint: '' }],
      lastRun: '2026-10-31T11:16:00',
      nextRun: '2026-10-31T11:31:00',
      lastResult: 1,
    },
    now,
  );
  check('夹具1 Windows LastTaskResult=1 ⇒ 🔴 失败', wFail.level === 'fail', `level=${wFail.level} reason=${wFail.reason}`);
  check('夹具1b 失败原因为"上次结果 0x00000001"', /0x00000001/.test(wFail.reason || ''), wFail.reason);

  // ── 夹具 2：tickd job enabled=false ⇒ ⚪ ──
  const tOff = normalizeTickdJob(
    {
      id: 'family-remind',
      label: '家庭日程提醒（每 1 分钟 · 默认关）',
      every: '1m',
      lastStatus: 'ok',
      lastEndAt: '2026-10-31T03:15:00.000Z',
      runs: 12,
      failures: 0,
      enabled: false,
      switchReason: 'job 开关关（file: 第26棒验收：验证完毕回关）',
    },
    now,
  );
  check('夹具2 tickd enabled=false ⇒ ⚪ 默认关', tOff.level === 'off', `level=${tOff.level} reason=${tOff.reason}`);
  check('夹具2b switchReason 进了说明', /第26棒验收/.test(tOff.reason || ''), tOff.reason);

  // ── 夹具 3：lastEndAt 3 小时前 + every 15m ⇒ 🔴 停摆 ──
  const tStall = normalizeTickdJob(
    {
      id: 'fake-stall-15m',
      label: '夹具：3 小时没跑',
      every: '15m',
      lastStatus: 'ok',
      // now(11:20 东八区 = 03:20 UTC) − 3h = 00:20 UTC
      lastEndAt: '2026-10-31T00:20:00.000Z',
      runs: 100,
      failures: 0,
      enabled: true,
      switchReason: 'ok',
    },
    now,
  );
  check('夹具3 lastEndAt 3h 前 + every=15m ⇒ 🔴 停摆', tStall.level === 'fail', `level=${tStall.level} reason=${tStall.reason}`);
  check('夹具3b 停摆原因为"停摆"', /停摆/.test(tStall.reason || ''), tStall.reason);
  check('夹具3c UTC→本地换算对（3h 前）', tStall.lastRunText === '08:20:00', `lastRunText=${tStall.lastRunText}`);

  // ── 夹具 4：一切正常 ⇒ ✔（证明判据不是"见谁都红"） ──
  const tFine = normalizeTickdJob(
    {
      id: 'fake-fine',
      label: '夹具：刚跑过',
      every: '15m',
      lastStatus: 'ok',
      lastEndAt: '2026-10-31T03:10:00.000Z',
      runs: 9,
      failures: 0,
      enabled: true,
      switchReason: 'ok',
    },
    now,
  );
  check('夹具4 刚跑过 10 分钟 ⇒ ✔ 不判红', tFine.level === 'ok', `level=${tFine.level}`);

  // ── 夹具 5：有定时触发器但 NextRunTime 空 ⇒ 🟡 ──
  const wNoNext = normalizeWindowsTask(
    {
      name: 'DSH-Fake-NoNext',
      state: 'Ready',
      description: '夹具：有定时触发器但没有下次时间',
      exec: 'node.exe',
      args: '',
      triggers: [{ kind: 'MSFT_TaskDailyTrigger', rep: '', start: '2026-09-01T09:00:00', doweek: '', dayint: '1' }],
      lastRun: '2026-10-22T00:25:09',
      nextRun: null,
      lastResult: 0,
    },
    now,
  );
  check('夹具5 定时触发器 + NextRunTime 空 ⇒ 🟡 下次未知', wNoNext.level === 'warn', `level=${wNoNext.level} reason=${wNoNext.reason}`);

  // ── 夹具 5b：无触发器（仅手动）⇒ 不许因为"没有下次"判 🟡（--all 下 138 条系统任务的噪声源） ──
  const wManual = normalizeWindowsTask(
    {
      name: 'DSH-Fake-Manual',
      state: 'Ready',
      description: '夹具：仅手动',
      exec: 'node.exe',
      args: '',
      triggers: [],
      lastRun: '2026-10-22T00:25:09',
      nextRun: null,
      lastResult: 0,
    },
    now,
  );
  check('夹具5b 仅手动（无触发器）⇒ 不判 🟡', wManual.level === 'ok', `level=${wManual.level} reason=${wManual.reason}`);

  // ── 夹具 5c：登录时触发 ⇒ 没有固定下次时间也正常，不判 🟡 ──
  const wLogon = normalizeWindowsTask(
    {
      name: 'DSH-Fake-Logon',
      state: 'Ready',
      description: '夹具：登录时',
      exec: 'node.exe',
      args: '',
      triggers: [{ kind: 'MSFT_TaskLogonTrigger', rep: '', start: '', doweek: '', dayint: '' }],
      lastRun: '2026-10-31T08:00:00',
      nextRun: null,
      lastResult: 0,
    },
    now,
  );
  check('夹具5c 登录时触发 ⇒ 不判 🟡', wLogon.level === 'ok', `level=${wLogon.level} reason=${wLogon.reason}`);

  // ── 夹具 6：NextRunTime 已过 30 分钟 ⇒ 🔴 该跑没跑 ──
  const wMiss = normalizeWindowsTask(
    {
      name: 'DSH-Fake-Missed',
      state: 'Ready',
      description: '夹具：该跑没跑',
      exec: 'node.exe',
      args: '',
      triggers: [{ kind: 'MSFT_TaskTimeTrigger', rep: 'PT15M', start: '2026-10-31T00:00:00', doweek: '', dayint: '' }],
      lastRun: '2026-10-31T10:30:00',
      nextRun: '2026-10-31T10:50:00',
      lastResult: 0,
    },
    now,
  );
  check('夹具6 NextRunTime 过 30 分钟 ⇒ 🔴 该跑没跑', wMiss.level === 'fail', `level=${wMiss.level} reason=${wMiss.reason}`);

  // ── 夹具 7：Disabled ⇒ ⚪（不因 NextRun 空误判 🟡） ──
  const wDis = normalizeWindowsTask(
    {
      name: 'DSH-Fake-Disabled',
      state: 'Disabled',
      description: '夹具：已禁用',
      exec: 'node.exe',
      args: '',
      triggers: [],
      lastRun: null,
      nextRun: null,
      lastResult: 0,
    },
    now,
  );
  check('夹具7 State=Disabled ⇒ ⚪（不被"下次未知"抢走）', wDis.level === 'off', `level=${wDis.level}`);

  // ── 夹具 11：0x41301「任务正在运行」是信息码 ⇒ 不许判红（实测 MailboxQ-host 常年这个值） ──
  const wRunning = normalizeWindowsTask(
    {
      name: 'DSH-Fake-Running',
      state: 'Ready',
      description: '夹具：正在运行（信息码）',
      exec: 'node.exe',
      args: '',
      triggers: [{ kind: 'MSFT_TaskTimeTrigger', rep: 'PT1M', start: '2026-10-26T10:05:00', doweek: '', dayint: '' }],
      lastRun: '2026-10-31T11:19:01',
      nextRun: '2026-10-31T11:21:00',
      lastResult: 0x00041301,
    },
    now,
  );
  check('夹具11 LastTaskResult=0x00041301（运行中）⇒ 不判红', wRunning.level === 'ok', `level=${wRunning.level} reason=${wRunning.reason}`);

  // ── 夹具 12：真失败码 0x2（找不到文件）⇒ 🔴 ──
  const wCode2 = normalizeWindowsTask(
    {
      name: 'DSH-Fake-Code2',
      state: 'Ready',
      description: '夹具：0x2',
      exec: 'node.exe',
      args: '',
      triggers: [{ kind: 'MSFT_TaskTimeTrigger', rep: 'PT15M', start: '2026-10-31T00:00:00', doweek: '', dayint: '' }],
      lastRun: '2026-10-31T11:00:00',
      nextRun: '2026-10-31T11:15:00',
      lastResult: 2,
    },
    now,
  );
  check('夹具12 LastTaskResult=0x2 ⇒ 🔴 失败', wCode2.level === 'fail', `level=${wCode2.level} reason=${wCode2.reason}`);

  // ── 夹具 8：频率翻译不许瞎猜 ──
  check('夹具8a PT15M ⇒ 每 15 分钟', humanTrigger({ kind: 'MSFT_TaskTimeTrigger', repetitionInterval: 'PT15M' }).human === '每 15 分钟', humanTrigger({ kind: 'MSFT_TaskTimeTrigger', repetitionInterval: 'PT15M' }).human);
  check('夹具8b PT1H ⇒ 每小时', humanTrigger({ kind: 'MSFT_TaskTimeTrigger', repetitionInterval: 'PT1H' }).human === '每小时');
  check('夹具8c 每日 09:00 ⇒ 每天 09:00', humanTrigger({ kind: 'MSFT_TaskDailyTrigger', startBoundary: '2026-10-28T09:00:00+08:00', daysInterval: 1 }).human === '每天 09:00', humanTrigger({ kind: 'MSFT_TaskDailyTrigger', startBoundary: '2026-10-28T09:00:00+08:00', daysInterval: 1 }).human);
  const wt = humanTrigger({ kind: 'MSFT_TaskWeeklyTrigger', startBoundary: '2026-10-28T09:05:00', daysOfWeek: 'MON', daysInterval: 1 });
  check('夹具8d 每周 MON ⇒ 每周一 09:05', wt.human === '每周一 09:05', wt.human);
  check('夹具8e 不认识的类型原样打', humanTrigger({ kind: 'MSFT_TaskWhateverTrigger' }).human.includes('原始'), humanTrigger({ kind: 'MSFT_TaskWhateverTrigger' }).human);
  check('夹具8f tickd 工作日句式', humanEvery('08:30 · 工作日(MON,TUE,WED,THU,FRI)').human === '每天 08:30（工作日）', humanEvery('08:30 · 工作日(MON,TUE,WED,THU,FRI)').human);
  check('夹具8g tickd 每周多天', humanEvery('13:00 · 每周(MON,FRI)').human === '每天 13:00（每周一、五）', humanEvery('13:00 · 每周(MON,FRI)').human);
  check('夹具8h tickd 认不出的原样打、间隔给 null', humanEvery('weird-stuff').ms === null && humanEvery('weird-stuff').human === 'weird-stuff');
  check('夹具8i 间隔解析不出 ⇒ 不判停摆', normalizeTickdJob({ id: 'x', label: 'x', every: 'weird', lastStatus: 'ok', lastEndAt: '2026-10-20T00:00:00Z', enabled: true }, now).level === 'ok', `level=${normalizeTickdJob({ id: 'x', label: 'x', every: 'weird', lastStatus: 'ok', lastEndAt: '2026-10-20T00:00:00Z', enabled: true }, now).level}`);

  // ── 夹具 9：判定不会因为"取数失败"变成 0 条静默 ──
  const fakeEmpty = { ok: false, error: '夹具：pwsh 挂了', items: [], skipped: [], total: 0 };
  const txt = renderText({
    now,
    host: { name: 'HOST-A', alias: '本机' },
    windows: fakeEmpty,
    tickd: { ok: true, items: [], total: 0, data: null },
    only: 'schtask',
  });
  check('夹具9 取数失败 ⇒ 明写失败，不装成 0 条', /取数失败/.test(txt) && !/Windows 0 个/.test(txt), txt.split('\n').find((l) => /取数失败/.test(l)) || '');

  // ── 夹具 10：参数 fail-closed ──
  let unknownRejected = false;
  try {
    parseArgs(['--helpp']);
  } catch (e) {
    unknownRejected = e instanceof UsageError && /不认识/.test(e.message);
  }
  check('夹具10 未知参数 --helpp ⇒ 用法错（fail-closed）', unknownRejected);
  check('夹具10b --help 认得出', parseArgs(['--help']).help === true);
  check('夹具10c --only 拼错 ⇒ 用法错', (() => {
    try { parseArgs(['--only', 'scheduled']); return false; } catch (e) { return e instanceof UsageError; }
  })());

  const failed = results.filter((r) => !r.pass);
  log('');
  log(`自测小结：${results.length - failed.length}/${results.length} 通过${failed.length ? `，${failed.length} 条 FAIL` : '（全绿）'}`);
  return failed.length === 0 ? 0 : 3;
}

/* ────────────────────────── 入口 ────────────────────────── */

function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`用法错：${e.message}\n\n${HELP}`);
      return 1;
    }
    process.stderr.write(`内部错：${e.stack || e.message}\n`);
    return 1;
  }

  if (opts.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (opts.version) {
    process.stdout.write(`${SELF} v${VERSION}\n`);
    return 0;
  }
  if (opts.selftest) return selftest();

  const now = new Date();
  const p = buildPayload({ now, opts });

  if (opts.json) {
    process.stdout.write(JSON.stringify(toJsonPayload(p), null, 1) + '\n');
  } else {
    process.stdout.write(
      renderText({
        now,
        host: p.host,
        windows: p.windows,
        tickd: p.tickd,
        only: opts.only,
        filter: opts.filter,
        all: opts.all,
      }),
    );
  }
  return p.exitCode;
}

// junction 守卫：import.meta.url 是物理路径、argv[1] 是逻辑路径 ⇒ 双方 realpath 后再比
let isMain = false;
try {
  const { fileURLToPath } = await import('node:url');
  const { realpathSync } = await import('node:fs');
  const selfPath = realpathSync(fileURLToPath(import.meta.url));
  const argPath = process.argv[1] ? realpathSync(process.argv[1]) : '';
  isMain = !!argPath && selfPath.toLowerCase() === argPath.toLowerCase();
} catch {
  isMain = false;
}

if (isMain) {
  process.exitCode = main(process.argv.slice(2));
}
