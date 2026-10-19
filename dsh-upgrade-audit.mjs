// L0 预检内核 v4（2026-09-23 · 卡 L-11 ③）：目标版 SDK 导出面 vs (新版插件 tarball + 本地已装插件) import 面
//                   + **主包内置包样本**（v4 新增） + 运行时 API 面（在线探针）
//                   + **会话事件词表离线判定**（v3 / T7，2026-09-15）
// 用法: node dsh-upgrade-audit.mjs [tarballsDir]     # 人读报告，输出 _tmp/l0-audit-report.md
//       node dsh-upgrade-audit.mjs --self-test        # 隔离夹具自测（不读样本目录、不联网、不写报告）
// 纯只读，零依赖。
//
// v4 口径变更（为什么）：样本原先是**手工 `npm pack` 的 tarball**，收不到**主包内置包**
//   （`dsh-fs` / `dsh-session` / `dsh-host-webserver` … 都在主包安装目录的 node_modules 里，
//   不单独发 tarball）⇒ 插件 import 它们**恒被判 PKG_ABSENT**，而结论速览把 PKG_ABSENT 渲染成 🔴。
//   实测：`dsh-butler-panel` 的 `await import('@deepseek-ai/dsh-fs')` 被判「包不在目标线」，
//   可 P5 门（fs/write-intent · fs/edit-intent · fs/observed）日常实测好用 ⇒ **假红**。
//   真源：`docs\复查-0.1.5升级遗留全面自查-20260923.md` §3-F3。
//   现口径 = **两级样本**：① tarball 命中优先（那才是目标线本体）；② tarball 没收到的包，
//   从**主包安装目录**（`%APPDATA%\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai`，
//   可用 `DSH_AUDIT_BUILTIN_ROOT` 覆盖）惰性取面，判成「内置包样本」。
//   ⚠️ 内置包样本来自**本机已装主包**（可能与 API_TARGET 不同版）⇒ 报告里显式标注来源与版本，
//   不把它当成「目标线逐字快照」（否则又是一次静默失准）。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
// 2026-09-14 环境边界：profile 根走统一解析（BUTLER_DSH_HOME > DSH_HOME > ~/.dsh）
import { resolveDshHome } from './lib/dsh-home.mjs';

const SELF_TEST = process.argv.includes('--self-test');
const ROOT = (SELF_TEST ? null : process.argv[2]) || path.join(os.homedir(), 'dsh-offsync', 'upgrade-canary', 'tarballs');
const PROFILE = path.join(resolveDshHome(), 'profiles', 'web');
// 运行时 API 面核对的目标线（T7 · 2026-09-10 新增）。
// ⚠️ 随主包目标线更新；也可用 env 覆盖：DSH_API_TARGET=0.1.5-rc.1
const API_TARGET = process.env.DSH_API_TARGET || '0.1.5-rc.1';
const UA = 'dsh-upgrade-audit/3.0 (dsh long-term task; contact: local)';

// ---------- 工具 ----------
function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs|cjs|d\.ts)$/.test(e.name)) out.push(p);
  }
  return out;
}
/** 模块名 → 包名（剥子路径，如 @s/n/client → @s/n） */
function pkgOf(mod) {
  const parts = mod.split('/');
  return mod.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

const EXPORT_RES = [
  /export\s+declare\s+(?:abstract\s+)?(?:function|class|const|let|var)\s+([A-Za-z0-9_$]+)/g,
  /export\s+(?:abstract\s+)?class\s+([A-Za-z0-9_$]+)/g,
  /export\s+(?:interface|type|enum)\s+([A-Za-z0-9_$]+)/g,
  /export\s*\{([^}]+)\}(?:\s*from\s*['"][^'"]+['"])?/g,
  /export\s+default\s+([A-Za-z0-9_$]+)/g
];
function extractExports(dir) {
  const syms = new Set();
  for (const f of walk(dir)) {
    const rel = f.replace(/\\/g, '/');
    if (!/\/(lib|src|dist)\//.test(rel)) continue;
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const re of EXPORT_RES) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(src))) {
        if (re.source.includes('\\{')) {
          for (const part of m[1].split(',')) {
            const t = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop().trim();
            if (/^[A-Za-z0-9_$]+$/.test(t)) syms.add(t);
          }
        } else if (m[1] && /^[A-Za-z0-9_$]+$/.test(m[1])) syms.add(m[1]);
      }
    }
  }
  return syms;
}

const IMPORT_RE = /(?:import\s+(?:type\s+)?(?:([A-Za-z0-9_$]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*|require\(\s*|import\(\s*)['"](@deepseek-ai\/[^'"]+)['"]/g;
function scanImports(dir) {
  const mods = new Map();
  for (const f of walk(dir)) {
    let src;
    try { src = fs.readFileSync(f, 'utf8'); } catch { continue; }
    IMPORT_RE.lastIndex = 0;
    let m;
    while ((m = IMPORT_RE.exec(src))) {
      const mod = m[3];
      if (!mods.has(mod)) mods.set(mod, { symbols: new Set(), default: false, files: new Set() });
      const rec = mods.get(mod);
      rec.files.add(path.relative(dir, f).replace(/\\/g, '/'));
      if (m[1]) rec.default = true;
      if (m[2]) {
        for (const part of m[2].split(',')) {
          const t = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/)[0].trim();
          if (/^[A-Za-z0-9_$]+$/.test(t)) rec.symbols.add(t);
        }
      }
    }
  }
  return mods;
}
function readPkg(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); } catch { return null; }
}

// ---------- 0. 样本层 + 判定唯一入口（2026-09-23 · 卡 L-11 ③；主流程与 --self-test 共用） ----------
/** 目标 SDK 样本表：包名 → { version, exports }（由 main 从 tarball 填充；tarball = 目标线本体） */
const sdk = new Map();
/** 主包内置包样本根：tarball 收不到的那批（dsh-fs / dsh-session / dsh-host-webserver …） */
const BUILTIN_ROOT = process.env.DSH_AUDIT_BUILTIN_ROOT
  || path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai');
const MAIN_PKG_DIR = path.join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@deepseek-ai', 'dsh');
const MAIN_VERSION = readPkg(MAIN_PKG_DIR)?.version ?? null;
const builtinCache = new Map();
/** 命中「内置包样本」的判定条数（报告里自证用了几次） */
let builtinHitRows = 0;

/**
 * 惰性取「主包内置包」样本 —— 只有 tarball 没收到的包才走这里（不为 195 个包装一遍 exports）。
 * @returns {{version:string, exports:Set<string>}|null} 目录不存在 / 包名不符 / 读不到 ⇒ null（不算样本）
 */
function builtinSample(pk, root = BUILTIN_ROOT) {
  const key = root + '|' + pk;
  if (builtinCache.has(key)) return builtinCache.get(key);
  let rec = null;
  try {
    const dir = path.join(root, pk.slice('@deepseek-ai/'.length));
    const j = readPkg(dir);
    if (j?.name === pk) rec = { version: j.version, exports: extractExports(dir) };
  } catch { /* 目录/权限问题一律视为"无此样本"，不抛 */ }
  builtinCache.set(key, rec);
  return rec;
}

/**
 * **判定唯一入口**：一条 import → 一行判定。样本两级 = tarball（目标线本体）优先 ⇒ 主包内置包（v4 新增）。
 * ⚠️ 内置包样本**同样逐符号核对**，不因"内置"就放行（缺符号照报 BROKEN）。
 * @param {{group:string,name:string,version:string,dir:string}} subject 被测插件
 * @param {string} mod 被 import 的模块名（@deepseek-ai/…）
 * @param {{symbols:Set<string>,default:boolean,files:Set<string>}} rec 该 import 的符号面
 * @param {{sdkMap?:Map<string,{version:string,exports:Set<string>}>, builtinRoot?:string}} [opt] self-test 注入
 */
function judgeImport(subject, mod, rec, opt = {}) {
  const sdkMap = opt.sdkMap ?? sdk;
  const builtinRoot = opt.builtinRoot ?? BUILTIN_ROOT;
  const pk = pkgOf(mod);
  const sub = mod.slice(pk.length) || '';
  const tgz = sdkMap.get(pk);
  const b = tgz ? null : builtinSample(pk, builtinRoot);
  const sample = tgz ? { version: tgz.version, exports: tgz.exports, source: 'tarball' }
    : (b ? { version: b.version, exports: b.exports, source: 'builtin' } : null);
  if (!sample) {
    return { ...subject, mod, pk, sub, src: null, targetVer: null, verdict: 'PKG_ABSENT', missing: [...rec.symbols], used: [...rec.symbols] };
  }
  if (sample.source === 'builtin') builtinHitRows += 1;
  const missing = [...rec.symbols].filter((x) => !sample.exports.has(x));
  return {
    ...subject, mod, pk, sub, src: sample.source, targetVer: sample.version,
    verdict: missing.length ? 'BROKEN' : (rec.symbols.size ? 'OK' : 'BARE'),
    missing, used: [...rec.symbols]
  };
}

// ---------- main：主流程（`--self-test` 时整段跳过） ----------
async function main() {
// ---------- 1. SDK 导出面（来自目标版 tarball） ----------
for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const pdir = path.join(ROOT, d.name, 'package');
  const j = readPkg(pdir);
  if (!j?.name) continue;
  if (!j.name.startsWith('@deepseek-ai/')) continue;
  sdk.set(j.name, { version: j.version, exports: extractExports(pdir) });
}

// ---------- 2/3. 两组被测插件 ----------
const subjects = []; // { group, name, version, dir }
for (const d of fs.readdirSync(ROOT, { withFileTypes: true })) {
  if (!d.isDirectory()) continue;
  const pdir = path.join(ROOT, d.name, 'package');
  const j = readPkg(pdir);
  if (!j?.name || j.name.startsWith('@deepseek-ai/')) continue;
  subjects.push({ group: '新版(tarball)', name: j.name, version: j.version, dir: pdir });
}
const localPkg = readPkg(PROFILE);
for (const name of Object.keys(localPkg?.dependencies ?? {})) {
  const dir = path.join(PROFILE, 'node_modules', ...name.split('/'));
  const j = readPkg(dir);
  if (!j?.name) continue;
  subjects.push({ group: '本地已装', name: j.name, version: j.version, dir });
}

// ---------- 4. 比对（判定唯一入口 = judgeImport：tarball 样本 → 主包内置包样本） ----------
const rows = [];
for (const s of subjects) {
  for (const [mod, rec] of scanImports(s.dir)) rows.push(judgeImport(s, mod, rec));
}

// ---------- 5. 报告 ----------
const L = [];
// PKG_ABSENT 语义（2026-09-10 修正 · 2026-09-23 v4 收紧）：指「**两级样本**（tarball + 主包内置包）
//   里都没有这个包」。v4 之前只有 tarball 一级 ⇒ 主包内置包（dsh-fs / dsh-session / dsh-host-webserver …）
//   恒被判 PKG_ABSENT（实测 dsh-butler-panel → dsh-fs 那条 = 假红，而 P5 门日常实测好用）。
//   仍降为 🟡 而非 🔴：样本并非"目标线逐字快照"（tarball 手工 pack、内置包取自本机已装主包），
//   真实结论以下方「运行时 API 面核对」段与本地实测为准。
const ICON = { BROKEN: '🔴', PKG_ABSENT: '🟡', BARE: '🟡', OK: '🟢' };
L.push(`# L0 兼容预检报告（目标：主包 ${API_TARGET} 线）`);
L.push('');
L.push(`生成: ${new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`);
L.push(`SDK 样本: ${[...sdk.keys()].length} 个包（源自 npm tarball）`);
L.push(`内置包样本: 主包 ${MAIN_VERSION ?? '?'} @ \`${BUILTIN_ROOT}\`${fs.existsSync(BUILTIN_ROOT) ? '' : '（**目录不存在** ⇒ 本段无效，PKG_ABSENT 可能只是样本缺失）'}｜本轮命中 ${builtinHitRows} 条 import 判定`);
L.push(`> ⚠️ 内置包样本取自**本机已装主包**（${MAIN_VERSION ?? '?'}），与目标线 \`${API_TARGET}\` **可能不同版**：它只补「tarball 收不到的包」这类盲区，`);
L.push(`> **不是**目标线逐字快照 ⇒ 差异结论仍以「运行时 API 面核对」段与本地实测为准（样本口径见文件头 v4 说明）。`);
L.push('');
L.push('## 目标 SDK 导出面');
for (const [n, v] of sdk) L.push(`- ${n}@${v.version} — ${v.exports.size} 个导出符号`);
L.push('');
for (const g of ['新版(tarball)', '本地已装']) {
  const rs = rows.filter((r) => r.group === g);
  if (!rs.length) continue;
  L.push(`## ${g} 插件 → 目标 SDK 判定`);
  L.push('');
  L.push('| 插件 | 版本 | 依赖模块 | 样本 | 判定 | 缺失符号 |');
  L.push('|---|---|---|---|---|---|');
  const order = { BROKEN: 0, PKG_ABSENT: 1, BARE: 2, OK: 3 };
  for (const r of rs.sort((a, b) => (order[a.verdict] - order[b.verdict]) || a.name.localeCompare(b.name) || a.mod.localeCompare(b.mod))) {
    L.push(`| ${r.name} | ${r.version} | \`${r.mod}\` | ${r.src === 'builtin' ? `内置 ${r.targetVer ?? ''}`.trim() : (r.src ?? '—')} | ${ICON[r.verdict]} ${r.verdict} | ${r.missing.join(', ') || '—'} |`);
  }
  L.push('');
}
L.push('## 结论速览');
const broken = rows.filter((r) => r.verdict === 'BROKEN' || r.verdict === 'PKG_ABSENT');
if (!broken.length) L.push('- 无 🔴 断裂项');
else for (const r of broken) L.push(`- 🔴 ${r.group} ${r.name}@${r.version} → \`${r.mod}\`${r.missing.length ? ' 缺: ' + r.missing.join(', ') : ' 包不在两级样本（tarball + 主包内置包）'}`);
// ---------- 6. 运行时 API 面核对（T7 · 2026-09-10 新增） ----------
// 为什么要有这一段（补 L0 盲区）：
//   本脚本原先只比对「插件 import 的符号」——而**零 import、只走运行时 ctx API** 的自研插件
//   （大管家面板 / 生态面板）在审计里**完全不可见**；且样本从未包含
//   `dsh-fs` / `dsh-host-webserver` / `dsh-session`（fs/* 门、webServer.register、会话词表全在盲区）。
// 做法：对我方**登记的运行时 API**（事件名 / 方法）直接从目标线 npm 源码做存在性探针。
//   登记表：`docs\自研插件运行时API登记表.md`（新增 API 时同步登记，本段才会覆盖到）
const PROBES = [
  { pkg: '@deepseek-ai/dsh-fs', file: 'lib/types/index.d.ts',
    symbols: ["'fs/write-intent'", "'fs/edit-intent'", "'fs/observed'"],
    users: 'butler-panel P5 A 层门' },
  { pkg: '@deepseek-ai/dsh-tools', file: 'lib/types/index.d.ts',
    symbols: ["'tools/pre-execute'"],
    users: 'butler-panel P5 A+ 层门' },
  { pkg: '@deepseek-ai/dsh-host-webserver', file: 'lib/types/index.d.ts',
    symbols: ['register(route', 'registerUpgrade', 'registerFallback'],
    users: '面板 / 看板 / 归档 host 路由' },
  // ⚠️ `@deepseek-ai/dsh-session` **不在此表**（2026-09-15 · T7 移出）。
  //    原先这里硬编码了 4 个事件名（`assistant/chunk` / `tool/code-dispatch(-start)` …）——
  //    主包一改名，**探针自己就成了"静默失准"的一份子**：把"已改名"报成"🔴 缺失"，
  //    还要人读报告才知道该怎么改。现在改走**离线词表守卫**（下方「会话事件词表」段）：
  //    名字来自宿主适配层唯一源（跟着代码走），判定用本地目标线样本 + 改名映射。
  { pkg: '@deepseek-ai/dsh-settings', file: 'lib/types/index.d.ts',
    symbols: ['installSection', 'installSettingsSection', 'settingsNamespace'],
    users: 'task-board-local settings 适配' },
];

L.push(`## 运行时 API 面核对（目标线 ${API_TARGET}）`);
L.push('');
L.push('> 补 L0 盲区：原先只比 import 符号 → 零 import 插件（大管家 / 生态面板）与 `dsh-fs` / `dsh-host-webserver` / `dsh-session` 从未覆盖。');
L.push('> 探针 = 直接取目标线 npm 包源码，检查**我方登记的运行时 API** 是否仍在。登记表：`docs\\自研插件运行时API登记表.md`');
L.push('');
L.push('| 包 | 符号 | 使用方 | 判定 |');
L.push('|---|---|---|---|');
for (const p of PROBES) {
  let text = '';
  let reachable = false;
  try {
    const res = await fetch(`https://unpkg.com/${p.pkg}@${API_TARGET}/${p.file}`, { headers: { 'user-agent': UA } });
    if (res.ok) {
      text = await res.text();
      reachable = true;
    }
  } catch {
    /* 保持 unreachable */
  }
  for (const s of p.symbols) {
    const verdict = !reachable ? '🟡 UNREACH' : (text.includes(s) ? '🟢 在' : '🔴 缺失');
    L.push(`| \`${p.pkg}\` | \`${s}\` | ${p.users} | ${verdict} |`);
  }
}
L.push('');
L.push('> ⚠️ `🔴 缺失` 有两种成因：**已改名**（如 `assistant/chunk` → `assistant/attempt`）或**已删除**（如 `installSettingsSection`）。'); // vocab-guard: allow 这行是说明文案，不是判定路径
L.push('> 两者都必须人工确认替代符号后再改代码 —— 前者改名字即可，后者要换 API（见升级方案 §3 P0）。');
L.push('');

// ---------- 6.5 会话事件词表（离线判定 · 2026-09-15 T7 新增） ----------
// 为什么单列一段（补本脚本最后一块盲区）：
//   在线探针只能回答"目标线文件里**有没有这个字符串**"，回答不了三件真正要紧的事：
//   ① 我**方登记**了哪些事件名（写死的探针符号表会漏、会过时）；
//   ② 哪些名字是**改名**（有兼容映射）而不是删除；③ 哪些名字跨线消失且**无替代路径**（= 静默失准）。
// 做法：把判定交给 `tools\dsh-vocab-guard.mjs`（判定唯一源），本段只渲染。
//   名字来源 = 宿主适配层唯一源 `tools\lib\host-adapter.mjs`｜判定 = 本地两线词表 + legacyName 映射。
L.push('## 会话事件词表（离线判定 · T7）');
L.push('');
try {
  const { inspectVocab } = await import('./dsh-vocab-guard.mjs');
  const v = await inspectVocab();
  if (!v.ok) {
    L.push(`- 🟡 离线样本不可用：${v.reason}`);
    L.push('- ⇒ 本段**无结论**（不使用在线探针顶替：它只看字符串在不在，区分不了"改名"与"删除"，会误导）。');
    L.push('- 补样本：`npm pack @deepseek-ai/dsh-session@<目标版本>` 解压后，用 `--new <包目录>` 跑词表守卫。');
  } else {
    const interesting = v.judgeRows.filter((r) => r.verdict !== 'OK' && r.verdict !== 'NA');
    const gone = v.judgeRows.filter((r) => r.verdict === 'GONE');
    L.push(`- 现网线：\`@deepseek-ai/dsh-session@${v.oldSide.version ?? '?'}\`｜目标线：\`@deepseek-ai/dsh-session@${v.newSide.version ?? '?'}\``);
    L.push(`- 词表差异：目标线**删除 ${v.diff.removed.length}** / **新增 ${v.diff.added.length}** / 改名候选 ${v.renames.length}`);
    if (v.diff.removed.length) L.push(`- 删除项：${v.diff.removed.map((x) => `\`${x}\``).join('、')}`);
    L.push('');
    if (!interesting.length) L.push('- 🟢 我方登记事件名全部有替代路径（映射或族判定）');
    else {
      L.push('| 我方登记事件名 | 现网线 | 目标线 | 判定 | 说明 |');
      L.push('|---|---|---|---|---|');
      const ICON2 = { GONE: '🔴', MAPPED: '🟡', FAMILY: '🟡', 'NEW-ONLY': '🟢' };
      for (const r of interesting) {
        L.push(`| \`${r.type}\` | ${r.inOld ? '在' : '无'} | ${r.inNew ? '在' : '无'} | ${ICON2[r.verdict] ?? '⚪'} ${r.verdict} | ${r.note} |`);
      }
    }
    L.push('');
    L.push(`> ${gone.length ? `🔴 **${gone.length} 项跨线消失且无替代 → 升级后静默失准**（升级前必须收口）` : '🟢 无跨线消失且无替代的登记名'}`);
    L.push('> 完整报告（含"写死已删名字"的代码位置扫描与 R4 对账）：`node tools\\dsh-vocab-guard.mjs`');
  }
} catch (e) {
  L.push(`- 🟡 词表守卫不可用：${e?.message ?? e}（本段缺省，不影响报告其余段落）`);
}
L.push('');

const out = L.join('\n');
fs.writeFileSync(path.join(os.homedir(), '.dsh', '_tmp', 'l0-audit-report.md'), out, 'utf8');
console.log(out);
} // ---------- main 结束 ----------

// ---------- 7. --self-test（隔离夹具：不读样本目录、不联网、不写报告） ----------
// 目的：把「两级样本判定」这条判据钉住 —— 尤其「内置包样本**同样逐符号核对**」（不因内置就放行）
// 与「真缺符号仍报 BROKEN」。改本判据前先跑它，红了说明判据被改瞎了。
if (SELF_TEST) {
  const results = [];
  const t = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'l0-audit-selftest-'));
  try {
    const mk = (dir, json) => {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(json), 'utf8');
    };
    const mkSrc = (dir, rel, body) => {
      const p = path.join(dir, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, body, 'utf8');
    };

    // 夹具 ①：tarball 样本（@deepseek-ai/pkg-a，2 个符号）
    const tgzA = path.join(base, 'tarballs', 'pkg-a');
    mk(tgzA, { name: '@deepseek-ai/pkg-a', version: '1.0.0' });
    mkSrc(tgzA, 'lib/index.d.ts', 'export declare function alpha(): void;\nexport declare function beta(): void;\n');
    // 夹具 ②：主包内置包样本（@deepseek-ai/pkg-b 有 1 个符号；pkg-c 另有；pkg-x 目录名不符）
    const bi = path.join(base, 'builtin');
    mk(path.join(bi, 'pkg-b'), { name: '@deepseek-ai/pkg-b', version: '2.0.0' });
    mkSrc(path.join(bi, 'pkg-b'), 'lib/index.d.ts', 'export declare function gamma(): void;\n');
    mk(path.join(bi, 'pkg-c'), { name: '@deepseek-ai/pkg-c', version: '3.0.0' });
    mkSrc(path.join(bi, 'pkg-c'), 'lib/index.d.ts', 'export declare function delta(): void;\n');
    const wrong = path.join(base, 'builtin-wrong', 'pkg-x');
    mk(wrong, { name: '@deepseek-ai/other', version: '9.9.9' });

    const sdkMap = new Map();
    sdkMap.set('@deepseek-ai/pkg-a', { version: '1.0.0', exports: extractExports(tgzA) });
    const subject = { group: '本地已装', name: 'fixture-plugin', version: '0.0.1', dir: base };
    const sym = (...names) => ({ symbols: new Set(names), default: false, files: new Set() });
    const J = (mod, rec, root = bi) => judgeImport(subject, mod, rec, { sdkMap, builtinRoot: root });

    const r1 = J('@deepseek-ai/pkg-a', sym('alpha'));
    t('tarball 样本命中 + 符号齐 ⇒ OK（src=tarball）', r1.verdict === 'OK' && r1.src === 'tarball', `${r1.verdict}/${r1.src}`);
    const r2 = J('@deepseek-ai/pkg-a', sym('alpha', 'nonexistent'));
    t('tarball 样本缺符号 ⇒ BROKEN（真缺符号仍报红）', r2.verdict === 'BROKEN' && r2.missing.includes('nonexistent'), r2.verdict);
    const r3 = J('@deepseek-ai/pkg-b', sym('gamma'));
    t('tarball 无 · 内置有 · 符号齐 ⇒ OK（src=builtin，dsh-fs 那类）', r3.verdict === 'OK' && r3.src === 'builtin', `${r3.verdict}/${r3.src}`);
    const r4 = J('@deepseek-ai/pkg-b', sym('gamma', 'nowhere'));
    t('内置样本缺符号 ⇒ BROKEN（内置**不豁免**核对）', r4.verdict === 'BROKEN' && r4.src === 'builtin', r4.verdict);
    const r5 = J('@deepseek-ai/pkg-c', sym());
    t('无命名符号 ⇒ BARE（不是 OK，也不是 PKG_ABSENT）', r5.verdict === 'BARE', r5.verdict);
    const r6 = J('@deepseek-ai/pkg-missing', sym('x'));
    t('两级样本都无 ⇒ PKG_ABSENT', r6.verdict === 'PKG_ABSENT' && r6.src === null, `${r6.verdict}/${r6.src}`);
    const r7 = J('@deepseek-ai/pkg-b', sym('gamma'), path.join(base, '__no_such_builtin__'));
    t('内置根不可用 ⇒ 降级 PKG_ABSENT（不崩、不抛）', r7.verdict === 'PKG_ABSENT', r7.verdict);
    const r8 = J('@deepseek-ai/pkg-x', sym('whatever'), path.join(base, 'builtin-wrong'));
    t('内置目录名与包名不符 ⇒ 不认作样本（PKG_ABSENT）', r8.verdict === 'PKG_ABSENT', r8.verdict);
    t('判定带出样本版本', r3.targetVer === '2.0.0' && r2.targetVer === '1.0.0' && r5.targetVer === '3.0.0');
    t('判定带出被 import 的符号面', r2.used.includes('alpha') && r2.missing.length === 1);
  } finally {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  for (const r of results) if (!r.ok) console.error('  ✗ ' + r.name + (r.extra ? '  [' + r.extra + ']' : ''));
  const failed = results.filter((r) => !r.ok);
  console.log(`${failed.length === 0 ? '✅' : '❌'} dsh-upgrade-audit --self-test ${results.length - failed.length}/${results.length}` + (failed.length ? `（失败 ${failed.length}）` : ''));
  process.exitCode = failed.length === 0 ? 0 : 1;
}

if (!SELF_TEST) await main();
