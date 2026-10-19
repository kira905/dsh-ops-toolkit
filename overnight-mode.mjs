#!/usr/bin/env node
/**
 * overnight-mode.mjs — 插电保护（睡眠/休眠/关屏/合盖/屏保 一键开关 + 按电源自动切换）
 *
 * 称呼订正（2026-10-16 · 主人拍板「改叫插电保护」）
 *   对外一律叫「**插电保护**」；**文件名 / 命令名 / 状态文件名仍用 `overnight-mode`**（历史名，
 *   全库 1200+ 处指针引用它，改名会扯断一片；技能目录名同理保留）。代码注释里的历史叙述保留原词。
 *
 * 用途
 *   主人说「整夜干活 / 通宵跑 / 关盖跑」→ on：备份当前电源设置后，把所有会让机器
 *   停下来睡觉的设置改成「永不」，关盖也不动作，屏保关掉。
 *   「当前是否保护中」的判据面 = **电源 7 项 + 屏保 3 项**（2026-10-08 起，见下方「屏保并入判据」段）。
 *   主人说「恢复正常」→ off：按备份逐条写回改动前的原值（含 AC/DC 分别恢复）。
 *   **2026-10-16 起不用再手动喊**：`auto` 按电源状态自己切（插电 ⇒ 保护；拔电 ⇒ 宽限后恢复正常），
 *   由 DSH 生态开机链 + tickd 周期 job 两处驱动（见下方「插电自动对齐」段）。
 *
 * 用法
 *   node <DSH_ROOT>\tools\overnight-mode.mjs auto          # 按电源状态自动对齐（幂等；一致时零动作零写盘）
 *   node <DSH_ROOT>\tools\overnight-mode.mjs on            # 手动进入保护（幂等；含 Windows 更新防重启加固）
 *   node <DSH_ROOT>\tools\overnight-mode.mjs off           # 手动恢复正常（按备份写回）
 *   node <DSH_ROOT>\tools\overnight-mode.mjs status        # 只看当前状态，不改任何东西
 *   node <DSH_ROOT>\tools\overnight-mode.mjs on --dry-run  # 只算不写
 *   node <DSH_ROOT>\tools\overnight-mode.mjs adopt --import-from <备份目录>
 *                                                      # 把手工改动的旧备份导入成状态文件
 *   node <DSH_ROOT>\tools\overnight-mode.mjs --self-test   # mock 单测（不碰真机）
 *   通用开关：--json（stdout 只输出 JSON） / --force / --no-events
 *   WU 相关：--no-wu（本次跳过更新加固） / --wu-window 21-15（自定义活动时间窗口）
 *   接力相关：--no-relay（本次跳过「放行会话接力 job」· 见下方「会话接力联动」段）
 *   自动对齐（仅 auto 用）：--grace-minutes 10（拔电后宽限多久才退保护） / --verify-hours 6（每隔几小时做一次真核自愈，0 = 关）
 *
 * 插电自动对齐（2026-10-16 加 · 卡「整夜模式 → 插电保护（常驻化四件套）」）
 *   主人令：「四件套都做，改叫插电保护，根据电源情况自己判断」。⇒ 不用再手动喊开关，
 *   `auto` 自己按电源状态对齐，两个驱动点：**DSH 生态开机链**（`dsh-start.ps1`，非阻塞）
 *   + **tickd 周期 job `plug-guard`**（10 分钟一轮）。
 *   判据 = kernel32 `GetSystemPowerStatus` 的 `ACLineStatus`（1 = 插电 / 0 = 电池 / 255 = 未知）：
 *     · ⚠️ **不许**用 `Win32_Battery.BatteryStatus`（2 是 Unknown，不是"已接电源"）；
 *     · ⚠️ **不许**用 `root/wmi` 的 `BatteryStatus.PowerOnline`（本机实测给误导性 False）。
 *   四象限行为（一致时**零动作、零写盘**）：
 *     插电 × 未保护 ⇒ 调 on（幂等路径，含备份 + WU 加固 + 接力 job 放行）
 *     插电 × 保护中 ⇒ 什么都不做
 *     电池 × 保护中 ⇒ **宽限期**（默认 10 分钟，`--grace-minutes`）起算；到点才调 off
 *     电池 × 未保护 ⇒ 什么都不做
 *     电源读不到（未知）⇒ 本轮什么都不做（不当成"拔电"处理）
 *   宽限状态存 `~/.dsh/overnight-mode-auto-<host>.json`（与主状态文件分开，`off` 完全不读它）：
 *     只在「宽限开始 / 宽限清空 / 真核到点」时写，其余轮次一个字节都不写。
 *   **真核自愈**（默认每 6 小时一次，`--verify-hours 0` 关）：轻判据只看状态文件，若保护值被外部改回
 *     而状态文件没变，auto 会一直以为"已保护"⇒ 每隔 6 小时重读一次真值（同 status 的判据面），
 *     发现漂移就当"未保护"走 on 的补做路径自愈（不覆盖电源备份）。每日 `overnight-guard` job 仍兜底。
 *   ⚠️ **auto 从不提权**（设计如此）：从 DSH 会话 / tickd 跑都是普通权限，而 `off` 的 L2 层
 *     （`restoreWuGuard`）在非管理员时**本就不会去删那条策略**（源码见该函数 `!deps.isAdmin()` 分支）
 *     ⇒ 自动循环不会把「夜里防更新重启」的硬保险撤掉又补不回来（那是手动提权跑 off 才有的风险）。
 *
 * 屏保并入判据（2026-10-08 加 · 主人 2026-10-08 12:1x 拍板修）
 *   旧版：on 会把屏保 3 项（HKCU\Control Panel\Desktop 的 ScreenSaveActive / ScreenSaveTimeOut /
 *   ScreenSaverIsSecure）设成 0，但**「当前是否保护中」的判据只看电源 7 项** ⇒
 *   ① 屏保单独漂移回 1 时 status 仍报「保护中」（假绿，自动化/日报天天带噪声）；
 *   ② on 的幂等分支看到 7 项全 0 就早退，屏保**再也不被纠正**（无自愈路径，只能靠主人手动 on 顺带改）。
 *   现在：① 判据面 = 电源 7 项 + 屏保 3 项（读不到 = 不合规，不判绿）；
 *        ② on 幂等时若屏保漂移则走「补做」路径纠正（不覆盖电源备份）；
 *        ③ 设不了（被组策略/EDR 锁）**如实报 need-admin 并只告警，不判失败**（见 applyScreensaverGuard）。
 *   保护值 = 0/0/0，与 tools/overnight-guard-check.mjs 的 SS_TARGET 同源（改一处要同步另一处）。
 *
 * Windows 更新防重启加固（2026-09-17 加，主人要求「堵更新重启，写进切换脚本」）
 *   背景：本机活动时间是系统默认 8:00-20:00，也就是**夜里 20:00-8:00 属于「非活动时间」**
 *   ——正是整夜跑任务的时段，Windows 装完更新可以这段时间自动重启，把任务打断。
 *   两层，on 时默认自动全部尝试：
 *     L1 活动时间（**普通权限即可**，实测 reg add rc=0）：改成 21:00 → 次日 15:00（窗口上限
 *        18 小时），把整夜划进「活动时间」→ Windows 夜里不自动重启。
 *     L2 组策略 NoAutoRebootWithLoggedOnUsers=1（**需管理员**）：只要有人登录就绝不自动重启，
 *        硬保险。非管理员时跳过并提示「双击桌面 DSH插电保护.cmd」（那个脚本会自动 UAC 提权）。
 *   off 按 state.wu 备份的原值逐条还原（活动时间写回原值、策略值删除或写回原值）。
 *   ⚠ 旧做法「net stop wuauserv / UsoSvc」已删除：非管理员根本做不到、WaaSMedicSvc 会把服务
 *     自愈拉起、停服务还可能让更新状态机变脏——收益低风险高，换成上面两层。
 *
 * 会话接力联动（2026-09-22 加 · 主人令「jobs 放进整夜模式脚本里」）
 *   背景：会话接力 = 把快干满上下文的会话自动交接给新会话接着干（`tools/session-relay.mjs`）。
 *   它有一条 tickd 定时通道（job id = `relay`，5 分钟一轮）：无人值守时替卡执行会话自动写交接档、
 *   开接手会话、补标【已交接】。默认关（交付≠放行）——而整夜跑任务恰恰是「没人看着也要能交接」的场景。
 *   on：先备份 job 现状（写进状态文件 `relayJob` 块）再**放行**（`jobs.relay.enabled = true`）；
 *   off：按备份**还原**（开整夜模式前本来就是开的 → 不关回，保持原样）。
 *   ⚠ 放行后 tickd 每 5 分钟可能真开新会话、调模型（花钱；另有每日额度兜着）⇒ 只在整夜模式期间开。
 *   ⚠ 只动 `jobs.relay`（定时通道）；`modules.relay`（会话内主动发起那条）**不归本工具管**。
 *   跳过：`--no-relay`。本机没有大管家组件（`tools/dsh-butler/`）时自动跳过并提示，不算失败。
 *   开关真源 = `~/.dsh/butler-autonomy.json` 的 `jobs.relay`；回读核对：
 *   `node <DSH_ROOT>\tools\dsh-butler\butler-autonomy-cli.mjs job list`。
 *
 * 设计要点（都是踩过的坑）
 *   1. 读值走 WMI/CIM：Win32_PowerSettingDataIndex 的 InstanceID 形如
 *      Microsoft:PowerSettingDataIndex\{scheme}\AC\{setting} —— AC/DC 分开且**隐藏项
 *      （合盖动作 LIDACTION、无人值守睡眠 UNATTENDSLEEP）也读得到**；
 *      powercfg /q 对这些隐藏项根本不显示值，只看它会误判成「没设置成功」。
 *   2. 写值走 powercfg /setacvalueindex —— 非管理员权限即可（实测 rc=0），
 *      而直接改注册表 HKLM\SYSTEM\...\Power 需要管理员，所以不用注册表写。
 *   3. 备份存在 ~/.dsh/overnight-mode-<host>.json（按主机名分文件，跨机同步不会互相覆盖）。
 *   4. 电源与屏保只碰用户级设置；WU 加固分两层（L1 活动时间＝普通权限 / L2 策略＝需管理员），见上。
 *   5. 收尾一律 process.exitCode，不 process.exit()（Windows + undici 强退会 0xC0000409）。
 *
 * 关联
 *   - 首次手工版本的回滚点/演练：<DSH_ROOT>\_archive\overnight-nosleep-20260915-002534
 *   - 桌面兜底脚本：桌面\DSH鲸落地\ 下的两个 .cmd（双击可用）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveDshHome } from './lib/dsh-home.mjs';
// 【2026-10-09 · 卡「360弹窗治本-pwsh7」】PowerShell 一律走统一工具（pwsh 7 优先）：
//   360 企业版 EDR 只对 5.1（powershell.exe）弹「PowerShell 命令执行攻击」；工具缺失 ⇒ 兜底 5.1。
const PS_EXE = await import('./lib/powershell-exe.mjs').then((m) => m.powerShellExe()).catch(() => 'powershell.exe');

// 大管家 job 开关库（**可选依赖**）：用顶层 await + try/catch 动态 import ——
// 静态 import 一旦失败整个脚本都加载不了，而整夜模式是主人手边的开关工具，不该被新依赖拖死。
// 加载不到 = 本机没有大管家组件 ⇒ 接力联动记「跳过」（不是失败）。
let relayLib = null;
try { relayLib = await import('./dsh-butler/lib/autonomy-modules.mjs'); } catch { relayLib = null; }

const VERSION = '1.4.0';
// DSH 数据根：口径 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh（2026-09-17 环境边界修复，
// 卡：自研组件去 os.homedir() 硬编码）。原为 `path.join(os.homedir(), '.dsh')` ——
// 在测试/金丝雀实例里跑 on|off 会读写**生产** home 的状态备份文件。
// 不设环境变量时 resolveDshHome() 回落 ~/.dsh，路径与改造前逐字节一致。
const STATE_DIR = resolveDshHome();
const LOG_FILE = path.join(os.tmpdir(), 'dsh-overnight-mode.log');

// ---------------------------------------------------------------- 设置清单
// 每一项都是「会让机器停下来」的开关；sub 是电源子组 GUID，id 是设置 GUID
const SUB_SLEEP = '238c9fa8-0aad-41ed-83f4-97be242c8f20';
const SUB_VIDEO = '7516b95f-f776-4464-8c53-06167f40cc99';
const SUB_DISK = '0012ee47-9041-4b5d-9b77-535fba8b1442';
const SUB_USB = '2a737441-1930-4402-8d77-b2bebba308a3';
const SUB_BTN = '4f971e89-eebd-4455-a8de-9e59040e7347';

const SETTINGS = [
  { name: 'STANDBYIDLE', sub: SUB_SLEEP, id: '29f6c1db-86da-48c5-9fdb-f2b67b1f44da', label: '空闲多久自动睡眠' },
  { name: 'HIBERNATEIDLE', sub: SUB_SLEEP, id: '9d7815a6-7ee4-497e-8888-515a05f02364', label: '空闲多久自动休眠' },
  { name: 'UNATTENDSLEEP', sub: SUB_SLEEP, id: '7bc4a2f9-d8fc-4469-b07b-33eb785aaca0', label: '无人值守睡眠超时(隐藏项)' },
  { name: 'VIDEOIDLE', sub: SUB_VIDEO, id: '3c0bc021-c8a8-4e07-a973-6b14cbcb2b7e', label: '空闲多久关闭显示器' },
  { name: 'DISKIDLE', sub: SUB_DISK, id: '6738e2c4-e8a5-4a42-b16a-e040e769756e', label: '空闲多久关闭硬盘' },
  { name: 'USBSUSPEND', sub: SUB_USB, id: '48e6b7a6-50f5-4782-a5d4-53bb8f07e226', label: 'USB 选择性挂起' },
  { name: 'LIDACTION', sub: SUB_BTN, id: '5ca83367-6e45-459f-a27b-476b1d01c936', label: '合盖动作(隐藏项)' },
];
const SCREENSAVER_VALUES = ['ScreenSaveActive', 'ScreenSaveTimeOut', 'ScreenSaverIsSecure'];
// 屏保三项的「保护值」= 全 0（关屏保 / 不锁屏），与电源 7 项的期望值同源（0 = 永不 / 关闭）。
// ⚠ 与 tools/overnight-guard-check.mjs 的 SS_TARGET 逐字同源：改这里要同步改那边。
const SCREENSAVER_TARGETS = { ScreenSaveActive: '0', ScreenSaveTimeOut: '0', ScreenSaverIsSecure: '0' };
const SS_KEY = 'HKCU\\Control Panel\\Desktop';
const WU_AU_KEY = 'HKLM\\SOFTWARE\\Policies\\Microsoft\\Windows\\WindowsUpdate\\AU';
const WU_VALUE = 'NoAutoRebootWithLoggedOnUsers';
// 活动时间（Windows 更新「使用时段」）：实测这个键**普通权限就能写**（reg add rc=0），
// 于是「不让它夜里重启」这件事不需要提权也能办到 —— 这是 L1 层能落地的根本原因。
const WU_UX_KEY = 'HKLM\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings';
// 活动时间窗口上限 18 小时（Win11 限制），默认把整夜圈进去：21:00 → 次日 15:00。
// 剩下的非活动窗口落在 15:00-21:00（主人在电脑前，且 L2 策略生效时根本不会自动重启）。
const WU_WINDOW_DEFAULT = { start: 21, end: 15 };
const WU_WINDOW_MAX_HOURS = 18;

// 会话接力联动的 job id：必须与 `tools/dsh-butler/butler-tickd.mjs` 的 JOBS 表逐字一致
// （全篇唯一 `relay` —— 曾出现「方案写 session-relay、闸门写 relay」两种 id，会让一键停落到不存在的 id）。
const RELAY_JOB_ID = 'relay';
const RELAY_JOB_WHY_ON = '插电保护：无人值守自动交接（overnight-mode on）';
const RELAY_JOB_WHY_OFF = '插电保护恢复：按备份还原 job 开关（overnight-mode off）';

const EXIT = { OK: 0, ERROR: 1, USAGE: 2, ENV: 3, NEED_ADMIN: 4, HOST_MISMATCH: 5 };

// ---------------------------------------------------------------- 插电自动对齐（auto）
// 宽限期：拔电后**不立刻**退保护（挪个位置、拔一下充电器不该折腾机器），默认 10 分钟。
// 主人 2026-10-16 拍板「默认 10 分钟」，要改就是一句话的事（--grace-minutes N 或改这里）。
const AUTO_GRACE_MINUTES_DEFAULT = 10;
// 真核自愈间隔：auto 平时只看状态文件（轻判据）；每隔这么久重读一次真值，发现保护被外部改回就自愈。
// 为什么需要：状态文件说"保护中"而实际值被改回时，轻判据永远发现不了（每日 overnight-guard 只能次日兜底）。
const AUTO_VERIFY_HOURS_DEFAULT = 6;

/**
 * 读电源状态的那段 PowerShell（**唯一判据**：kernel32 GetSystemPowerStatus 的 ACLineStatus）。
 * ⚠️ health() 与 readAc() 共用同一段（口径单一真源）：Win32_Battery.BatteryStatus 的 2 是 Unknown、
 *    root/wmi 的 PowerOnline 本机给误导性 False —— 都别用。
 */
const POWER_STATUS_PS = [
  `$sig='[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GetSystemPowerStatus(out SYSTEM_POWER_STATUS sps); [StructLayout(LayoutKind.Sequential)] public struct SYSTEM_POWER_STATUS { public byte ACLineStatus; public byte BatteryFlag; public byte BatteryLifePercent; public byte SystemStatusFlag; public int BatteryLifeTime; public int BatteryFullLifeTime; }'`,
  'Add-Type -MemberDefinition $sig -Name PwrApi -Namespace W32 -ErrorAction SilentlyContinue',
  '$s = New-Object W32.PwrApi+SYSTEM_POWER_STATUS',
  '[void][W32.PwrApi]::GetSystemPowerStatus([ref]$s)',
  '@{ac=[int]$s.ACLineStatus; percent=[int]$s.BatteryLifePercent} | ConvertTo-Json -Compress',
].join('; ');

// ---------------------------------------------------------------- 工具函数
let jsonMode = false;

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

function stateFile(host) {
  return path.join(STATE_DIR, `overnight-mode-${String(host).toLowerCase()}.json`);
}

/**
 * auto 自己的小状态文件（**与主状态文件分开**）：只存宽限起算时刻 + 上次真核时刻。
 * 为什么分开：主状态文件是 `off` 的还原依据（电源原值/WU/接力 job 备份），auto 的临时计时信息
 * 混进去会污染它（旧版工具读到不认识的字段倒不怕，但"off 只读自己那份备份"这条不变量要守住）。
 */
function autoStateFile(host) {
  return path.join(STATE_DIR, `overnight-mode-auto-${String(host).toLowerCase()}.json`);
}

function writeFileAtomic(file, text) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
}

// ---------------------------------------------------------------- 默认依赖(真机)
function realDeps() {
  return {
    host: os.hostname(),
    now: () => new Date(),
    stateFile,

    /** 跑一条外部命令，返回 {code, out, err} */
    run(cmd, args, opts = {}) {
      const r = spawnSync(cmd, args, { encoding: null, windowsHide: true, timeout: opts.timeout ?? 60000 });
      return {
        code: r.status === null ? -1 : r.status,
        out: decode(r.stdout),
        err: decode(r.stderr),
        error: r.error ? String(r.error.message || r.error) : '',
      };
    },

    /** 枚举电源方案：powercfg /list */
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

    /** 一次 CIM 调用读全部 (方案 × AC/DC × 设置) 的值；隐藏项也读得到 */
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

    /** 写一个设置值（AC 或 DC） */
    setValue(planGuid, subGuid, settingGuid, mode, value) {
      const flag = mode.toLowerCase() === 'ac' ? '/setacvalueindex' : '/setdcvalueindex';
      const r = this.run('powercfg', [flag, planGuid, subGuid, settingGuid, String(value)]);
      return { ok: r.code === 0, code: r.code, err: r.err || r.error };
    },

    setActivePlan(guid) {
      const r = this.run('powercfg', ['/setactive', guid]);
      return { ok: r.code === 0, code: r.code, err: r.err || r.error };
    },

    readScreensaver() {
      const out = {};
      for (const name of SCREENSAVER_VALUES) {
        const r = this.run('reg', ['query', SS_KEY, '/v', name]);
        const m = r.out.match(new RegExp(`${name}\\s+REG_\\w+\\s+(.*)$`, 'm'));
        out[name] = m ? m[1].trim() : null;
      }
      return out;
    },

    writeScreensaver(values) {
      const results = [];
      for (const name of SCREENSAVER_VALUES) {
        if (values[name] === null || values[name] === undefined) continue;
        const r = this.run('reg', ['add', SS_KEY, '/v', name, '/t', 'REG_SZ', '/d', String(values[name]), '/f']);
        results.push({ name, ok: r.code === 0, err: r.err || r.error });
      }
      return results;
    },

    isAdmin() {
      const r = this.run('net', ['session']);
      return r.code === 0;
    },

    /** 夜间中断事件（睡眠/唤醒/重启/意外断电） */
    wakeEvents(sinceIso) {
      const ps = `$s=[datetime]::Parse('${sinceIso}'); Get-WinEvent -FilterHashtable @{LogName='System'; Id=41,42,107,109,6005,6006,6008; StartTime=$s} -ErrorAction SilentlyContinue | Sort-Object TimeCreated | ForEach-Object { '{0}|{1}' -f $_.TimeCreated.ToString('s'), $_.Id }`;
      const r = this.run(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', ps], { timeout: 120000 });
      if (r.code !== 0) return null;
      return r.out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
        const [time, id] = l.split('|');
        const why = { 41: '意外断电/死机', 42: '进入睡眠', 107: '从睡眠唤醒', 109: '内核发起关机', 6005: '事件日志启动(开机)', 6006: '事件日志停止(正常关机)', 6008: '上次关机是意外的' };
        return { time, id: Number(id), why: why[Number(id)] || '其他' };
      });
    },

    /**
     * 只读电源状态（auto 的**唯一判据**，轻量：一次 pwsh 调用 ≈ 1 s）。
     * 返回 { ac, percent }；读不到返回 null（**不许**把"读不到"当成"拔电"——那会在电流抖动时误退保护）。
     * ac: 1 = 插电 / 0 = 电池 / 255 = 未知（kernel32 的 ACLineStatus 语义）。
     */
    readAc() {
      const r = this.run(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', POWER_STATUS_PS]);
      if (r.code !== 0 || !r.out.trim()) return null;
      try {
        const j = JSON.parse(r.out.trim());
        return { ac: Number(j.ac), percent: Number(j.percent) };
      } catch { return null; }
    },

    health() {
      const out = {};
      try {
        // 是否插电必须用 kernel32 GetSystemPowerStatus：Win32_Battery.BatteryStatus 语义混乱
        // (2=Unknown，很多机器插电时也返回 2)，root/wmi 的 PowerOnline 本机直接给出 False，同样误导。
        // （口径真源 = 模块级 POWER_STATUS_PS，与 readAc() 共用同一段）
        const r = this.run(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', POWER_STATUS_PS]);
        if (r.code === 0 && r.out.trim()) out.battery = JSON.parse(r.out.trim());
      } catch { /* ignore */ }
      try {
        const r = this.run(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command',
          "Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings' -ErrorAction SilentlyContinue | Select-Object ActiveHoursStart,ActiveHoursEnd | ConvertTo-Json -Compress"]);
        if (r.code === 0 && r.out.trim()) out.activeHours = JSON.parse(r.out.trim());
      } catch { /* ignore */ }
      try {
        const r = this.run(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command',
          "@(Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'), @(Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -join ','"]);
        out.pendingReboot = /True/i.test(r.out);
      } catch { /* ignore */ }
      return out;
    },

    /** 读 Windows 更新「活动时间」；null = 读不到（键缺失或命令失败） */
    readActiveHours() {
      const out = {};
      for (const name of ['ActiveHoursStart', 'ActiveHoursEnd']) {
        const r = this.run('reg', ['query', WU_UX_KEY, '/v', name]);
        if (r.code !== 0) return null;
        const m = r.out.match(/REG_DWORD\s+0x([0-9a-f]+)/i);
        if (!m) return null;
        out[name] = parseInt(m[1], 16);
      }
      return { start: out.ActiveHoursStart, end: out.ActiveHoursEnd };
    },

    /** 写活动时间（普通权限即可，实测 reg add rc=0）；ok 只代表命令成功，调用方必须回读复核 */
    writeActiveHours(start, end) {
      const a = this.run('reg', ['add', WU_UX_KEY, '/v', 'ActiveHoursStart', '/t', 'REG_DWORD', '/d', String(start), '/f']);
      const b = this.run('reg', ['add', WU_UX_KEY, '/v', 'ActiveHoursEnd', '/t', 'REG_DWORD', '/d', String(end), '/f']);
      return {
        ok: a.code === 0 && b.code === 0,
        steps: [a.code, b.code],
        err: (a.err || b.err || a.error || b.error || '').replace(/\s+/g, ' ').trim(),
      };
    },

    /** 读策略值；null = 这个值从来没设过（off 时据此决定「删掉」还是「写回原值」） */
    readWuPolicy() {
      const r = this.run('reg', ['query', WU_AU_KEY, '/v', WU_VALUE]);
      if (r.code !== 0) return null;
      const m = r.out.match(/REG_DWORD\s+0x([0-9a-f]+)/i);
      return m ? parseInt(m[1], 16) : null;
    },

    /** 写策略值（**需管理员**：普通权限实测 rc=1 拒绝访问） */
    writeWuPolicy(value) {
      const r = this.run('reg', ['add', WU_AU_KEY, '/v', WU_VALUE, '/t', 'REG_DWORD', '/d', String(value), '/f']);
      return { ok: r.code === 0, err: (r.err || r.error || '').replace(/\s+/g, ' ').trim() };
    },

    /** 删策略值（需管理员；调用方先用 readWuPolicy() 判断是否真的存在，避免把「本来就没有」当失败） */
    deleteWuPolicy() {
      const r = this.run('reg', ['delete', WU_AU_KEY, '/v', WU_VALUE, '/f']);
      return { ok: r.code === 0, err: (r.err || r.error || '').replace(/\s+/g, ' ').trim() };
    },

    /** 读 tickd job `relay` 的开关现状（只读；available=false = 本机没有大管家组件） */
    readRelayJob() {
      if (!relayLib) return { available: false, enabled: false, source: null };
      const r = relayLib.isTickJobEnabled(RELAY_JOB_ID, { home: STATE_DIR });
      return { available: true, enabled: r.enabled === true, source: r.source ?? null, why: r.why ?? null, by: r.by ?? null };
    },

    /**
     * 写 tickd job `relay` 开关。走大管家 `setJobEnabled`（RMW 锁 + 原子写 + 审计 + jobHistory），
     * **绝不手改 butler-autonomy.json**。why 必填（开关变更必须可溯源）。
     */
    setRelayJob(enabled, why) {
      if (!relayLib) return { ok: false, err: '本机没有大管家组件（tools/dsh-butler/lib/autonomy-modules.mjs）' };
      const r = relayLib.setJobEnabled(RELAY_JOB_ID, enabled, { home: STATE_DIR, by: 'overnight-mode', why });
      return { ok: r.ok === true, err: r.ok ? '' : String(r.error ?? '写入失败') };
    },
  };
}

// ---------------------------------------------------------------- 核心逻辑(可注入 deps 做单测)
function readProtectedState(deps) {
  const values = deps.readValues();
  const plans = deps.listPlans();
  const rows = [];
  for (const p of plans) {
    const row = { guid: p.guid, name: p.name, active: p.active, items: {} };
    let complete = true;
    for (const s of SETTINGS) {
      const ac = values[p.guid]?.AC?.[s.id];
      const dc = values[p.guid]?.DC?.[s.id];
      row.items[s.name] = { ac, dc };
      if (ac === undefined || dc === undefined) complete = false;
    }
    row.complete = complete;
    rows.push(row);
  }
  return { plans, rows };
}

function allZero(rows) {
  const bad = [];
  for (const row of rows) {
    for (const s of SETTINGS) {
      const v = row.items[s.name];
      if (v.ac !== 0 || v.dc !== 0) bad.push(`${row.name}/${s.name}=${v.ac}/${v.dc}`);
    }
  }
  return bad;
}

/**
 * 屏保三项是否落在保护值（0/0/0）。返回不合规清单（空 = 合规）。
 * ⚠ 读不到（null/undefined）**也算不合规**——口径与 tools/overnight-guard-check.mjs 的 T10 一致：
 * 「读不到」不许判绿，否则会被当成「已关」，正是本函数要堵的假绿。
 */
function screensaverNotProtected(ss) {
  const bad = [];
  for (const name of SCREENSAVER_VALUES) {
    const raw = ss ? ss[name] : undefined;
    const v = raw === null || raw === undefined ? null : String(raw).trim();
    if (v === null || v === '') bad.push(`${name}=读不到`);
    else if (v !== SCREENSAVER_TARGETS[name]) bad.push(`${name}=${v}`);
  }
  return bad;
}

/** 只读探测屏保三项现状（供 status 判据 / on 幂等判据 / 写后复核复用） */
function readScreensaverState(deps) {
  let values = null;
  try { values = deps.readScreensaver(); } catch { values = null; }
  const bad = screensaverNotProtected(values);
  return { values, bad, ok: bad.length === 0 };
}

/**
 * 屏保 3 项（防锁屏）：**写 + 回读复核**。走 HKCU 用户级注册表（普通权限即可；HKCU 是本用户拥有的键）。
 * ⚠ 设不了（组策略 / 公司 EDR 锁住）⇒ **如实报 failed 并只告警，不算失败、不阻塞开启**；
 *   绝不静默、绝不谎报「已设」——写入成功 ≠ 真关掉，所以一律回读复核。
 * @returns {{status:'ok'|'failed'|'dry-run', bad:string[], notes:string[], values:object|null}}
 */
function applyScreensaverGuard(deps, { dryRun }) {
  if (dryRun) return { status: 'dry-run', bad: [], notes: [], values: null };
  let wrote = [];
  try { wrote = deps.writeScreensaver(SCREENSAVER_TARGETS) || []; }
  catch (e) { wrote = [{ name: '(writeScreensaver)', ok: false, err: String(e?.message ?? e) }]; }
  const errs = wrote.filter((x) => !x.ok)
    .map((x) => `${x.name ?? '?'}${x.err ? `(${String(x.err).replace(/\s+/g, ' ').trim().slice(0, 120)})` : ''}`);
  const now = readScreensaverState(deps);
  if (now.ok) return { status: 'ok', bad: [], notes: [], values: now.values };
  return {
    status: 'failed',
    bad: now.bad,
    values: now.values,
    notes: [
      `屏保 3 项未全为 0（当前 ${now.bad.join(' ')}）${errs.length ? `；写入报错：${errs.join(' ')}` : ''}`,
      `需要管理员/被策略锁：HKCU\\Control Panel\\Desktop 的 ${SCREENSAVER_VALUES.join(' / ')}（普通权限写 HKCU 通常可行，失败多为组策略/EDR 锁）`,
      '手动一条命令（普通 PowerShell 即可）：reg add "HKCU\\Control Panel\\Desktop" /v ScreenSaveActive /t REG_SZ /d 0 /f　（另两项把 /v 换成 ScreenSaveTimeOut、ScreenSaverIsSecure）',
    ],
  };
}

/** 只读复核屏保（不写）——供 on 的「已在保护中」判据与售后告警复用 */
function verifyScreensaverGuard(deps) {
  const now = readScreensaverState(deps);
  if (now.ok) return { status: 'ok', bad: [], notes: [], values: now.values };
  return {
    status: 'failed',
    bad: now.bad,
    values: now.values,
    notes: [
      `屏保 3 项未全为 0（当前 ${now.bad.join(' ')}）⇒ 屏保仍可能锁屏`,
      `需要管理员/被策略锁（只告警、不判失败、不阻塞开启）：HKCU\\Control Panel\\Desktop 的 ${SCREENSAVER_VALUES.join(' / ')}`,
      '手动一条命令（普通 PowerShell 即可）：reg add "HKCU\\Control Panel\\Desktop" /v ScreenSaveActive /t REG_SZ /d 0 /f　（另两项把 /v 换成 ScreenSaveTimeOut、ScreenSaverIsSecure）',
    ],
  };
}

/** 屏保结果打成人话（on 主流程 / 补做路径共用） */
function reportScreensaverGuard(res) {
  const label = {
    ok: '✓ 已关闭（Active=0 TimeOut=0 IsSecure=0）',
    failed: '⚠ 未能设成 0（只告警，不阻塞插电保护）',
    'dry-run': '(dry-run) 未执行',
  };
  log(`      屏保（防锁屏）：${label[res.status] || res.status}`);
  for (const n of res.notes || []) log(`        ↳ ${n}`);
}

function snapshot(deps) {
  const { plans, rows } = readProtectedState(deps);
  const values = {};
  for (const row of rows) {
    values[row.guid] = {};
    for (const s of SETTINGS) values[row.guid][s.name] = { ac: row.items[s.name].ac, dc: row.items[s.name].dc };
  }
  return {
    schemaVersion: 1,
    tool: `overnight-mode.mjs v${VERSION}`,
    host: deps.host,
    createdAt: deps.now().toISOString(),
    activePlan: (plans.find((p) => p.active) || {}).guid || null,
    plans: plans.map((p) => ({ guid: p.guid, name: p.name })),
    values,
    screensaver: deps.readScreensaver(),
    // WU 加固前的原值：活动时间窗口 + 策略值（null = 原本没设过）。off 时据此逐条还原
    wu: { activeHours: deps.readActiveHours(), policy: deps.readWuPolicy() },
    wuGuard: false,
    // 会话接力 job 放行前的原值（由 planRelayJob 现场读取后填；null = 本次没做接力联动）
    relayJob: null,
    restoredAt: null,
  };
}

/**
 * 堵住「Windows 更新夜里自动重启」。两层：L1 活动时间（普通权限）/ L2 组策略（需管理员）。
 * 返回 { window, layer1, layer2, admin, notes }；层状态取值 ok | failed | need-admin | nothing | skipped | dry-run
 */
function applyWuGuard(deps, state, { wuWindow, dryRun }) {
  const w = wuWindow || WU_WINDOW_DEFAULT;
  const res = { window: w, layer1: 'skipped', layer2: 'skipped', admin: false, notes: [] };
  // 老状态文件（v1.0.0 写的）没有 wu 备份块：现场读一次原值补上，否则 off 会还原不了活动时间
  if (!state.wu || !state.wu.activeHours) {
    state.wu = { ...(state.wu || {}), activeHours: deps.readActiveHours(), policy: deps.readWuPolicy() };
  }
  if (dryRun) { res.layer1 = 'dry-run'; res.layer2 = 'dry-run'; return res; }

  // L1：活动时间 —— 把整夜圈进「活动时间」，Windows 不会在这段时间自动重启
  const wr = deps.writeActiveHours(w.start, w.end);
  const back = deps.readActiveHours();
  if (wr.ok && back && back.start === w.start && back.end === w.end) res.layer1 = 'ok';
  else {
    res.layer1 = 'failed';
    res.notes.push(`活动时间写入未生效${wr.err ? `：${wr.err}` : ''}`);
  }

  // L2：组策略 —— 只要有用户登录就绝不自动重启（需管理员；非管理员不当作失败，只提示）
  res.admin = deps.isAdmin();
  if (res.admin) {
    const pr = deps.writeWuPolicy(1);
    res.layer2 = pr.ok ? 'ok' : 'failed';
    if (!pr.ok) res.notes.push(`策略写入失败${pr.err ? `：${pr.err}` : ''}`);
  } else {
    res.layer2 = 'need-admin';
  }

  state.wu.window = w;
  state.wu.appliedAt = deps.now().toISOString();
  state.wuGuard = res.layer1 === 'ok' || res.layer2 === 'ok';
  return res;
}

/**
 * WU 加固是否已经做到「本机权限能做到的最好」。
 * ⚠ 不能只看 state.wuGuard：L1 成功就会把它置 true，而 L2 要管理员才做得成 ——
 * 2026-09-17 实测踩到：非管理员先跑 on（L1 成、L2 没做），之后管理员再跑却被
 * already-on 挡住，L2 永远补不上。所以这里回读真实状态来判断。
 */
function isWuGuardComplete(deps, state) {
  if (!state.wu || state.wuGuard !== true) return false;
  const win = state.wu.window || WU_WINDOW_DEFAULT;
  const ah = deps.readActiveHours();
  if (!ah || ah.start !== win.start || ah.end !== win.end) return false;  // L1 没对齐
  if (deps.readWuPolicy() === 1) return true;                             // L2 已生效
  return !deps.isAdmin();                                                 // 非管理员：L2 本机做不到，到此为止
}

/** off：按 state.wu 备份还原（活动时间写回原值；策略值原本没设过就删掉、设过就写回原值） */
function restoreWuGuard(deps, state, { dryRun }) {
  const res = { layer1: 'skipped', layer2: 'skipped', notes: [] };
  const bak = state.wu;
  if (!bak || !bak.activeHours) {
    res.layer1 = 'nothing';
    res.layer2 = 'nothing';
    res.notes.push('状态文件里没有 WU 加固备份（未加固过或旧版工具写的），活动时间与策略都不动');
    return res;
  }
  if (dryRun) { res.layer1 = 'dry-run'; res.layer2 = 'dry-run'; return res; }

  const ar = deps.writeActiveHours(bak.activeHours.start, bak.activeHours.end);
  res.layer1 = ar.ok ? 'ok' : 'failed';
  if (!ar.ok) res.notes.push(`活动时间还原失败${ar.err ? `：${ar.err}` : ''}`);

  // 先看当前有没有值：本来就没有 → 没什么可删，别把「不存在」误报成失败
  const cur = deps.readWuPolicy();
  if (!deps.isAdmin()) {
    res.layer2 = cur === null ? 'nothing' : 'need-admin';
  } else if (cur === null) {
    res.layer2 = 'nothing';
  } else if (bak.policy === null || bak.policy === undefined) {
    const dr = deps.deleteWuPolicy();
    res.layer2 = dr.ok ? 'ok' : 'failed';
    if (!dr.ok) res.notes.push(`策略删除失败${dr.err ? `：${dr.err}` : ''}`);
  } else {
    const pr = deps.writeWuPolicy(bak.policy);
    res.layer2 = pr.ok ? 'ok' : 'failed';
    if (!pr.ok) res.notes.push(`策略还原失败${pr.err ? `：${pr.err}` : ''}`);
  }
  return res;
}

/** 把 WU 加固结果打印成人话（on/off 共用；mode='off' 时用「还原」措辞） */
function reportWuGuard(res, mode = 'on') {
  const off = mode === 'off';
  const L1 = off
    ? { ok: '✓ 已写回原值', failed: '✗ 写回失败', 'need-admin': '— 需管理员', nothing: '— 无需处理', skipped: '— 已跳过', 'dry-run': '(dry-run) 未执行' }
    : { ok: '✓ 已生效', failed: '✗ 未生效', 'need-admin': '— 需管理员', nothing: '— 无需处理', skipped: '— 已跳过', 'dry-run': '(dry-run) 未执行' };
  const L2 = off
    ? { ok: '✓ 已还原', failed: '✗ 还原失败', 'need-admin': '⚠ 需管理员，本次没做成', nothing: '— 原本没设过，无需处理', skipped: '— 已跳过', 'dry-run': '(dry-run) 未执行' }
    : { ok: '✓ 已生效', failed: '✗ 未生效', 'need-admin': '⚠ 需管理员，本次没做成', nothing: '— 无需处理', skipped: '— 已跳过', 'dry-run': '(dry-run) 未执行' };
  const w = res.window || WU_WINDOW_DEFAULT;
  log(off ? '      Windows 更新防重启加固：撤销结果' : '      Windows 更新防重启加固：');
  log(`        L1 活动时间：${L1[res.layer1] || res.layer1}　（加固窗口 ${w.start}:00 → 次日 ${w.end}:00）`);
  log(`        L2 组策略：${L2[res.layer2] || res.layer2}　（有人登录时禁止自动重启，硬保险）`);
  if (res.layer2 === 'need-admin' && !off) {
    log('        ↳ 想补 L2 就双击「桌面\\DSH鲸落地\\DSH插电保护.cmd」（它会自己弹 UAC，点一下「是」）');
  }
  for (const n of res.notes || []) log(`        ⚠ ${n}`);
  if (!off && (res.layer1 === 'failed' || res.layer2 === 'failed')) log('        ⚠ 有层没做成 → 夜里仍有被自动重启打断的可能');
}

/**
 * 第一段（**只读** + 把现状记进 `state.relayJob`）：算出放行计划，供状态文件落盘后执行。
 * 为什么拆两段：备份必须先落地、再动开关 —— 这样即使中途失败/被 Ctrl-C 打断，
 * `off` 也能凭备份把开关还原（比 WU 层「先动作后写盘」的老顺序更稳，故 relay 这层不照抄）。
 * @returns {{status:'pending'|'already'|'skipped', before:boolean|null, after:boolean|null, notes:string[], doApply:boolean}}
 */
function planRelayJob(deps, state, { noRelay }) {
  const plan = { status: 'skipped', before: null, after: null, notes: [], doApply: false };
  if (noRelay) { plan.notes.push('按 --no-relay 跳过'); return plan; }
  const cur = deps.readRelayJob ? deps.readRelayJob() : null;
  if (!cur || cur.available === false) {
    plan.notes.push('本机没有大管家组件（tools/dsh-butler/）⇒ 不碰 job 开关');
    return plan;
  }
  // 老状态文件（v1.1.0 及以前）没有 relayJob 块：现场读一次原值补上，否则 off 还原不了
  if (!state.relayJob || typeof state.relayJob.enabled !== 'boolean') {
    state.relayJob = { enabled: cur.enabled === true, source: cur.source ?? null, at: deps.now().toISOString() };
  }
  plan.before = state.relayJob.enabled;
  if (cur.enabled === true) { plan.status = 'already'; plan.after = true; return plan; }
  plan.doApply = true;
  plan.status = 'pending';
  return plan;
}

/** 第二段（**状态文件落盘之后**调用）：真正放行 + 回读复核（写入成功 ≠ job 侧读到 true） */
function commitRelayJob(deps, plan, { dryRun }) {
  if (!plan || plan.doApply !== true) return plan;
  if (dryRun) { plan.status = 'dry-run'; return plan; }
  const w = deps.setRelayJob(true, RELAY_JOB_WHY_ON);
  if (!w.ok) { plan.status = 'failed'; plan.notes.push(`放行失败：${w.err}`); return plan; }
  const back = deps.readRelayJob ? deps.readRelayJob() : null;
  if (back && back.available !== false && back.enabled !== true) {
    plan.status = 'failed'; plan.after = false;
    plan.notes.push('写入后回读仍是「关」⇒ 判失败（别当成已放行就去睡）');
    return plan;
  }
  plan.status = 'ok';
  plan.after = true;
  return plan;
}

/** off：按 `state.relayJob` 备份还原（开之前本来就放行的 → 保持放行，不关回） */
function restoreRelayJob(deps, state, { dryRun }) {
  const res = { status: 'skipped', notes: [] };
  const bak = state.relayJob;
  if (!bak || typeof bak.enabled !== 'boolean') {
    res.status = 'nothing';
    res.notes.push('状态文件里没有 job 备份（旧版工具写的）⇒ 开关不动');
    return res;
  }
  const cur = deps.readRelayJob ? deps.readRelayJob() : null;
  if (!cur || cur.available === false) { res.notes.push('本机没有大管家组件 ⇒ 开关不动'); return res; }
  if (bak.enabled === true) { res.status = 'nothing'; res.notes.push('开插电保护前它就是放行的 ⇒ 保持放行（不关回）'); return res; }
  if (cur.enabled === false) { res.status = 'nothing'; res.notes.push('当前已是「关」'); return res; }
  if (dryRun) { res.status = 'dry-run'; return res; }

  const w = deps.setRelayJob(false, RELAY_JOB_WHY_OFF);
  if (!w.ok) { res.status = 'failed'; res.notes.push(`关回失败：${w.err}`); return res; }
  const back = deps.readRelayJob ? deps.readRelayJob() : null;
  if (back && back.available !== false && back.enabled === true) {
    res.status = 'failed'; res.notes.push('关回后回读仍是「开」⇒ 判失败');
    return res;
  }
  res.status = 'ok';
  return res;
}

/**
 * 接力联动是否已做到位（供 doOn 的「已处于整夜模式」补做判据用，同 isWuGuardComplete 的思路）：
 * 已备份原值 **且** 现在确实是放行态；原本就放行的、本机没有大管家组件的都算「做到位」。
 */
function isRelayJobAligned(deps, state) {
  if (!state.relayJob || typeof state.relayJob.enabled !== 'boolean') return false;
  if (state.relayJob.enabled === true) return true;
  const cur = deps.readRelayJob ? deps.readRelayJob() : null;
  if (!cur || cur.available === false) return true;
  return cur.enabled === true;
}

/** 把接力 job 联动结果打印成人话（on/off 共用；mode='off' 用「还原」措辞） */
function reportRelayJob(res, mode = 'on') {
  const off = mode === 'off';
  const label = {
    ok: off ? '✓ 已按备份还原' : '✓ 已放行（无人值守自动交接）',
    already: '— 原本就是放行的，未改动',
    nothing: '— 无需改动',
    skipped: '— 已跳过',
    'dry-run': '(dry-run) 未执行',
    failed: off ? '✗ 还原失败' : '✗ 放行失败',
  };
  log(`      会话接力 job（${RELAY_JOB_ID}）：${label[res.status] || res.status}`
    + (res.before === null || res.before === undefined ? '' : `　（原值 ${res.before ? '放行' : '关'}）`));
  for (const n of res.notes || []) log(`        ↳ ${n}`);
}

function applyProtection(deps, state, { dryRun }) {
  const actions = [];
  for (const plan of state.plans) {
    for (const s of SETTINGS) {
      for (const mode of ['ac', 'dc']) {
        if (dryRun) { actions.push({ plan: plan.name, setting: s.name, mode, value: 0, dryRun: true }); continue; }
        const r = deps.setValue(plan.guid, s.sub, s.id, mode, 0);
        actions.push({ plan: plan.name, setting: s.name, mode, value: 0, ok: r.ok, err: r.ok ? '' : r.err });
      }
    }
  }
  let activeOk = null;
  if (state.activePlan && !dryRun) activeOk = deps.setActivePlan(state.activePlan).ok;
  const ssTargets = SCREENSAVER_TARGETS;
  const ss = dryRun ? SCREENSAVER_VALUES.map((n) => ({ name: n, value: ssTargets[n], dryRun: true })) : deps.writeScreensaver(ssTargets);
  // 写入成功 ≠ 真关掉（可能被组策略 / EDR 锁）⇒ 一律回读复核；设不了只告警、不判失败（见 applyScreensaverGuard）
  const screensaverGuard = dryRun ? { status: 'dry-run', bad: [], notes: [], values: null } : verifyScreensaverGuard(deps);
  return { actions, activeOk, screensaver: ss, screensaverGuard };
}

function restoreFromState(deps, state, { dryRun }) {
  const actions = [];
  const missing = new Set(deps.listPlans().map((p) => p.guid));
  for (const plan of state.plans) {
    if (!missing.has(plan.guid)) { actions.push({ plan: plan.name, skipped: true, reason: '该电源方案已不存在' }); continue; }
    for (const s of SETTINGS) {
      const want = state.values[plan.guid]?.[s.name];
      if (!want) continue;
      for (const mode of ['ac', 'dc']) {
        const v = want[mode];
        if (v === undefined || v === null) continue;
        if (dryRun) { actions.push({ plan: plan.name, setting: s.name, mode, value: v, dryRun: true }); continue; }
        const r = deps.setValue(plan.guid, s.sub, s.id, mode, v);
        actions.push({ plan: plan.name, setting: s.name, mode, value: v, ok: r.ok, err: r.ok ? '' : r.err });
      }
    }
  }
  if (state.activePlan) deps.setActivePlan(state.activePlan);
  const ss = dryRun ? Object.entries(state.screensaver).map(([name, value]) => ({ name, value, dryRun: true })) : deps.writeScreensaver(state.screensaver);
  return { actions, screensaver: ss };
}

function verifyRestored(rows, state) {
  const bad = [];
  for (const row of rows) {
    const want = state.values[row.guid];
    if (!want) continue;
    for (const s of SETTINGS) {
      const w = want[s.name];
      const got = row.items[s.name];
      if (!w) continue;
      if (w.ac !== got.ac || w.dc !== got.dc) bad.push(`${row.name}/${s.name}: 期望 ${w.ac}/${w.dc}, 实得 ${got.ac}/${got.dc}`);
    }
  }
  return bad;
}

function doOn(deps, opts) {
  const file = deps.stateFile(deps.host);
  if (fs.existsSync(file) && !opts.force) {
    let prev = null;
    try { prev = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* ignore */ }
    if (prev && !prev.restoredAt) {
      const { rows } = readProtectedState(deps);
      const bad = allZero(rows);
      // 屏保 3 项也进「是否已在保护中」判据（2026-10-08）：旧版只看电源 7 项 ⇒ 屏保漂移后
      // 这里会早退成 already-on，屏保**再也没有纠正路径**（实测：只能靠主人手动 on 顺带改回来）。
      const ssState = readScreensaverState(deps);
      if (!bad.length) {
        // 电源部分已在保护中：再看 WU 加固 / 接力 job / 屏保做没做，没做就补上（绝不覆盖电源备份）
        // 判据不能只看 wuGuard（L1 成功就会置 true）：L2 可能要等管理员再来一次才做得成，
        // 详见 isWuGuardComplete 的注释（2026-09-17 实测踩到的坑）
        const wuDone = opts.noWu || isWuGuardComplete(deps, prev);
        const relayDone = opts.noRelay || isRelayJobAligned(deps, prev);
        const ssDone = ssState.ok;
        if (wuDone && relayDone && ssDone) {
          log(`已处于保护中（自 ${new Date(prev.createdAt).toLocaleString('zh-CN')}），未重复备份。`);
          log('（要重新对齐备份值请加 --force）');
          return { exit: EXIT.OK, result: { status: 'already-on', since: prev.createdAt, stateFile: file, wuGuard: prev.wuGuard === true, relayJob: prev.relayJob ?? null, screensaver: ssState } };
        }
        log(`已处于保护中（自 ${new Date(prev.createdAt).toLocaleString('zh-CN')}），电源设置未重复备份。`);
        let wu = null;
        if (!wuDone) {
          log('[补做] Windows 更新防重启加固（不碰已有电源备份）…');
          wu = applyWuGuard(deps, prev, { wuWindow: opts.wuWindow, dryRun: opts.dryRun });
          reportWuGuard(wu);
        } else log('[补做] Windows 更新防重启加固：已到位，跳过');
        const relayPlan = relayDone ? null : planRelayJob(deps, prev, { noRelay: opts.noRelay });
        if (!relayDone) log('[补做] 会话接力 job 放行（不碰已有电源备份）…');
        else log('[补做] 会话接力 job：已到位，跳过');
        if (!opts.dryRun) { writeFileAtomic(file, JSON.stringify(prev, null, 2)); log(`      状态文件已补记原值备份（WU / 接力 job）：${file}`); }
        const relay = relayPlan ? commitRelayJob(deps, relayPlan, { dryRun: opts.dryRun }) : null;
        if (relay) reportRelayJob(relay);
        // 屏保补做：写 + 回读复核；设不了只告警、不判失败（屏保属「能设就设，设不了报 need-admin」那档）
        let ssGuard = null;
        if (!ssDone) {
          log('[补做] 屏保 3 项（防锁屏）…');
          ssGuard = applyScreensaverGuard(deps, { dryRun: opts.dryRun });
          reportScreensaverGuard(ssGuard);
        } else log('[补做] 屏保：已到位，跳过');
        const wuBad = !!wu && (wu.layer1 === 'failed' || wu.layer2 === 'failed');
        const relayBad = !!relay && relay.status === 'failed';
        return {
          exit: (wuBad || relayBad) ? EXIT.ERROR : EXIT.OK,
          result: {
            status: (wuDone && relayDone) ? 'screensaver-applied' : 'wu-applied',
            since: prev.createdAt, stateFile: file, wuGuard: wu, relayJob: relay, screensaverGuard: ssGuard,
            failed: (wuBad ? 1 : 0) + (relayBad ? 1 : 0),
          },
        };
      }
      log(`发现保护状态文件，但 ${bad.length} 处设置不是 0（可能被手动改过）：${bad.slice(0, 3).join(' ')}`);
      log('改为按现有文件重新应用保护（不覆盖备份）…');
      const r = applyProtection(deps, prev, { dryRun: opts.dryRun });
      return { exit: EXIT.OK, result: { status: 'reapplied', since: prev.createdAt, stateFile: file, applied: r.actions.length } };
    }
  }

  log('=== 正在进入插电保护 ===');
  log('[1/5] 备份当前电源设置…');
  const state = snapshot(deps);
  log(`      方案 ${state.plans.length} 个 × ${SETTINGS.length} 项 × AC/DC = ${state.plans.length * SETTINGS.length * 2} 条备份值`);
  let wuRes = null;
  if (opts.noWu) log('      Windows 更新防重启加固：已按 --no-wu 跳过');
  else {
    wuRes = applyWuGuard(deps, state, { wuWindow: opts.wuWindow, dryRun: opts.dryRun });
    reportWuGuard(wuRes);
  }
  // 会话接力 job：先只读地备份原值（已进 state），状态文件落盘**之后**才真放行 ——
  // 备份先于动作，中途失败/被打断也能靠 off 还原（详见 planRelayJob 注释）
  const relayPlan = planRelayJob(deps, state, { noRelay: opts.noRelay });
  if (!opts.dryRun) { writeFileAtomic(file, JSON.stringify(state, null, 2)); log(`[2/5] 状态文件已写：${file}`); }
  else log(`[2/5] (dry-run) 本应写状态文件：${file}`);
  const relayRes = commitRelayJob(deps, relayPlan, { dryRun: opts.dryRun });
  reportRelayJob(relayRes);

  log('[3/5] 应用保护（全部改 0 = 永不）…');
  const applied = applyProtection(deps, state, { dryRun: opts.dryRun });
  const failed = applied.actions.filter((a) => a.ok === false);
  log(opts.dryRun
    ? `      (dry-run) 将写入 ${applied.actions.length} 条，未真正执行`
    : `      写入 ${applied.actions.length} 条${failed.length ? `, 失败 ${failed.length} 条` : ', 全部成功'}`);
  reportScreensaverGuard(applied.screensaverGuard);

  log('[4/5] 复核（重新读数验证）…');
  let bad = [];
  if (!opts.dryRun) {
    const { rows } = readProtectedState(deps);
    bad = allZero(rows);
    log(bad.length ? `      ⚠ ${bad.length} 项未生效` : `      ✓ ${rows.length} 个方案 × ${SETTINGS.length} 项 全部为 0`);
  } else log('      (dry-run) 跳过复核');

  log('[5/5] 环境体检…');
  const h = opts.dryRun ? {} : deps.health();
  if (h.battery) {
    const ac = h.battery.ac === 1 ? '已接电源' : (h.battery.ac === 0 ? '⚠ 电池供电' : '未知');
    log(`      电源：${ac}，电量 ${h.battery.percent}%`);
    if (h.battery.ac === 0) log('      🔴 警告：现在没插电源！整夜跑任务会在电池耗尽时断电中断，请插上充电器。');
  }
  if (h.activeHours) log(`      更新活动时间：${h.activeHours.ActiveHoursStart}:00 → ${h.activeHours.ActiveHoursEnd}:00（这段时间内 Windows 不会自动重启）`);
  log(`      更新待重启：${h.pendingReboot ? '⚠ 有（重启只会在活动时间之外尝试，已被上面的加固挡住）' : '无'}`);

  log('');
  if (applied.screensaverGuard.status === 'failed') {
    log('插电保护已开启（电源 7 项全 0）。⚠ 屏保 3 项没能关掉 —— 屏保仍可能锁屏，见上面的 ⚠ 行。');
  } else {
    log('插电保护已开启：不会空闲睡眠 / 休眠 / 关屏 / 关硬盘 / 合盖不动作 / 屏保已关。');
  }
  if (wuRes && wuRes.layer1 === 'ok') {
    log(`Windows 更新防重启：活动时间已设 ${wuRes.window.start}:00 → 次日 ${wuRes.window.end}:00${wuRes.layer2 === 'ok' ? ' ＋ 组策略硬保险' : '（组策略那层要管理员，双击「桌面\\DSH鲸落地\\DSH插电保护.cmd」可补）'}。`);
  }
  if (relayRes && relayRes.status === 'ok') {
    log(`会话接力 job：已放行 —— 无人值守时也会自动把快干满的会话交接给新会话（每 5 分钟一轮）。`);
  }
  log(`恢复：node ${process.argv[1]} off`);
  const wuFailed = !!wuRes && (wuRes.layer1 === 'failed' || wuRes.layer2 === 'failed');
  const relayFailed = !!relayRes && relayRes.status === 'failed';
  return {
    exit: failed.length || bad.length || wuFailed || relayFailed ? EXIT.ERROR : EXIT.OK,
    result: { status: opts.dryRun ? 'dry-run' : 'on', stateFile: file, wrote: applied.actions.length, failed: failed.length, notZero: bad, screensaverGuard: applied.screensaverGuard, screensaverNotZero: applied.screensaverGuard.bad, health: h, wuGuard: wuRes, relayJob: relayRes ?? null, createdAt: state.createdAt },
  };
}

function doOff(deps, opts) {
  const file = deps.stateFile(deps.host);
  if (!fs.existsSync(file)) {
    log(`找不到状态文件：${file}`);
    log('可能从未开过插电保护；若之前是手工改的，用：adopt --import-from <备份目录>');
    return { exit: EXIT.USAGE, result: { status: 'no-state', stateFile: file } };
  }
  let state;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    log(`状态文件损坏：${e.message}`);
    return { exit: EXIT.ERROR, result: { status: 'bad-state', stateFile: file } };
  }
  if (String(state.host).toLowerCase() !== String(deps.host).toLowerCase() && !opts.force) {
    log(`状态文件属于另一台机器（${state.host}），本机是 ${deps.host}；拒绝执行（防误恢复）。`);
    return { exit: EXIT.HOST_MISMATCH, result: { status: 'host-mismatch', stateHost: state.host, host: deps.host } };
  }
  if (state.restoredAt && !opts.force) {
    log(`这份状态已在 ${new Date(state.restoredAt).toLocaleString('zh-CN')} 恢复过；如确认要再恢复一次请加 --force。`);
    return { exit: EXIT.OK, result: { status: 'already-off', restoredAt: state.restoredAt } };
  }

  log('=== 正在恢复正常电源设置 ===');
  log(`[1/5] 按备份写回（备份时间 ${new Date(state.createdAt).toLocaleString('zh-CN')}）…`);
  const r = restoreFromState(deps, state, { dryRun: opts.dryRun });
  const failed = r.actions.filter((a) => a.ok === false);
  const skipped = r.actions.filter((a) => a.skipped);
  const written = r.actions.filter((a) => !a.skipped).length;
  log(opts.dryRun
    ? `      (dry-run) 将写回 ${written} 条，未真正执行${skipped.length ? `，跳过 ${skipped.length} 条(${skipped[0].reason})` : ''}`
    : `      写入 ${written} 条${failed.length ? `，失败 ${failed.length} 条` : '，全部成功'}${skipped.length ? `，跳过 ${skipped.length} 条(${skipped[0].reason})` : ''}`);

  log('[2/5] 复核…');
  let bad = [];
  if (!opts.dryRun) {
    const { rows } = readProtectedState(deps);
    bad = verifyRestored(rows, state);
    log(bad.length ? `      ⚠ ${bad.length} 项与原值不符` : '      ✓ 已逐项回到改动前的值');
  } else log('      (dry-run) 跳过复核');

  let wuRestore = null;
  if (state.wuGuard === true || state.wu?.activeHours) {
    log('[3/5] Windows 更新防重启加固：按备份还原…');
    wuRestore = restoreWuGuard(deps, state, { dryRun: opts.dryRun });
    reportWuGuard({ ...wuRestore, window: state.wu?.window || WU_WINDOW_DEFAULT }, 'off');
    if (wuRestore.layer2 === 'need-admin') log('        ↳ 双击「桌面\\DSH鲸落地\\DSH关插电保护.cmd」会自动 UAC 提权，把策略那层一起撤掉');
  } else log('[3/5] Windows 更新防重启加固：本机没加固过，跳过');

  log('[4/5] 会话接力 job：按备份还原…');
  const relayRestore = restoreRelayJob(deps, state, { dryRun: opts.dryRun });
  reportRelayJob(relayRestore, 'off');

  if (!opts.dryRun && !opts.noEvents) {
    log('[5/5] 夜间中断记录（睡眠/唤醒/重启）…');
    const ev = deps.wakeEvents(state.createdAt);
    if (ev === null) log('      (事件日志不可读)');
    else if (!ev.length) log('      ✓ 未发现睡眠或重启事件——整夜没有被中断');
    else for (const e of ev) log(`      ${e.time}  ${e.why}(id=${e.id})`);
  } else log('[5/5] 跳过事件检查');

  if (!opts.dryRun) {
    state.restoredAt = deps.now().toISOString();
    writeFileAtomic(file, JSON.stringify(state, null, 2));
  }

  log('');
  log('已恢复正常（睡眠/关屏/合盖/屏保 都按备份回到改动前）。');
  const relayBad = relayRestore.status === 'failed';
  return { exit: failed.length || bad.length || relayBad ? EXIT.ERROR : EXIT.OK, result: { status: opts.dryRun ? 'dry-run' : 'off', restored: r.actions.filter((a) => !a.skipped).length, failed: failed.length + (relayBad ? 1 : 0), mismatches: bad, wuRestore, relayRestore } };
}

function doStatus(deps, opts) {
  const file = deps.stateFile(deps.host);
  const { rows } = readProtectedState(deps);
  const bad = allZero(rows);
  // 判据面 = 电源 7 项 + 屏保 3 项（2026-10-08 修）：旧版只看电源项 ⇒ 屏保漂移回 1 时仍报「保护中」= 假绿
  const ssState = readScreensaverState(deps);
  const badAll = [...bad, ...ssState.bad];
  const protectedNow = badAll.length === 0;
  let state = null;
  if (fs.existsSync(file)) { try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* ignore */ } }
  const h = deps.health();
  const wuNow = { activeHours: deps.readActiveHours(), policy: deps.readWuPolicy() };
  const relayNow = deps.readRelayJob ? deps.readRelayJob() : null;
  if (!jsonMode) {
    log(`主机：${deps.host}`);
    log(`当前是否保护中：${protectedNow ? `是（所有方案 ${SETTINGS.length} 项全为 0 + 屏保 3 项已关）` : `否（${badAll.length} 项非 0，如 ${badAll.slice(0, 3).join(' ')}）`}`);
    log(`方案数：${rows.length}`);
    log(`状态文件：${fs.existsSync(file) ? file : '(不存在)'}`);
    if (state) log(`上次开启：${new Date(state.createdAt).toLocaleString('zh-CN')}${state.restoredAt ? `，已于 ${new Date(state.restoredAt).toLocaleString('zh-CN')} 恢复` : '，尚未恢复'}`);
    const ss = ssState.values || {};
    log(`屏保：Active=${ss.ScreenSaveActive} TimeOut=${ss.ScreenSaveTimeOut} IsSecure=${ss.ScreenSaverIsSecure}${ssState.ok ? '（= 保护值 0/0/0 ✓）' : '　⚠ 未在保护值（应为 0/0/0）'}`);
    if (h.battery) log(`电源：${h.battery.ac === 1 ? '已接电源' : h.battery.ac === 0 ? '⚠ 电池供电（整夜任务会断电！）' : '未知'} ${h.battery.percent}%`);
    log(`更新待重启：${h.pendingReboot ? '有' : '无'}`);
    if (wuNow.activeHours) {
      const win = state?.wu?.window || WU_WINDOW_DEFAULT;
      const hardened = wuNow.activeHours.start === win.start && wuNow.activeHours.end === win.end;
      log(`更新活动时间：${wuNow.activeHours.start}:00 → ${wuNow.activeHours.end}:00${hardened ? '（= 整夜加固窗口，夜里不会自动重启 ✓）' : '（未加固，夜里可能自动重启 ⚠）'}`);
    } else log('更新活动时间：(读不到)');
    log(`自动重启策略：${wuNow.policy === 1 ? '已开（有人登录就禁止自动重启 ✓）' : wuNow.policy === null ? '未设置（要管理员才能设）' : `= ${wuNow.policy}`}`);
    if (!relayNow || relayNow.available === false) log('会话接力 job：(本机没有大管家组件，插电保护不会去碰它)');
    else log(`会话接力 job：${relayNow.enabled ? '🟢 已放行（无人值守时也会自动交接会话）' : '🔴 关（插电保护 on 会自动放行、off 按备份还原）'}`);
  }
  return { exit: EXIT.OK, result: { status: protectedNow ? 'protected' : 'normal', host: deps.host, plans: rows.length, notZero: bad, notZeroAll: badAll, screensaver: ssState.values, screensaverNotZero: ssState.bad, screensaverProtected: ssState.ok, stateFile: fs.existsSync(file) ? file : null, state, health: h, wu: wuNow, relayJob: relayNow } };
}

/**
 * 读 auto 小状态（容错：文件缺失 / 坏 JSON / 字段类型不对 ⇒ 一律当"空状态"，绝不抛）。
 * 只认两个字段：acOffSince（宽限起算时刻，ISO 带 Z 或空）/ lastVerifyAt（上次真核时刻）。
 */
function readAutoState(file) {
  const empty = { acOffSince: null, lastVerifyAt: null };
  try {
    if (!fs.existsSync(file)) return empty;
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      acOffSince: typeof j.acOffSince === 'string' && j.acOffSince ? j.acOffSince : null,
      lastVerifyAt: typeof j.lastVerifyAt === 'string' && j.lastVerifyAt ? j.lastVerifyAt : null,
    };
  } catch { return empty; }
}

/** 写 auto 小状态（原子写）。只在"宽限开始 / 宽限清空 / 真核到点"时被调用 ⇒ 一致时零写盘。 */
function writeAutoState(file, obj, { dryRun, host, nowIso }) {
  if (dryRun) return false;
  const payload = {
    schemaVersion: 1,
    tool: `overnight-mode.mjs v${VERSION}`,
    host,
    updatedAt: nowIso,
    acOffSince: obj.acOffSince ?? null,
    lastVerifyAt: obj.lastVerifyAt ?? null,
  };
  writeFileAtomic(file, JSON.stringify(payload, null, 2));
  return true;
}

/**
 * auto：按电源状态自动对齐保护态（幂等 —— 一致时**零动作、零写盘**）。
 *
 * 判据只有一个：kernel32 `GetSystemPowerStatus` 的 `ACLineStatus`（1 插电 / 0 电池 / 其余=未知）。
 * 保护态判据 = **状态文件**（存在且没打 restoredAt）= 轻判据；真核到点（默认 6 小时）才重读真值自愈。
 * 该切时复用既有 on / off 路径（连备份、WU 加固、接力 job 一并齐活），**不改它们的语义与退出码**。
 *
 * ⚠️ **永不提权**（见文件头「插电自动对齐」段）：非管理员跑 off 时 restoreWuGuard 本就不会删
 *   那条需要管理员才能设回来的 L2 策略 ⇒ 自动循环不会把夜里防重启的硬保险弄丢。
 */
function doAuto(deps, opts) {
  const file = deps.stateFile(deps.host);
  const autoFile = deps.autoStateFile ? deps.autoStateFile(deps.host) : autoStateFile(deps.host);
  const graceMin = Number.isFinite(opts.graceMinutes) ? Math.max(0, opts.graceMinutes) : AUTO_GRACE_MINUTES_DEFAULT;
  const verifyH = Number.isFinite(opts.verifyHours) ? Math.max(0, opts.verifyHours) : AUTO_VERIFY_HOURS_DEFAULT;
  const graceMs = graceMin * 60_000;
  const verifyMs = verifyH * 3_600_000;
  const now = deps.now();
  const prev = readAutoState(autoFile);
  const auto = { ...prev };
  let needWrite = false;

  const res = {
    status: null, mode: 'auto', host: deps.host, stateFile: file, autoStateFile: autoFile,
    power: null, action: 'none', protectedBefore: null, protectedAfter: null,
    grace: null, verify: null, wroteState: false, dryRun: !!opts.dryRun, notes: [],
  };
  /** 只有 needWrite 为真才落盘（dry-run 一律不写）—— "一致时零写盘"这条判据就靠它 */
  const flush = () => {
    if (!needWrite) return false;
    writeAutoState(autoFile, auto, { dryRun: opts.dryRun, host: deps.host, nowIso: now.toISOString() });
    return !opts.dryRun;
  };

  // ── 1) 电源判据（唯一）
  const p = deps.readAc ? deps.readAc() : null;
  const ac = p && Number.isFinite(Number(p.ac)) ? Number(p.ac) : null;
  res.power = p ? { ac, percent: p.percent } : null;

  // ── 2) 保护态：轻判据（状态文件）
  let st = null;
  if (fs.existsSync(file)) { try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { st = null; } }
  const registeredProtected = !!(st && !st.restoredAt);
  let protectedNow = registeredProtected;
  res.protectedBefore = protectedNow;

  // ── 2b) 真核自愈（只在"登记为保护中"时做；到点才做）
  const lastVerifyMs = prev.lastVerifyAt ? Date.parse(prev.lastVerifyAt) : NaN;
  const verifyDue = verifyMs > 0 && (!Number.isFinite(lastVerifyMs) || (now.getTime() - lastVerifyMs) >= verifyMs);
  if (registeredProtected && verifyDue) {
    res.verify = { due: true, checked: false };
    try {
      const { rows } = readProtectedState(deps);
      const bad = allZero(rows);
      const ssBad = readScreensaverState(deps).bad;
      res.verify.checked = true;
      res.verify.drifted = bad.length + ssBad.length > 0;
      res.verify.detail = [...bad, ...ssBad].slice(0, 5);
      if (res.verify.drifted) {
        protectedNow = false;
        res.notes.push(`真核发现保护值已漂移（${res.verify.detail.join(' ')}）⇒ 当作"未保护"走补做路径自愈`);
      }
      auto.lastVerifyAt = now.toISOString();
      needWrite = true;
    } catch (e) {
      // 真核失败 ⇒ **保守保持轻判据结论**（不许因读不到就误判"未保护"而在电池上去退保护）
      res.verify.checked = false;
      res.verify.error = String(e.message || e);
      res.notes.push(`真核读值失败（${res.verify.error}）⇒ 本轮仍按状态文件判断，不切`);
    }
  }
  res.protectedAfter = protectedNow;

  // ── 3) 电源未知 ⇒ 什么都不做（**不把"读不到"当"拔电"**：电流抖动/查询失败时误退保护是致命的）
  if (ac === null || (ac !== 0 && ac !== 1)) {
    res.status = 'unknown-power';
    res.notes.push('电源状态读不到或不是已知值（ACLineStatus 既非 1 也非 0）⇒ 本轮不切，等下一轮');
    if (!jsonMode) log('⚡ 插电保护·自动：读不到电源状态 ⇒ 本轮什么都不做（不当成拔电）');
    res.wroteState = flush();
    return { exit: EXIT.OK, result: res };
  }

  // ── 4) 插电
  if (ac === 1) {
    if (auto.acOffSince) {
      auto.acOffSince = null;
      needWrite = true;
      res.notes.push('已插回电源 ⇒ 清掉宽限计时');
    }
    if (protectedNow) {
      res.status = 'ok-protected';
      if (!jsonMode) log('🔌 插电保护·自动：插电 + 已在保护中 ⇒ 零动作（不写盘）');
      res.wroteState = flush();
      return { exit: EXIT.OK, result: res };
    }
    if (!jsonMode) log('🔌 插电保护·自动：插电且未在保护中 ⇒ 进入保护（走 on 的幂等路径）…');
    const out = doOn(deps, {
      dryRun: opts.dryRun, force: false, noWu: opts.noWu, noRelay: opts.noRelay,
      wuWindow: opts.wuWindow, noEvents: true,
    });
    res.status = 'turned-on';
    res.action = 'on';
    res.protectedAfter = true;
    res.on = out.result;
    res.wroteState = flush();
    return { exit: out.exit, result: res };
  }

  // ── 5) 电池（ac === 0）
  if (!protectedNow) {
    if (auto.acOffSince) { auto.acOffSince = null; needWrite = true; res.notes.push('本就不在保护中 ⇒ 清掉宽限计时'); }
    res.status = 'ok-normal';
    if (!jsonMode) log('🔋 插电保护·自动：电池 + 本就不在保护中 ⇒ 零动作（不写盘）');
    res.wroteState = flush();
    return { exit: EXIT.OK, result: res };
  }
  // 宽限 0 分钟 = 立刻退（不经过"起算"这一步）；否则先记起算时刻，下一轮才开始倒计时
  if (!auto.acOffSince && graceMs > 0) {
    auto.acOffSince = now.toISOString();
    needWrite = true;
    res.status = 'grace-started';
    res.grace = { since: auto.acOffSince, minutes: graceMin };
    if (!jsonMode) log(`🔋 插电保护·自动：电池供电，保护中 ⇒ 起算宽限 ${graceMin} 分钟（到点才恢复正常）`);
    res.wroteState = flush();
    return { exit: EXIT.OK, result: res };
  }
  const sinceMs = Date.parse(auto.acOffSince);
  const elapsedMs = Number.isFinite(sinceMs) ? Math.max(0, now.getTime() - sinceMs) : Number.POSITIVE_INFINITY;
  if (elapsedMs < graceMs) {
    res.status = 'grace-waiting';
    res.grace = { since: auto.acOffSince, minutes: graceMin, elapsedMs, remainingMs: Math.max(0, graceMs - elapsedMs) };
    if (!jsonMode) {
      const left = Math.ceil(res.grace.remainingMs / 60_000);
      log(`🔋 插电保护·自动：电池供电，还在宽限期内（约剩 ${left} 分钟）⇒ 零动作`);
    }
    res.wroteState = flush();
    return { exit: EXIT.OK, result: res };
  }

  if (!jsonMode) log(`🔋 插电保护·自动：电池供电已超过宽限 ${graceMin} 分钟 ⇒ 恢复正常（走 off 路径）…`);
  const out = doOff(deps, { dryRun: opts.dryRun, noEvents: true, force: false });
  res.status = 'turned-off';
  res.action = 'off';
  auto.acOffSince = null;
  needWrite = true;
  res.off = out.result;
  if (out.exit === EXIT.OK) res.protectedAfter = false;
  res.wroteState = flush();
  return { exit: out.exit, result: res };
}

/** adopt: 把手工改动的旧备份目录（含 plan-*.txt / powercfg-all-query.txt）导入成状态文件 */
function doAdopt(deps, opts) {
  const dir = opts.importFrom;
  if (!dir || !fs.existsSync(dir)) { log(`--import-from 目录不存在：${dir}`); return { exit: EXIT.USAGE, result: { status: 'bad-import' } }; }
  const plans = deps.listPlans();
  const values = {};
  const GUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
  function parseSetting(text, settingGuid) {
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((l) => l.includes(settingGuid));
    if (start < 0) return null;
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i++) if (GUID_RE.test(lines[i])) { end = i; break; }
    const hexes = [];
    for (let i = start + 1; i < end; i++) { const m = lines[i].match(/0x[0-9a-fA-F]{8}/); if (m) hexes.push(m[0]); }
    if (hexes.length < 2) return null;
    return { ac: parseInt(hexes[hexes.length - 2], 16), dc: parseInt(hexes[hexes.length - 1], 16) };
  }
  const dumpCache = new Map();
  const readDump = (f) => { if (!dumpCache.has(f)) dumpCache.set(f, fs.readFileSync(f, 'latin1')); return dumpCache.get(f); };
  const dumpHeaderPlan = (f) => { const m = readDump(f).match(/GUID:\s*([0-9a-f-]{36})/i); return m ? m[1].toLowerCase() : null; };
  const files = fs.readdirSync(dir);
  const wholeDump = files.filter((f) => /powercfg-all-query/i.test(f)).map((f) => path.join(dir, f))[0] || null;
  function pickDump(plan) {
    if (opts.fileMap && opts.fileMap[plan.guid]) return opts.fileMap[plan.guid];
    // 活动方案优先用「无参 powercfg /q」的整方案快照 —— 手工改动前留档的惯例是它属于当时的活动方案，
    // 而 plan-<Name>.txt 有可能是改动**之后**才 dump 的（本工具首次落地时就踩过这个坑）。
    if (plan.active && wholeDump && fs.existsSync(wholeDump) && dumpHeaderPlan(wholeDump) === plan.guid) return wholeDump;
    // 再按 dump 头部的方案 GUID 匹配（方案名可能是中文「平衡」，不能靠文件名猜）
    const byGuid = files
      .filter((f) => /\.txt$/i.test(f))
      .map((f) => path.join(dir, f))
      .find((p) => dumpHeaderPlan(p) === plan.guid);
    if (byGuid) return byGuid;
    const named = files.find((f) => new RegExp(`plan-${plan.name}`, 'i').test(f));
    if (named) return path.join(dir, named);
    if (wholeDump && fs.existsSync(wholeDump) && dumpHeaderPlan(wholeDump) === plan.guid) return wholeDump;
    return null;
  }
  for (const p of plans) {
    const f = pickDump(p);
    if (!f || !fs.existsSync(f)) { log(`  ${p.name}: 找不到匹配的原值 dump，跳过（可用 --file "<方案GUID>=<文件>" 指定）`); continue; }
    const text = readDump(f);
    const items = {};
    for (const s of SETTINGS) {
      const v = parseSetting(text, s.id);
      if (v) items[s.name] = v;
      else if (s.name === 'LIDACTION') items[s.name] = { ac: 1, dc: 1 };          // 隐藏项原为未显式＝系统默认：合盖睡眠
      else if (s.name === 'UNATTENDSLEEP') items[s.name] = { ac: 0, dc: 0 };      // 保持 0（不引入无人值守睡眠）
    }
    values[p.guid] = items;
    const summary = ['STANDBYIDLE', 'VIDEOIDLE', 'LIDACTION']
      .map((n) => (items[n] ? `${n}=${items[n].ac}/${items[n].dc}` : ''))
      .filter(Boolean).join(' ');
    log(`  ${p.name}: 从 ${path.basename(f)} 导入 ${Object.keys(items).length} 项  [${summary}]`);
  }
  const state = {
    schemaVersion: 1, tool: `overnight-mode.mjs v${VERSION}`, host: deps.host, createdAt: deps.now().toISOString(),
    activePlan: (plans.find((p) => p.active) || {}).guid || null,
    plans: plans.map((p) => ({ guid: p.guid, name: p.name })),
    values, screensaver: deps.readScreensaver(), wuGuard: false, restoredAt: null,
    adoptedFrom: dir,
    adoptedNote: '由手工备份目录导入；LIDACTION 用系统默认(合盖睡眠=1)，UNATTENDSLEEP 保持 0',
  };
  const file = deps.stateFile(deps.host);
  if (opts.dryRun) log(`(dry-run) 本应写状态文件：${file}`);
  else { writeFileAtomic(file, JSON.stringify(state, null, 2)); log(`状态文件已生成：${file}`); }
  return { exit: EXIT.OK, result: { status: 'adopted', stateFile: file, adoptedFrom: dir } };
}

// ---------------------------------------------------------------- 单测(mock)
function selfTest() {
  jsonMode = true; // 测试期间人类日志走文件，stdout 只留 PASS/FAIL
  const results = [];
  const t = (name, fn) => { try { fn(); results.push({ name, pass: true }); } catch (e) { results.push({ name, pass: false, err: String(e.message) }); } };
  const assert = (cond, msg) => { if (!cond) throw new Error(msg || 'assertion failed'); };

  const HOST = 'test-host';
  function makeDeps(overrides = {}) {
    const planGuids = ['aaaa0000-0000-0000-0000-000000000001', 'aaaa0000-0000-0000-0000-000000000002'];
    const baseValues = {};
    planGuids.forEach((g, gi) => {
      baseValues[g] = { AC: {}, DC: {} };
      SETTINGS.forEach((s, si) => { baseValues[g].AC[s.id] = 300 + gi * 10 + si; baseValues[g].DC[s.id] = 180 + gi * 10 + si; });
    });
    const calls = { setValue: [], setActive: [], reg: [], wu: [], relay: [] };
    let fakeActiveHours = { start: 8, end: 20 };   // 假机器上的活动时间原值（真机默认就是 8-20）
    let fakePolicy = null;                          // 假机器上策略值没设过
    let fakeRelayJob = false;                       // 假机器上会话接力 job 默认关（生产默认也是关）
    // 屏保 3 项的内存态：初始 = 屏保开着（Active=1）；_setScreensaverWriteFail 模拟「写不进」（组策略/EDR 锁）
    let fakeScreensaver = { ScreenSaveActive: '1', ScreenSaveTimeOut: '0', ScreenSaverIsSecure: '0' };
    let fakeScreensaverWriteFail = false;
    let fakeAc = 1;                                                     // 假机器默认插电（ACLineStatus=1）
    let fakeNow = new Date('2026-09-15T00:00:00Z');                     // 可变"现在"（auto 的宽限/真核要用它推时间）
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'overnight-selftest-'));
    return {
      calls, planGuids, baseValues, tmp,
      host: HOST,
      now: () => fakeNow,
      stateFile: (h) => path.join(tmp, `overnight-mode-${h}.json`),
      autoStateFile: (h) => path.join(tmp, `overnight-mode-auto-${h}.json`),
      listPlans: () => planGuids.map((g, i) => ({ guid: g, name: i === 1 ? 'Silent' : 'Performance', active: i === 0 })),
      readValues: () => JSON.parse(JSON.stringify(baseValues)),
      setValue: (plan, sub, id, mode, value) => { calls.setValue.push({ plan, sub, id, mode, value }); baseValues[plan][mode.toUpperCase()][id] = value; return { ok: true }; },
      setActivePlan: (g) => { calls.setActive.push(g); return { ok: true }; },
      // 屏保三项：**内存态**（真机 reg add 之后 reg query 就会变 ⇒ mock 必须跟着变，
      // 否则「写后回读复核」这条路径在单测里永远看不到效果）。初始值 = 屏保开着（Active=1）。
      readScreensaver: () => ({ ...fakeScreensaver }),
      writeScreensaver: (v) => {
        calls.reg.push({ ...v });
        const res = [];
        for (const [n, val] of Object.entries(v)) {
          if (fakeScreensaverWriteFail) { res.push({ name: n, ok: false, err: '假失败（模拟被组策略/EDR 锁）' }); continue; }
          fakeScreensaver[n] = String(val);
          res.push({ name: n, ok: true });
        }
        return res;
      },
      _setScreensaver: (v) => { Object.assign(fakeScreensaver, v); },
      _getScreensaver: () => ({ ...fakeScreensaver }),
      _setScreensaverWriteFail: (v) => { fakeScreensaverWriteFail = v; },
      // 电源判据（auto 的唯一判据）：内存态，测试里可改（1 插电 / 0 电池 / null 读不到）
      readAc: () => (fakeAc === null ? null : { ac: fakeAc, percent: 88 }),
      _setAc: (v) => { fakeAc = v; },
      _setNow: (d) => { fakeNow = new Date(d); },
      isAdmin: () => false,
      wakeEvents: (since) => [],
      health: () => ({ battery: { ac: 1, percent: 90 }, activeHours: { ActiveHoursStart: 8, ActiveHoursEnd: 20 }, pendingReboot: false }),
      // WU 加固的假实现：活动时间/策略值各存一份内存态，测试里可读可改
      readActiveHours: () => ({ ...fakeActiveHours }),
      writeActiveHours: (start, end) => { calls.wu.push({ op: 'activeHours', start, end }); fakeActiveHours = { start, end }; return { ok: true, steps: [0, 0], err: '' }; },
      readWuPolicy: () => fakePolicy,
      writeWuPolicy: (v) => { calls.wu.push({ op: 'policy', value: v }); fakePolicy = v; return { ok: true, err: '' }; },
      deleteWuPolicy: () => { calls.wu.push({ op: 'delPolicy' }); fakePolicy = null; return { ok: true, err: '' }; },
      _setActiveHours: (v) => { fakeActiveHours = { ...v }; },
      _setPolicy: (v) => { fakePolicy = v; },
      _getActiveHours: () => ({ ...fakeActiveHours }),
      _getPolicy: () => fakePolicy,
      // 会话接力 job 的假实现（同 WU：内存态，可读可改、可被 overrides 注入失败分支）
      readRelayJob: () => ({ available: true, enabled: fakeRelayJob, source: 'file' }),
      setRelayJob: (enabled, why) => { calls.relay.push({ enabled, why }); fakeRelayJob = enabled; return { ok: true }; },
      _setRelayJob: (v) => { fakeRelayJob = v; },
      _getRelayJob: () => fakeRelayJob,
      ...overrides,
    };
  }
  const quiet = () => { };

  t('快照包含 方案×设置×AC/DC 全部值', () => {
    const deps = makeDeps();
    const st = snapshot(deps);
    assert(st.plans.length === 2, 'plans');
    assert(Object.keys(st.values).length === 2, 'values keys');
    for (const s of SETTINGS) assert(typeof st.values[deps.planGuids[0]][s.name].ac === 'number', s.name);
    assert(st.screensaver.ScreenSaveActive === '1', 'screensaver captured');
    assert(st.activePlan === deps.planGuids[0], 'active plan');
  });

  t('on: dry-run 零写入', () => {
    const deps = makeDeps();
    const before = JSON.parse(JSON.stringify(deps.baseValues));
    doOn(deps, { dryRun: true });
    assert(deps.calls.setValue.length === 0, 'no powercfg writes');
    assert(deps.calls.reg.length === 0, 'no reg writes');
    assert(JSON.stringify(before) === JSON.stringify(deps.baseValues), 'values untouched');
    assert(!fs.existsSync(deps.stateFile(HOST)), 'no state file written in dry-run');
  });

  t('on: 写入 = 方案×7项×2 且全为 0，并落状态文件', () => {
    const deps = makeDeps();
    const r = doOn(deps, {});
    assert(r.result.status === 'on', 'status');
    assert(deps.calls.setValue.length === 2 * SETTINGS.length * 2, `writes=${deps.calls.setValue.length}`);
    assert(deps.calls.setValue.every((c) => c.value === 0), 'all zero');
    assert(fs.existsSync(deps.stateFile(HOST)), 'state file exists');
  });

  t('on: 幂等（第二次不再重复备份/写入）', () => {
    const deps = makeDeps();
    doOn(deps, {});
    const n1 = deps.calls.setValue.length;
    const created = JSON.parse(fs.readFileSync(deps.stateFile(HOST), 'utf8')).createdAt;
    const r2 = doOn(deps, {});
    assert(r2.result.status === 'already-on', `status=${r2.result.status}`);
    assert(deps.calls.setValue.length === n1, 'no extra writes');
    assert(JSON.parse(fs.readFileSync(deps.stateFile(HOST), 'utf8')).createdAt === created, 'backup preserved');
  });

  t('off: 逐条写回改动前的值', () => {
    const deps = makeDeps();
    const snapshotValues = JSON.parse(JSON.stringify(deps.baseValues));
    doOn(deps, {});
    deps.calls.setValue.length = 0;
    const r = doOff(deps, { noEvents: true });
    assert(r.result.status === 'off', 'status');
    assert(r.result.failed === 0, 'no failures');
    for (const s of SETTINGS) {
      const expect = snapshotValues[deps.planGuids[0]][`AC`][s.id];
      const got = deps.baseValues[deps.planGuids[0]].AC[s.id];
      assert(expect === got, `${s.name} restored: want ${expect} got ${got}`);
    }
    assert(deps.calls.reg.length > 0, 'screensaver restored');
    assert(JSON.parse(fs.readFileSync(deps.stateFile(HOST), 'utf8')).restoredAt, 'state marked restored');
  });

  t('off: 复核不一致会报 mismatch（注入 readValues 造假）', () => {
    const deps = makeDeps();
    doOn(deps, {});
    const broken = makeDeps();
    broken.readValues = () => { const v = JSON.parse(JSON.stringify(broken.baseValues)); v[broken.planGuids[0]].AC[SETTINGS[0].id] = 999; return v; };
    fs.copyFileSync(deps.stateFile(HOST), broken.stateFile(HOST));
    const r = doOff(broken, { noEvents: true });
    assert(r.exit === EXIT.ERROR, 'exit should be error');
    assert(r.result.mismatches.length === 1, `mismatches=${JSON.stringify(r.result.mismatches)}`);
  });

  t('off: 无状态文件 -> 退出码 2', () => {
    const deps = makeDeps();
    const r = doOff(deps, {});
    assert(r.exit === EXIT.USAGE, `exit=${r.exit}`);
  });

  t('off: 主机名不符 -> 退出码 5 且不动任何值', () => {
    const deps = makeDeps();
    doOn(deps, {});
    const other = makeDeps({ host: 'other-host' });
    fs.copyFileSync(deps.stateFile(HOST), other.stateFile('other-host'));
    const r = doOff(other, {});
    assert(r.exit === EXIT.HOST_MISMATCH, `exit=${r.exit}`);
    assert(other.calls.setValue.length === 0, 'no writes');
  });

  t('off: 已恢复过再跑 -> already-off（除非 --force）', () => {
    const deps = makeDeps();
    doOn(deps, {});
    doOff(deps, { noEvents: true });
    const r = doOff(deps, { noEvents: true });
    assert(r.result.status === 'already-off', `status=${r.result.status}`);
  });

  t('off: 方案已消失 -> 跳过且不炸', () => {
    const deps = makeDeps();
    doOn(deps, {});
    const later = makeDeps();
    later.listPlans = () => [{ guid: later.planGuids[0], name: 'Performance', active: true }];
    fs.copyFileSync(deps.stateFile(HOST), later.stateFile(HOST));
    later.calls.setValue.length = 0;
    const r = doOff(later, { noEvents: true });
    assert(r.exit === EXIT.OK, `exit=${r.exit}`);
    assert(later.calls.setValue.every((c) => c.plan === later.planGuids[0]), 'only existing plan written');
  });

  t('status: 保护中/正常 判定正确', () => {
    const deps = makeDeps();
    assert(doStatus(deps, {}).result.status === 'normal', 'normal before');
    doOn(deps, {});
    assert(doStatus(deps, {}).result.status === 'protected', 'protected after');
  });

  t('状态文件可 JSON 往返（含 null 值不丢字段）', () => {
    const deps = makeDeps();
    const f = deps.stateFile(HOST);
    const st = snapshot(deps);
    st.screensaver.ScreenSaveExe = null;
    writeFileAtomic(f, JSON.stringify(st, null, 2));
    const back = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert(back.screensaver.ScreenSaveExe === null, 'null preserved');
    assert(Object.keys(back.values).length === 2, 'values preserved');
  });

  t('on 默认做 WU 加固：L1 活动时间生效 + 原值被备份', () => {
    const deps = makeDeps();
    const r = doOn(deps, {});
    const st = JSON.parse(fs.readFileSync(deps.stateFile(HOST), 'utf8'));
    assert(st.wu.activeHours.start === 8 && st.wu.activeHours.end === 20, `原值备份=${JSON.stringify(st.wu.activeHours)}`);
    assert(deps.calls.wu.some((c) => c.op === 'activeHours' && c.start === 21 && c.end === 15), 'L1 写入 21-15');
    assert(r.result.wuGuard.layer1 === 'ok', `layer1=${r.result.wuGuard.layer1}`);
    assert(r.result.wuGuard.layer2 === 'need-admin', `layer2=${r.result.wuGuard.layer2}`);
    assert(st.wuGuard === true, 'L1 成功即算已加固');
    assert(r.exit === EXIT.OK, 'layer2=need-admin 不该算失败');
  });

  t('on --no-wu：完全不碰 WU', () => {
    const deps = makeDeps();
    const r = doOn(deps, { noWu: true });
    assert(deps.calls.wu.length === 0, '没有任何 WU 动作');
    assert(r.result.wuGuard === null, 'wuGuard 为 null');
    assert(deps._getActiveHours().start === 8, '活动时间没被动过');
  });

  t('管理员时 L2 策略也写入 1', () => {
    const deps = makeDeps({ isAdmin: () => true });
    const r = doOn(deps, {});
    assert(r.result.wuGuard.layer2 === 'ok', `layer2=${r.result.wuGuard.layer2}`);
    assert(deps.calls.wu.some((c) => c.op === 'policy' && c.value === 1), '写了策略值 1');
    assert(deps._getPolicy() === 1, '假机器策略值应为 1');
  });

  t('--wu-window 自定义窗口生效', () => {
    const deps = makeDeps();
    const r = doOn(deps, { wuWindow: { start: 22, end: 16, hours: 18 } });
    assert(deps.calls.wu.some((c) => c.op === 'activeHours' && c.start === 22 && c.end === 16), '写了自定义窗口');
    assert(r.result.wuGuard.window.start === 22, '窗口记录进结果');
  });

  t('parseWuWindow 校验合法与非法输入', () => {
    assert(parseWuWindow('21-15').hours === 18, '21-15 应为 18 小时');
    assert(parseWuWindow('21 - 15').start === 21, '允许空格');
    assert(parseWuWindow('20-8').hours === 12, '跨午夜 20-8 = 12 小时');
    assert(parseWuWindow('8-20').hours === 12, '8-20 = 12 小时');
    assert(parseWuWindow('21-21') === null, '零长窗口应拒绝');
    assert(parseWuWindow('0-19') === null, '超 18 小时上限应拒绝');
    assert(parseWuWindow('24-5') === null, '小时越界应拒绝');
    assert(parseWuWindow('abc') === null, '非数字应拒绝');
  });

  t('off：活动时间写回原值 + 策略原本没设过则删除', () => {
    const deps = makeDeps({ isAdmin: () => true });
    doOn(deps, {});
    deps.calls.wu.length = 0;
    const r = doOff(deps, { noEvents: true });
    assert(deps.calls.wu.some((c) => c.op === 'activeHours' && c.start === 8 && c.end === 20), '活动时间写回 8-20');
    assert(r.result.wuRestore.layer1 === 'ok', `layer1=${r.result.wuRestore.layer1}`);
    assert(r.result.wuRestore.layer2 === 'ok', `layer2=${r.result.wuRestore.layer2}`);
    assert(deps._getPolicy() === null, '策略值被删掉（原本没设过）');
  });

  t('off：策略原本设过 → 写回原值而不是删', () => {
    const deps = makeDeps({ isAdmin: () => true });
    const st = snapshot(deps);
    st.wu = { activeHours: { start: 8, end: 20 }, policy: 0 };
    writeFileAtomic(deps.stateFile(HOST), JSON.stringify(st, null, 2));
    deps._setPolicy(1);
    deps._setActiveHours({ start: 21, end: 15 });
    const r = doOff(deps, { noEvents: true });
    assert(deps.calls.wu.some((c) => c.op === 'policy' && c.value === 0), '写回原值 0');
    assert(r.result.wuRestore.layer2 === 'ok', `layer2=${r.result.wuRestore.layer2}`);
  });

  t('off 非管理员：L1 照常还原、L2 记为 need-admin', () => {
    const deps = makeDeps({ isAdmin: () => true });
    doOn(deps, {});
    const plain = makeDeps();               // 非管理员
    fs.copyFileSync(deps.stateFile(HOST), plain.stateFile(HOST));
    plain._setActiveHours({ start: 21, end: 15 });
    plain._setPolicy(1);
    const r = doOff(plain, { noEvents: true });
    assert(r.result.wuRestore.layer1 === 'ok', `layer1=${r.result.wuRestore.layer1}`);
    assert(r.result.wuRestore.layer2 === 'need-admin', `layer2=${r.result.wuRestore.layer2}`);
    assert(plain._getActiveHours().start === 8, '活动时间照样被还原了');
  });

  t('旧状态文件（v1.0.0 无 wu 块）on 时补做并捕获原值', () => {
    const deps = makeDeps();
    doOn(deps, { noWu: true });             // 老式开启：没做 WU 加固
    const f = deps.stateFile(HOST);
    const st0 = JSON.parse(fs.readFileSync(f, 'utf8'));
    delete st0.wu; delete st0.wuGuard;      // 模拟旧版工具写的状态文件
    writeFileAtomic(f, JSON.stringify(st0, null, 2));
    const r = doOn(deps, {});
    assert(r.result.status === 'wu-applied', `status=${r.result.status}`);
    const st1 = JSON.parse(fs.readFileSync(f, 'utf8'));
    assert(st1.wuGuard === true, 'wuGuard true');
    assert(st1.wu.activeHours.start === 8, '原值 8 被捕获（否则 off 还原不回去）');
    assert(deps.calls.setValue.length === 2 * SETTINGS.length * 2, '电源备份没有被重复写入');
  });

  t('on 幂等：已加固后再 on 不重复动 WU', () => {
    const deps = makeDeps();
    doOn(deps, {});
    deps.calls.wu.length = 0;
    const r = doOn(deps, {});
    assert(r.result.status === 'already-on', `status=${r.result.status}`);
    assert(deps.calls.wu.length === 0, '没有多余的 WU 动作');
  });

  t('L1 已成但 L2 未做：管理员再跑 on 会补 L2（电源不重复写）', () => {
    const plain = makeDeps();                          // 先以非管理员身份跑
    doOn(plain, {});
    assert(plain._getPolicy() === null, '非管理员确实写不了策略');
    const admin = makeDeps({ isAdmin: () => true });   // 之后换成管理员再来一次
    for (const g of admin.planGuids) {                 // 先把假机器的电源设成「已在保护中」
      for (const s of SETTINGS) { admin.baseValues[g].AC[s.id] = 0; admin.baseValues[g].DC[s.id] = 0; }
    }
    fs.copyFileSync(plain.stateFile(HOST), admin.stateFile(HOST));
    admin._setActiveHours({ start: 21, end: 15 });     // L1 已生效的状态
    admin._setPolicy(null);
    const r = doOn(admin, {});
    assert(r.result.status === 'wu-applied', `status=${r.result.status}`);
    assert(admin._getPolicy() === 1, 'L2 补上了');
    assert(admin.calls.setValue.length === 0, '电源没有被重复写');
  });

  t('L1 被外部改回去时：再跑 on 会重新对齐', () => {
    const deps = makeDeps();
    doOn(deps, {});
    deps.calls.wu.length = 0;
    deps._setActiveHours({ start: 8, end: 20 });       // 模拟被别的东西改回去
    const r = doOn(deps, {});
    assert(r.result.status === 'wu-applied', `status=${r.result.status}`);
    assert(deps.calls.wu.some((c) => c.op === 'activeHours' && c.start === 21), 'L1 重新对齐');
  });

  // ── 会话接力 job 联动（v1.2.0 · 主人令「jobs 放进整夜模式脚本里」）────────────────
  t('on 默认放行会话接力 job：原值被备份 + 真写到 true', () => {
    const deps = makeDeps();
    const r = doOn(deps, {});
    const st = JSON.parse(fs.readFileSync(deps.stateFile(HOST), 'utf8'));
    assert(st.relayJob && st.relayJob.enabled === false, `原值备份=${JSON.stringify(st.relayJob)}`);
    assert(deps.calls.relay.length === 1 && deps.calls.relay[0].enabled === true, '放行了一次');
    assert(deps._getRelayJob() === true, '假机器上开关已是 true');
    assert(r.result.relayJob.status === 'ok', `status=${r.result.relayJob.status}`);
    assert(r.exit === EXIT.OK, '放行成功不该算失败');
  });

  t('on：接力 job 原本就放行 → 不动它（already）', () => {
    const deps = makeDeps();
    deps._setRelayJob(true);
    const r = doOn(deps, {});
    assert(deps.calls.relay.length === 0, '没有任何写入');
    const st = JSON.parse(fs.readFileSync(deps.stateFile(HOST), 'utf8'));
    assert(st.relayJob.enabled === true, '原值记成 true');
    assert(r.result.relayJob.status === 'already', `status=${r.result.relayJob.status}`);
  });

  t('on --no-relay：完全不碰 job 开关', () => {
    const deps = makeDeps();
    const r = doOn(deps, { noRelay: true });
    assert(deps.calls.relay.length === 0, '没有写入');
    assert(deps._getRelayJob() === false, '开关保持关');
    assert(r.result.relayJob.status === 'skipped', `status=${r.result.relayJob.status}`);
    const st = JSON.parse(fs.readFileSync(deps.stateFile(HOST), 'utf8'));
    assert(!st.relayJob, '没接管 = 不写备份块');
  });

  t('on dry-run：job 开关零写入', () => {
    const deps = makeDeps();
    const r = doOn(deps, { dryRun: true });
    assert(deps.calls.relay.length === 0, '没有写入');
    assert(deps._getRelayJob() === false, '开关没被动');
    assert(r.result.relayJob.status === 'dry-run', `status=${r.result.relayJob.status}`);
  });

  t('off：按备份把 job 关回', () => {
    const deps = makeDeps();
    doOn(deps, {});
    assert(deps._getRelayJob() === true, 'on 之后应为 true');
    deps.calls.relay.length = 0;
    const r = doOff(deps, { noEvents: true });
    assert(deps.calls.relay.length === 1 && deps.calls.relay[0].enabled === false, '关回一次');
    assert(deps._getRelayJob() === false, '开关回到 false');
    assert(r.result.relayRestore.status === 'ok', `status=${r.result.relayRestore.status}`);
    assert(r.exit === EXIT.OK, '不该算失败');
  });

  t('off：开插电保护前本来就放行的 → 保持放行、不关回', () => {
    const deps = makeDeps();
    deps._setRelayJob(true);
    doOn(deps, {});
    deps.calls.relay.length = 0;
    const r = doOff(deps, { noEvents: true });
    assert(deps.calls.relay.length === 0, '没有写入');
    assert(deps._getRelayJob() === true, '保持放行');
    assert(r.result.relayRestore.status === 'nothing', `status=${r.result.relayRestore.status}`);
  });

  t('off：状态文件没有 job 备份（旧版工具写的）→ 开关不动', () => {
    const deps = makeDeps();
    const st = snapshot(deps);
    st.wu = { activeHours: { start: 8, end: 20 }, policy: null };
    st.relayJob = null;
    writeFileAtomic(deps.stateFile(HOST), JSON.stringify(st, null, 2));
    deps._setRelayJob(true);      // 模拟「别的地方开着它」，而状态文件里没有备份
    const r = doOff(deps, { noEvents: true });
    assert(deps.calls.relay.length === 0, '不碰没有备份的开关');
    assert(deps._getRelayJob() === true, '保持原样');
    assert(r.result.relayRestore.status === 'nothing', `status=${r.result.relayRestore.status}`);
  });

  t('旧状态文件（无 relayJob 块）在 already-on 时补做并捕获原值', () => {
    const deps = makeDeps();
    for (const g of deps.planGuids) for (const s of SETTINGS) { deps.baseValues[g].AC[s.id] = 0; deps.baseValues[g].DC[s.id] = 0; }
    const st = snapshot(deps);                 // 电源已是保护态 ⇒ 走「已在整夜模式」补做分支
    st.wu = { activeHours: { start: 21, end: 15 }, policy: null };
    st.wuGuard = true;
    st.relayJob = null;
    writeFileAtomic(deps.stateFile(HOST), JSON.stringify(st, null, 2));
    const r = doOn(deps, { noWu: true });
    assert(r.result.status === 'wu-applied', `status=${r.result.status}`);
    assert(deps._getRelayJob() === true, '补做放行');
    const back = JSON.parse(fs.readFileSync(deps.stateFile(HOST), 'utf8'));
    assert(back.relayJob && back.relayJob.enabled === false, '补记了原值（false）');
    assert(back.createdAt === st.createdAt, '没有覆盖电源备份');
  });

  t('on：放行写失败 → 记为 failed 且退出码 1（不静默）', () => {
    const deps = makeDeps({ setRelayJob: () => ({ ok: false, err: '假失败' }) });
    const r = doOn(deps, {});
    assert(r.result.relayJob.status === 'failed', `status=${r.result.relayJob.status}`);
    assert(r.exit === EXIT.ERROR, 'exit 应为 1');
  });

  t('on：写入后回读仍为关 → 判失败（回读复核不是走过场）', () => {
    const deps = makeDeps({ setRelayJob: () => ({ ok: true }) });   // 假成功：内存态其实没变
    const r = doOn(deps, {});
    assert(r.result.relayJob.status === 'failed', `status=${r.result.relayJob.status}`);
    assert(r.exit === EXIT.ERROR, 'exit 应为 1');
  });

  t('本机没有大管家组件（available=false）→ 跳过且不算失败', () => {
    const deps = makeDeps({ readRelayJob: () => ({ available: false, enabled: false }) });
    const r = doOn(deps, {});
    assert(r.result.relayJob.status === 'skipped', `status=${r.result.relayJob.status}`);
    assert(r.exit === EXIT.OK, '跳过不该算失败');
  });

  t('off：关回写失败 → failed 且退出码 1', () => {
    const deps = makeDeps();
    doOn(deps, {});
    deps.setRelayJob = () => ({ ok: false, err: '假失败' });
    deps.calls.relay.length = 0;
    const r = doOff(deps, { noEvents: true });
    assert(r.result.relayRestore.status === 'failed', `status=${r.result.relayRestore.status}`);
    assert(r.exit === EXIT.ERROR, 'exit 应为 1');
  });

  t('status 里能看到会话接力 job 现状', () => {
    const deps = makeDeps();
    const r1 = doStatus(deps, {});
    assert(r1.result.relayJob && r1.result.relayJob.enabled === false, '默认关');
    deps._setRelayJob(true);
    const r2 = doStatus(deps, {});
    assert(r2.result.relayJob.enabled === true, '放行后看得见');
  });

  // ── 屏保三项并入判据 + 自愈路径（v1.3.0 · 2026-10-08 主人拍板修）───────────────
  t('status：屏保三项也进「保护中」判据（电源全 0 但 Active=1 ⇒ 不再假绿）', () => {
    const deps = makeDeps();
    for (const g of deps.planGuids) for (const s of SETTINGS) { deps.baseValues[g].AC[s.id] = 0; deps.baseValues[g].DC[s.id] = 0; }
    deps._setScreensaver({ ScreenSaveActive: '1', ScreenSaveTimeOut: '0', ScreenSaverIsSecure: '0' });
    const r = doStatus(deps, {});
    assert(r.result.status === 'normal', `电源全 0 但屏保 Active=1 ⇒ 不该算保护中（got ${r.result.status}）`);
    assert(r.result.notZero.length === 0, '电源 7 项本身没问题（notZero 语义不变）');
    assert(r.result.screensaverNotZero.length === 1 && /ScreenSaveActive=1/.test(r.result.screensaverNotZero[0]), `屏保项应被点名：${JSON.stringify(r.result.screensaverNotZero)}`);
    deps._setScreensaver({ ScreenSaveActive: '0' });
    assert(doStatus(deps, {}).result.status === 'protected', '屏保回 0 后应恢复「保护中」');
  });

  t('status：屏保读不到（null）不判绿', () => {
    const deps = makeDeps();
    for (const g of deps.planGuids) for (const s of SETTINGS) { deps.baseValues[g].AC[s.id] = 0; deps.baseValues[g].DC[s.id] = 0; }
    deps._setScreensaver({ ScreenSaveActive: null, ScreenSaveTimeOut: null, ScreenSaverIsSecure: null });
    const r = doStatus(deps, {});
    assert(r.result.status === 'normal', '读不到不许算保护中');
    assert(r.result.screensaverNotZero.length === 3, `3 项读不到都该点名：${JSON.stringify(r.result.screensaverNotZero)}`);
  });

  t('on 幂等：屏保漂移（Active=1）不再早退，走补做纠正回 0', () => {
    const deps = makeDeps();
    doOn(deps, {});
    assert(deps._getScreensaver().ScreenSaveActive === '0', 'on 之后屏保应为 0');
    deps._setScreensaver({ ScreenSaveActive: '1' });     // 模拟屏保被别的程序改回去
    deps.calls.reg.length = 0;
    deps.calls.setValue.length = 0;
    const r = doOn(deps, {});
    assert(r.result.status === 'screensaver-applied', `status=${r.result.status}`);
    assert(deps._getScreensaver().ScreenSaveActive === '0', '屏保被纠正回 0');
    assert(deps.calls.reg.some((c) => c.ScreenSaveActive === '0'), '真写了屏保');
    assert(deps.calls.setValue.length === 0, '电源没有被重复写');
  });

  t('on：屏保写不进（被锁）⇒ 如实报 failed + 只告警，退出码仍 0', () => {
    const deps = makeDeps();
    deps._setScreensaverWriteFail(true);
    const r = doOn(deps, {});
    assert(r.result.screensaverGuard.status === 'failed', `guard=${JSON.stringify(r.result.screensaverGuard)}`);
    assert(r.exit === EXIT.OK, `屏保设不了不该把整夜模式判失败（exit=${r.exit}）`);
    assert(r.result.screensaverGuard.notes.some((n) => /需要管理员/.test(n)), '要如实告诉主人需要管理员');
    assert(deps._getScreensaver().ScreenSaveActive === '1', '没设成就不许谎报（内存态仍是 1）');
  });

  t('on dry-run：屏保也零写入', () => {
    const deps = makeDeps();
    const r = doOn(deps, { dryRun: true });
    assert(deps.calls.reg.length === 0, 'dry-run 不写屏保');
    assert(deps._getScreensaver().ScreenSaveActive === '1', '屏保保持原样');
    assert(r.result.screensaverGuard.status === 'dry-run', `guard=${r.result.screensaverGuard.status}`);
  });

  t('adopt: 从备份目录 dump 解析原值', () => {
    const deps = makeDeps();
    const dir = deps.tmp;
    // 造一个最小 dump: 方案名 + 设置块(3 个 0x 行 + AC/DC)
    // 真实 dump 里不含隐藏项(LIDACTION/UNATTENDSLEEP)——powercfg /q 对 ATTRIB_HIDE 的项不输出值行
    for (const p of ['Performance', 'Silent']) {
      const lines = [];
      for (const s of SETTINGS.filter((x) => x.name !== 'LIDACTION' && x.name !== 'UNATTENDSLEEP')) {
        lines.push(`    电源设置 GUID: ${s.id}  (label)`);
        lines.push('      GUID 别名: X');
        lines.push('      最小可能的设置: 0x00000000');
        lines.push('      最大可能的设置: 0xffffffff');
        lines.push('      可能的设置增量: 0x00000001');
        lines.push('      当前交流电源设置索引: 0x0000012c');
        lines.push('      当前直流电源设置索引: 0x000000b4');
      }
      fs.writeFileSync(path.join(dir, `plan-${p}.txt`), lines.join('\r\n'), 'latin1');
    }
    const r = doAdopt(deps, { importFrom: dir });
    assert(r.result.status === 'adopted', `status=${r.result.status}`);
    const st = JSON.parse(fs.readFileSync(deps.stateFile(HOST), 'utf8'));
    assert(st.values[deps.planGuids[0]].STANDBYIDLE.ac === 300, 'ac parsed 300');
    assert(st.values[deps.planGuids[0]].STANDBYIDLE.dc === 180, 'dc parsed 180');
    assert(st.values[deps.planGuids[0]].LIDACTION.ac === 1, 'lid default 1');
    assert(st.values[deps.planGuids[0]].UNATTENDSLEEP.ac === 0, 'unattend kept 0');
  });

  t('adopt 出来的状态可以直接 off 且值正确', () => {
    const deps = makeDeps();
    const dir = deps.tmp;
    for (const p of ['Performance', 'Silent']) {
      const lines = [];
      for (const s of SETTINGS.filter((x) => x.name !== 'LIDACTION' && x.name !== 'UNATTENDSLEEP')) {
        lines.push(`    电源设置 GUID: ${s.id}`);
        lines.push('      最小可能的设置: 0x00000000');
        lines.push('      最大可能的设置: 0xffffffff');
        lines.push('      可能的设置增量: 0x00000001');
        lines.push('      当前交流电源设置索引: 0x00000258');
        lines.push('      当前直流电源设置索引: 0x0000012c');
      }
      fs.writeFileSync(path.join(dir, `plan-${p}.txt`), lines.join('\r\n'), 'latin1');
    }
    doAdopt(deps, { importFrom: dir });
    deps.calls.setValue.length = 0;
    doOff(deps, { noEvents: true });
    assert(deps.calls.setValue.some((c) => c.value === 600 && c.mode === 'ac'), 'ac 600 written');
    assert(deps.calls.setValue.some((c) => c.value === 300 && c.mode === 'dc'), 'dc 300 written');
  });

  // ──────────────────────────────────────────────── auto（插电保护自动对齐）
  // 夹具里"零写盘"用 内容 + mtime 双判据（写入后内容可能一模一样，但 mtime 必变）
  const readTxt = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
  const stampOf = (f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : null);

  t('auto：插电 × 未保护 ⇒ 进入保护（真写 7 项 + 落状态文件）', () => {
    const deps = makeDeps();
    const r = doAuto(deps, {});
    assert(r.result.status === 'turned-on', `status=${r.result.status}`);
    assert(r.result.action === 'on', 'action=on');
    assert(deps.calls.setValue.length === 2 * SETTINGS.length * 2, `writes=${deps.calls.setValue.length}`);
    assert(deps.calls.setValue.every((c) => c.value === 0), 'all zero');
    assert(fs.existsSync(deps.stateFile(HOST)), '状态文件已落');
  });

  t('auto：插电 × 保护中 ⇒ 零动作 + 零写盘（主状态文件与 auto 文件都不动）', () => {
    const deps = makeDeps();
    doOn(deps, {});
    const sf = deps.stateFile(HOST);
    const af = deps.autoStateFile(HOST);
    fs.writeFileSync(af, JSON.stringify({ acOffSince: null, lastVerifyAt: deps.now().toISOString() }), 'utf8');
    const nWrites = deps.calls.setValue.length;
    const sfBefore = readTxt(sf); const afBefore = readTxt(af);
    const sfStamp = stampOf(sf); const afStamp = stampOf(af);
    const r = doAuto(deps, {});
    assert(r.result.status === 'ok-protected', `status=${r.result.status}`);
    assert(deps.calls.setValue.length === nWrites, '未再写电源值');
    assert(readTxt(sf) === sfBefore && stampOf(sf) === sfStamp, '主状态文件一个字节没动');
    assert(readTxt(af) === afBefore && stampOf(af) === afStamp, 'auto 状态文件一个字节没动');
    assert(r.result.wroteState === false, 'wroteState 应为 false');
  });

  t('auto：电池 × 未保护 ⇒ 零动作（不建主状态文件、也不建 auto 文件）', () => {
    const deps = makeDeps();
    deps._setAc(0);
    const r = doAuto(deps, {});
    assert(r.result.status === 'ok-normal', `status=${r.result.status}`);
    assert(deps.calls.setValue.length === 0, '零写入');
    assert(!fs.existsSync(deps.stateFile(HOST)), '不建主状态文件');
    assert(!fs.existsSync(deps.autoStateFile(HOST)), '不建 auto 状态文件（零写盘）');
  });

  t('auto：电池 × 保护中 ⇒ 先起算宽限（不立刻退），到点才恢复正常', () => {
    const deps = makeDeps();
    const original = JSON.parse(JSON.stringify(deps.baseValues));
    doOn(deps, {});
    deps._setAc(0);
    const r1 = doAuto(deps, {});
    assert(r1.result.status === 'grace-started', `第一轮 status=${r1.result.status}`);
    assert(deps.baseValues[deps.planGuids[0]].AC[SETTINGS[0].id] === 0, '宽限期内仍是保护值（没退）');
    deps._setNow(new Date(deps.now().getTime() + 5 * 60_000));
    const r2 = doAuto(deps, {});
    assert(r2.result.status === 'grace-waiting', `第二轮 status=${r2.result.status}`);
    assert(deps.baseValues[deps.planGuids[0]].AC[SETTINGS[0].id] === 0, '仍在保护值');
    deps._setNow(new Date(deps.now().getTime() + 6 * 60_000));
    const r3 = doAuto(deps, {});
    assert(r3.result.status === 'turned-off', `第三轮 status=${r3.result.status}`);
    assert(r3.result.action === 'off', 'action=off');
    assert(deps.baseValues[deps.planGuids[0]].AC[SETTINGS[0].id] === original[deps.planGuids[0]].AC[SETTINGS[0].id], '值已回到原值');
    assert(JSON.parse(readTxt(deps.autoStateFile(HOST))).acOffSince === null, '宽限计时已清');
  });

  t('auto：宽限期内插回电源 ⇒ 撤销计时、保持保护（且只写这一次）', () => {
    const deps = makeDeps();
    doOn(deps, {});
    deps._setAc(0);
    doAuto(deps, {});
    assert(JSON.parse(readTxt(deps.autoStateFile(HOST))).acOffSince !== null, '计时已起算');
    deps._setAc(1);
    const r = doAuto(deps, {});
    assert(r.result.status === 'ok-protected', `status=${r.result.status}`);
    assert(JSON.parse(readTxt(deps.autoStateFile(HOST))).acOffSince === null, '宽限计时已清');
    assert(r.result.wroteState === true, '清计时那一次要落盘');
  });

  t('auto：--grace-minutes 0 ⇒ 电池 × 保护中 立刻恢复正常（不经过起算）', () => {
    const deps = makeDeps();
    doOn(deps, {});
    deps._setAc(0);
    const r = doAuto(deps, { graceMinutes: 0 });
    assert(r.result.status === 'turned-off', `status=${r.result.status}`);
  });

  t('auto：电源读不到 ⇒ 零动作（不把"读不到"当"拔电"）', () => {
    const deps = makeDeps();
    doOn(deps, {});
    const sf = deps.stateFile(HOST);
    const before = readTxt(sf); const stamp = stampOf(sf);
    const nWrites = deps.calls.setValue.length;
    deps._setAc(null);
    const r = doAuto(deps, {});
    assert(r.result.status === 'unknown-power', `status=${r.result.status}`);
    assert(deps.calls.setValue.length === nWrites, '零写入');
    assert(readTxt(sf) === before && stampOf(sf) === stamp, '状态文件未动');
  });

  t('auto：dry-run（插电 × 未保护）⇒ 走 on 的 dry-run，零写入零落盘', () => {
    const deps = makeDeps();
    const before = JSON.parse(JSON.stringify(deps.baseValues));
    const r = doAuto(deps, { dryRun: true });
    assert(r.result.status === 'turned-on', `status=${r.result.status}`);
    assert(JSON.stringify(before) === JSON.stringify(deps.baseValues), '零写入');
    assert(!fs.existsSync(deps.stateFile(HOST)), '主状态文件未建');
    assert(!fs.existsSync(deps.autoStateFile(HOST)), 'auto 状态文件未建');
  });

  t('auto：真核到点发现保护值被外部改回 ⇒ 自愈（走 on 补做，且不覆盖备份）', () => {
    const deps = makeDeps();
    doOn(deps, {});
    const sf = deps.stateFile(HOST);
    const created = JSON.parse(readTxt(sf)).createdAt;
    for (const g of deps.planGuids) for (const s of SETTINGS) { deps.baseValues[g].AC[s.id] = 999; deps.baseValues[g].DC[s.id] = 999; }
    deps.calls.setValue.length = 0;
    const r = doAuto(deps, {});   // auto 文件不存在 ⇒ 真核到点
    assert(r.result.verify && r.result.verify.checked === true, '真核应真跑');
    assert(r.result.verify.drifted === true, '真核应报漂移');
    assert(r.result.status === 'turned-on', `status=${r.result.status}`);
    assert(deps.calls.setValue.length > 0 && deps.calls.setValue.every((c) => c.value === 0), '重新写回全 0');
    assert(JSON.parse(readTxt(sf)).createdAt === created, '电源备份未被覆盖（createdAt 不变）');
  });

  t('auto：未到真核点（lastVerifyAt = 刚核过）⇒ 不重读真值（省开销）', () => {
    const deps = makeDeps();
    doOn(deps, {});
    fs.writeFileSync(deps.autoStateFile(HOST), JSON.stringify({ acOffSince: null, lastVerifyAt: deps.now().toISOString() }), 'utf8');
    let readCount = 0;
    const orig = deps.readValues;
    deps.readValues = () => { readCount++; return orig(); };
    const r = doAuto(deps, {});
    assert(r.result.status === 'ok-protected', `status=${r.result.status}`);
    assert(readCount === 0, `未到点不该读真值，实读 ${readCount} 次`);
  });

  t('auto：真核读值失败 ⇒ 保守保持"保护中"（电池时仍走宽限，不误退）', () => {
    const deps = makeDeps();
    doOn(deps, {});
    deps._setAc(0);
    deps.readValues = () => { throw new Error('假读值失败'); };
    const r = doAuto(deps, {});
    assert(r.result.verify && r.result.verify.checked === false, '真核应记 checked=false');
    assert(r.result.status === 'grace-started', `status=${r.result.status}（失败也不许误判成"未保护"）`);
  });

  t('auto：auto 状态文件坏 JSON ⇒ 当空状态、不崩（且重起宽限）', () => {
    const deps = makeDeps();
    doOn(deps, {});
    fs.writeFileSync(deps.autoStateFile(HOST), '{ 这不是 JSON', 'utf8');
    deps._setAc(0);
    const r = doAuto(deps, {});
    assert(r.result.status === 'grace-started', `status=${r.result.status}`);
  });

  t('auto：on/off 既有语义未受影响（auto 跑完仍能手跑 status/off）', () => {
    const deps = makeDeps();
    doAuto(deps, {});
    const s = doStatus(deps, {});
    assert(s.result.status === 'protected', `status=${s.result.status}`);
    const r = doOff(deps, { noEvents: true });
    assert(r.result.status === 'off', `off status=${r.result.status}`);
  });

  const pass = results.filter((r) => r.pass).length;
  for (const r of results) console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.pass ? '' : '  <- ' + r.err}`);
  console.log(`\n${pass}/${results.length} 通过`);
  return pass === results.length ? EXIT.OK : EXIT.ERROR;
}

/**
 * 解析 --wu-window "21-15"：小时 0-23，窗口按跨午夜算，最长 18 小时（Win11 活动时间上限）。
 * 例：21-15 = 21:00 到次日 15:00 共 18 小时；非法输入返回 null 让 CLI 报用法错误。
 */
function parseWuWindow(text) {
  const m = String(text ?? '').trim().match(/^(\d{1,2})\s*-\s*(\d{1,2})$/);
  if (!m) return null;
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (start > 23 || end > 23) return null;
  const hours = ((end - start) + 24) % 24;
  if (hours === 0 || hours > WU_WINDOW_MAX_HOURS) return null;
  return { start, end, hours };
}

// ---------------------------------------------------------------- CLI
function parseArgs(argv) {
  const opts = { dryRun: false, force: false, noWu: false, noRelay: false, wuWindow: null, noEvents: false, importFrom: null, json: false, fileMap: {}, graceMinutes: null, verifyHours: null };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--force') opts.force = true;
    else if (a === '--no-wu') opts.noWu = true;
    // v1.1.0 起 WU 加固默认就做；--with-wu 保留只为兼容旧命令行/旧文档，等同默认行为
    else if (a === '--with-wu') { /* no-op：默认已开 */ }
    else if (a === '--wu-window' || a.startsWith('--wu-window=')) {
      const v = a === '--wu-window' ? argv[++i] : a.slice('--wu-window='.length);
      const parsedWin = parseWuWindow(v);
      if (!parsedWin) return { error: `--wu-window 要写成 "开始-结束"（小时 0-23，窗口最长 ${WU_WINDOW_MAX_HOURS} 小时），例如 21-15：${v}` };
      opts.wuWindow = parsedWin;
    }
    else if (a === '--no-events') opts.noEvents = true;
    // 新增 v1.4.0：auto 的两个旋钮（只影响 auto；on/off/status 完全不看它们）
    else if (a === '--grace-minutes' || a.startsWith('--grace-minutes=')) {
      const v = a === '--grace-minutes' ? argv[++i] : a.slice('--grace-minutes='.length);
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return { error: `--grace-minutes 需要 ≥ 0 的数字（分钟），例如 --grace-minutes 10：${v}` };
      opts.graceMinutes = n;
    }
    else if (a === '--verify-hours' || a.startsWith('--verify-hours=')) {
      const v = a === '--verify-hours' ? argv[++i] : a.slice('--verify-hours='.length);
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) return { error: `--verify-hours 需要 ≥ 0 的数字（小时，0 = 关掉真核自愈），例如 --verify-hours 6：${v}` };
      opts.verifyHours = n;
    }
    // 新增 v1.2.0：--no-relay 本次跳过「放行会话接力 job」（不动任何 job 开关）
    else if (a === '--no-relay') opts.noRelay = true;
    else if (a === '--json') { opts.json = true; jsonMode = true; }
    else if (a === '--import-from') opts.importFrom = argv[++i];
    else if (a.startsWith('--import-from=')) opts.importFrom = a.slice('--import-from='.length);
    else if (a === '--file' || a.startsWith('--file=')) {
      const v = a === '--file' ? argv[++i] : a.slice('--file='.length);
      const idx = String(v).indexOf('=');
      if (idx < 1) return { error: `--file 需要写成 "<方案GUID>=<文件路径>"：${v}` };
      opts.fileMap[String(v).slice(0, idx).trim().toLowerCase()] = String(v).slice(idx + 1).trim();
    }
    else if (a.startsWith('-')) return { error: `未知参数：${a}` };
    else positional.push(a);
  }
  return { opts, command: positional[0] || null, positional };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  const parsed = parseArgs(argv);
  if (parsed.error) {
    console.error(parsed.error);
    console.error('用法：overnight-mode.mjs <auto|on|off|status|adopt> [--dry-run] [--force] [--no-wu] [--wu-window 21-15] [--no-relay] [--no-events] [--json]');
    console.error('      auto 专用：--grace-minutes 10（拔电宽限）/ --verify-hours 6（真核自愈间隔，0 = 关）');
    return EXIT.USAGE;
  }
  const { opts, command } = parsed;
  if (!command) {
    console.error('用法：overnight-mode.mjs <auto|on|off|status|adopt> [--dry-run] [--force] [--no-wu] [--wu-window 21-15] [--no-relay] [--no-events] [--json]');
    console.error('      auto 专用：--grace-minutes 10（拔电宽限）/ --verify-hours 6（真核自愈间隔，0 = 关）');
    return EXIT.USAGE;
  }
  let deps;
  try { deps = realDeps(); } catch (e) { console.error(`环境不可用：${e.message}`); return EXIT.ENV; }

  let out;
  try {
    if (command === 'on') out = doOn(deps, opts);
    else if (command === 'off') out = doOff(deps, opts);
    else if (command === 'status') out = doStatus(deps, opts);
    else if (command === 'auto') out = doAuto(deps, opts);
    else if (command === 'adopt') out = doAdopt(deps, opts);
    else { console.error(`未知命令：${command}`); return EXIT.USAGE; }
  } catch (e) {
    console.error(`执行失败：${e.message}`);
    return EXIT.ERROR;
  }
  if (jsonMode) process.stdout.write(JSON.stringify(out.result, null, 2) + '\n');
  return out.exit;
}

process.exitCode = main();
