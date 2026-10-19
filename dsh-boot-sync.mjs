#!/usr/bin/env node
/**
 * dsh-boot-sync.mjs —— 接机一键对齐（ROG/TUF 双机通用 · 停机段执行）
 *
 * 把「开机前 9 步」压缩成一条命令：
 *   ① 只读收仓（git pull --ff-only 三仓，不采集、不推送）
 *   ② 方向体检（三仓 ahead/behind + 工作副本 dirty + 生产 vs 仓内 mtime 反向检测）
 *   ③ 白名单回灌（仓3 → <DSH_ROOT>；仓1 → ~/.dsh 稳态），robocopy /E /XJ，**只覆盖更新的**
 *   ④ 打印"下一步：起 DSH + handoff --arrive（+ 看板并回）"
 *
 * 安全语义（与仓3 采集脚本同口径）：
 *   · 白名单目录 = docs / tools / assets / dsh-emoji-plugin；根文件 = *.cmd *.ps1 *.ico *.mjs
 *   · 排除目录 = node_modules _archive _tmp generated logs snapshots backups .git
 *     排除文件 = zip / tmp / bak / old / orig / before-restore 后缀
 *   · **禁用镜像语义**：永不 /MIR、永不 purge；`--prune` 参数不存在（刻意不做）
 *   · robocopy 默认「新则覆盖、旧则跳过」→ 仓里比生产旧的文件不会被写回（防降级）
 *   · **不碰** settings.yaml / .credentials.yaml（双机各一份）
 *   · DSH 正在跑就拒绝执行（回灌会与运行中的 Host 抢文件）——`--force` 可跳过（不推荐）
 *
 * 用法：
 *   node <DSH_ROOT>\tools\dsh-boot-sync.mjs                 # 收仓 + 回灌（推荐）
 *   node <DSH_ROOT>\tools\dsh-boot-sync.mjs --dry-run       # 只体检，不动任何文件
 *   node <DSH_ROOT>\tools\dsh-boot-sync.mjs --no-pull       # 跳过 git pull（离线/已手动拉过）
 *   node <DSH_ROOT>\tools\dsh-boot-sync.mjs --root-only     # 只回灌 <DSH_ROOT>，不碰 ~/.dsh
 *   node <DSH_ROOT>\tools\dsh-boot-sync.mjs --closure-fail-close  # 闭包指向有污染时阻断（默认只告警）
 *   node <DSH_ROOT>\tools\dsh-boot-sync.mjs --self-test     # 纯逻辑自检（不联网不写盘）
 *
 * 启动场景哨兵（2026-09-14 新增 · ④b 段 · 卡「闭包闸」B 段）：
 *   只读扫 <DSH_HOME>\profiles\node_modules，出现指向 DSH-test* 或 canary 的链接即 🔴（判据单一真源
 *   `tools\lib\closure-links.mjs`，与日报「🏗 结构健康」、面板健康卡同源）；默认**告警不阻断**，
 *   `--closure-fail-close` 才升级为阻断（档位由主人拍板）。
 *
 * 退出码：0 成功 · 1 环境不允许（DSH 在跑 / 参数错） · 2 体检有阻断项 · 3 回灌有失败项
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import net from 'node:net';

// ---------------------------------------------------------------- 常量（与 dsh-backup-workspace.ps1 同口径）
const repoDir = (envKey, def) => process.env[envKey] || def;
const WORKSPACE_REPO = repoDir('BOOTSYNC_REPO_WS', path.join(os.homedir(), 'dsh-offsync', 'git-backup', 'dsh-workspace'));
const CORE_REPO = repoDir('BOOTSYNC_REPO_CORE', path.join(os.homedir(), 'dsh-offsync', 'git-backup', 'dsh-core'));
const SESSIONS_REPO = repoDir('BOOTSYNC_REPO_SESSIONS', path.join(os.homedir(), 'dsh-offsync', 'git-backup', 'dsh-sessions'));

const WS_DIRS = ['docs', 'tools', 'assets', 'dsh-emoji-plugin'];
const WS_ROOT_GLOBS = ['.cmd', '.ps1', '.ico', '.mjs'];
const EXCLUDE_DIRS = ['node_modules', '_archive', '_tmp', 'generated', 'logs', 'snapshots', 'backups', '.git'];
const EXCLUDE_FILES = ['*.zip', '*.tmp', '*.bak*', '*.old', '*.orig', '*.before-restore'];

/** 仓1 → ~/.dsh 的回灌清单（刻意不含 settings.yaml / .credentials.yaml） */
const CORE_DIRS = ['.agent-presets', 'skills', 'task-board', 'storages', 'memory'];

// 生产根：**必须延迟求值** —— CLI 的 --root/--home 是在 main 里才写 env 的，
// 顶层 const 会在模块加载时就把值固定成默认路径（2026-09-13 演练实测踩到：
// 沙箱演练时 ROOT 仍是 <DSH_ROOT>，回灌打到了生产根）。
const SELF_DIR = path.dirname(fileURLToPath(import.meta.url));
let ROOT = process.env.DSH_ROOT || path.resolve(SELF_DIR, '..');
const log = (...a) => console.log(...a);
const ok = (m) => console.log(`  ✔ ${m}`);
const warn = (m) => console.log(`  ⚠ ${m}`);
const bad = (m) => console.log(`  ✖ ${m}`);

// 口径 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh（2026-09-14 统一，与 tools/lib/dsh-home.mjs 同源）
function dshHome() { return process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'); }

/** DSH 是否在跑（3080 监听 / 有 ESTABLISHED 都算） */
export function dshRunning(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port: 3080 });
    const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/**
 * 【施工卡 ②-2 · 挂点④】登记一致性**真扫**（只读 · 告警档）—— 照 ④b 段形态（动态 import 真跑判定），
 * **不是** `expects` 那种 `existsSync` 存在性检查（② 包 §3.2 挂点④ / 轮三 R9 / 轮二 4）。
 *
 * 判定唯一源 = `tools\dsh-butler\lib\registry-audit.mjs`（本函数**不复制任何判据**，只渲染 1–6 行摘要）；
 * 加载失败 / 抛错 / 缺 `asOf` ⇒ 显式「不可探测」（**绝不静默跳过、绝不当成零差集**）。
 * 纯只读：不写状态、不改开关、不发通知；**只告警不阻断**（开机绝不被登记问题拦下）。
 *
 * @param {{root?:string, home?:string, now?:number, auditFn?:Function}} [opts] `auditFn` 仅供单测注入
 * @returns {Promise<{ok:boolean, level:'ok'|'fail'|'warn'|'unavailable', lines:string[], summary:object|null, reason:string|null}>}
 */
export async function checkRegistryConsistency({ root = ROOT, home = dshHome(), now = Date.now(), auditFn = null } = {}) {
  const libPath = path.join(root, 'tools', 'dsh-butler', 'lib', 'registry-audit.mjs');
  const lines = [];
  let r = null;
  try {
    let run = typeof auditFn === 'function' ? auditFn : null;
    if (!run) {
      const mod = await import(pathToFileURL(libPath).href);
      if (typeof mod.auditRegistries !== 'function') throw new Error('registry-audit 未导出 auditRegistries');
      run = mod.auditRegistries;
    }
    r = run({ home, root, now });
    if (!r || typeof r.asOf !== 'string' || !r.asOf) throw new Error('校验器返回值缺 asOf ⇒ 判不可探测（不许判绿）');
  } catch (e) {
    const reason = String(e?.message ?? e);
    lines.push(`登记一致性：⚠️ 不可探测（${reason}）—— 兜底：node tools\\dsh-butler\\butler-registry-audit.mjs`);
    return { ok: false, level: 'unavailable', lines, summary: null, reason };
  }
  const problems = Array.isArray(r.problems) ? r.problems : [];
  const un = Array.isArray(r.unavailable) ? r.unavailable : [];
  const checks = Object.values(r.byDomain ?? {}).reduce((s, v) => s + Number(v?.checks ?? 0), 0);
  const counts = `action ${r.counts?.action ?? '?'} / module ${r.counts?.module ?? '?'} / job ${r.counts?.job ?? '?'} / state-file ${r.counts?.['state-file'] ?? '?'}`;
  const summary = { ok: r.ok === true, asOf: r.asOf, counts: r.counts ?? null, checks, problems: problems.length, unavailable: un.length };
  if (r.ok === true) {
    lines.push(`登记一致性：✅ 零差集（${counts} · 断言 ${checks} 次 · asOf=${r.asOf}）`);
    return { ok: true, level: 'ok', lines, summary, reason: null };
  }
  if (problems.length) {
    lines.push(`登记一致性：🔴 ${problems.length} 项差异（${counts} · asOf=${r.asOf}）`);
    for (const p of problems.slice(0, 5)) lines.push(`❌ [${p.domain}] ${p.id} · ${p.check}：${p.detail}`);
    if (problems.length > 5) lines.push(`…另 ${problems.length - 5} 项，全量：node tools\\dsh-butler\\butler-registry-audit.mjs`);
    return { ok: false, level: 'fail', lines, summary, reason: `登记差异 ${problems.length} 项` };
  }
  lines.push(`登记一致性：⚠️ 判定不可用 ${un.length} 项（**不是零差集** · asOf=${r.asOf}）`);
  for (const u of un.slice(0, 3)) lines.push(`⚠️ [${u.domain}] ${u.check}：${u.detail}`);
  return { ok: false, level: 'warn', lines, summary, reason: `判定不可用 ${un.length} 项` };
}

function git(dir, args, timeout = 600000) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim(), code: r.status };
}

function robocopy(src, dst, extra = []) {
  fs.mkdirSync(dst, { recursive: true });
  const args = [src, dst, '/E', '/XJ',
    '/XD', ...EXCLUDE_DIRS, '/XF', ...EXCLUDE_FILES,
    '/R:2', '/W:1', '/NFL', '/NDL', '/NJH', '/NP', ...extra];   // 保留摘要行（别加 /NJS，否则统计拿不到）
  const r = spawnSync('robocopy', args, { encoding: 'utf8', windowsHide: true, timeout: 900000 });
  return { code: r.status, out: (r.stdout ?? '').trim() };
}

/** 从 robocopy 摘要里取「总计/复制/跳过」（中英文双兼容：Files: / 文件:） */
export function parseRobocopyCopied(out) {
  const re = /(?:Files|文件)\s*[:：]\s*(\d+)\s+(\d+)\s+(\d+)/i;
  const m = out.match(re);
  if (m) return { total: Number(m[1]), copied: Number(m[2]), skipped: Number(m[3]) };
  return null;
}

/** 方向判据：生产文件是否比仓内副本更新（生产更新 = 回灌会降级 → 跳过该文件） */
export function isProductionNewer(srcFile, dstFile) {
  try {
    const s = fs.statSync(srcFile), d = fs.statSync(dstFile);
    return d.mtimeMs > s.mtimeMs + 2000;   // 2s 容差：git 落盘会有同秒抖动
  } catch { return false; }
}

// ---------------------------------------------------------------- 主流程

async function run(opts) {
  const blocking = [];
  ROOT = process.env.DSH_ROOT || path.resolve(SELF_DIR, '..');   // 延迟到此刻取值（--root 已在 main 注入 env）
  log(`── 接机对齐（${os.hostname()}）${opts.dryRun ? ' · DRY-RUN' : ''} ──────────────────`);
  log(`  workspace 仓：${WORKSPACE_REPO}`);
  log(`  core 仓     ：${CORE_REPO}`);
  log(`  生产根      ：${ROOT} / ${dshHome()}`);

  // ⓪ 环境闸
  const running = await dshRunning();
  if (running && !opts.force) {
    bad('DSH 正在运行（3080 有响应）→ 拒绝回灌（会与运行中的 Host 抢文件）。先停 DSH 再跑，或加 --force 硬来（不推荐）');
    process.exitCode = 1; return;
  }
  if (running && opts.force) warn('DSH 在跑（--force 放行，风险自负）');
  else ok('DSH 未运行（可以安全回灌）');

  // ① 收仓（只读 pull）
  if (!opts.noPull) {
    log('\n① 收仓（git pull --ff-only，不采集、不推送）');
    for (const [name, dir] of [['dsh-workspace', WORKSPACE_REPO], ['dsh-core', CORE_REPO], ['dsh-sessions', SESSIONS_REPO]]) {
      if (!fs.existsSync(path.join(dir, '.git'))) { warn(`${name}: 不是 git 工作副本，跳过`); continue; }
      const r = git(dir, ['pull', '--ff-only'], 600000);
      if (r.ok) ok(`${name}: ${r.out.split('\n').pop() || 'up to date'}`);
      else { warn(`${name}: pull 未成功（可能是离线）→ ${r.err.split('\n')[0]}`); blocking.push(`${name} pull 失败`); }
    }
  } else log('\n① 收仓：--no-pull 跳过');

  // ② 方向体检
  log('\n② 方向体检（三仓 ahead/behind + dirty）');
  for (const [name, dir] of [['dsh-core', CORE_REPO], ['dsh-sessions', SESSIONS_REPO], ['dsh-workspace', WORKSPACE_REPO]]) {
    if (!fs.existsSync(path.join(dir, '.git'))) continue;
    const ab = git(dir, ['rev-list', '--left-right', '--count', 'HEAD...@{u}']);
    const dirty = git(dir, ['status', '--porcelain']);
    const [ahead, behind] = ab.ok ? ab.out.split(/\s+/).map(Number) : [NaN, NaN];
    const d = dirty.out ? dirty.out.split('\n').length : 0;
    log(`  ${name}: ahead=${ahead} behind=${behind} dirty=${d}`);
    if (ahead > 0) blocking.push(`${name} 有 ${ahead} 个未推送提交（本机未 depart）`);
    if (behind > 0) warn(`${name} 落后 ${behind} 个提交（pull 应该已经处理）`);
  }

  // ③ 回灌
  log(`\n③ 回灌（robocopy /E /XJ，无 purge；${opts.dryRun ? 'DRY-RUN 只统计' : '实跑'}）`);
  const stats = [];
  const guardHits = [];

  const doTree = (src, dst, label) => {
    if (!fs.existsSync(src)) { warn(`${label}: 仓内不存在 ${src}`); return; }
    if (opts.dryRun) { const n = countFiles(src); log(`  · ${label}: 将同步（源 ${n} 文件）`); stats.push({ label, planned: n }); return; }
    const before = countFiles(dst);                       // 不用解析 robocopy 摘要（/NJS 会关掉、且语言不定），直接数文件
    const r = robocopy(src, dst);
    if (r.code >= 8) { bad(`${label}: robocopy 失败 code=${r.code}`); stats.push({ label, failed: true }); return; }
    const after = countFiles(dst);
    const srcN = countFiles(src);
    const copied = Math.max(0, after - before);
    log(`  · ${label}: 目标 ${before} → ${after}（本次复制 ${copied}）· 源共 ${srcN}`);
    stats.push({ label, copied, tail: after, srcN });
  };

  if (fs.existsSync(WORKSPACE_REPO)) {
    for (const d of WS_DIRS) doTree(path.join(WORKSPACE_REPO, d), path.join(ROOT, d), `ws:${d}`);
    // 根启动链：逐个文件（新则覆盖，旧则跳过；robocopy 语义天然如此）
    const rootSrc = fs.readdirSync(WORKSPACE_REPO).filter((f) => WS_ROOT_GLOBS.includes(path.extname(f).toLowerCase()));
    let copied = 0, skipped = 0, older = 0;
    for (const f of rootSrc) {
      const s = path.join(WORKSPACE_REPO, f), d = path.join(ROOT, f);
      if (opts.dryRun) { stats.push({ label: `root:${f}`, planned: 1 }); continue; }
      if (fs.existsSync(d)) {
        if (isProductionNewer(s, d)) { older++; guardHits.push(f); continue; }   // 生产更新 → 不降级覆盖
        try {
          const sm = fs.statSync(s), dm = fs.statSync(d);
          if (sm.size === dm.size && sm.mtimeMs <= dm.mtimeMs + 2000) { skipped++; continue; }  // 已同步 → 跳过（幂等）
        } catch { /* 取不到 stat 就照常复制 */ }
      }
      try { fs.copyFileSync(s, d); copied++; } catch (e) { bad(`root:${f} 复制失败 ${e.code ?? e.message}`); }
    }
    if (!opts.dryRun) log(`  · root-launchers: 复制 ${copied} / 已同步 ${skipped} / 防降级跳过 ${older}`);
    stats.push({ label: 'root-launchers', copied, skipped, older });
  }

  if (!opts.rootOnly) {
    log('  --- ~/.dsh 稳态（仓1）---');
    for (const d of CORE_DIRS) doTree(path.join(CORE_REPO, 'dsh', d), path.join(dshHome(), d), `dsh:${d}`);
  } else log('  --- ~/.dsh：--root-only 跳过 ---');

  // ④ 关键件到位检查
  log('\n④ 关键件到位检查');
  const expects = [
    ['大管家底座', path.join(ROOT, 'tools', 'dsh-butler', 'handoff.mjs')],
    ['看板并回器', path.join(ROOT, 'tools', 'board-merge.mjs')],
    ['并回快照', path.join(ROOT, 'tools', 'board-snapshots')],
    ['急救台', path.join(ROOT, 'tools', 'dsh-firstaid', 'firstaid.mjs')],
    ['闭包体检', path.join(ROOT, 'tools', 'closure-check.mjs')],
    // ⚠️ 本行**只断言实体存在、不做校验**（② 包 §12.2-9 明写；真校验在 ④c 段真扫 + tickd 挂点①）
    ['登记校验器（仅断言实体存在）', path.join(ROOT, 'tools', 'dsh-butler', 'butler-registry-audit.mjs')],
  ];
  for (const [label, p] of expects) (fs.existsSync(p) ? ok(`${label}: ${path.basename(p)}`) : warn(`${label}: 缺失（${p}）`));

  // ④b 闭包指向哨兵（2026-09-14 新增 · 卡「闭包闸」B 段 · **告警档**）
  //   判据单一真源 = tools/lib/closure-links.mjs（与日报「🏗 结构健康」、面板健康卡同源，别造第二套）。
  //   默认只告警不阻断；只有显式 --closure-fail-close 才升级为阻断项（fail-close 档由主人拍板，默认关）。
  log('\n④b 闭包指向哨兵（只读 · 告警档）');
  try {
    const clPath = process.env.DSH_CLOSURE_LINKS
        ? process.env.DSH_CLOSURE_LINKS
        : (fs.existsSync(path.join(ROOT, 'tools', 'lib', 'closure-links.mjs'))
          ? path.join(ROOT, 'tools', 'lib', 'closure-links.mjs')
          : path.join(SELF_DIR, 'lib', 'closure-links.mjs'));
      const cl = await import(pathToFileURL(clPath).href);
    const linkRoot = process.env.DSH_PROFILES_HOME || path.join(dshHome(), 'profiles', 'node_modules');
    const scan = cl.scanClosureLinks({ linkRoot });
    if (!scan.ok) {
      warn(`闭包指向：不可探测（${scan.reason ?? 'unknown'}）`);
    } else if (scan.polluted.length > 0) {
      warn(`闭包指向：🔴 ${scan.polluted.length} 个链接指向测试/金丝雀闭包（应为 0）· 层 ${scan.linkRoot}`);
      const attr = cl.formatAttributionLine(scan);
      if (attr) log(`  ${attr}`);
      for (const l of scan.polluted.slice(0, 5)) log(`  🔴 ${l.rel} → ${l.target}${l.targetExists ? '' : '（目标不存在）'}`);
      if (scan.polluted.length > 5) log(`  …另有 ${scan.polluted.length - 5} 个，全量清单：node "${cl.checkerPath()}"`);
      for (const line of cl.formatRepairLines(scan)) log(`  ${line}`);
      if (opts.closureFailClose) blocking.push(`闭包指向污染 ${scan.polluted.length} 处（--closure-fail-close 阻断档）`);
      else warn('（告警档：不阻断。要阻断档请加 --closure-fail-close）');
    } else if (scan.broken.length > 0) {
      warn(`闭包指向：🟡 干净但有 ${scan.broken.length} 个断链`);
    } else {
      ok(`闭包指向：干净（${scan.total} 个链接 · 指向生产闭包 ${scan.matched}）`);
    }
  } catch (e) {
    warn(`闭包指向哨兵跳过：${String(e?.message ?? e)}`);
  }

  // ④c 登记一致性哨兵（2026-09-18 · 施工卡 ②-2 · **挂点④** · 只读 · **告警档**）
  //   为什么要有这一段：④ 段那行 `expects` 只判"校验器脚本在不在"（existsSync），**不等于校验跑过**；
  //   而 tickd 挂点① 的上界 = 下次 DSH 重启、日报是每天一次 ⇒ 开机这一刻也把四域结论摆出来。
  //   判据单一真源 = tools\dsh-butler\lib\registry-audit.mjs（本段只渲染，不复制判定）；不阻断（不写 blocking）。
  log('\n④c 登记一致性哨兵（跨表准入 · 只读 · 告警档）');
  try {
    const rc = await checkRegistryConsistency({ root: ROOT, home: dshHome() });
    for (const line of rc.lines) log(`  ${line}`);
    if (rc.level !== 'ok') {
      warn('（告警档：不阻断开机。兜底出口 = 每日日报「🧾 登记一致性」段 / CLI butler-registry-audit.mjs）');
    }
  } catch (e) {
    warn(`登记一致性哨兵跳过：${String(e?.message ?? e)}`);
  }

  // ⑤ 结论
  log('\n⑤ 结论');
  if (guardHits.length) warn(`防降级门拦下 ${guardHits.length} 个"生产更新"的根文件（未覆盖）：${guardHits.slice(0, 6).join(', ')}`);
  if (blocking.length) { bad(`阻断项：${blocking.join('；')}`); }
  if (opts.dryRun) log('  （DRY-RUN：未改动任何文件）');
  log('\n下一步（DSH 还没起）:');
  log('  1) 起服务：dsh-start.cmd（DSH 根）');
  log('  2) 交接  ：node tools\\dsh-butler\\handoff.mjs --arrive');
  log('  3) 并回  ：node tools\\board-merge.mjs --dry-run → --apply');

  process.exitCode = blocking.length ? 2 : 0;
}

function countFiles(dir) {
  let n = 0;
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (EXCLUDE_DIRS.includes(e.name)) continue;
      const p = path.join(d, e.name);
      let st = null; try { st = fs.lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) continue;              // junction：不钻
      if (e.isDirectory()) walk(p);
      else if (!EXCLUDE_FILES.some((g) => e.name.endsWith(g.replace('*', '')))) n++;
    }
  };
  walk(dir);
  return n;
}

// ---------------------------------------------------------------- 自检
function selfTest() {
  let pass = 0; const fail = [];
  const t = (c, m) => { if (c) pass++; else fail.push(m); };

  t(parseRobocopyCopied('   Files :         5        3        2  0  0  0  0  0')?.copied === 3, 'robocopy 英文摘要解析');
  t(parseRobocopyCopied('   文件:         5        3        2  0  0  0  0  0')?.copied === 3, 'robocopy 中文摘要解析');
  t(parseRobocopyCopied('Total    Copied   Skipped') === null, '无法解析时返回 null 而非乱猜');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bootsync-'));
  const oldF = path.join(tmp, 'old.txt'), newF = path.join(tmp, 'new.txt');
  fs.writeFileSync(oldF, 'x'); fs.writeFileSync(newF, 'y');
  const past = Date.now() - 3600_000, future = Date.now() + 3600_000;
  fs.utimesSync(oldF, past / 1000, past / 1000);
  fs.utimesSync(newF, future / 1000, future / 1000);
  t(isProductionNewer(oldF, newF) === true, '生产 mtime 更新 → 应判 true（拒绝降级覆盖）');
  t(isProductionNewer(newF, oldF) === false, '生产 mtime 更旧 → 应判 false（允许覆盖）');
  t(isProductionNewer(oldF, path.join(tmp, 'nope.txt')) === false, '目标不存在 → false');
  t(EXCLUDE_DIRS.includes('node_modules') && EXCLUDE_DIRS.includes('_archive'), '排除目录清单含关键项');
  t(WS_DIRS.includes('tools') && WS_DIRS.includes('docs'), '白名单目录含 tools/docs');
  t(!CORE_DIRS.includes('settings.yaml') && !JSON.stringify(CORE_DIRS).includes('credentials'), '仓1 清单不含敏感单机文件');
  fs.rmSync(tmp, { recursive: true, force: true });

  console.log(`[self-test] ${pass} 项通过${fail.length ? '，' + fail.length + ' 项失败: ' + fail.join(' | ') : ''}`);
  return fail.length === 0;
}

// ---------------------------------------------------------------- 入口
const isMain = (() => {
  try { return fs.realpathSync(process.argv[1] ?? '') === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const args = process.argv.slice(2);
  const argVal = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法: node dsh-boot-sync.mjs [--dry-run] [--no-pull] [--root-only] [--force] [--closure-fail-close] [--self-test]');
    console.log('      隔离/换路径: --root <生产根> --home <DSH_HOME> --repo-ws <仓3> --repo-core <仓1> --repo-sessions <仓2>');
    console.log('      --closure-fail-close: 闭包指向有污染时升级为阻断项（默认告警档，不阻断）');
    process.exitCode = 0;
  } else if (args.includes('--self-test')) {
    process.exitCode = selfTest() ? 0 : 1;
  } else {
    // 隔离演练/换路径（不设则用默认生产路径）
    const root = argVal('--root', null);
    const home = argVal('--home', null);
    const ws = argVal('--repo-ws', null);
    const core = argVal('--repo-core', null);
    const sess = argVal('--repo-sessions', null);
    if (root) process.env.DSH_ROOT = root;
    if (home) process.env.DSH_HOME = home;
    if (ws) process.env.BOOTSYNC_REPO_WS = ws;
    if (core) process.env.BOOTSYNC_REPO_CORE = core;
    if (sess) process.env.BOOTSYNC_REPO_SESSIONS = sess;
    run({ dryRun: args.includes('--dry-run'), noPull: args.includes('--no-pull'), rootOnly: args.includes('--root-only'), force: args.includes('--force'), closureFailClose: args.includes('--closure-fail-close') })
      .catch((e) => { console.error(`✖ 失败：${e?.stack ?? e}`); process.exitCode = 3; });
  }
}
