#!/usr/bin/env node
// dsh-butler / dsh-bootstrap.mjs —— C 类 bootstrap（P9 H3 · 方案 §4.2 第 4 动作「部署 C 类」）
//
// 解决什么（2026-09-15 ROG→TUF 换机实测）：
//   插件实体 / 调度常驻 / 桌面入口 / 全局 npm 补丁 / 配置恢复**都不在任何仓里**（机器级状态），
//   换机后靠人记（docs\换机必补清单.md 是清单，但没人执行）。本工具把它变成**一条命令**：
//
//     node <DSH_ROOT>\tools\dsh-bootstrap.mjs --check     # 只读体检：缺什么、怎么补（零副作用）
//     node <DSH_ROOT>\tools\dsh-bootstrap.mjs --plan      # 打印将要执行的动作（等价 dry-run）
//     node <DSH_ROOT>\tools\dsh-bootstrap.mjs --apply     # 真补齐（幂等，可重复跑）
//     node <DSH_ROOT>\tools\dsh-bootstrap.mjs --apply --only sched,desktop   # 只补指定步骤
//     node <DSH_ROOT>\tools\dsh-bootstrap.mjs --apply --safe                 # 只做非破坏动作（不装插件/不跑补丁）
//
// 步骤（id）：main(主包) · profile(profile 装配) · closure(依赖闭包) · plugins(插件实体)
//            patches(魔改补丁) · sched(调度常驻) · desktop(桌面入口) · config(配置恢复) · verify(自检)
//
// ⚠️ 边界（写死）：
//   1. **不升主包**、不改 profile 声明版本 —— 版本决策属「受控升级」线（B 系列卡），本工具只做"按清单补齐"。
//   2. **绝不实体化 profiles\node_modules 依赖闭包**（junction 432 个；实体化 = dsh 崩 + guard 无限重启）。
//   3. 不碰 git-crypt key（C 类例外只能手工传递，见 docs\gitee备份使用说明.md §5）。
//   4. 一切"装/改"动作幂等；`--check` 与 `--plan` 严格只读。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
// 【卡 S14 · 2026-10-08 · token 门判活遗留同批修】HTTP 存活判据**单一真源**：
//   `<DSH_ROOT>\guard-http.mjs#judgeHttp`（H1）—— 2xx / 3xx / 401 / 403 = 活；其它 4xx、5xx、无应答 = 不活。
//   为什么必须接：0.1.5 起 dsh web 带 cookie token 门，无 token 访问 `/` 返 **401**
//   ⇒ 旧判据 `res.ok`（只认 2xx）把"正在跑的 dsh"报成"3080 未响应（DSH 未起）"。
//   接法 = 绝对 `file:///`（全仓只此一份码表；真源被移走时本文件 import 阶段硬失败，不静默降级）。
import { judgeHttp } from './lib/guard-http.mjs';
// 【2026-10-09 · 卡「360弹窗治本-pwsh7」】PowerShell 一律走统一工具（pwsh 7 优先）：
//   360 企业版 EDR 只对 5.1（powershell.exe）弹「PowerShell 命令执行攻击」；工具缺失 ⇒ 兜底 5.1。
const PS_EXE = await import('./lib/powershell-exe.mjs').then((m) => m.powerShellExe()).catch(() => 'powershell.exe');

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const BOOTSTRAP_VERSION = '0.1.0';
const ARGV = process.argv.slice(2);

export function dshRoot() { return process.env.DSH_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'); }
export function dshHome() {
  const o = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  return o && o.trim() ? path.resolve(o.trim()) : path.join(os.homedir(), '.dsh');
}
export function profileDir() { return path.join(dshHome(), 'profiles', 'web'); }
/** dsh-butler 组件目录（plugin-sources.json / plugin-align.mjs 在那里；本脚本位于 tools/ 下一级）。 */
export function butlerDir() { return path.join(dshRoot(), 'tools', 'dsh-butler'); }
function readJsonSafe(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
function exists(p) { try { fs.statSync(p); return true; } catch { return false; } }
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: opts.timeout ?? 120_000, ...opts });
  return { ok: r.status === 0, code: r.status, out: `${r.stdout ?? ''}`, err: `${r.stderr ?? ''}`, error: r.error?.message ?? null };
}

/** 桌面三件套（与 persona / docs\换机必补清单.md §4 一致）。 */
export const DESKTOP_LINKS = [
  { name: 'DeepSeek Harness.lnk', target: 'dsh-start.cmd', icon: 'dsh-icon.ico', desc: '开机日常入口' },
  { name: 'DSH 重启.lnk', target: 'dsh-restart.cmd', icon: 'whale-guard-green.ico', desc: 'GUI 卡死急救 / 让新配置生效' },
  { name: 'DSH关机.lnk', target: 'dsh-shutdown.cmd', icon: 'whale-guard.ico', desc: '停机（退房暗号「退下吧」）' },
];
export function desktopDir() { return path.join(os.homedir(), 'Desktop'); }
export function landingDir() { return path.join(desktopDir(), 'DSH鲸落地'); }

// ---------------------------------------------------------------- 各步骤

/** 主包版本（读全局 npm 实体的 package.json，不联网）。 */
export function mainPackageVersion() {
  const p = path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json');
  return readJsonSafe(p)?.version ?? null;
}

/** 依赖闭包 junction 计数（判据：`~\.dsh\profiles\web\node_modules` 下 LinkType 数量）。 */
export function closureLinkCount(nm = path.join(profileDir(), 'node_modules')) {
  let dirs = [];
  try { dirs = fs.readdirSync(nm, { withFileTypes: true }); } catch { return { total: 0, links: -1 }; }
  let links = 0;
  const countLinks = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isSymbolicLink()) links++;
      else if (e.isDirectory() && e.name.startsWith('@')) countLinks(path.join(dir, e.name));
    }
  };
  countLinks(nm);
  return { total: dirs.length, links };
}

/** 调度（本机 ROG = tickd 常驻；TUF = Windows 计划任务）。 */
export function schedulerStatus() {
  const tickd = path.join(butlerDir(), 'butler-tickd.mjs');
  let tickdRunning = false;
  try {
    const r = spawnSync('node', [tickd, '--status'], { encoding: 'utf8', windowsHide: true, timeout: 20_000 });
    tickdRunning = r.status === 0 && /"pid"/.test(r.stdout ?? '');
  } catch { /* 忽略 */ }
  let tasks = [];
  try {
    const r = spawnSync('schtasks', ['/Query', '/FO', 'CSV'], { encoding: 'buffer', windowsHide: true, timeout: 20_000 });
    const text = r.stdout ? new TextDecoder('gbk').decode(r.stdout) : '';   // schtasks 输出是 GBK（老坑）
    tasks = text.split(/\r?\n/).filter((l) => /DSH-Butler/i.test(l)).map((l) => l.split('","')[0].replace(/^"/, ''));
  } catch { /* 忽略 */ }
  return { tickdPath: tickd, tickdExists: exists(tickd), tickdRunning, tasks };
}

export function desktopStatus() {
  return {
    desktopDir: desktopDir(),
    landingDir: landingDir(),
    links: DESKTOP_LINKS.map((l) => ({ ...l, exists: exists(path.join(desktopDir(), l.name)) })),
    landingExists: exists(landingDir()),
  };
}

/** 插件实体状态（源清单 ↔ 实体）。 */
export function pluginStatus() {
  const srcFile = path.join(butlerDir(), 'plugin-sources.json');
  const src = readJsonSafe(srcFile);
  if (!src) return { error: `安装源清单缺失：${srcFile}`, rows: [], findings: [] };
  const align = path.join(butlerDir(), 'plugin-align.mjs');
  let findings = [];
  try {
    const mod = requireAlign();
    findings = mod.verifySources(src).map((f) => ({ ...f }));
  } catch (e) {
    findings = [{ level: 'diff', code: 'verify-failed', subject: '-', message: String(e?.message ?? e) }];
  }
  return { srcFile, count: src.plugins.length, rows: src.plugins, findings, align };
}

let _align = null;
function requireAlign() {
  if (_align) return _align;
  // 同步 require 形态：plugin-align.mjs 是 ESM，这里用 createRequire 的等价物（顶层 await 已 import 不了），
  // 故直接内联调用其 CLI 的 JSON 输出（保持"单一实现"：算法只在 plugin-align.mjs 里）。
  return _align = {
    verifySources: (src) => {
      const r = run(process.execPath, [path.join(butlerDir(), 'plugin-align.mjs'), '--verify', '--json'], { timeout: 120_000 });
      try { return JSON.parse(r.out).findings ?? []; } catch { return [{ level: 'diff', code: 'verify-failed', subject: '-', message: r.err.slice(0, 200) }]; }
    },
  };
}

/** 魔改补丁状态（把每个 patch 脚本的 --dry-run 当探针；脚本幂等且都支持 --dry-run）。 */
export function patchStatus(only = null) {
  const src = readJsonSafe(path.join(butlerDir(), 'plugin-sources.json'));
  const out = [];
  const list = [];
  for (const p of src?.plugins ?? []) for (const s of p.patches ?? []) list.push({ plugin: p.name, script: s });
  for (const s of src?.mainPackage?.patches ?? []) list.push({ plugin: '(主包)', script: s.script });
  const seen = new Set();
  for (const item of list) {
    if (seen.has(item.script)) continue;
    seen.add(item.script);
    const file = path.join(dshRoot(), 'tools', item.script);
    out.push({ ...item, path: file, exists: exists(file) });
  }
  return only ? out.filter((x) => only.includes(x.script)) : out;
}

// ---------------------------------------------------------------- 体检

/** 依赖闭包体检：数 junction（闭包在 `.dsh-module-fallback\node_modules`），挑出**指向测试/金丝雀根**的污染链接。 */
export function closureStatus() {
  const nm = path.join(profileDir(), 'node_modules');
  const fallback = path.join(nm, '.dsh-module-fallback', 'node_modules');
  const foreign = [];
  let links = 0;
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(dir, e.name);
      if (e.isSymbolicLink()) {
        links++;
        let target = '';
        try { target = fs.readlinkSync(full); } catch { /* 断链 */ }
        if (/DSH-test|canary/i.test(target)) foreign.push({ path: full, target });
      } else if (e.isDirectory() && (e.name.startsWith('@') || e.name === '.dsh-module-fallback')) {
        walk(full, depth + 1);
      }
    }
  };
  walk(nm);
  const topCount = (() => { try { return fs.readdirSync(nm).length; } catch { return -1; } })();
  return { nodeModules: nm, fallbackDir: fallback, links, topCount, foreign };
}

export async function buildReport() {
  const steps = [];
  const add = (id, title, status, detail, action) => steps.push({ id, title, status, detail, action: action ?? null });

  const mainVer = mainPackageVersion();
  add('main', '主包（全局 npm @deepseek-ai/dsh）', mainVer ? 'ok' : 'missing',
    mainVer ? `实体版本 ${mainVer}` : '找不到全局主包实体（%APPDATA%\\npm\\node_modules\\@deepseek-ai\\dsh）',
    mainVer ? null : 'npm i -g @deepseek-ai/dsh@<版本>（版本对齐 docs\\插件升级决策表.md）');

  const profPkg = path.join(profileDir(), 'package.json');
  add('profile', 'profile 装配（~/.dsh/profiles/web）', exists(profPkg) ? 'ok' : 'missing',
    exists(profPkg) ? `profile 存在（依赖 ${Object.keys(readJsonSafe(profPkg)?.dependencies ?? {}).length} 项）` : 'profile 不存在',
    exists(profPkg) ? null : '先跑 DSH 根的 dsh-start.cmd（dsh 首次启动会自建 profile 与依赖闭包）');

  const cl = closureStatus();
  // 判据（2026-09-16 实测校正）：本机 profile 的形态是「插件与依赖为实体目录 + 客户端库（react/zustand/immer）
  // 以 junction 指向 `.dsh-module-fallback`」→ junction 只有个位数属正常，**不能**拿"数百个 junction"当门槛
  // （那是另一种 profile 形态）。真正要报的是：① 顶层条目过少（profile 空）② 有链接指向测试/金丝雀根（污染）。
  const clStatus = cl.topCount < 0 ? 'missing' : (cl.foreign.length ? 'diff' : (cl.topCount >= 20 ? 'ok' : 'warn'));
  add('closure', '依赖闭包（junction，禁止实体化）', clStatus,
    cl.topCount < 0 ? 'node_modules 不存在'
      : `顶层 ${cl.topCount} 项 / junction ${cl.links} 个${cl.foreign.length ? ` / ⚠️ 指向测试根的可疑链接 ${cl.foreign.length} 个` : ''}`,
    cl.foreign.length ? '跑 node tools\\repair-closure-links.mjs --apply（清理指向测试/金丝雀闭包的链接）'
      : (cl.topCount >= 20 ? null : '跑一次 dsh-start（healProfilesModuleFallback 自愈）；**绝不要 pnpm install 实体化**'));

  const ps = pluginStatus();
  const pdiff = (ps.findings ?? []).filter((f) => f.level !== 'info');
  add('plugins', `插件实体（安装源清单 ${ps.count ?? 0} 项）`, pdiff.length ? 'diff' : 'ok',
    pdiff.length ? `${pdiff.length} 处差异：${pdiff.slice(0, 5).map((d) => `${d.subject}(${d.code})`).join('、')}${pdiff.length > 5 ? ' …' : ''}` : '与安装源清单一致',
    pdiff.length ? 'node tools\\dsh-butler\\plugin-align.mjs --verify 看明细' : null);

  const patches = patchStatus();
  const pmiss = patches.filter((p) => !p.exists);
  add('patches', '魔改补丁脚本', pmiss.length ? 'missing' : 'ok',
    pmiss.length ? `${pmiss.length} 个补丁脚本缺失：${pmiss.slice(0, 5).map((p) => p.script).join('、')}` : `${patches.length} 个补丁脚本齐备（**是否已打到产物上**用生态面板「魔改补丁健康」核对）`,
    pmiss.length ? '检查仓3 是否拉全（-Pull）' : null);

  const sch = schedulerStatus();
  const schOk = sch.tickdRunning || sch.tasks.length > 0;
  add('sched', '调度常驻（tickd 或计划任务）', schOk ? 'ok' : 'missing',
    sch.tickdRunning ? `tickd 常驻运行中（计划任务 ${sch.tasks.length} 个）` : (sch.tasks.length ? `Windows 计划任务 ${sch.tasks.length} 个` : '既无 tickd 常驻、也无 DSH-Butler-* 计划任务'),
    schOk ? null : `node ${path.join(dshRoot(), 'tools', 'dsh-butler', 'butler-tickd.mjs')} --ensure`);

  const des = desktopStatus();
  const desMiss = des.links.filter((l) => !l.exists);
  add('desktop', '桌面入口（三件套 + DSH鲸落地）', (desMiss.length || !des.landingExists) ? 'missing' : 'ok',
    (desMiss.length || !des.landingExists) ? `缺 ${desMiss.map((l) => l.name).join('、') || ''}${des.landingExists ? '' : '；缺 DSH鲸落地 目录'}` : '三件套 + DSH鲸落地 齐备',
    (desMiss.length || !des.landingExists) ? '--apply 可自动重建（指针见 persona 桌面三件套）' : null);

  const cred = path.join(dshHome(), '.credentials.yaml');
  const settings = path.join(dshHome(), 'settings.yaml');
  add('config', '配置恢复（凭据 / 主配置）', (exists(cred) && exists(settings)) ? 'ok' : 'missing',
    `credentials=${exists(cred) ? '有' : '缺'} settings=${exists(settings) ? '有' : '缺'}`,
    (exists(cred) && exists(settings)) ? null : '仓1 解出来后跑 dsh-backup-sync.ps1 -Pull；凭据回填见 docs\\gitee备份使用说明.md');

  const net = await net3080();
  add('verify', 'DSH 自检（3080 可连）', net.ok ? 'ok' : 'warn',
    net.ok
      ? `HTTP 判活（status=${net.status} · ${net.reason} · 口径 ${net.rule}）`
      : (net.status === 0
        ? '3080 未响应（DSH 未起；换机新机属正常，跑 dsh-start.cmd）'
        : `3080 有应答但判死（status=${net.status} · ${net.reason}）`), null);

  return { host: os.hostname().toLowerCase(), dshRoot: dshRoot(), dshHome: dshHome(), version: BOOTSTRAP_VERSION, steps };
}

/**
 * 本机 DSH 是否在跑（进程内 fetch，**不起 node -e 子进程**）。
 * 【卡 S14 · 2026-10-08 · token 门判活遗留同批修】判据走**单一真源** `guard-http.mjs#judgeHttp`：
 *   旧实现 `return res.ok`（`res.ok` 只认 2xx）⇒ token 门下 `GET /` 返 **401** 被判死，
 *   自检报告误报"3080 未响应（DSH 未起）"（本机实测 2026-10-08：`localhost:3080/` → 401）。
 *   语义变化（如实标注）：旧的"只认 2xx" ⇒ 新的"2xx/3xx/**401/403** 也算活着"；其它 4xx、5xx、无应答仍判死。
 * `url` 可注入仅**为单测**（生产调用点不传，仍指 `http://localhost:3080/`）。
 * @param {string} [url]
 * @returns {Promise<{ok:boolean, status:number, reason:string, rule:string}>} `status=0` = 连不上/超时
 */
export async function net3080(url = 'http://localhost:3080/') {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const j = judgeHttp(res.status);
    return { ok: j.alive, status: res.status, reason: j.reason, rule: j.rule };
  } catch {
    // 连不上/超时/中止 ⇒ 等价 curl 的 `000` ⇒ no-answer ⇒ 不活（fail-closed，与旧口径等价）
    const j = judgeHttp('000');
    return { ok: false, status: 0, reason: j.reason, rule: j.rule };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------- apply 动作

/** 重建桌面入口（幂等；已存在则跳过）。用 PowerShell WScript.Shell 建 .lnk。 */
export function applyDesktop({ dryRun = false } = {}) {
  const log = [];
  if (!dryRun && !exists(landingDir())) fs.mkdirSync(landingDir(), { recursive: true });
  log.push(`${dryRun ? '[dry] ' : ''}DSH鲸落地 目录：${landingDir()}`);
  for (const l of DESKTOP_LINKS) {
    const lnk = path.join(desktopDir(), l.name);
    if (exists(lnk)) { log.push(`  跳过（已存在）：${l.name}`); continue; }
    const target = path.join(dshRoot(), l.target);
    const icon = path.join(dshRoot(), l.icon);
    if (!exists(target)) { log.push(`  ✗ 目标缺失，跳过：${l.name} → ${target}`); continue; }
    if (dryRun) { log.push(`  [dry] 将创建 ${l.name} → ${target}`); continue; }
    const ps = `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk.replace(/'/g, "''")}');`
      + `$s.TargetPath='${target.replace(/'/g, "''")}';$s.IconLocation='${icon.replace(/'/g, "''")}';`
      + `$s.Description='${l.desc}';$s.WorkingDirectory='${dshRoot().replace(/'/g, "''")}';$s.Save()`;
    const r = spawnSync(PS_EXE, ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true, timeout: 30_000 });
    log.push(`${r.status === 0 ? '  ✓' : '  ✗'} ${l.name}${r.status === 0 ? '' : `（rc=${r.status}）`}`);
  }
  return log;
}

/** 调度：确保 tickd 常驻（幂等）。 */
export function applyScheduler({ dryRun = false } = {}) {
  const tickd = path.join(dshRoot(), 'tools', 'dsh-butler', 'butler-tickd.mjs');
  if (!exists(tickd)) return [`✗ tickd 脚本缺失：${tickd}`];
  if (dryRun) return [`[dry] node ${tickd} --ensure`];
  const r = run(process.execPath, [tickd, '--ensure'], { timeout: 60_000 });
  return [`${r.ok ? '✓' : '✗'} tickd --ensure${r.ok ? '' : `（rc=${r.code}）`} ${(r.out || r.err).trim().split('\n').slice(-1)[0]}`];
}

/** 插件实体：npm → dsh-plugin.cmd add；local → deploy.mjs。 */
export function applyPlugins({ dryRun = false, only = null } = {}) {
  const src = readJsonSafe(path.join(butlerDir(), 'plugin-sources.json'));
  const log = [];
  const align = requireAlign();
  const findings = align.verifySources(src);
  const badNames = new Set(findings.filter((f) => ['not-installed', 'version-mismatch'].includes(f.code)).map((f) => f.subject));
  for (const p of src?.plugins ?? []) {
    if (only && !only.includes(p.name)) continue;
    if (p.delete === true) { log.push(`  跳过（清单标删除项）：${p.name}`); continue; }
    if (!badNames.has(p.name) && p.install !== 'local') { log.push(`  跳过（已就绪）：${p.name}`); continue; }
    if (p.install === 'npm') {
      const spec = p.spec ?? `${p.name}@${p.version}`;
      const cmd = [path.join(dshRoot(), 'dsh-plugin.cmd'), '--profile', 'web', 'add', spec];
      if (dryRun) { log.push(`  [dry] ${cmd.join(' ')}`); continue; }
      const r = spawnSync('cmd.exe', ['/c', ...cmd], { encoding: 'utf8', windowsHide: true, timeout: 300_000 });
      log.push(`${r.status === 0 ? '✓' : '✗'} npm 装 ${spec}${r.status === 0 ? '' : `（rc=${r.status}）`}`);
    } else if (p.install === 'local') {
      if (!p.deploy) { log.push(`  · 手工项（无 deploy.mjs）：${p.name} ← ${p.source}`); continue; }
      const dep = path.join(dshRoot(), ...p.deploy.split('/'));
      if (!exists(dep)) { log.push(`  ✗ deploy 脚本缺失：${p.deploy}`); continue; }
      if (p.needsBuild && !dryRun) {
        log.push(`  · 先构建：cd ${path.dirname(dep)} && npm run build`);
        const b = spawnSync('cmd.exe', ['/c', 'npm', 'run', 'build'], { cwd: path.dirname(dep), encoding: 'utf8', windowsHide: true, timeout: 300_000 });
        log.push(`${b.status === 0 ? '✓' : '✗'} build ${p.name}${b.status === 0 ? '' : `（rc=${b.status}）`}`);
      } else if (p.needsBuild) log.push(`  [dry] 将先跑 npm run build（${p.name}）`);
      if (dryRun) { log.push(`  [dry] node ${dep}`); continue; }
      const r = run(process.execPath, [dep, '--no-restart'], { timeout: 300_000 });
      log.push(`${r.ok ? '✓' : '✗'} deploy ${p.name}${r.ok ? '' : `（rc=${r.code}）`}`);
    } else if (p.install === 'link') {
      log.push(`  · 手工项（link 安装需改 profile package.json）：${p.name} → ${p.spec} ← ${p.source}`);
    }
  }
  return log;
}

/** 魔改补丁：按清单顺序跑（幂等，各脚本自带 --dry-run / 备份 / node --check）。 */
export function applyPatches({ dryRun = false, only = null } = {}) {
  const list = patchStatus(only);
  const log = [];
  for (const p of list) {
    if (!p.exists) { log.push(`  ✗ 缺失：${p.script}`); continue; }
    if (dryRun) { log.push(`  [dry] node tools/${p.script}`); continue; }
    const r = run(process.execPath, [p.path], { timeout: 300_000 });
    const last = (r.out || r.err).trim().split('\n').slice(-1)[0] ?? '';
    log.push(`${r.ok ? '✓' : '✗'} ${p.script}${r.ok ? '' : `（rc=${r.code}）`} ${last.slice(0, 120)}`);
  }
  return log;
}

// ---------------------------------------------------------------- CLI

function usage() {
  return [
    'dsh-bootstrap —— C 类 bootstrap（新机一条命令补齐插件实体/调度/桌面入口/补丁/配置）',
    '',
    '  node dsh-bootstrap.mjs --check [--json]',
    '  node dsh-bootstrap.mjs --plan',
    '  node dsh-bootstrap.mjs --apply [--safe] [--only <step,step>] [--json]',
    '  node dsh-bootstrap.mjs --self-test',
    '',
    '  --check   只读体检（缺什么 + 怎么补）',
    '  --plan    打印将执行的动作（等价 --apply --dry-run）',
    '  --apply   真补齐（幂等；--safe = 只做非破坏动作：调度/桌面；不装插件、不跑补丁）',
    '  --only    只跑指定步骤（plugins,patches,sched,desktop）',
    '  --json    机器可读输出',
    '',
    '  环境覆盖：DSH_ROOT / DSH_HOME / BUTLER_DSH_HOME（隔离测试环境用）',
  ].join('\n');
}

function fmt(report) {
  const lines = [`C 类 bootstrap 体检：${report.host}（DSH_ROOT=${report.dshRoot}，DSH_HOME=${report.dshHome}）`];
  const icon = { ok: '✅', warn: '🟡', diff: '🟡', missing: '🔴' };
  for (const s of report.steps) {
    lines.push(`  ${icon[s.status] ?? '·'} [${s.id}] ${s.title} — ${s.detail}`);
    if (s.action) lines.push(`        → ${s.action}`);
  }
  const bad = report.steps.filter((s) => s.status === 'missing' || s.status === 'diff' || s.status === 'warn');
  lines.push(`  合计：${report.steps.length - bad.length}/${report.steps.length} 项就绪${bad.length ? `；${bad.length} 项待补（--apply 可自动补 plugins/patches/sched/desktop）` : ''}`);
  return lines.join('\n');
}

async function main() {
  if (ARGV.includes('--self-test')) { process.exitCode = await selfTest() ? 0 : 1; return; }
  if (ARGV.includes('--help') || ARGV.length === 0) { process.stdout.write(usage() + '\n'); return; }
  const asJson = ARGV.includes('--json');
  const apply = ARGV.includes('--apply');
  const plan = ARGV.includes('--plan');
  const safe = ARGV.includes('--safe');
  const onlyIdx = ARGV.indexOf('--only');
  const only = onlyIdx >= 0 ? String(ARGV[onlyIdx + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean) : null;

  const report = await buildReport();
  if (!apply && !plan) {
    if (asJson) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    else process.stdout.write(fmt(report) + '\n');
    process.exitCode = 0;
    return;
  }

  const dryRun = plan;
  const want = (id) => !only || only.includes(id);
  const logs = [];
  if (want('desktop')) { logs.push('· 桌面入口'); logs.push(...applyDesktop({ dryRun })); }
  if (want('sched')) { logs.push('· 调度常驻'); logs.push(...applyScheduler({ dryRun })); }
  if (!safe && want('plugins')) { logs.push('· 插件实体'); logs.push(...applyPlugins({ dryRun })); }
  if (!safe && want('patches')) { logs.push('· 魔改补丁'); logs.push(...applyPatches({ dryRun })); }

  if (asJson) process.stdout.write(JSON.stringify({ ...report, mode: dryRun ? 'plan' : 'apply', logs }, null, 2) + '\n');
  else {
    process.stdout.write(`${dryRun ? '【PLAN】' : '【APPLY】'} C 类 bootstrap（${report.host}）\n`);
    for (const l of logs) process.stdout.write(`  ${l}\n`);
    process.stdout.write('\n复检：\n');
    process.stdout.write(fmt(await buildReport()) + '\n');
  }
  process.exitCode = 0;
}

async function selfTest() {
  let pass = 0; const fail = [];
  const ok = (c, m) => { if (c) pass++; else fail.push(m); };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-'));
  const oldHome = process.env.BUTLER_DSH_HOME;
  try {
    process.env.BUTLER_DSH_HOME = tmp;
    ok(profileDir() === path.join(tmp, 'profiles', 'web'), 'profileDir 跟随 BUTLER_DSH_HOME（隔离可注入）');
    ok(butlerDir() === path.join(dshRoot(), 'tools', 'dsh-butler'), 'butlerDir 指向 dsh-butler（源清单/体检器所在地）');
    const cl0 = closureStatus();
    ok(cl0.topCount === -1 && Array.isArray(cl0.foreign), '沙盒 profile 不存在 → topCount=-1 且 foreign 为空数组');
    ok(cl0.nodeModules === path.join(tmp, 'profiles', 'web', 'node_modules'), '闭包路径跟随 DSH_HOME 隔离');
    const st = schedulerStatus();
    ok(typeof st.tickdRunning === 'boolean' && Array.isArray(st.tasks), 'schedulerStatus 契约');
    const des = desktopStatus();
    ok(des.links.length === 3, '桌面三件套口径 3 条');
    const patches = patchStatus();
    ok(patches.length >= 15, `补丁清单 ≥15 个（实际 ${patches.length}）`);
    ok(patches.every((p) => /\.mjs$/.test(p.script)), '补丁条目都是 .mjs 脚本');
    const dup = patches.filter((p, i) => patches.findIndex((q) => q.script === p.script) !== i);
    ok(dup.length === 0, '补丁清单已去重（同一脚本跨插件只跑一次）');
    const rep = await buildReport();
    ok(rep.steps.length === 9, `体检 9 步（实际 ${rep.steps.length}）`);
    for (const id of ['main', 'profile', 'closure', 'plugins', 'patches', 'sched', 'desktop', 'config', 'verify']) {
      ok(rep.steps.some((s) => s.id === id), `体检含步骤 ${id}`);
    }
    ok(rep.steps.every((s) => ['ok', 'warn', 'diff', 'missing'].includes(s.status)), '每步状态在白名单内');
    // dry-run 不得写任何东西
    const before = fs.readdirSync(tmp).length;
    applyDesktop({ dryRun: true });
    applyScheduler({ dryRun: true });
    ok(fs.readdirSync(tmp).length === before, 'dry-run 不产生任何写入');
  } finally {
    if (oldHome === undefined) delete process.env.BUTLER_DSH_HOME; else process.env.BUTLER_DSH_HOME = oldHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log(`[self-test] ${pass} 项通过${fail.length ? `，${fail.length} 项失败：\n  - ${fail.join('\n  - ')}` : ''}`);
  return fail.length === 0;
}

const isMain = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
})();
if (isMain) await main();
