#!/usr/bin/env node
/**
 * upgrade-triage-cli.mjs —— 「升级档位」唯一入口（只读 · 缓存优先 · 白名单零副作用）
 *
 * 施工卡：①-4「①-4 档位单源」（① 控制室口径包 · P-4）
 * 口径真源：`docs\控制室口径包-方案-20260917.md` §3.4（P-4 · 升级档位单源）+ §5 判据 4 + §6 表 1/表 3
 *
 * 【为什么存在】
 *   升级档位原本有**两份**实现：生态面板 `dsh-ecosystem-panel\lib\upgrade.js`（自算红黄绿）
 *   与 `tools\lib\upgrade-triage.mjs`（判定唯一源）。本 CLI 把判定唯一源包成**只读入口**，
 *   面板改为「取 CLI 的档位 → 渲染」，从此**面板不再自算三色**（冻结项④：唯一档位源 = triage 经只读 CLI）。
 *
 * 【判定不复制】
 *   本文件**不含任何定档逻辑**：判据一律走 `lib\upgrade-triage.mjs` 的 `triageUpgrade()`，
 *   输入采集一律走 `lib\upgrade-inputs.mjs`（决策表解析也在那里，不在此重写）。
 *   ⚠️ 硬约束（方案 §3.4-1）：**不得 import `dsh-upgrade-orchestrator.mjs`**（那个会真跑升级链）。
 *
 * 【缓存优先（默认 --cache-only）】
 *   · 不查网、不 spawn 长任务（`RUN_TIMEOUT_MS = 180_000` 的 `dsh-upgrade-audit.mjs` 一律不跑）；
 *   · npm 版本取**面板现有 24h 文件缓存**（`~/.dsh/ecosystem-panel-upgrade-cache.json`，结构 `{at,latest,highest}`）
 *     —— 注意：该缓存结构与 triage 输入**不同源**（①包轮五 E15 实测），故此处有一层**结构映射**
 *     （见 `mapPanelNpmCache()`），不是"直接复用"；
 *   · L0 断裂符号取**既有审计报告**（`<root>\_tmp\l0-audit-report.md`，只读、不 spawn）；
 *   · `--refresh` 才真采（spawn 审计 + 查 npm）。
 *
 * 【零副作用（白名单式 · 方案 §3.4-1 硬约束）】
 *   默认（cache-only）路径**不写任何文件**（连自己的缓存都不写；npm 缓存归面板）。
 *   `--refresh` 真采路径的写入白名单**仅两处**（照方案 E15 补正的清单）：
 *     ① `<root>\_tmp\`      —— 审计脚本自己的报告输出；
 *     ② `os.tmpdir()`       —— 升级体检脚本的 `--json` 输出。
 *   除这两处外本 CLI 不写任何生产路径；**不声称"跑前后全盘 mtime 不变"**（那是被推翻的 v1 断言）。
 *
 * 【档位可用性（本卡拍定 · 方案未定义，落地时定的口径，已写进交付报告）】
 *   `available = 决策表可用 && 目标版本可判 && triage 证据缺口为空`
 *   · 任一条不满足 ⇒ `available:false` + `unavailableReason`，**由面板渲染成「档位不可用（原因）」**，
 *     绝不渲染颜色。依据：①包 §6 表 3「档位…逃生舱 = **缓存缺失即显'不可用'**」；
 *     且 triage 是 fail-closed 的（证据缺口 → tier=red），若照 red 上屏就会变成
 *     09-17 A5 卡那种**假红**（面板误报 2 个红标）。故此处把"证据缺口"与"真判红"分开。
 *   · `tier` 字段**永远照 triage 原样输出**（不隐藏、不改写）——"也能出档位"（方案 §5 判据②）；
 *     是否允许上屏是由 `available` 决定的**渲染口径**，不是对判定的改写。
 *
 * 【退出码】0 = 出结果（含"档位不可用"）；2 = 用法错误；3 = 输入整体不可解析（连包清单都拿不到）。
 *   收尾一律 `process.exitCode`（本机铁律：禁 `process.exit()`，Windows libuv 断言）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const CLI_VERSION = '1.0.0';
export const TIER_SOURCE = 'upgrade-triage';

const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));   // …\tools
const DEFAULT_ROOT = process.env.DSH_ROOT || path.dirname(HERE);             // …\DSH
const DEFAULT_TOOLS = process.env.DSH_TOOLS_DIR || path.join(DEFAULT_ROOT, 'tools');

function dshHome() {
  const override = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  if (override && override.trim()) return path.resolve(override.trim());
  return path.join(os.homedir(), '.dsh');
}

/** 解析参数（fail-closed：不认识的参数直接拒，避免静默走默认路径）。 */
export function parseArgs(argv = []) {
  const o = {
    json: false, help: false, refresh: false, input: null, pkgs: [],
    root: DEFAULT_ROOT, toolsDir: DEFAULT_TOOLS, home: dshHome(),
    decisionTable: null, auditReport: null, tarballs: null, npmCacheFile: null,
    timeoutMs: 60_000,
  };
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) { unknown.push(`${a}（缺参数值）`); return null; }
      i += 1; return v;
    };
    if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--refresh') o.refresh = true;
    else if (a === '--cache-only') o.refresh = false;              // 默认即此，显式给出也接受
    else if (a === '--input') o.input = val();
    else if (a === '--pkg') { const v = val(); if (v) o.pkgs.push(...v.split(',').map((s) => s.trim()).filter(Boolean)); }
    else if (a === '--root') { const v = val(); if (v) o.root = v; }
    else if (a === '--tools-dir') { const v = val(); if (v) o.toolsDir = v; }
    else if (a === '--home') { const v = val(); if (v) o.home = v; }
    else if (a === '--decision-table') o.decisionTable = val();
    else if (a === '--audit-report') o.auditReport = val();
    else if (a === '--tarballs') o.tarballs = val();
    else if (a === '--npm-cache') o.npmCacheFile = val();
    else if (a === '--timeout-ms') { const v = Number(val()); if (Number.isFinite(v) && v > 0) o.timeoutMs = v; }
    else unknown.push(a);
  }
  if (o.decisionTable === null) o.decisionTable = path.join(o.root, 'docs', '插件升级决策表.md');
  if (o.auditReport === null) o.auditReport = path.join(o.root, '_tmp', 'l0-audit-report.md');
  if (o.npmCacheFile === null) o.npmCacheFile = path.join(o.home, 'ecosystem-panel-upgrade-cache.json');
  if (o.tarballs === null) o.tarballs = process.env.DSH_L0_TARBALLS || path.join(os.homedir(), 'dsh-offsync', 'upgrade-canary', 'tarballs');
  return { ok: unknown.length === 0, opts: o, unknown };
}

export const USAGE = `升级档位唯一入口（只读 · 缓存优先）

用法：
  node tools/upgrade-triage-cli.mjs [--json] [--pkg <名>[,<名>]] [--input <文件|->] [--refresh]

参数：
  --json                机器可读输出（面板用；人类默认为文本表）
  --pkg <名>            只判这些包（默认：--input 里的包，或本地 profile + npm 缓存并集）
  --input <文件|->      注入输入 JSON（面板把"同一份缓存输入"经 stdin 传进来；- = 读 stdin）
  --refresh             真采（spawn 审计 + 查 npm）；默认 cache-only：不查网、不跑长任务
  --root <目录>         DSH 根（默认由本文件位置推）
  --tools-dir <目录>    工具目录（默认 <root>/tools）
  --home <目录>         DSH 数据根（默认 BUTLER_DSH_HOME > DSH_HOME > ~/.dsh）
  --decision-table <f>  决策表路径（默认 <root>/docs/插件升级决策表.md）
  --audit-report <f>    L0 审计报告（默认 <root>/_tmp/l0-audit-report.md，只读不 spawn）
  --tarballs <目录>     目标版 tarball 样本（仅 --refresh 用）
  --npm-cache <f>       面板 npm 缓存文件（默认 <home>/ecosystem-panel-upgrade-cache.json）
  --timeout-ms <n>      内部采集超时（默认 60000）
  --help                本帮助

只读承诺：cache-only 路径不写任何文件；--refresh 的写入白名单仅 <root>\\_tmp\\ 与 os.tmpdir()。
退出码：0 出结果（含"档位不可用"）/ 2 用法错误 / 3 输入整体不可解析。`;

// ---------------------------------------------------------------------------
// 结构映射层（①包轮五 E15：面板缓存 ≠ triage 输入结构，必须映射）
// ---------------------------------------------------------------------------
/**
 * 面板 npm 24h 缓存 `{at, latest:{名:版本}, highest:{名:版本}}` → 每包目标版本。
 * @returns {{ok:boolean, at:number|null, ageMs:number|null, names:string[], targetOf:(n:string)=>string|null, reason:string}}
 */
export function mapPanelNpmCache(cache) {
  const latest = (cache && typeof cache === 'object' && cache.latest && typeof cache.latest === 'object') ? cache.latest : null;
  const highest = (cache && typeof cache === 'object' && cache.highest && typeof cache.highest === 'object') ? cache.highest : null;
  if (!latest && !highest) return { ok: false, at: null, ageMs: null, names: [], targetOf: () => null, reason: '面板 npm 缓存结构不可解析（缺 latest/highest）' };
  const at = typeof cache.at === 'number' ? cache.at : null;
  const names = [...new Set([...Object.keys(highest ?? {}), ...Object.keys(latest ?? {})])].sort();
  return {
    ok: true, at, ageMs: at === null ? null : Date.now() - at, names,
    // 口径：highest 优先（npm latest 标签不一定是最高版本，主包实测 latest=0.1.5-rc.1 / highest=0.1.6-alpha.1）
    targetOf: (n) => (highest?.[n] ?? latest?.[n] ?? null),
    reason: '',
  };
}

// ---------------------------------------------------------------------------
// 输入采集
// ---------------------------------------------------------------------------
/** 读面板 npm 缓存文件（只读；不存在/坏 → ok:false，绝不猜）。 */
export function readPanelNpmCache(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ...mapPanelNpmCache(j), file, exists: true };
  } catch (e) {
    return { ok: false, at: null, ageMs: null, names: [], targetOf: () => null, file, exists: false, reason: `npm 缓存读不到（${e?.code === 'ENOENT' ? '文件不存在' : String(e?.message ?? e)}）` };
  }
}

/** 本地插件事实（无 --input 时的独立模式）：与面板 `collectLocalFacts` 同口径 —— 实体 package.json 优先。 */
function collectLocalFacts(profileDir) {
  const pkgFile = path.join(profileDir, 'package.json');
  let pkg = null;
  try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch { return { ok: false, reason: `profile package.json 读不到：${pkgFile}`, packages: [] }; }
  const nm = path.join(profileDir, 'node_modules');
  const packages = [];
  for (const [name, declared] of Object.entries(pkg?.dependencies ?? {})) {
    const seg = name.startsWith('@') ? name.split('/') : [name];
    let entityVersion = null;
    try { entityVersion = JSON.parse(fs.readFileSync(path.join(nm, ...seg, 'package.json'), 'utf8'))?.version ?? null; } catch { /* 实体缺失 */ }
    const isLink = typeof declared === 'string' && declared.startsWith('link:');
    packages.push({
      name, declared, isLink,
      entityVersion,
      localVersion: entityVersion ?? (isLink ? null : (declared ?? null)),
      npmSource: !isLink,   // 自研/link 包无 npm 源；面板侧由规则表修正
    });
  }
  return { ok: packages.length > 0, packages, reason: packages.length ? '' : 'profile dependencies 为空' };
}

/** 读注入输入（面板路径）：文件或 stdin。 */
function readInjectedInput(spec) {
  try {
    const text = spec === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(spec, 'utf8');
    const j = JSON.parse(text);
    if (!j || typeof j !== 'object') return { ok: false, reason: '注入内容不是对象' };
    return { ok: true, input: j };
  } catch (e) {
    return { ok: false, reason: `注入输入读不到/不合法：${String(e?.message ?? e)}` };
  }
}

// ---------------------------------------------------------------------------
// 单包判定
// ---------------------------------------------------------------------------
/**
 * 判一个包（纯函数：输入全在参数里，不读盘）。
 * @returns 见文件头「档位可用性」
 */
export function judgeOne({ pkgFact, npmCache, hostUpgradeRequired = false, shared }) {
  const name = String(pkgFact?.name ?? '').trim();
  const local = pkgFact?.localVersion ?? null;
  const npmSource = pkgFact?.npmSource !== false;      // 默认 true；面板可显式传 false（link/自研）
  const targetFromCache = name ? npmCache.targetOf(name) : null;
  let target = targetFromCache;
  let targetSource = targetFromCache ? 'npm-cache' : null;
  if (!target && !npmSource) { target = null; targetSource = 'none'; }        // 无 npm 源 ⇒ 不涉升级，不算缺口
  if (!target && npmSource && pkgFact?.targetVersion) { target = pkgFact.targetVersion; targetSource = 'input'; }

  const targetOk = targetSource === 'npm-cache' || targetSource === 'input' || targetSource === 'none';

  const patchRegistry = shared.inspectPatchRegistry(name);
  const r = shared.triageUpgrade({
    pkg: { name, localVersion: local, targetVersion: target },
    decisionTable: shared.decisionTable,
    decoupling: shared.decoupling,
    vocabGuard: shared.vocabGuard,
    audit: shared.audit,
    patches: patchRegistry,
    hostUpgradeRequired: hostUpgradeRequired === true,
    // 无远端版本（无 npm 源）⇒ 不存在"升版"，不该被 isMajorJump(缺失) 判成大跳（fail-closed 会误红）
    majorJump: target ? undefined : false,
  });

  const unavailable = [];
  if (!shared.decisionTable.ok) unavailable.push(`决策表不可用（${shared.decisionTable.reason ?? '未采集'}）`);
  if (!targetOk) unavailable.push('目标版本不可判（有 npm 源但缓存里没有该包；--refresh 或等面板刷新缓存）');
  for (const g of r.evidenceGaps) unavailable.push(`证据缺口：${g}`);

  return {
    name,
    local,
    target,
    targetSource,
    tier: r.tier,
    tierLabel: shared.tierLabelOf(r.tier),   // 渲染文案也取自判定的唯一源（面板不再自造标签，防"绿点 + 红文案"矛盾）
    available: unavailable.length === 0,
    unavailableReason: unavailable.length ? [...new Set(unavailable)].join('；') : null,
    reasons: r.reasons,
    evidenceGaps: r.evidenceGaps,
    checks: r.checks,
    hasPatches: r.hasPatches,
    patchReady: r.patchReady,
    patchRegistry: { registered: patchRegistry.registered, count: (patchRegistry.entries ?? []).length, scripts: (patchRegistry.entries ?? []).map((e) => e.script).filter(Boolean) },
    versions: r.versions,
    triageVersion: r.triageVersion,
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
/**
 * 跑一次（可被面板/夹具直接 import 调用；CLI 入口只是它的一层壳）。
 * @param {object} opts parseArgs().opts
 */
export async function runCli(opts) {
  const t0 = Date.now();
  const toolsDir = opts.toolsDir;
  const inputsMod = await import(pathToFileURL(path.join(toolsDir, 'lib', 'upgrade-inputs.mjs')).href);
  const triageMod = await import(pathToFileURL(path.join(toolsDir, 'lib', 'upgrade-triage.mjs')).href);

  // —— 输入①：包清单 + npm 缓存（注入优先；无注入则本地读） ——
  let injected = null;
  if (opts.input) {
    const got = readInjectedInput(opts.input);
    if (!got.ok) return { ok: false, exitCode: 3, error: got.reason };
    injected = got.input;
  }
  const npmCache = injected?.npmCache
    ? { ...mapPanelNpmCache(injected.npmCache), file: '(注入)', exists: true }
    : readPanelNpmCache(opts.npmCacheFile);

  let packages = Array.isArray(injected?.packages) ? injected.packages.slice() : [];
  if (!packages.length) {
    const local = collectLocalFacts(opts.profileDir ?? path.join(opts.home, 'profiles', 'web'));
    if (!local.ok && !npmCache.ok) return { ok: false, exitCode: 3, error: `包清单拿不到：${local.reason}；且 ${npmCache.reason}` };
    const seen = new Set(packages.map((p) => p.name));
    for (const p of local.packages ?? []) { if (!seen.has(p.name)) { packages.push(p); seen.add(p.name); } }
    // npm 缓存里有、本地没装的包（主包等）不判：分级授权不覆盖未安装的包
  }
  if (opts.pkgs.length) packages = packages.filter((p) => opts.pkgs.includes(p.name));

  // —— 输入②：其余判据输入（注入优先 ⇒ 夹具/调用方完全可控；否则真采） ——
  //   ⚠️ 注入口径：`--input` 里的 `inputs.decisionTable / decoupling / vocabGuard / audit / patchesByPkg`
  //     存在即直接用（形状不对时由 triage 侧 fail-closed 消费成"不可用"，本 CLI 不静默兜底）。
  const inj = injected?.inputs ?? {};
  const decisionTable = inj.decisionTable ?? inputsMod.readDecisionTable(opts.decisionTable);
  const decoupling = inj.decoupling ?? await inputsMod.collectDecoupling({ root: toolsDir });
  // 仓库级扫描（scan:true，约 1s）只喂"证据提示项"、不参与定档 ⇒ cache-only 恒跳过，压首屏耗时
  const vocabGuard = inj.vocabGuard ?? await inputsMod.collectVocabGuard({ scan: false });
  // ⚠️ 关键：cache-only **不 spawn** 审计脚本（RUN_TIMEOUT_MS=180s），只读既有报告（spawn:false）
  const audit = inj.audit ?? inputsMod.collectAudit({
    enabled: true,
    spawn: opts.refresh === true,
    report: opts.auditReport,
    tarballs: opts.tarballs,
  });

  const shared = {
    triageUpgrade: triageMod.triageUpgrade, decisionTable, decoupling, vocabGuard, audit,
    // 补丁登记可注入（夹具用假补丁，避免把"生产脚本在不在"混进定档用例）
    inspectPatchRegistry: (name) => inj.patchesByPkg?.[name] ?? inputsMod.inspectPatchRegistry(name),
    tierLabelOf: (t) => triageMod.TIER_LABEL?.[t] ?? null,
  };
  const hostMap = injected?.hostUpgradeRequiredByPkg ?? {};

  const items = packages.map((p) => judgeOne({ pkgFact: p, npmCache, hostUpgradeRequired: hostMap[p.name] === true, shared }));

  const inputGaps = [];
  if (!decisionTable.ok) inputGaps.push(`决策表：${decisionTable.reason ?? '不可用'}`);
  if (!decoupling.ok) inputGaps.push(`解耦检查：${decoupling.reason ?? '不可用'}`);
  if (!vocabGuard.ok) inputGaps.push(`词表守卫：${vocabGuard.reason ?? '不可用'}`);
  if (!audit.ok) inputGaps.push(`L0 审计：${audit.reason ?? '不可用'}`);
  if (!npmCache.ok) inputGaps.push(`npm 缓存：${npmCache.reason ?? '不可用'}`);

  const summary = { total: items.length, green: 0, yellow: 0, red: 0, unavailable: 0 };
  for (const it of items) {
    if (!it.available) summary.unavailable += 1;
    if (it.tier === 'green') summary.green += 1;
    else if (it.tier === 'yellow') summary.yellow += 1;
    else if (it.tier === 'red') summary.red += 1;
  }

  return {
    ok: true, exitCode: 0,
    cliVersion: CLI_VERSION,
    triageVersion: triageMod.TRIAGE_VERSION,
    tierSource: TIER_SOURCE,
    cacheOnly: opts.refresh !== true,
    generatedAt: new Date().toISOString(),
    elapsedMs: Date.now() - t0,
    inputs: {
      decisionTable: { ok: decisionTable.ok, count: decisionTable.forbidden?.length ?? 0, source: decisionTable.source, reason: decisionTable.reason ?? null },
      decoupling: { ok: decoupling.ok, r1HardCount: decoupling.r1HardCount ?? null, r5Ok: decoupling.r5Ok ?? null, reason: decoupling.reason ?? null },
      vocabGuard: { ok: vocabGuard.ok, gone: vocabGuard.gone ?? null, repoScanSkipped: true, reason: vocabGuard.reason ?? null },
      audit: { ok: audit.ok, spawned: audit.spawned === true, report: audit.report ?? null, packages: Object.keys(audit.brokenByPackage ?? {}).length, reason: audit.reason ?? null },
      npmCache: { ok: npmCache.ok, file: npmCache.file ?? null, at: npmCache.at ?? null, ageMs: npmCache.ageMs ?? null, names: npmCache.names?.length ?? 0, reason: npmCache.reason ?? null },
    },
    inputGaps,
    items,
    summary,
  };
}

/** 人类可读文本（默认输出；--json 时不用）。 */
export function renderText(res) {
  if (!res.ok) return `档位不可用：${res.error}`;
  const L = [];
  L.push(`升级档位（源=${res.tierSource} · CLI ${res.cliVersion} · ${res.cacheOnly ? 'cache-only' : 'refresh'} · ${res.elapsedMs}ms）`);
  L.push(`输入：决策表 ${res.inputs.decisionTable.ok ? '✅' : '❌'} · 解耦 ${res.inputs.decoupling.ok ? '✅' : '❌'} · 词表 ${res.inputs.vocabGuard.ok ? '✅' : '❌'} · L0 审计 ${res.inputs.audit.ok ? '✅' : '❌'} · npm 缓存 ${res.inputs.npmCache.ok ? `✅(${res.inputs.npmCache.names})` : '❌'}`);
  for (const g of res.inputGaps) L.push(`  ⚠ 输入缺口：${g}`);
  L.push('');
  const ICON = { green: '🟢', yellow: '🟡', red: '🔴' };
  for (const it of res.items) {
    const head = it.available ? `${ICON[it.tier] ?? '?'} ${it.tier}` : `⬜ 档位不可用`;
    L.push(`${head.padEnd(12)} ${it.name}  ${it.local ?? '?'} → ${it.target ?? '(无 npm 源)'}`);
    if (!it.available) L.push(`             └ ${it.unavailableReason}`);
    else if (it.reasons.length) L.push(`             └ ${it.reasons.slice(0, 3).join('；')}`);
  }
  L.push('');
  L.push(`合计 ${res.summary.total}：🟢${res.summary.green} 🟡${res.summary.yellow} 🔴${res.summary.red} ⬜不可用${res.summary.unavailable}`);
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// 入口（junction 坑：realpath 双方比较；否则 import.meta.url 是物理路径、argv[1] 是逻辑路径 ⇒ 永不触发）
// ---------------------------------------------------------------------------
function isMainEntry() {
  const a = process.argv[1];
  if (!a) return false;
  try { return fs.realpathSync(a) === fs.realpathSync(fileURLToPath(import.meta.url)); } catch { return false; }
}

if (isMainEntry()) {
  const { ok, opts, unknown } = parseArgs(process.argv.slice(2));
  if (unknown.length || opts.help) {
    if (unknown.length) console.error(`[upgrade-triage-cli] 不认识的参数：${unknown.join(' ')}\n`);
    console.log(USAGE);
    process.exitCode = unknown.length ? 2 : 0;
  } else {
    runCli(opts).then((res) => {
      if (res.exitCode !== 0) {
        console.error(`[upgrade-triage-cli] ${res.error}`);
        process.exitCode = res.exitCode;
        return;
      }
      console.log(opts.json ? JSON.stringify(res, null, 2) : renderText(res));
      process.exitCode = 0;
    }).catch((e) => {
      console.error(`[upgrade-triage-cli] 执行失败：${e?.stack ?? e}`);
      process.exitCode = 3;
    });
  }
}
