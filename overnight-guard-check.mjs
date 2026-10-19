#!/usr/bin/env node
/**
 * overnight-guard-check.mjs —— 丙-1「整夜保护每日自检」（**纯只读**）
 *
 * 出处：`docs\待主人拍板-整夜兜底线-20260925.md` §丙-1（本鱼建议「做」，主人 2026-09-27 21:54
 *   授权整夜推进后按建议默认执行）；口径真源 = `docs\整夜模式-自主推进与自动交接口径-20260925.md` §1。
 *
 * 治什么病：
 *   2026-09-25 实测「整夜保护掉过一次」—— 加固值被人（或某软件）改回原值，**当晚没有任何人知道**，
 *   而整夜模式正是靠这 7 项挡住睡眠/休眠/关屏/合盖，一旦掉了机器就可能整夜睡死、任务全停。
 *   `overnight-mode.mjs status` 只报「所有方案 7 项全为 0 / N 项非 0」，**不区分**「本来就是 0」
 *   与「被改回原值」，也不看屏保 / Windows 更新时段窗 ⇒ 需要一台**比对型**探针。
 *
 * 判据（三层，全部只读；口径与 `overnight-mode.mjs` 同源，不抄文档）：
 *   ① 7 项电源保护：加固目标 = **所有方案 × 7 项 × AC/DC 一律 0**
 *      （同源 = `tools\overnight-mode.mjs` 的 `SETTINGS` + `applyProtection()`：值逐条写 0）；
 *      实测 ≠ 0 ⇒ 变化项，再按「是否等于备份原值」细分：
 *        · `reverted` = 实测 == `state.values[方案][项][ac|dc]`（= 开整夜模式前的原值）⇒ **疑似被人改回**
 *        · `changed`  = 实测是第三个数（既不是 0 也不是原值）⇒ 被改成了别值
 *   ② 屏保 3 项（HKCU\Control Panel\Desktop）：加固目标 = 0/0/0，同样与 `state.screensaver` 原值比对。
 *   ③ Windows 更新时段窗 + 自动重启策略：目标 = `state.wu.window`（默认 21:00→15:00，把整夜划进活动时间）
 *      / `NoAutoRebootWithLoggedOnUsers = 1`。夜里自动重启 = 正面打断整夜任务，与 7 项同权重报。
 *
 * 级别（判据写死，别现场发挥）：
 *   🔴 alarm = **当前活动方案**上存在任一非 0 项（保护真失效，机器随时可能睡）
 *   🟡 warn  = 仅在**非活动方案**上有非 0 项 / 屏保有差异 / 更新加固被改回
 *   🟢 ok    = 三层全在位
 *   ❔ unavailable = 读不到（powershell/reg 失败）⇒ **显式成段，绝不判绿**（fail-loud，不 fail-silent）
 *
 * 用法：
 *   node <DSH_ROOT>\tools\overnight-guard-check.mjs                # 人话读数（只读，不写任何文件）
 *   node <DSH_ROOT>\tools\overnight-guard-check.mjs --json         # stdout 只输出 JSON（日志落文件）
 *   node <DSH_ROOT>\tools\overnight-guard-check.mjs --section      # 输出日报 Markdown 段（供 report.mjs 渲染）
 *   node <DSH_ROOT>\tools\overnight-guard-check.mjs --fail-on-change  # 有变化时退出码 4（默认**不**非 0）
 *   node <DSH_ROOT>\tools\overnight-guard-check.mjs --self-test    # mock 单测（不碰真机）
 *
 * 退出码：0 = 正常（含「发现变化」这个正常结论）/ 2 = 用法错 / 3 = 判定不可用 /
 *         4 = 有变化且显式给了 `--fail-on-change`。
 * ⚠️ 为什么「发现变化」默认**不**非 0：本脚本是要挂 tickd 的巡检 job —— 非 0 会被 tickd 记成
 *   `failures` 并在日报「⏱ tick 调度健康」段刷红，那是**告警疲劳**（先例 = `upgrade-patrol` 的
 *   `--no-fail-on-red`，理由逐字同款）。「有变化」是巡检的正常结论，可见性由日报段承载。
 *
 * 【只读承诺（可断言）】本脚本**不写任何文件**、不改任何电源/注册表值、不 import 任何写入型 API
 *   （无 fs.writeFileSync / 无 powercfg 写开关 / 无 reg add）。要改回保护请显式跑
 *   `node <DSH_ROOT>\tools\overnight-mode.mjs on`（那是另一条命令，本探针绝不代劳）。
 *
 * 关联：`tools\overnight-mode.mjs`（保护本体）· `tools\dsh-butler\butler-tickd.mjs`（job 接线）
 *       · `tools\dsh-butler-panel\report.mjs`（日报段渲染）· 交付报告
 *       `docs\交付报告-整夜班底丙1丙2-20260927.md`
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveDshHome } from './lib/dsh-home.mjs';
// 【2026-10-09 · 卡「360弹窗治本-pwsh7」】PowerShell 一律走统一工具（pwsh 7 优先）：
//   360 企业版 EDR（公司下发 · 终端只读）只对 5.1（powershell.exe）弹「PowerShell 命令执行攻击」。
//   工具缺失 ⇒ 兜底 5.1，可用性不下降。
const PS_EXE = await import('./lib/powershell-exe.mjs').then((m) => m.powerShellExe()).catch(() => 'powershell.exe');

export const OVERNIGHT_GUARD_VERSION = '0.1.0';

/** 7 项电源保护 —— **与 `tools\overnight-mode.mjs` 的 SETTINGS 逐字同源**（id/sub 是 Windows 电源设置 GUID）。
 *  ⚠️ 两处必须同步改；改一处不改另一处 = 探针比对错项（单测 `--self-test` 的 T1 会拿本表与
 *  overnight-mode 的 applyProtection 目标值（0）对账，不校验 GUID 逐字相等 —— GUID 靠人工同步）。 */
export const SETTINGS = [
  { name: 'STANDBYIDLE', sub: '238c9fa8-0aad-41ed-83f4-97be242c8f20', id: '29f6c1db-86da-48c5-9fdb-f2b67b1f44da', label: '空闲多久自动睡眠' },
  { name: 'HIBERNATEIDLE', sub: '238c9fa8-0aad-41ed-83f4-97be242c8f20', id: '9d7815a6-7ee4-497e-8888-515a05f02364', label: '空闲多久自动休眠' },
  { name: 'UNATTENDSLEEP', sub: '238c9fa8-0aad-41ed-83f4-97be242c8f20', id: '7bc4a2f9-d8fc-4469-b07b-33eb785aaca0', label: '无人值守睡眠超时(隐藏项)' },
  { name: 'VIDEOIDLE', sub: '7516b95f-f776-4464-8c53-06167f40cc99', id: '3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e', label: '空闲多久关闭显示器' },
  { name: 'DISKIDLE', sub: '0012ee47-9041-4b5d-9b77-535fba8b1442', id: '6738e2c4-e8a5-4a42-b16a-e040e769756e', label: '空闲多久关闭硬盘' },
  { name: 'USBSUSPEND', sub: '2a737441-1930-4402-8d77-b2bebba308a3', id: '48e6b7a6-50f5-4782-a5d4-53bb8f07e226', label: 'USB 选择性挂起' },
  { name: 'LIDACTION', sub: '4f971e89-eebd-4455-a8de-9e59040e7347', id: '5ca83367-6e45-459f-a27b-476b1d01c936', label: '合盖动作(隐藏项)' },
];

/** 加固目标值：7 项一律 0（同源 = overnight-mode 的 applyProtection：`setValue(..., 0)`）。 */
export const PROTECT_TARGET = 0;

/** 屏保加固目标（同源 = overnight-mode 的 applyProtection 的 ssTargets）。 */
export const SS_TARGET = { ScreenSaveActive: '0', ScreenSaveTimeOut: '0', ScreenSaverIsSecure: '0' };
export const SCREENSAVER_VALUES = ['ScreenSaveActive', 'ScreenSaveTimeOut', 'ScreenSaverIsSecure'];
const SS_KEY = 'HKCU\\Control Panel\\Desktop';

/** 更新时段窗默认（同源 = overnight-mode 的 WU_WINDOW_DEFAULT）。 */
export const WU_WINDOW_DEFAULT = { start: 21, end: 15 };
const WU_UX_KEY = 'HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings';
const WU_AU_KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU';
const WU_POLICY_VALUE = 'NoAutoRebootWithLoggedOnUsers';

export const EXIT = { OK: 0, USAGE: 2, UNAVAILABLE: 3, CHANGED: 4 };

// ---------------------------------------------------------------- 工具函数
let jsonMode = false;
const LOG_FILE = path.join(os.tmpdir(), 'dsh-overnight-guard.log');

/** `--json` 时日志**只落文件、不污染 stdout**（persona 三红线 ③；同源 = overnight-mode.mjs 的 log()）。 */
function log(msg) {
  if (jsonMode) {
    try { fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] ${msg}\n`, 'utf8'); } catch { /* ignore */ }
  } else {
    process.stdout.write(msg + '\n');
  }
}

function decode(buf) {
  if (!buf) return '';
  try { return new TextDecoder('gbk').decode(buf); } catch { return buf.toString('latin1'); }
}

export function stateFileFor(host) {
  return path.join(resolveDshHome(), `overnight-mode-${String(host).toLowerCase()}.json`);
}

// ---------------------------------------------------------------- 默认依赖（真机·只读）
export function realDeps() {
  return {
    host: os.hostname(),
    now: () => new Date(),
    stateFile: stateFileFor,
    /** 跑一条**只读**外部命令，返回 { code, out, err } */
    run(cmd, args, opts = {}) {
      const r = spawnSync(cmd, args, { encoding: null, windowsHide: true, timeout: opts.timeout ?? 60000 });
      return {
        code: r.status === null ? -1 : r.status,
        out: decode(r.stdout),
        err: decode(r.stderr),
        error: r.error ? String(r.error.message || r.error) : '',
      };
    },
    /** 枚举电源方案（powercfg /list，只读） */
    listPlans() {
      const r = this.run('powercfg', ['/list']);
      if (r.code !== 0) throw new Error(`powercfg /list failed: ${r.err || r.error}`);
      const plans = [];
      for (const line of r.out.split(/\r?\n/)) {
        const m = line.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\s*\(([^)]*)\)/i);
        if (!m) continue;
        plans.push({ guid: m[1].toLowerCase(), name: m[2].trim(), active: /(^|\s)\*/.test(line) });
      }
      if (!plans.length) throw new Error('powercfg /list: no plan parsed');
      return plans;
    },
    /** 一次 CIM 调用读全部 (方案 × AC/DC × 设置) 的值；隐藏项（合盖/无人值守）也读得到。
     *  同源 = `tools\overnight-mode.mjs` 的 readValues()（同一段 PowerShell，逐字照抄不改口径）。 */
    readValues() {
      const ps = [
        '$o = @{}',
        'Get-CimInstance -Namespace root/cimv2/power -ClassName Win32_PowerSettingDataIndex | ForEach-Object {',
        "  if ($_.InstanceID -match 'PowerSettingDataIndex\\\\\\{([^}]+)\\}\\\\(AC|DC)\\\\\\{([^}]+)\\}') {",
        '    $s = $Matches[1].ToLower(); $m = $Matches[2]; $g = $Matches[3].ToLower()',
        '    if (-not $o[$s]) { $o[$s] = @{} }',
        '    if (-not $o[$s][$m]) { $o[$s][$m] = @{} }',
        '    $o[$s][$m][$g] = [int]$_.SettingIndexValue',
        '  }',
        '}',
        '$o | ConvertTo-Json -Depth 6 -Compress',
      ].join('; ');
      const r = this.run(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 120000 });
      if (r.code !== 0 || !r.out.trim()) throw new Error(`readValues failed: ${r.err || r.error || 'empty output'}`);
      return JSON.parse(r.out.trim());
    },
    /** 读屏保 3 项（reg query，只读） */
    readScreensaver() {
      const out = {};
      for (const name of SCREENSAVER_VALUES) {
        const r = this.run('reg', ['query', SS_KEY, '/v', name]);
        const m = r.out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)$`, 'm'));
        out[name] = m ? m[1].trim() : null;
      }
      return out;
    },
    /** 读 Windows 更新时段窗 + 自动重启策略（reg query，只读） */
    readWuNow() {
      const r = this.run('reg', ['query', WU_UX_KEY]);
      const grab = (k) => {
        const m = r.out.match(new RegExp(`${k}\\s+REG_\\w+\\s+(\\S+)`, 'm'));
        if (!m) return null;
        const n = Number(m[1]);
        return Number.isFinite(n) ? n : null;
      };
      const activeHours = (() => {
        const s = grab('ActiveHoursStart');
        const e = grab('ActiveHoursEnd');
        return s === null || e === null ? null : { start: s, end: e };
      })();
      const p = this.run('reg', ['query', WU_AU_KEY, '/v', WU_POLICY_VALUE]);
      const pm = p.out.match(new RegExp(`${WU_POLICY_VALUE}\\s+REG_\\w+\\s+(\\S+)`, 'm'));
      const policy = p.code === 0 && pm ? Number(pm[1]) : null;
      return { activeHours, policy: Number.isFinite(policy) ? policy : null };
    },
    /** 读状态文件（只读、容错） */
    readState(file) {
      if (!file || !fs.existsSync(file)) return { exists: false, state: null, error: null };
      try {
        return { exists: true, state: JSON.parse(fs.readFileSync(file, 'utf8')), error: null };
      } catch (e) {
        return { exists: true, state: null, error: String(e?.message ?? e) };
      }
    },
  };
}

// ---------------------------------------------------------------- 核心判据（纯函数·可注入）
/**
 * @param {object} input
 * @param {object|null} input.state      状态文件内容（备份原值；null = 无备份可比对）
 * @param {Array}  input.plans           `listPlans()` 结果
 * @param {object} input.values          `readValues()` 结果
 * @param {object} input.screensaver     当前屏保实测
 * @param {object|null} input.wuNow      当前更新时段窗/策略实测
 * @param {string[]} [input.readErrors]  读取失败原因（非空 ⇒ unavailable）
 * @param {number} [input.now]
 * @returns {{level:string, protection:object, screensaver:object, wu:object, notes:string[], stats:object}}
 */
export function judgeGuard(input = {}) {
  const { state = null, plans = [], values = {}, screensaver = {}, wuNow = null, readErrors = [] } = input;
  const notes = [];
  const activeGuid = (plans.find((p) => p.active) || {}).guid || state?.activePlan || null;

  // ---- ① 7 项保护 ----
  const items = [];
  let okCount = 0;
  for (const plan of plans) {
    for (const s of SETTINGS) {
      for (const mode of ['ac', 'dc']) {
        const gotRaw = values?.[plan.guid]?.[mode.toUpperCase()]?.[s.id];
        const got = gotRaw === undefined ? null : Number(gotRaw);
        const backupRaw = state?.values?.[plan.guid]?.[s.name]?.[mode];
        const backup = backupRaw === undefined ? null : Number(backupRaw);
        let status;
        if (got === null) status = 'unknown';
        else if (got === PROTECT_TARGET) { status = 'ok'; okCount++; }
        else if (backup !== null && backup !== PROTECT_TARGET && got === backup) status = 'reverted';
        else status = 'changed';
        if (status === 'ok') continue;
        items.push({
          plan: plan.guid, planName: plan.name, active: !!plan.active, setting: s.name,
          label: s.label, mode, want: PROTECT_TARGET, got, backup, status,
        });
      }
    }
  }
  const activeBad = items.filter((i) => i.active && i.status !== 'unknown');
  const unknownItems = items.filter((i) => i.status === 'unknown');
  const reverted = items.filter((i) => i.status === 'reverted');
  const changed = items.filter((i) => i.status === 'changed');

  // ---- ② 屏保 ----
  const ssItems = [];
  for (const name of SCREENSAVER_VALUES) {
    const got = screensaver?.[name] ?? null;
    const backup = state?.screensaver?.[name] ?? null;
    const want = SS_TARGET[name];
    let status;
    if (got === null) status = 'unknown';
    else if (got === want) status = 'ok';
    else if (backup !== null && got === backup && backup !== want) status = 'reverted';
    else status = 'changed';
    ssItems.push({ name, want, got, backup, status });
  }
  const ssBad = ssItems.filter((i) => i.status !== 'ok');

  // ---- ③ 更新加固 ----
  const wu = { window: state?.wu?.window ?? WU_WINDOW_DEFAULT, now: wuNow, activeHours: 'unknown', policy: 'unknown' };
  if (!wuNow || !wuNow.activeHours) {
    wu.activeHours = 'unknown';
  } else if (wuNow.activeHours.start === wu.window.start && wuNow.activeHours.end === wu.window.end) {
    wu.activeHours = 'ok';
  } else if (state?.wu?.activeHours
    && wuNow.activeHours.start === state.wu.activeHours.start
    && wuNow.activeHours.end === state.wu.activeHours.end) {
    wu.activeHours = 'reverted';
  } else {
    wu.activeHours = 'changed';
  }
  if (!wuNow || wuNow.policy === null) wu.policy = 'unset';
  else if (wuNow.policy === 1) wu.policy = 'ok';
  else wu.policy = 'changed';

  // ---- 级别 ----
  let level;
  if (readErrors.length) level = 'unavailable';
  else if (activeBad.length) level = 'alarm';
  else if (items.length || ssBad.length || wu.activeHours === 'reverted' || wu.activeHours === 'changed') level = 'warn';
  else level = 'ok';

  if (!state) notes.push('没有状态文件（这台机可能从未开过插电保护）⇒ 只能核「是否全为 0」，**无法判「是否被改回原值」**');
  if (state?.restoredAt) notes.push(`状态文件显示已于 ${state.restoredAt} **恢复**（= 插电保护已关）⇒ 本段读数不代表保护中`);
  if (unknownItems.length) notes.push(`${unknownItems.length} 个电源值读不到（CIM 缺项）⇒ 已按 unknown 单列，不判绿`);
  if (wu.activeHours === 'unknown') notes.push('更新时段窗读不到（reg query 失败）⇒ 只报未知，不判绿');
  if (wu.policy === 'unset') notes.push('自动重启策略未设置（L2 层需管理员；非管理员属正常）');
  for (const e of readErrors) notes.push(`读取失败：${e}`);

  return {
    version: OVERNIGHT_GUARD_VERSION,
    asOf: input.now ?? Date.now(),
    host: input.host ?? null,
    level,
    protection: {
      total: plans.length * SETTINGS.length * 2, ok: okCount,
      planCount: plans.length, activeGuid, bad: items, reverted, changed, unknown: unknownItems,
    },
    screensaver: { items: ssItems, bad: ssBad },
    wu,
    stateFile: input.stateFile ?? null,
    stateExists: !!state,
    readErrors,
    notes,
  };
}

/** 汇总一次真机（或夹具）只读采集 + 判定。只读：不写任何文件。 */
export function collectAndJudge(deps = realDeps(), opts = {}) {
  const host = opts.host ?? deps.host;
  const file = deps.stateFile(host);
  const rs = deps.readState ? deps.readState(file) : { exists: false, state: null, error: null };
  const readErrors = [];
  if (rs.error) readErrors.push(`状态文件解析失败（${file}）：${rs.error}`);
  let plans = [];
  let values = {};
  let screensaver = {};
  let wuNow = null;
  try { plans = deps.listPlans(); } catch (e) { readErrors.push(`枚举电源方案失败：${String(e?.message ?? e)}`); }
  try { values = deps.readValues(); } catch (e) { readErrors.push(`读取电源值失败：${String(e?.message ?? e)}`); }
  try { screensaver = deps.readScreensaver(); } catch (e) { readErrors.push(`读取屏保失败：${String(e?.message ?? e)}`); }
  try { wuNow = deps.readWuNow(); } catch (e) { readErrors.push(`读取更新加固失败：${String(e?.message ?? e)}`); }
  return judgeGuard({
    state: rs.state, plans, values, screensaver, wuNow, readErrors,
    now: deps.now().getTime(), host, stateFile: rs.exists ? file : null,
  });
}

// ---------------------------------------------------------------- 渲染
const LVL_ICON = { ok: '🟢', warn: '🟡', alarm: '🔴', unavailable: '❔' };

const MODE_CN = { ac: '插电', dc: '电池' };
const STATUS_CN = {
  reverted: '疑似被改回原值', changed: '被改成了别值', unknown: '读不到',
};

/** 变化项一行（人话）。 */
export function itemLine(i) {
  const where = `${i.planName}${i.active ? '（活动方案）' : ''} · ${i.label} · ${MODE_CN[i.mode] ?? i.mode}`;
  if (i.status === 'unknown') return `${where}：读不到（期望 ${i.want}）`;
  return `${where}：期望 ${i.want}（永不），实测 **${i.got}**`
    + (i.status === 'reverted' ? ` = 开启插电保护前的原值 ⇒ **${STATUS_CN.reverted}**` : ` ⇒ ${STATUS_CN.changed}`);
}

/** 日报段（Markdown 行数组）。任何异常都必须显式成段，绝不静默变绿。 */
export function renderLines(r) {
  const L = [];
  L.push('## 🌙 插电保护自检（丙-1）');
  L.push('');
  const icon = LVL_ICON[r.level] ?? '❔';
  if (r.level === 'unavailable') {
    L.push(`- ${icon} **判定不可用**（读不到电源/屏保/更新时间窗）⇒ 本段**不代表保护在位**`);
    for (const n of r.notes) L.push(`  - ${n}`);
    L.push('- 复核 `node overnight-guard-check.mjs`；修保护 `node overnight-mode.mjs on`');
    L.push('');
    return L;
  }
  const p = r.protection;
  if (r.level === 'ok') {
    L.push(`- 🟢 7 项保护**全部在位**（${p.planCount} 个方案 × 7 项 × AC/DC = ${p.total} 个值全为 0）`);
  } else if (r.level === 'alarm') {
    const bad = p.bad.filter((i) => i.active);
    L.push(`- 🔴 **保护失效**：活动方案上有 **${bad.length}** 项非 0 —— 机器随时可能睡眠/休眠/关屏`);
    for (const i of bad.slice(0, 8)) L.push(`  - ${itemLine(i)}`);
    if (bad.length > 8) L.push(`  - …其余 ${bad.length - 8} 项见 \`--json\``);
  } else {
    L.push('- 🟡 活动方案上的 7 项**都还在位**（机器不会睡），但检测到变化：');
    if (p.bad.length) {
      L.push(`  - 电源项 **${p.bad.length}** 处（非活动方案 / 非全零）：`);
      for (const i of p.bad.slice(0, 6)) L.push(`    - ${itemLine(i)}`);
      if (p.bad.length > 6) L.push(`    - …其余 ${p.bad.length - 6} 项见 \`--json\``);
    } else {
      L.push('  - 电源 7 项本身无变化 —— 差异在下面的屏保 / 更新时段窗');
    }
  }
  // 屏保
  const ssBad = r.screensaver.bad;
  L.push(`- 屏保：${ssBad.length ? `🟡 ${ssBad.map((i) => `${i.name} 期望 ${i.want} 实测 ${i.got ?? '读不到'}`).join(' / ')}` : '🟢 3 项均与加固目标一致（0/0/0）'}`);
  // 更新加固
  const wu = r.wu;
  const wuIcon = wu.activeHours === 'ok' ? '🟢' : wu.activeHours === 'unknown' ? '❔' : '🟡';
  const win = `${String(wu.window.start).padStart(2, '0')}:00 → ${String(wu.window.end).padStart(2, '0')}:00`;
  const nowTxt = wu.now?.activeHours ? `${wu.now.activeHours.start}:00 → ${wu.now.activeHours.end}:00` : '读不到';
  L.push(`- 更新时段窗：${wuIcon} 加固目标 ${win}，实测 ${nowTxt}${wu.activeHours === 'ok' ? '（夜里不会自动重启 ✓）' : wu.activeHours === 'unknown' ? '（读不到，不判绿）' : '（⚠ 已被改动，夜里可能自动重启）'}`);
  L.push(`- 自动重启策略：${wu.policy === 'ok' ? '🟢 已开（有人登录就禁止自动重启）' : wu.policy === 'unset' ? '⚪ 未设置（L2 层需管理员，属正常）' : '🟡 值异常'}`);
  if (r.stateFile) L.push(`- 备份比对源 \`${r.stateFile}\``);
  for (const n of r.notes) L.push(`- ⓘ ${n}`);
  L.push(`- 修保护 \`node overnight-mode.mjs on\`｜详查 \`node overnight-guard-check.mjs\``);
  L.push('');
  return L;
}

/** CLI 人话读数。 */
export function renderText(r) {
  const L = [];
  L.push(`插电保护自检 v${r.version} —— ${LVL_ICON[r.level] ?? '❔'} ${r.level.toUpperCase()}`);
  L.push(`主机：${r.host ?? '?'}｜方案数：${r.protection.planCount}｜活动方案：${r.protection.activeGuid ?? '?'}`);
  L.push(`状态文件：${r.stateFile ?? '(不存在)'}`);
  L.push(`7 项保护：${r.protection.ok}/${r.protection.total} 个值 = 0（加固目标）`);
  if (!r.protection.bad.length) L.push('  🟢 无不一致项');
  else for (const i of r.protection.bad) L.push(`  ${i.status === 'reverted' ? '🟡' : i.status === 'changed' ? '🟡' : '❔'} ${itemLine(i)}`);
  L.push(`屏保：${r.screensaver.bad.length ? '🟡 有差异' : '🟢 一致（0/0/0）'}`);
  for (const i of r.screensaver.bad) {
    L.push(`  · ${i.name}：期望 ${i.want}，实测 ${i.got ?? '读不到'}`
      + (i.status === 'reverted' ? ` = 原值 ⇒ 疑似被改回` : i.status === 'changed' ? ' ⇒ 被改成别值' : ''));
  }
  const wu = r.wu;
  L.push(`更新时间窗：${wu.activeHours}（目标 ${wu.window.start}:00 → ${wu.window.end}:00`
    + `，实测 ${wu.now?.activeHours ? `${wu.now.activeHours.start}:00 → ${wu.now.activeHours.end}:00` : '读不到'}）`);
  L.push(`自动重启策略：${wu.policy}`);
  for (const n of r.notes) L.push(`ⓘ ${n}`);
  return L.join('\n');
}

// ---------------------------------------------------------------- 自检（mock，不碰真机）
export function selfTest() {
  let pass = 0;
  const fails = [];
  const ok = (cond, name) => { if (cond) pass++; else fails.push(name); };

  const PLAN_A = 'aaaa1111-1111-1111-1111-111111111111';  // 活动方案
  const PLAN_B = 'bbbb2222-2222-2222-2222-222222222222';  // 非活动方案
  const plans = [
    { guid: PLAN_A, name: 'Performance', active: true },
    { guid: PLAN_B, name: '平衡', active: false },
  ];
  // 备份原值（模拟 overnight-mode on 时快照）
  const backupValues = (v) => ({ [PLAN_A]: v, [PLAN_B]: v });
  const ORIG = Object.fromEntries(SETTINGS.map((s) => [s.name, { ac: 300, dc: 180 }]));
  const zeroValues = () => {
    const o = {};
    for (const p of [PLAN_A, PLAN_B]) {
      o[p] = { AC: {}, DC: {} };
      for (const s of SETTINGS) { o[p].AC[s.id] = 0; o[p].DC[s.id] = 0; }
    }
    return o;
  };
  const state = {
    values: backupValues(ORIG), activePlan: PLAN_A,
    screensaver: { ScreenSaveActive: '1', ScreenSaveTimeOut: '600', ScreenSaverIsSecure: '0' },
    wu: { window: { start: 21, end: 15 }, activeHours: { start: 8, end: 20 } },
  };
  const ssOk = { ScreenSaveActive: '0', ScreenSaveTimeOut: '0', ScreenSaverIsSecure: '0' };
  const wuOk = { activeHours: { start: 21, end: 15 }, policy: 1 };

  // T1 全在位 ⇒ 🟢
  {
    const r = judgeGuard({ state, plans, values: zeroValues(), screensaver: ssOk, wuNow: wuOk, host: 'X', now: 1 });
    ok(r.level === 'ok', 'T1 level=ok');
    ok(r.protection.ok === 28, 'T1 28 个值全 0');
    ok(r.protection.bad.length === 0, 'T1 无变化项');
  }
  // T2 活动方案一项被改回原值 ⇒ 🔴 alarm + reverted
  {
    const v = zeroValues();
    v[PLAN_A].AC[SETTINGS[0].id] = 300;
    const r = judgeGuard({ state, plans, values: v, screensaver: ssOk, wuNow: wuOk, host: 'X', now: 1 });
    ok(r.level === 'alarm', 'T2 活动方案改动 ⇒ alarm');
    const it = r.protection.bad.find((i) => i.setting === 'STANDBYIDLE' && i.mode === 'ac');
    ok(!!it && it.status === 'reverted', 'T2 判定 reverted');
    ok(!!it && it.got === 300 && it.backup === 300, 'T2 读数 300=原值');
    ok(renderLines(r).some((l) => l.includes('保护失效')), 'T2 段内出现「保护失效」');
  }
  // T3 非活动方案被改成第三值 ⇒ 🟡 warn + changed
  {
    const v = zeroValues();
    v[PLAN_B].DC[SETTINGS[3].id] = 99;
    const r = judgeGuard({ state, plans, values: v, screensaver: ssOk, wuNow: wuOk, host: 'X', now: 1 });
    ok(r.level === 'warn', 'T3 非活动方案 ⇒ warn');
    const it = r.protection.bad.find((i) => i.setting === 'VIDEOIDLE');
    ok(!!it && it.status === 'changed' && it.got === 99, 'T3 判定 changed/99');
  }
  // T4 屏保被改回 ⇒ 🟡
  {
    const r = judgeGuard({
      state, plans, values: zeroValues(),
      screensaver: { ScreenSaveActive: '1', ScreenSaveTimeOut: '0', ScreenSaverIsSecure: '0' },
      wuNow: wuOk, host: 'X', now: 1,
    });
    ok(r.level === 'warn', 'T4 屏保差异 ⇒ warn');
    const it = r.screensaver.bad.find((i) => i.name === 'ScreenSaveActive');
    ok(!!it && it.status === 'reverted' && it.got === '1', 'T4 屏保 reverted');
  }
  // T5 更新时段窗回到原值 ⇒ 🟡（且段里明说夜里可能自动重启）
  {
    const r = judgeGuard({
      state, plans, values: zeroValues(), screensaver: ssOk,
      wuNow: { activeHours: { start: 8, end: 20 }, policy: 1 }, host: 'X', now: 1,
    });
    ok(r.level === 'warn', 'T5 WU 回原值 ⇒ warn');
    ok(r.wu.activeHours === 'reverted', 'T5 wu=reverted');
    ok(renderLines(r).some((l) => l.includes('夜里可能自动重启')), 'T5 段内提示自动重启');
  }
  // T6 无状态文件 + 实测全 0 ⇒ 🟢 但带「无法判是否被改回」注
  {
    const r = judgeGuard({ state: null, plans, values: zeroValues(), screensaver: ssOk, wuNow: wuOk, host: 'X', now: 1 });
    ok(r.level === 'ok', 'T6 无状态文件仍判 ok');
    ok(r.notes.some((n) => n.includes('无法判')), 'T6 注明无法判「被改回」');
  }
  // T7 读取失败 ⇒ unavailable（绝不判绿）
  {
    const r = judgeGuard({
      state, plans, values: zeroValues(), screensaver: ssOk, wuNow: wuOk,
      readErrors: ['读取电源值失败：boom'], host: 'X', now: 1,
    });
    ok(r.level === 'unavailable', 'T7 读失败 ⇒ unavailable');
    ok(renderLines(r).some((l) => l.includes('判定不可用')), 'T7 段内显式「判定不可用」');
  }
  // T8 值读不到（CIM 缺项）⇒ unknown 项单列，不判绿
  {
    const v = zeroValues();
    delete v[PLAN_A].AC[SETTINGS[1].id];
    const r = judgeGuard({ state, plans, values: v, screensaver: ssOk, wuNow: wuOk, host: 'X', now: 1 });
    ok(r.protection.unknown.length === 1, 'T8 unknown 项 1 个');
    ok(renderLines(r).some((l) => l.includes('不判绿')), 'T8 段内注明不判绿');
  }
  // T9 「已恢复」注（状态文件有 restoredAt ⇒ 读数不代表保护中）
  {
    const st2 = { ...state, restoredAt: '2026-09-27T00:00:00.000Z' };
    const r = judgeGuard({ state: st2, plans, values: zeroValues(), screensaver: ssOk, wuNow: wuOk, host: 'X', now: 1 });
    ok(r.notes.some((n) => n.includes('已关')), 'T9 明说整夜模式已关');
  }
  // T10 屏保读不到 ⇒ unknown（不判绿）
  {
    const r = judgeGuard({
      state, plans, values: zeroValues(),
      screensaver: { ScreenSaveActive: null, ScreenSaveTimeOut: null, ScreenSaverIsSecure: null },
      wuNow: wuOk, host: 'X', now: 1,
    });
    ok(r.screensaver.bad.every((i) => i.status === 'unknown'), 'T10 屏保未知');
    ok(r.level === 'warn', 'T10 未知 ⇒ 至少 warn（不判绿）');
  }
  // T11 渲染器的 JSON 可序列化性 + 段行数
  {
    const r = judgeGuard({ state, plans, values: zeroValues(), screensaver: ssOk, wuNow: wuOk, host: 'X', now: 1 });
    ok(typeof JSON.stringify(r) === 'string', 'T11 结果可 JSON 化');
    ok(renderLines(r)[0] === '## 🌙 插电保护自检（丙-1）', 'T11 段标题固定');
  }
  return { total: 11, assertions: pass + fails.length, pass, fails };
}

// ---------------------------------------------------------------- CLI
export function parseArgv(argv) {
  const o = { json: false, section: false, selfTest: false, failOnChange: false, host: null, stateFile: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') o.json = true;
    else if (a === '--section') o.section = true;
    else if (a === '--self-test') o.selfTest = true;
    else if (a === '--fail-on-change') o.failOnChange = true;
    else if (a === '--host') o.host = argv[++i] ?? null;
    else if (a === '--state') o.stateFile = argv[++i] ?? null;
    else if (a === '--help' || a === '-h') o.help = true;
    else return { error: `未知参数：${a}` };
  }
  return o;
}

export function isMainEntry(argv1 = process.argv[1]) {
  // junction 坑（persona 铁律）：argv[1] 是逻辑路径、import.meta.url 是物理路径 ⇒ 必须 realpath 双方再比
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url));
    const argv = argv1 ? fs.realpathSync(argv1) : '';
    return !!argv && self.toLowerCase() === argv.toLowerCase();
  } catch {
    return false;
  }
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgv(argv);
  if (opts.error) { process.stderr.write(opts.error + '\n用法：node overnight-guard-check.mjs [--json|--section|--self-test|--fail-on-change]\n'); process.exitCode = EXIT.USAGE; return; }
  if (opts.help) {
    process.stdout.write('用法：node overnight-guard-check.mjs [--json|--section|--self-test|--fail-on-change] [--host H] [--state FILE]\n');
    return;
  }
  if (opts.selfTest) {
    const r = selfTest();
    if (jsonMode) { /* self-test 不用 json 模式 */ }
    process.stdout.write(`[overnight-guard] self-test：${r.pass}/${r.assertions} 断言通过${r.fails.length ? `（红：${r.fails.join(' | ')}）` : ''}\n`);
    if (r.fails.length) process.exitCode = 1;
    return;
  }
  jsonMode = opts.json;
  let r;
  try {
    const deps = realDeps();
    if (opts.stateFile) {
      const orig = deps.stateFile;
      deps.stateFile = () => opts.stateFile;
      void orig;
    }
    r = collectAndJudge(deps, { host: opts.host ?? undefined });
  } catch (e) {
    process.stderr.write(`[overnight-guard] 采集失败：${String(e?.message ?? e)}\n`);
    process.exitCode = EXIT.UNAVAILABLE;
    return;
  }
  if (opts.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
  else if (opts.section) process.stdout.write(renderLines(r).join('\n') + '\n');
  else { log(renderText(r)); }
  if (r.level === 'unavailable') process.exitCode = EXIT.UNAVAILABLE;
  else if (r.level !== 'ok' && opts.failOnChange) process.exitCode = EXIT.CHANGED;
}

if (isMainEntry()) main();
