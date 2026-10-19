#!/usr/bin/env node
/**
 * 「升级前一刻」快照（幂等 · 零依赖 · 默认 dry-run）
 * ---------------------------------------------------------------------------
 * 用途：主包受控升级（`docs\升级方案-2026-09-10.md` §4.1/§4.3）在**部署到生产之前**
 *       刷新一次的轻量快照点，与 2026-09-11 的 L1 全量资产包（含会话快照）分工：
 *       - 11 号包 = 「升级前的老基线」（十天前状态）
 *       - 本脚本 = 「升级前一刻」（窗口当天刷新的那份，只抓会因升级而变的四面）
 *
 * 采集四面（卡面口径）：
 *   ① 主包   %APPDATA%\npm\node_modules\@deepseek-ai\dsh → 版本 + tarball + 整树 tar + bin 包装器 + 逐文件清单
 *   ② profile 四件套 package.json / pnpm-lock.yaml / cordis.patch.yml / node_modules\.package-map.json
 *   ③ 插件实体 profiles\web\node_modules 全量副本 + 逐文件清单 + 副本对账（源↔实体 / 同包多处 / R5 适配层）
 *   ④ 关键配置 settings.yaml / 两个 preset（whale-girl · liangshen）/ <DSH_ROOT>\guard*.mjs / butler-autonomy.json
 *
 * 产出：<DSH_ROOT>\_archive\upgrade-pre-<ts>\
 *         manifest.json        总索引（每文件 sha256 + 大小 + mtime；含 targets 生产锚点）
 *         README.md            包里有什么 / 怎么回滚 / 基线数值
 *         restore-upgrade-pre.mjs  回滚脚本副本（真源在 <DSH_ROOT>\tools\，两侧同 sha）
 *         mainpkg/             meta.json · tree-files.json · tree\*.tar.gz · tarballs\*.tgz · bin\
 *         profile/             四件套
 *         plugins/             entities\node_modules\*（全量副本）· entity-files.json · copies.json
 *         config/              settings.yaml · presets\* · guard\*.mjs · butler-autonomy.json
 *
 * 铁律：
 *   - **幂等**：逐文件比对，内容相同即跳过（第二次跑 = 0 拷贝、0 改动）
 *   - **只读生产**：本脚本从不写 DSH 生产路径，只读 + 只写 --out 指向的 _archive 目录
 *   - 默认 **dry-run**：不加 --apply 只打印计划，零写入
 *
 * 用法：
 *   node snapshot-upgrade-pre.mjs                       # dry-run：探查 + 打印计划
 *   node snapshot-upgrade-pre.mjs --apply               # 建快照（可重复跑，幂等）
 *   node snapshot-upgrade-pre.mjs --apply --no-tree     # 跳过整树 tar（快，约 30s）
 *   node snapshot-upgrade-pre.mjs --verify              # 只读：快照自身完整性 + 与生产对账
 *   node snapshot-upgrade-pre.mjs --verify --backup <DSH_ROOT>\_archive\upgrade-pre-20260922-1630
 * 选项：
 *   --ts <20260922-163000>  时间戳（默认当前时刻）
 *   --out <dir>             产出目录（默认 <DSH_ROOT>\_archive\upgrade-pre-<ts>）
 *   --home <dir>            DSH home（默认 %USERPROFILE%\.dsh；演练/隔离用）
 *   --apply                 真正写入（缺省 = dry-run）
 *   --force                 目标目录非空时允许继续（默认拒绝；已存在的快照可增量刷新）
 *   --no-tree               不生成主包整树 tar
 *   --no-entities           不复制插件实体副本（只记清单与对账）
 *   --json                  末尾输出机器可读 JSON 摘要
 * 退出码：0 = OK / 2 = 用法或环境错 / 3 = dry-run 有待写入 / 4 = 校验发现差异(fail) / 5 = 缺 --apply
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------
// 0. 路径与参数
// ---------------------------------------------------------------------------
// junction 坑：<DSH_ROOT>\_archive 是 junction → import.meta.url 会解析成物理路径
// （<OFFSYNC_ROOT>\deep\_archive\...）。优先用 process.argv[1] 的逻辑路径。
const SELF = (() => {
  const a = process.argv[1] ? path.resolve(process.argv[1]) : null;
  if (a && fs.existsSync(a)) return a;
  return fileURLToPath(import.meta.url);
})();
const TOOLS_DIR = path.dirname(SELF);
const argv = process.argv.slice(2);
const has = (n) => argv.includes(n) === true;
function arg(name, def = null) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : def;
}
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const TS = arg('--ts', stamp());
const HOME = os.homedir();
const DSH_HOME = path.resolve(arg('--home', process.env.DSH_HOME || path.join(HOME, '.dsh')));
const PROFILE_DIR = path.join(DSH_HOME, 'profiles', 'web');
const DSH_ROOT = process.env.DSH_ROOT_DIR ? path.resolve(process.env.DSH_ROOT_DIR) : path.resolve(path.dirname(SELF), '..');
const OUT = path.resolve(arg('--out', path.join(DSH_ROOT, '_archive', `upgrade-pre-${TS}`)));
const APPLY = has('--apply');
const FORCE = has('--force');
const WANT_TREE = !has('--no-tree');
const WANT_ENTITIES = !has('--no-entities');
const VERIFY_ONLY = has('--verify');
const JSON_OUT = has('--json');
const VERIFY_BACKUP = path.resolve(arg('--backup', arg('--out', path.join(DSH_ROOT, '_archive', `upgrade-pre-${TS}`))));

const log = (...a) => console.log(...a);
const num = (n) => Number(n).toLocaleString('en-US');
const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const readJsonSafe = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
function cmd(file, args, opts = {}) {
  try {
    const r = spawnSync(file, args, { encoding: 'utf8', shell: process.platform === 'win32', timeout: 900000, ...opts });
    return { ok: r.status === 0, status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
  } catch (e) { return { ok: false, status: -1, stdout: '', stderr: String(e.message) }; }
}
/** 遍历目录 → [{rel, abs, bytes, mtime}]（跟随 junction/链接，与 09-11 备份口径一致） */
function walk(dir, base = dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let isDir = e.isDirectory();
    if (e.isSymbolicLink()) { try { isDir = fs.statSync(full).isDirectory(); } catch { isDir = false; } }
    if (isDir) walk(full, base, out);
    else {
      let st; try { st = fs.statSync(full); } catch { continue; }
      out.push({ rel: path.relative(base, full).split(path.sep).join('/'), abs: full, bytes: st.size, mtime: st.mtime.toISOString() });
    }
  }
  return out;
}
const relOf = (abs, base) => path.relative(base, abs).split(path.sep).join('/');
/** 3080 是否有监听 —— netstat 为主判据（原生命令，无 shell 引号问题），powershell 兜底 */
function detectPort3080() {
  const b = cmd('netstat', ['-ano']);
  if (b.ok && b.stdout) {
    const m = /[:.]3080\s+\S+\s+LISTENING\s+(\d+)/im.exec(b.stdout);
    return m ? parseInt(m[1], 10) !== 0 : false;   // netstat 跑通：有监听 → true，无 → false
  }
  const a = cmd('powershell', ['-NoProfile', '-NonInteractive', '-Command', '"@((Get-NetTCPConnection -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue) | Measure-Object).Count"']);
  const t = String(a.stdout || '').trim().replace(/^\uFEFF/, '').replace(/^"|"$/g, '');
  if (/^\d+$/.test(t)) return t !== '0';
  return null;   // 两法都不通 → 未知（不许错报 false）
}

// ---------------------------------------------------------------------------
// 1. --verify：只读对账（快照自身完整性 + 与生产逐位比对）
// ---------------------------------------------------------------------------
if (VERIFY_ONLY) {
  const BK = VERIFY_BACKUP;
  const mp = path.join(BK, 'manifest.json');
  log('=========================================================');
  log(' 「升级前一刻」快照 · 校验（只读，零写入）');
  log('---------------------------------------------------------');
  log(` 快照包 : ${BK}`);
  if (!fs.existsSync(mp)) {
    console.error(`[ABORT] 找不到 manifest.json：${mp}\n        （用 --backup <dir> 指定快照目录）`);
    process.exitCode = 2;
  } else {
    const M = JSON.parse(fs.readFileSync(mp, 'utf8'));
    log(` 建于   : ${M.createdAt}（设备 ${M.device}）`);
    log(` 主包   : ${M.mainPackage?.name}@${M.mainPackage?.version}`);
    log('=========================================================');
    const res = { ok: 0, miss: 0, extra: 0, shaBad: 0, sizeBad: 0 };
    // --- A. 快照自身完整性（manifest.files[] ↔ 磁盘） ---
    log('\n[A] 快照自身完整性（manifest.files ↔ 磁盘）');
    const onDisk = walk(BK).filter((f) => f.rel !== 'manifest.json');
    const diskMap = new Map(onDisk.map((f) => [f.rel, f]));
    const listed = new Set();
    for (const f of M.files || []) {
      listed.add(f.rel);
      const d = diskMap.get(f.rel);
      if (!d) { res.miss++; log(`  ✗ 缺失 ${f.rel}`); continue; }
      if (d.bytes !== f.bytes) { res.sizeBad++; log(`  ✗ 大小不符 ${f.rel}（磁盘 ${d.bytes} / 清单 ${f.bytes}）`); continue; }
      const h = sha256(d.abs);
      if (h === f.sha256) res.ok++;
      else { res.shaBad++; log(`  ✗ sha 不符 ${f.rel}（磁盘 ${h.slice(0, 12)} / 清单 ${f.sha256.slice(0, 12)}）`); }
    }
    for (const d of onDisk) if (!listed.has(d.rel)) { res.extra++; log(`  ✗ 多余文件（清单里没有）${d.rel}`); }
    log(`  → 一致 ${num(res.ok)} / 缺失 ${res.miss} / sha 不符 ${res.shaBad} / 大小不符 ${res.sizeBad} / 多余 ${res.extra}`);

    // --- B. 与生产对账（manifest.targets ↔ 生产现状） ---
    log('\n[B] 与生产对账（快照基线 ↔ 当前生产）');
    const d1 = { same: 0, diff: 0, missing: 0 };
    for (const t of M.targets || []) {
      const p = t.live;
      if (!fs.existsSync(p)) { d1.missing++; log(`  ! 生产缺失 ${t.kind} ${p}`); continue; }
      const st = fs.statSync(p);
      if (st.isDirectory()) continue;
      const h = sha256(p);
      if (h === t.sha256) d1.same++;
      else { d1.diff++; log(`  ! 与基线不同 ${t.kind} ${p}\n      现值 ${h.slice(0, 12)} / 基线 ${t.sha256.slice(0, 12)}`); }
    }
    log(`  → 锚点一致 ${d1.same} / 与基线不同 ${d1.diff} / 生产缺失 ${d1.missing}`);

    // --- C. 主包树 / 插件实体逐文件对账（大清单） ---
    for (const [label, file, liveRoot] of [
      ['主包树', path.join(BK, 'mainpkg', 'tree-files.json'), M.mainPackage?.installDir],
      ['插件实体', path.join(BK, 'plugins', 'entity-files.json'), M.plugins?.entitiesDir],
    ]) {
      if (!fs.existsSync(file) || !liveRoot || !fs.existsSync(liveRoot)) { log(`\n[C] ${label} 清单或生产目录不可用 → 跳过`); continue; }
      const list = JSON.parse(fs.readFileSync(file, 'utf8'));
      const live = new Map(walk(liveRoot).map((f) => [f.rel, f]));
      let same = 0, diff = 0, missing = 0, extra = 0;
      const diffs = [];
      for (const [rel, meta] of Object.entries(list.files || {})) {
        const l = live.get(rel);
        if (!l) { missing++; if (diffs.length < 10) diffs.push(`缺失 ${rel}`); continue; }
        if (l.bytes !== meta.bytes || sha256(l.abs) !== meta.sha256) { diff++; if (diffs.length < 10) diffs.push(`不同 ${rel}`); }
        else same++;
      }
      for (const rel of live.keys()) if (!(rel in (list.files || {}))) { extra++; if (diffs.length < 10) diffs.push(`新增 ${rel}`); }
      log(`\n[C] ${label} 逐文件对账（${num(Object.keys(list.files || {}).length)} 条基线 vs ${num(live.size)} 个现文件）`);
      log(`  → 一致 ${num(same)} / 内容不同 ${diff} / 生产缺失 ${missing} / 生产新增 ${extra}`);
      if (diffs.length) log('  样例:\n      ' + diffs.join('\n      '));
    }
    const bad = res.miss + res.extra + res.shaBad + res.sizeBad;
    log('\n=========================================================');
    log(` 结论：快照自身 ${bad === 0 ? '✅ 完整（逐文件 sha 全对）' : `✗ 有 ${bad} 处问题`}`);
    log('=========================================================');
    if (JSON_OUT) log('\n' + JSON.stringify({ mode: 'verify', backup: BK, snapshotIntegrity: res, productionTargets: d1 }, null, 2));
    process.exitCode = bad ? 4 : 0;
  }
}

// ---------------------------------------------------------------------------
// 2. 采集（--apply 与 dry-run 共用；dry-run 不写）
// ---------------------------------------------------------------------------
if (!VERIFY_ONLY) {
  const stats = { copied: 0, skipped: 0, changed: 0, bytes: 0 };
  const writes = [];       // 计划/已写入
  const planned = [];      // dry-run 预测用（APPLY 时 manifest 以磁盘 walk 为准）
  function ensureDir(d) { if (APPLY) fs.mkdirSync(d, { recursive: true }); }
  /** 幂等复制：内容相同即跳过；返回 'same' | 'new' | 'changed' */
  function put(src, dstRel) {
    const dst = path.join(OUT, dstRel);
    if (!fs.existsSync(src)) throw new Error(`源缺失：${src}`);
    const sh = sha256(src);
    const st = fs.statSync(src);
    planned.push({ rel: dstRel, bytes: st.size, mtime: st.mtime.toISOString(), sha256: sh });
    if (fs.existsSync(dst)) {
      const dh = sha256(dst);
      if (dh === sh) { stats.skipped++; return 'same'; }
      if (APPLY) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
      stats.changed++; stats.bytes += st.size;
      return 'changed';
    }
    if (APPLY) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
    stats.copied++; stats.bytes += st.size;
    return 'new';
  }
  /** 写文本（幂等：内容相同跳过） */
  function putText(text, dstRel) {
    const dst = path.join(OUT, dstRel);
    const buf = Buffer.from(text, 'utf8');
    const sh = crypto.createHash('sha256').update(buf).digest('hex');
    planned.push({ rel: dstRel, bytes: buf.length, mtime: new Date().toISOString(), sha256: sh, predicted: !APPLY });
    if (fs.existsSync(dst)) {
      const dh = sha256(dst);
      if (dh === sh) { stats.skipped++; return 'same'; }
      if (APPLY) fs.writeFileSync(dst, buf);
      stats.changed++;
      return 'changed';
    }
    if (APPLY) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, buf); }
    stats.copied++;
    return 'new';
  }

  // 目标目录守卫 -------------------------------------------------------------
  const preExisting = fs.existsSync(OUT) && fs.existsSync(path.join(OUT, 'manifest.json'));
  const preManifest = preExisting ? readJsonSafe(path.join(OUT, 'manifest.json')) : null;
  // 幂等关键：首次确定后不再变（README / manifest 共用，保证重跑逐字节稳定）
  const CREATED_AT = preManifest?.createdAt || new Date().toISOString();
  const nonEmpty = fs.existsSync(OUT) && fs.readdirSync(OUT).length > 0;
  if (nonEmpty && !preExisting && !FORCE) {
    console.error(`\n[ABORT] 目标目录已存在且不是本脚本产出的快照：${OUT}\n        换 --ts / --out，或加 --force`);
    process.exitCode = 2;
  } else if (nonEmpty && !preExisting && FORCE && !APPLY) {
    log(`\n[注意] 目标目录非空（${OUT}）—— 已给 --force`);
  } else if (preExisting) {
    log(`\n[刷新模式] 目标已是快照（建于 ${preManifest.createdAt}）→ 逐文件比对，相同即跳过`);
  }

  log('=========================================================');
  log(' 「升级前一刻」快照');
  log('---------------------------------------------------------');
  log(` 模式     : ${APPLY ? 'APPLY（写入）' : 'DRY-RUN（只打印计划，零写入）'}`);
  log(` 时间戳   : ${TS}`);
  log(` 产出     : ${OUT}`);
  log(` DSH home : ${DSH_HOME}`);
  log(` profile  : ${PROFILE_DIR}`);
  log(` 选项     : 整树 tar ${WANT_TREE ? '开' : '关'} / 实体副本 ${WANT_ENTITIES ? '开' : '关'}`);
  log('=========================================================');

  const targets = [];   // 生产锚点：{kind, live, snap, sha256, bytes, mtime}
  const notes = [];
  function anchor(kind, live, snapRel) {
    if (!fs.existsSync(live)) { notes.push(`缺：${live}`); return null; }
    const st = fs.statSync(live);
    if (st.isDirectory()) return null;   // 目录不参与逐文件锚点（主包树/实体走各自的 files 清单）
    const rec = { kind, live, snap: snapRel, bytes: st.size, mtime: st.mtime.toISOString(), sha256: sha256(live) };
    targets.push(rec);
    return rec;
  }

  // ---------- ② profile 四件套 ----------
  log('\n[② ] profile 四件套');
  const FOUR = [
    ['package.json', 'profile/package.json'],
    ['pnpm-lock.yaml', 'profile/pnpm-lock.yaml'],
    ['cordis.patch.yml', 'profile/cordis.patch.yml'],
    ['node_modules/.package-map.json', 'profile/node_modules-package-map.json'],
  ];
  for (const [srcRel, dstRel] of FOUR) {
    const src = path.join(PROFILE_DIR, srcRel);
    if (!fs.existsSync(src)) { console.error(`  [FAIL] 缺失：${src}`); process.exitCode = 2; }
    else { const r = put(src, dstRel); anchor('profile', src, dstRel); writes.push({ dstRel, r }); log(`  ${r === 'same' ? '=' : '+'} ${srcRel.padEnd(34)} ${num(fs.statSync(src).size)} B ${sha256(src).slice(0, 12)}  [${r}]`); }
  }

  // ---------- ④ 关键配置 ----------
  log('\n[④ ] 关键配置');
  const CFG = [
    ['settings.yaml', path.join(DSH_HOME, 'settings.yaml'), 'config/settings.yaml'],
    ['butler-autonomy.json', path.join(DSH_HOME, 'butler-autonomy.json'), 'config/butler-autonomy.json'],
    ['guard.mjs', path.join(DSH_ROOT, 'guard.mjs'), 'config/guard.mjs'],
    ['guard-core.mjs', path.join(DSH_ROOT, 'guard-core.mjs'), 'config/guard-core.mjs'],
    ['guard-ctl.mjs', path.join(DSH_ROOT, 'guard-ctl.mjs'), 'config/guard-ctl.mjs'],
    ['guard-http.mjs', path.join(DSH_ROOT, 'guard-http.mjs'), 'config/guard-http.mjs'],
    ['repair.mjs', path.join(DSH_ROOT, 'repair.mjs'), 'config/repair.mjs'],
    ['repair-ctl.mjs', path.join(DSH_ROOT, 'repair-ctl.mjs'), 'config/repair-ctl.mjs'],
  ];
  const PRESET_NAMES = (() => {
    const a = arg('--presets');
    if (a) return String(a).split(',');
    const dir = path.join(DSH_HOME, '.agent-presets');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  })();
  const presetDir = path.join(DSH_HOME, '.agent-presets');
  for (const name of PRESET_NAMES) {
    for (const f of ['agent.cordis.yml', 'preset.yml', 'custom-bash.mjs', 'tool-bootstrap.mjs', 'NOTICE']) {
      const src = path.join(presetDir, name, f);
      if (fs.existsSync(src)) CFG.push([`.agent-presets/${name}/${f}`, src, `config/presets/${name}/${f}`]);
    }
  }
  for (const [label, src, dstRel] of CFG) {
    if (!fs.existsSync(src)) { notes.push(`缺：${src}`); log(`  - ${label.padEnd(38)} 不存在，跳过`); continue; }
    const r = put(src, dstRel);
    anchor(label, src, dstRel);
    log(`  ${r === 'same' ? '=' : '+'} ${label.padEnd(38)} ${num(fs.statSync(src).size)} B ${sha256(src).slice(0, 12)}  [${r}]`);
  }

  // ---------- ① 主包 ----------
  log('\n[① ] 主包');
  const npmRootCmd = cmd('npm', ['root', '-g']);
  const npmGlobalRoot = npmRootCmd.ok && npmRootCmd.stdout ? npmRootCmd.stdout : path.join(process.env.APPDATA || '', 'npm', 'node_modules');
  const mainDir = path.join(npmGlobalRoot, '@deepseek-ai', 'dsh');
  const binDir = path.dirname(npmGlobalRoot);
  if (!fs.existsSync(mainDir)) { console.error(`  [FAIL] 主包目录不存在：${mainDir}`); process.exitCode = 2; }
  const mpj = readJsonSafe(path.join(mainDir, 'package.json')) || {};
  const verCmd = cmd('dsh', ['--version']);
  log(`  ${mpj.name}@${mpj.version}（dsh --version → ${verCmd.stdout || 'n/a'}）`);
  log(`  安装目录 ${mainDir}`);

  // 主包逐文件清单（大清单单独落文件）
  const treeList = walk(mainDir);
  const treeFiles = {};
  for (const f of treeList) treeFiles[f.rel] = { bytes: f.bytes, mtime: f.mtime, sha256: sha256(f.abs) };
  const treeJson = JSON.stringify({ root: mainDir, count: treeList.length, files: treeFiles });
  const rTreeJson = putText(treeJson, 'mainpkg/tree-files.json');
  log(`  ${rTreeJson === 'same' ? '=' : '+'} tree-files.json ${num(treeList.length)} 文件 / ${mb(treeList.reduce((s, f) => s + f.bytes, 0))}  [${rTreeJson}]`);

  // 主包 meta
  const shims = [];
  for (const n of ['dsh', 'dsh.cmd', 'dsh.ps1']) {
    const p = path.join(binDir, n);
    if (fs.existsSync(p)) { const r = put(p, `mainpkg/bin/${n}`); shims.push({ name: n, live: p, snap: `mainpkg/bin/${n}`, bytes: fs.statSync(p).size, sha256: sha256(p) }); anchor(`bin-${n}`, p, `mainpkg/bin/${n}`); log(`  ${r === 'same' ? '=' : '+'} mainpkg/bin/${n} ${num(fs.statSync(p).size)} B  [${r}]`); }
  }

  // tarball（npm pack；优先复用快照内已有 → 幂等）
  let tarball = null;
  const tgzDirAbs = path.join(OUT, 'mainpkg', 'tarballs');
  const wantTgz = `deepseek-ai-dsh-${mpj.version}.tgz`;
  const insideTgz = path.join(tgzDirAbs, wantTgz);
  const existTgz = (() => {
    if (fs.existsSync(insideTgz)) return insideTgz;
    for (const e of fs.readdirSync(archRootExists() ? path.join(DSH_ROOT, '_archive') : DSH_ROOT, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      const c = path.join(DSH_ROOT, '_archive', e.name, 'mainpkg', 'tarballs', wantTgz);
      if (fs.existsSync(c)) return c;
    }
    return null;
  })();
  function archRootExists() { return fs.existsSync(path.join(DSH_ROOT, '_archive')); }
  if (existTgz) {
    const r = existTgz === insideTgz ? (stats.skipped++, 'same') : put(existTgz, `mainpkg/tarballs/${wantTgz}`);
    tarball = { file: `mainpkg/tarballs/${wantTgz}`, source: existTgz === insideTgz ? 'in-snapshot' : `reused:${existTgz}`, bytes: fs.statSync(APPLY ? insideTgz : existTgz).size, sha256: sha256(APPLY ? insideTgz : existTgz) };
    log(`  ${r === 'same' ? '=' : '+'} tarball ${existTgz === insideTgz ? '快照内已有（幂等复用）' : `复用已有：${existTgz}`}  [${r}]`);
  } else if (APPLY) {
    ensureDir(tgzDirAbs);
    const pk = cmd('npm', ['pack', `${mpj.name}@${mpj.version}`, '--pack-destination', tgzDirAbs]);
    const got = fs.existsSync(tgzDirAbs) ? fs.readdirSync(tgzDirAbs).find((f) => f.endsWith('.tgz')) : null;
    if (pk.ok && got) {
      tarball = { file: `mainpkg/tarballs/${got}`, source: 'npm-pack', bytes: fs.statSync(path.join(tgzDirAbs, got)).size, sha256: sha256(path.join(tgzDirAbs, got)) };
      stats.copied++;
      log(`  + tarball npm pack 成功：${got}`);
    } else log(`  ! tarball npm pack 失败：${(pk.stderr || '').split('\n')[0]}`);
  } else {
    log(`  ~ tarball 将在 --apply 时 npm pack（_archive 下未找到 ${wantTgz}）`);
  }

  // 整树 tar（离线回退主力）
  let tree = null;
  const treeDirAbs = path.join(OUT, 'mainpkg', 'tree');
  const treeTarAbs = path.join(treeDirAbs, `dsh-${mpj.version}-tree.tar.gz`);
  if (WANT_TREE) {
    if (fs.existsSync(treeTarAbs)) {
      tree = { file: relOf(treeTarAbs, OUT), bytes: fs.statSync(treeTarAbs).size, sha256: sha256(treeTarAbs), archiveRoot: path.basename(mainDir), extractTo: path.dirname(mainDir), sourceFiles: treeList.length, sourceBytes: treeList.reduce((s, f) => s + f.bytes, 0), note: '本次快照内已有 → 幂等复用' };
      stats.skipped++;
      log(`  = mainpkg/tree/${path.basename(treeTarAbs)} 已在快照内，幂等复用（${mb(tree.bytes)}）`);
    } else if (APPLY) {
      ensureDir(treeDirAbs);
      log(`  … 主包整树打包（含依赖闭包，本步最慢）`);
      const t0 = Date.now();
      // bsdtar 不认带 @ 前缀的路径 → -C 到 @deepseek-ai 下打包 dsh 子目录
      const scopeDir = path.dirname(mainDir);
      const r = cmd('tar', ['-czf', treeTarAbs, '-C', scopeDir, path.basename(mainDir)]);
      if (r.ok && fs.existsSync(treeTarAbs)) {
        tree = { file: relOf(treeTarAbs, OUT), bytes: fs.statSync(treeTarAbs).size, sha256: sha256(treeTarAbs), archiveRoot: path.basename(mainDir), extractTo: scopeDir, sourceFiles: treeList.length, sourceBytes: treeList.reduce((s, f) => s + f.bytes, 0), seconds: +((Date.now() - t0) / 1000).toFixed(1), restoreHint: `tar -xzf <backupDir>\\${relOf(treeTarAbs, OUT).replace(/\//g, '\\')} -C "${scopeDir}"（解压前先移走现有 @deepseek-ai\\dsh）` };
        stats.copied++;
        log(`  + 整树快照 ${mb(tree.bytes)}（源 ${num(tree.sourceFiles)} 文件 / ${mb(tree.sourceBytes)}，${tree.seconds}s）`);
      } else { notes.push(`整树 tar 失败：${(r.stderr || '').split('\n')[0]}`); log(`  ✗ 整树快照失败：${(r.stderr || '').split('\n')[0]}`); }
    } else {
      log(`  ~ 主包整树 tar 将在 --apply 时生成（约 1-2 分钟）`);
    }
  } else log('  - 跳过整树 tar（--no-tree）');

  // 冗余副本登记（同版本、别处已有的整树 tar，只登记不复制）
  const redundant = [];
  const archRoot = path.join(DSH_ROOT, '_archive');
  if (fs.existsSync(archRoot)) {
    for (const e of fs.readdirSync(archRoot, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^upgrade-/.test(e.name)) continue;
      const cand = path.join(archRoot, e.name, 'mainpkg', 'tree', `dsh-${mpj.version}-tree.tar.gz`);
      if (fs.existsSync(cand) && path.resolve(cand) !== path.resolve(treeTarAbs)) {
        redundant.push({ dir: path.join(archRoot, e.name), tar: cand, bytes: fs.statSync(cand).size, sha256: sha256(cand) });
      }
    }
  }
  if (redundant.length) { log(`  · 冗余整树副本 ${redundant.length} 份（同版本，别处已有）:`); for (const r of redundant) log(`      ${r.tar} ${mb(r.bytes)} sha ${r.sha256.slice(0, 12)}`); }

  const mainPackage = {
    name: mpj.name || '@deepseek-ai/dsh',
    version: mpj.version || null,
    versionCommand: verCmd.ok ? verCmd.stdout : null,
    installDir: mainDir,
    npmGlobalRoot,
    binDir,
    binShims: shims,
    dependencies: mpj.dependencies || {},
    sourceTree: { files: treeList.length, bytes: treeList.reduce((s, f) => s + f.bytes, 0) },
    tree,
    redundantTrees: redundant,
    tarball,
    rollbackPriority: [
      `① 整树快照离线还原（首选，无需网络）：${tree ? tree.restoreHint : tree && tree.note ? tree.note : '（本次未生成 → 用 --no-tree 之外的冗余副本或 tarball）'}`,
      `② tarball 安装：${tarball ? `npm install -g <backupDir>\\${tarball.file.replace(/\//g, '\\')}` : '（本次未生成）'}`,
      `③ 联网安装：npm install -g ${mpj.name || '@deepseek-ai/dsh'}@${mpj.version}`,
    ],
  };

  // ---------- ③ 插件实体 ----------
  log('\n[③ ] 插件实体');
  const nm = path.join(PROFILE_DIR, 'node_modules');
  const entities = [];
  const nonPkg = [];
  if (fs.existsSync(nm)) {
    const take = (pkgDir, rel) => {
      const pj = readJsonSafe(path.join(pkgDir, 'package.json'));
      const st = walk(pkgDir);
      if (!pj) { nonPkg.push({ rel, files: st.length, bytes: st.reduce((s, f) => s + f.bytes, 0) }); return; }
      entities.push({ name: pj.name || rel, version: pj.version || null, rel, files: st.length, bytes: st.reduce((s, f) => s + f.bytes, 0), dir: pkgDir });
    };
    for (const e of fs.readdirSync(nm, { withFileTypes: true })) {
      const full = path.join(nm, e.name);
      const lst = fs.lstatSync(full);
      if (!lst.isDirectory() && !lst.isSymbolicLink()) continue;
      if (e.name.startsWith('@')) {
        for (const s of fs.readdirSync(full, { withFileTypes: true })) {
          if (s.name.startsWith('.') || s.name === 'node_modules') continue;
          const sp = path.join(full, s.name);
          const sl = fs.lstatSync(sp);
          if (!sl.isDirectory() && !sl.isSymbolicLink()) continue;
          take(sp, `${e.name}/${s.name}`);
        }
      } else take(full, e.name);
    }
    entities.sort((a, b) => a.name.localeCompare(b.name));
  }
  log(`  实体包 ${entities.length} 个 + 非包目录 ${nonPkg.length} 个`);
  for (const e of entities) log(`      ${e.name.padEnd(42)} ${String(e.version).padEnd(12)} ${num(e.files).padStart(6)} 文件 ${mb(e.bytes)}`);

  // 实体逐文件清单
  const entList = walk(nm);
  const entFiles = {};
  for (const f of entList) entFiles[f.rel] = { bytes: f.bytes, mtime: f.mtime, sha256: sha256(f.abs) };

  // 形态登记：live 里的符号链接 / junction（副本内以解引用后的实体内容保存 → 回滚脚本据此提示形态差异）
  const liveLinks = [];
  if (fs.existsSync(nm)) {
    const collect = (d, depth = 0) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        let lst; try { lst = fs.lstatSync(full); } catch { continue; }
        if (lst.isSymbolicLink()) {
          let target = null, broken = false;
          try { target = fs.readlinkSync(full); } catch { }
          try { fs.realpathSync(full); } catch { broken = true; }
          liveLinks.push({ rel: relOf(full, nm), target, broken });
        } else if (lst.isDirectory() && depth < 1) collect(full, depth + 1);
      }
    };
    collect(nm);
    if (liveLinks.length) log(`  · 形态登记：node_modules 内 ${liveLinks.length} 个链接（junction；副本为解引用后的实体内容，回滚会提示形态差异）`);
  }
  const entJson = JSON.stringify({ root: nm, count: entList.length, files: entFiles });
  const rEntJson = putText(entJson, 'plugins/entity-files.json');
  log(`  ${rEntJson === 'same' ? '=' : '+'} entity-files.json ${num(entList.length)} 文件 / ${mb(entList.reduce((s, f) => s + f.bytes, 0))}  [${rEntJson}]`);

  // 实体副本（全量，幂等逐文件）
  if (WANT_ENTITIES) {
    const t0 = Date.now();
    let copied = 0;
    for (const f of entList) {
      const r = put(f.abs, `plugins/entities/node_modules/${f.rel}`);
      if (r !== 'same') copied++;
    }
    log(`  ${copied === 0 ? '=' : '+'} plugins/entities/node_modules ${num(entList.length)} 文件 / ${mb(entList.reduce((s, f) => s + f.bytes, 0))}（本次改动 ${num(copied)} 个，${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  } else log('  - 跳过实体副本（--no-entities）');

  // 副本对账（三类 + R5）
  log('\n[③b] 副本对账');
  const copies = { pairs: [], samePkgMultipleCopies: [], r5: null, summary: {} };
  // 对账 1：自研插件源码仓（tools）↔ profile 实体 —— "两处副本"
  const repoPairs = [
    ['dsh-task-board-local', 'dsh-task-board-local'],
    ['dsh-butler-panel', 'dsh-butler-panel'],
    ['dsh-ecosystem-panel', 'dsh-ecosystem-panel'],
    ['session-title-live', 'dsh-session-title-live'],
    ['dsh-archive-sessions', 'dsh-archive-sessions'],
    ['dsh-memory-local', 'dsh-memory'],
  ];
  let pairSame = 0, pairDiff = 0, pairMissing = 0;
  for (const [repo, pkg] of repoPairs) {
    const rDir = path.join(TOOLS_DIR, repo), lDir = path.join(nm, pkg);
    if (!fs.existsSync(rDir) || !fs.existsSync(lDir)) {
      copies.pairs.push({ repo, pkg, status: 'missing', repoExists: fs.existsSync(rDir), liveExists: fs.existsSync(lDir) });
      if (fs.existsSync(rDir) || fs.existsSync(lDir)) pairMissing++;
      continue;
    }
    const files = [];
    for (const f of ['lib/index.js', 'lib/client.js', 'package.json', 'lib/host-adapter.js', 'lib/host-adapter.mjs']) {
      const a = path.join(rDir, f), b = path.join(lDir, f);
      if (!fs.existsSync(a) && !fs.existsSync(b)) continue;
      const ha = fs.existsSync(a) ? sha256(a) : null, hb = fs.existsSync(b) ? sha256(b) : null;
      files.push({ file: f, repo: ha, live: hb, same: ha === hb });
    }
    const allSame = files.every((f) => f.same);
    if (allSame) pairSame++; else pairDiff++;
    copies.pairs.push({ repo, pkg, status: allSame ? 'same' : 'diff', files });
    log(`  ${allSame ? '✅' : '❌'} ${repo} ↔ ${pkg}  ${files.map((f) => `${f.file}${f.same ? '=' : '≠'}`).join(' ')}`);
  }
  copies.summary.pairs = { same: pairSame, diff: pairDiff, missing: pairMissing };

  // 对账 2：同一个包在 node_modules 里出现多处（如 dsh-task-control / .bak-0.4.2）
  const byName = new Map();
  for (const e of entities) { if (!byName.has(e.name)) byName.set(e.name, []); byName.get(e.name).push(e); }
  for (const [name, list] of byName) {
    if (list.length > 1) {
      copies.samePkgMultipleCopies.push({ name, copies: list.map((x) => ({ rel: x.rel, version: x.version, files: x.files, mainSha: (() => { const p = path.join(x.dir, 'lib', 'index.js'); return fs.existsSync(p) ? sha256(p) : null; })() })) });
      log(`  ⚠ 同包多处：${name} × ${list.length} → ${list.map((x) => `${x.rel}@${x.version}`).join(' , ')}`);
    }
  }

  // 对账 3：web 实体 ↔ 中层 profiles\node_modules 同名（junction 指向）
  const midNm = path.join(DSH_HOME, 'profiles', 'node_modules');
  let junctionCount = 0, midEntityCount = 0, brokenLinks = 0;
  if (fs.existsSync(midNm)) {
    const scan = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        const lst = fs.lstatSync(full);
        if (lst.isSymbolicLink()) {
          junctionCount++;
          try { fs.realpathSync(full); } catch { brokenLinks++; }
        } else if (lst.isDirectory()) {
          if (fs.existsSync(path.join(full, 'package.json'))) midEntityCount++;
          else scan(full);
        }
      }
    };
    scan(midNm);
  }
  copies.middleLayer = { dir: midNm, junctions: junctionCount, entityPackages: midEntityCount, brokenLinks };
  log(`  · 中层 profiles\\node_modules：junction ${num(junctionCount)} 个 / 实体包 ${midEntityCount} 个 / 断链 ${brokenLinks} 个`);

  // 对账 4：R5 宿主适配层副本一致性（**复用既有判定，不重写**）
  try {
    const mod = await import('file://' + path.join(TOOLS_DIR, 'sync-host-adapter.mjs').replace(/\\/g, '/'));
    const r5fn = mod.verifySummary || mod.adapterVerifySummary || null;
    if (typeof r5fn === 'function') {
      const r5 = r5fn();
      copies.r5 = { source: 'tools/sync-host-adapter.mjs#verifySummary', level: r5.level, note: r5.note, sha: r5.sha ?? null, total: r5.total ?? null, inSync: r5.inSync ?? null };
      log(`  ${r5.level === 'ok' ? '✅' : '🔴'} R5 适配层副本：${r5.note}`);
    } else {
      const src = path.join(TOOLS_DIR, 'lib', 'host-adapter.mjs');
      copies.r5 = { source: 'fallback', level: 'unknown', note: '同步器未导出 verifySummary', sourceSha: fs.existsSync(src) ? sha256(src) : null };
      log(`  · R5 判定函数不可用 → 记唯一源 sha ${String(copies.r5.sourceSha).slice(0, 12)}`);
    }
  } catch (e) {
    copies.r5 = { source: 'error', level: 'unknown', note: `导入失败：${e.message}` };
    log(`  · R5 检查器不可用（${e.message}）`);
  }

  const plugins = {
    entitiesDir: nm,
    entityCount: entities.length,
    packages: entities.map(({ dir, ...rest }) => rest),
    nonPackageDirs: nonPkg,
    declaredDependencies: (readJsonSafe(path.join(PROFILE_DIR, 'package.json')) || {}).dependencies || {},
    declaredBundles: (() => { const pj = readJsonSafe(path.join(PROFILE_DIR, 'package.json')) || {}; return pj.dsh?.profile?.bundles || pj.dsh?.bundles || null; })(),
    snapshot: WANT_ENTITIES ? { dir: 'plugins/entities/node_modules', files: entList.length, bytes: entList.reduce((s, f) => s + f.bytes, 0) } : null,
    entityFilesList: 'plugins/entity-files.json',
    links: liveLinks,
    copies,
    note: '「实体」= profiles\\web\\node_modules 下的实际包版本（方案 §1.2/§1.3 口径）；copies 段 = 副本对账',
  };

  // ---------- 状态登记（只读） ----------
  const autonomy = readJsonSafe(path.join(DSH_HOME, 'butler-autonomy.json'));
  const progPath = path.join(DSH_HOME, 'upgrade-progress.json');
  const lockPath = path.join(DSH_HOME, 'upgrade-lock');
  const sessionsDir = path.join(DSH_HOME, 'sessions');
  const sesFiles = walk(sessionsDir);
  const state = {
    autonomyGates: {
      path: path.join(DSH_HOME, 'butler-autonomy.json'),
      gates: autonomy ? { p5AutoRollbackEnabled: autonomy.p5AutoRollbackEnabled, autoHealEnabled: autonomy.autoHealEnabled, p0AutoRestartEnabled: autonomy.p0AutoRestartEnabled, p3AutoEnabled: autonomy.p3AutoEnabled } : null,
      requiredDuringUpgrade: '四项必须保持 false（方案 §4.1①）',
    },
    upgradeProgress: {
      path: progPath, exists: fs.existsSync(progPath), raw: readJsonSafe(progPath),
      lockPath, lockExists: fs.existsSync(lockPath),
      verdict: fs.existsSync(progPath) ? '存在 → 上次升级中断，先按该文件判定落点' : '不存在 → 无中断落点，可直接升级',
    },
    sessions: { dir: sessionsDir, files: sesFiles.length, bytes: sesFiles.reduce((s, f) => s + f.bytes, 0), note: '只登记元数据；会话本体不进本快照（09-11 资产包已有全量留档，升级不改会话格式）' },
    env: { hostname: os.hostname(), user: os.userInfo().username, node: process.version, dshHome: DSH_HOME, profileDir: PROFILE_DIR, dshRoot: DSH_ROOT, port: 3080, productionRunning: detectPort3080() },
  };
  log('\n[状态登记]');
  log(`  四门：${JSON.stringify(state.autonomyGates.gates)}`);
  log(`  中断落点：${state.upgradeProgress.verdict}`);
  log(`  会话元数据：${num(state.sessions.files)} 文件 / ${mb(state.sessions.bytes)}（只登记）`);
  log(`  3080 生产运行中：${state.env.productionRunning}`);

  // ---------- README + 回滚脚本副本 ----------
  const restoreSrc = path.join(TOOLS_DIR, 'restore-upgrade-pre.mjs');
  if (fs.existsSync(restoreSrc)) {
    const r = put(restoreSrc, 'restore-upgrade-pre.mjs');
    log(`\n  ${r === 'same' ? '=' : '+'} restore-upgrade-pre.mjs（回滚脚本副本）[${r}]`);
  } else notes.push('回滚脚本 tools\\restore-upgrade-pre.mjs 不存在 → 包内未含回滚脚本');

  const readme = buildReadme({ TS, OUT, mainPackage, plugins, targets, state, WANT_TREE, WANT_ENTITIES, createdAt: CREATED_AT });
  const rReadme = putText(readme, 'README.md');
  log(`  ${rReadme === 'same' ? '=' : '+'} README.md  [${rReadme}]`);

  // ---------- 总清单 + manifest ----------
  const diskFiles = walk(OUT).filter((f) => f.rel !== 'manifest.json')
    .map((f) => ({ rel: f.rel, bytes: f.bytes, mtime: f.mtime, sha256: sha256(f.abs) }));
  const files = (() => {
    if (APPLY) return diskFiles;
    // dry-run：以"计划写入清单"预测（此时 manifest 尚未落盘）
    const have = new Set(diskFiles.map((f) => f.rel));
    const seen = new Set();
    const extra = [];
    for (const p of planned) {
      if (have.has(p.rel) || seen.has(p.rel)) continue;
      seen.add(p.rel);
      extra.push({ rel: p.rel, bytes: p.bytes, mtime: p.mtime, sha256: p.sha256 });
    }
    return diskFiles.concat(extra);
  })();
  const changedCount = stats.changed + stats.copied;
  const refreshedAt = changedCount > 0 ? new Date().toISOString() : (preManifest?.refreshedAt || CREATED_AT);
  const refreshHistory = (preManifest?.refreshHistory || []).concat(
    changedCount > 0 ? [{ at: refreshedAt, copied: stats.copied, updated: stats.changed, skipped: stats.skipped }] : []
  );
  const manifest = {
    schemaVersion: 2,
    kind: 'dsh-upgrade-pre-snapshot',
    createdBy: 'tools/snapshot-upgrade-pre.mjs',
    createdAt: CREATED_AT,
    refreshedAt,
    refreshCount: refreshHistory.length,
    refreshHistory,
    ts: TS,
    device: os.hostname(),
    userProfile: HOME,
    paths: { backupRoot: OUT, dshHome: DSH_HOME, profileDir: PROFILE_DIR, dshRoot: DSH_ROOT },
    mainPackage,
    profile: {},
    plugins,
    targets,
    state,
    notes,
    files,
    totals: { files: files.length, bytes: files.reduce((s, f) => s + f.bytes, 0) },
  };
  for (const [srcRel, dstRel] of FOUR) {
    const src = path.join(PROFILE_DIR, srcRel);
    if (fs.existsSync(src)) manifest.profile[srcRel] = { backup: dstRel, bytes: fs.statSync(src).size, mtime: fs.statSync(src).mtime.toISOString(), sha256: sha256(src) };
  }
  // 幂等：本次零变化 → manifest 不重写（逐字节保持原样）
  if (!APPLY || changedCount > 0 || !preExisting) {
    putText(JSON.stringify(manifest, null, 2), 'manifest.json');
    log(`\n  ${APPLY ? '✓' : '~'} manifest.json 记录 ${num(files.length)} 文件 / ${mb(manifest.totals.bytes)}`);
  } else {
    stats.skipped++;
    log(`\n  = manifest.json 未变 → 幂等跳过（不重写）`);
  }
  log(`  runStats: 新增 ${stats.copied} / 跳过(已一致) ${stats.skipped} / 更新 ${stats.changed}`);

  log('\n=========================================================');
  if (!APPLY) {
    log(' DRY-RUN 结束 —— 未写入任何文件。');
    log(' 要真正建快照：加 --apply');
    log('=========================================================');
    process.exitCode = 3;
  } else {
    log(` ${stats.changed + stats.copied === 0 ? '✅ 幂等：本次零写入（全部文件已与快照一致）' : `✓ 快照已就绪（新增/更新 ${stats.copied + stats.changed} 个文件）`}`);
    log(` 回滚入口：node ${path.join(TOOLS_DIR, 'restore-upgrade-pre.mjs')} --check --backup "${OUT}"`);
    log('=========================================================');
  }
  if (JSON_OUT) log('\n' + JSON.stringify({ mode: APPLY ? 'apply' : 'dry-run', out: OUT, ts: TS, runStats: stats, totals: manifest.totals, mainPackage: `${mainPackage.name}@${mainPackage.version}`, entityCount: plugins.entityCount, tree: mainPackage.tree ? { bytes: mainPackage.tree.bytes, sha256: mainPackage.tree.sha256 } : null, tarball: mainPackage.tarball?.file || null, copies: copies.summary, r5: copies.r5?.note ?? null, notes }, null, 2));
}

// ---------------------------------------------------------------------------
// README 生成
// ---------------------------------------------------------------------------
function buildReadme({ TS, OUT, mainPackage, plugins, targets, state, WANT_TREE, WANT_ENTITIES, createdAt }) {
  const t = (p) => (fs.existsSync(p) ? `${num(fs.statSync(p).size)} B / sha ${sha256(p).slice(0, 12)}` : '（缺）');
  const L = [];
  L.push(`# 「升级前一刻」快照 · upgrade-pre-${TS}`);
  L.push('');
  L.push(`> 生成：${createdAt || new Date().toISOString()}（设备 ${os.hostname()}）`);
  L.push(`> 用途：主包受控升级（\`docs\\升级方案-2026-09-10.md\` §4.1/§4.3）在**部署到生产之前**刷新的回滚点。`);
  L.push(`> 性质：**只读资产**——包里没有任何自动执行的钩子、计划任务或守护进程。`);
  L.push(`> 与 2026-09-11 L1 全量资产包的分工：11 号包是「十天前的老基线」（含会话快照）；本包是「升级前一刻」（只抓会因升级而变的四面）。`);
  L.push('');
  L.push('## 一、包里有什么');
  L.push('');
  L.push('| 路径 | 内容 |');
  L.push('|---|---|');
  L.push(`| \`manifest.json\` | 总索引：${num((targets || []).length)} 个生产锚点 + 全包逐文件 sha256/大小/mtime + 副本对账 |`);
  L.push(`| \`mainpkg/tree/${mainPackage.tree ? path.basename(mainPackage.tree.file) : '（未生成）'}\` | 主包整树快照（离线回退主力）${mainPackage.tree ? ` ${mb(mainPackage.tree.bytes)} sha ${String(mainPackage.tree.sha256).slice(0, 12)}` : ''} |`);
  L.push(`| \`mainpkg/tarballs/\` | npm pack 官方 tarball ${mainPackage.tarball ? `（${path.basename(mainPackage.tarball.file)}，${num(mainPackage.tarball.bytes)} B）` : '（未生成）'} |`);
  L.push(`| \`mainpkg/tree-files.json\` | 主包树逐文件清单（${num(mainPackage.sourceTree?.files ?? 0)} 条 sha256/大小/mtime） |`);
  L.push(`| \`mainpkg/bin/\` | bin 包装器 dsh / dsh.cmd / dsh.ps1 |`);
  L.push(`| \`profile/\` | profile 四件套（package.json / pnpm-lock.yaml / cordis.patch.yml / node_modules-package-map.json） |`);
  L.push(`| \`plugins/entities/node_modules/\` | 插件实体全量副本${plugins.snapshot ? `（${num(plugins.snapshot.files)} 文件 / ${mb(plugins.snapshot.bytes)}）` : '（本次未含，--no-entities）'} |`);
  L.push(`| \`plugins/entity-files.json\` | 插件实体逐文件清单 |`);
  L.push(`| \`config/\` | settings.yaml / 两个 preset / guard*.mjs / butler-autonomy.json |`);
  L.push(`| \`restore-upgrade-pre.mjs\` | 回滚脚本副本（真源 \`tools\\restore-upgrade-pre.mjs\`，两侧同 sha） |`);
  L.push('');
  L.push('## 二、怎么回滚');
  L.push('');
  L.push('```powershell');
  L.push(`$bk = '${OUT}'`);
  L.push(`node tools\\restore-upgrade-pre.mjs --check --backup $bk        # 只读对账（先跑这个）`);
  L.push(`node tools\\restore-upgrade-pre.mjs --all --yes --backup $bk   # 三件套同批还原（需停 DSH）`);
  L.push('```');
  L.push('');
  L.push('双击入口：`桌面\\DSH鲸落地\\restore-upgrade-pre.cmd`');
  L.push('');
  L.push('⚠️ **缺 `--yes` 一律拒写**（fail-closed）；每次还原前，脚本会先把"当时的当前值"存进 `pre-restore-<ts>\\`。');
  L.push('');
  L.push('## 三、基线数值（升级后按此对账）');
  L.push('');
  L.push('| 项 | 基线值 |');
  L.push('|---|---|');
  L.push(`| 主包 | \`${mainPackage.name}\` **${mainPackage.version}**（\`${mainPackage.installDir}\`） |`);
  L.push(`| 主包树 | ${num(mainPackage.sourceTree?.files ?? 0)} 文件 / ${mb(mainPackage.sourceTree?.bytes ?? 0)} |`);
  L.push(`| 插件实体 | ${plugins.entityCount} 个包 / ${plugins.snapshot ? num(plugins.snapshot.files) : '?'} 文件 |`);
  L.push('| profile 四件套 | 见 `manifest.json` → `profile` |');
  L.push(`| 四门（升级全程须保持 false） | ${JSON.stringify(state.autonomyGates.gates)} |`);
  L.push(`| 中断落点 | ${state.upgradeProgress.verdict} |`);
  L.push('');
  L.push('## 四、副本对账（本次实测）');
  L.push('');
  const cp = plugins.copies || {};
  L.push(`- 自研插件「源码仓 ↔ 生产实体」：一致 ${cp.summary?.pairs?.same ?? 0} / 不同 ${cp.summary?.pairs?.diff ?? 0} / 缺一侧 ${cp.summary?.pairs?.missing ?? 0}`);
  for (const p of cp.pairs || []) if (p.status === 'diff') L.push(`  - ❌ \`${p.repo}\` ↔ \`${p.pkg}\`：${p.files.filter((f) => !f.same).map((f) => f.file).join(', ')}`);
  L.push(`- 同包多处：${(cp.samePkgMultipleCopies || []).length ? cp.samePkgMultipleCopies.map((x) => `${x.name}×${x.copies.length}`).join('、') : '无'}`);
  L.push(`- 中层 \`profiles\\node_modules\`：junction ${num(cp.middleLayer?.junctions ?? 0)} / 实体包 ${cp.middleLayer?.entityPackages ?? 0} / 断链 ${cp.middleLayer?.brokenLinks ?? 0}`);
  L.push(`- R5 宿主适配层：${cp.r5?.note ?? '未取到'}`);
  L.push('');
  L.push('## 五、已知边界');
  L.push('');
  L.push('1. **主包回退必须停守护鱼 + DSH**：脚本检测到 3080 在跑会拒绝主包/实体还原（`--force` 仅供 profile/config 面）。');
  L.push('2. **不含会话快照**：会话本体不因此次升级而变；全量留档见 09-11 资产包（盘外快照目录（本机自定））。');
  L.push('3. **快照会随生产漂移**：任何生产改动（插件补丁、配置变更）都会让本基线过时 —— 升级部署前请重跑一次 `snapshot-upgrade-pre.mjs --apply` 刷新。');
  L.push(`4. 整树 tar ${WANT_TREE ? '已生成' : '**本次未生成**（--no-tree）'}；实体副本 ${WANT_ENTITIES ? '已含' : '**本次未含**（--no-entities）'}。`);
  L.push('');
  L.push('*本 README 由 `tools\\snapshot-upgrade-pre.mjs` 自动生成，重跑刷新时会被同步覆盖。*');
  return L.join('\n') + '\n';
}
