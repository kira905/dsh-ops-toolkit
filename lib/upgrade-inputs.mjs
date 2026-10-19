#!/usr/bin/env node
/**
 * upgrade-inputs.mjs —— 「升级分级授权」判定输入采集（只读 · 可注入 · 零副作用）
 *
 * 配套 `lib\upgrade-triage.mjs`（纯判定）：本文件只负责"把口径 §2 的输入源取回来"，
 * 判定一律交给 triage 库（**不复制判据**）。口径唯一源见
 * `docs\升级分级授权-生效口径-20260915.md` §2。
 *
 * 输入源（口径 §2 表）：
 *   1. `docs\插件升级决策表.md`            → 🔴 禁升区（权威源，本文件只解析）
 *   2. `tools\check-decoupling.mjs`        → R1 静态 / R5 副本一致 / R4 断裂
 *   3. `tools\dsh-vocab-guard.mjs`         → 跨线词表差异 + GONE + 写死已删名的判定类命中
 *   4. `tools\dsh-upgrade-audit.mjs`（v3） → 目标版 SDK 断裂符号（需 tarball 样本；无样本 → 证据缺口）
 *   5. `tools\dsh-upgrade-watch.mjs`       → 本地**实体**版本 vs npm（B 线）
 *   6. `docs\插件魔改维护清单.md`（人工摘要）→ 魔改补丁登记表（本文件内置结构化副本 + 存在性/幂等探测）
 *
 * 【fail-closed】任何一步取不到 → 返回 `ok:false` + reason，由 triage 判为"证据缺口不通过"，
 *   **绝不静默当作"没问题"**。诊断信息一律进 reason，便于报告里显示"为什么判不了"。
 *
 * 收尾口径：本文件无 CLI；调用方（或单测）处理 process.exitCode。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
// 判定逻辑（决策表解析）**不在此复制**：直接用 triage 库的解析器
import { parseDecisionTable } from './upgrade-triage.mjs';

export const INPUTS_VERSION = '1.0.0';

const HERE = path.dirname(fs.realpathSync(fileURLToPath(import.meta.url)));   // …\tools\lib
export const TOOLS_DIR = path.dirname(HERE);                                   // …\tools
export const DSH_ROOT = path.dirname(TOOLS_DIR);                               // <DSH_ROOT>
const NODE = process.execPath;
const RUN_TIMEOUT_MS = 180_000;

/** 升级自动化的开关文件（**默认不存在 = 关**；口径：只有它 enabled:true 才可能真跑）。 */
export const AUTOMATION_CONFIG = path.join(
  process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || path.join(os.homedir(), '.dsh'),
  'upgrade-automation.json',
);

/**
 * 魔改补丁登记表（**来源 = `docs\插件魔改维护清单.md` 第一/第四节**，人工摘要；
 * 维护清单改了就同步这里，`inspectPatchRegistry()` 会检查脚本是否存在，防登记表过期）。
 *   key   = 插件包名（与 profile / npm 同名）
 *   value = [{ script, source }]  script 相对 `<DSH_ROOT>\tools\`
 * 注意：`dsh-task-board-local` / 两个面板属"改工程源码 → build → deploy"，**不属 patch 脚本机制**
 *       → 登记为 `selfdev: true`（口径 🟡 要求"已脚本化幂等"，工程改造不满足 → 该包恒不可自动）。
 */
export const PATCH_REGISTRY = {
  'whale-on-desk': [
    { script: 're-patch-whale-client.mjs' },
    { script: 'patch-whale-drag-walk.mjs' },
    { script: 'patch-whale-drag-walk-dir.mjs' },
    { script: 'patch-whale-walk-dt.mjs' },
    { script: 'patch-whale-menu-position.mjs' },
    { script: 'patch-whale-state-machine.mjs' },
    { script: 'patch-whale-desktop-dll.mjs' },
    { script: 'patch-whale-poke-play.mjs' },
    { script: 'patch-whale-say-endpoint.mjs' },
    { script: 'patch-whale-state-ttl.mjs' },
  ],
  'dsh-download-progress': [{ script: 'patch-dl-pill-pos.mjs' }],
  '@dickpy/dsh-imagegen': [{ script: 'patch-imagegen-qwen-edit.mjs' }, { script: 'patch-imagegen-sidebar-toggle.mjs' }],
  'dsh-emoji': [{ script: 're-patch-whale-client.mjs' }],
  'dsh-api-balance': [{ script: 'patch-dsh-api-balance-folded.mjs' }],
  'dsh-fish-tts': [{ script: 'patch-fish-tts-siliconflow.mjs' }],
  'dsh-memory': [{ script: 'patch-dsh-memory-journal.mjs' }],
  '@deepseek-ai/dsh': [{ script: 'patch-dsh-keybind.mjs' }],
  // ── 2026-10-16 摘除登记（卡「0.2.0 升级后遗症收尾 · 复验欠账 #5」）──
  //   原登记 5 支：patch-taskboard-{011,btn-ui,responsive,icon-size,order}.mjs
  //   摘除理由（实测）：目标包 `@linxin666/dsh-client-ui-task-board` 在本机 profile 里**已不存在** ——
  //     `~\.dsh\profiles\web\node_modules\@linxin666` 是**空目录**（计数 0），profile package.json 依赖
  //     与 `dsh.profile.bundles` 也都没有该包（只剩自建 `dsh-task-board-local`）⇒ 升级链每跑一次空跑 5 支。
  //   5 支脚本**未归档**（仍留在 `tools\`），理由与代价：① 生态面板 `dsh-ecosystem-panel\lib\state.js`
  //     （L251 / L254 / L257）按**文件名**登记其中 3 项，移走会让面板该项探测失败，而改面板需 deploy + 重启
  //     dsh（本卡红线 = 零重启）；② 它们保留「0.1.1 线回滚通道」价值，各脚本已加/已有**目标存在性守卫**
  //     （目标不在时明确 no-op，不再报 ENOENT/不再误导"Restart DSH to apply"）。
  //   能力早已移植进自建 `tools\dsh-task-board-local\src`（真源 `docs\换机必补清单.md`「已作废（勿重跑）」）。
  //   ⇒ 本包现为**无登记**：`inspectPatchRegistry()` 返回 `registered:false`（口径上不可自动），与现状一致。
  // 自研工程（源码 → build → deploy，无 patch 脚本）：登记为 selfdev，口径上**不能自动**
  'dsh-task-board-local': [{ selfdev: true, note: '改 tools\\dsh-task-board-local\\src → npm run build → deploy.mjs' }],
  'dsh-butler-panel': [{ selfdev: true, note: '改 tools\\dsh-butler-panel → deploy.mjs' }],
  'dsh-ecosystem-panel': [{ selfdev: true, note: '改 tools\\dsh-ecosystem-panel → deploy.mjs' }],
};

/** 幂等证据关键词（**弱证据**：文本探测，不是实跑验证）。 */
const IDEMPOTENT_HINTS = [/幂等/, /已打.{0,4}跳过/, /skip.{0,10}(already|patched)/i, /--dry-run/];

/**
 * 读 `~/.dsh/upgrade-automation.json`（开关 + 命令声明）。读不到 → null（=关）。
 * @returns {{ok:boolean, config:object|null, reason:string, path:string}}
 */
export function readAutomationConfig(file = AUTOMATION_CONFIG) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const cfg = JSON.parse(raw);
    if (!cfg || typeof cfg !== 'object') return { ok: false, config: null, reason: '内容不是对象', path: file };
    return { ok: true, config: cfg, reason: '', path: file };
  } catch (e) {
    return { ok: false, config: null, reason: e?.code === 'ENOENT' ? '文件不存在（=默认关）' : String(e?.message ?? e), path: file };
  }
}

/**
 * 读决策表 md → 交给 triage 的 `parseDecisionTable` 解析（判定逻辑不在此复制）。
 * @returns {{ok:boolean, forbidden:Array, reason?:string, source:string}}
 */
export function readDecisionTable(file = path.join(DSH_ROOT, 'docs', '插件升级决策表.md')) {
  let md;
  try {
    md = fs.readFileSync(file, 'utf8');
  } catch (e) {
    return { ok: false, forbidden: [], reason: `读不到决策表 ${file}：${e?.message ?? e}`, source: file };
  }
  return { ...parseDecisionTable(md), source: file };
}

/** 魔改登记表探测：脚本是否存在 + 幂等弱证据。 */
export function inspectPatchRegistry(pkgName, { toolsDir = TOOLS_DIR } = {}) {
  const list = PATCH_REGISTRY[pkgName] ?? [];
  const entries = list.map((e) => {
    if (e.selfdev) return { script: null, selfdev: true, exists: false, idempotent: false, note: e.note ?? '' };
    const file = path.join(toolsDir, e.script);
    const exists = fs.existsSync(file);
    let idempotent = false;
    let evidence = 'unknown';
    if (exists) {
      try {
        const src = fs.readFileSync(file, 'utf8').slice(0, 8000);
        idempotent = IDEMPOTENT_HINTS.some((re) => re.test(src));
        evidence = idempotent ? 'probe(文本探测 · 弱证据)' : 'unknown';
      } catch { /* 读不到 → 保持 unknown */ }
    }
    return { script: e.script, exists, idempotent, evidence, file: exists ? file : null };
  });
  return { pkg: pkgName, registered: list.length > 0, entries };
}

/** 解耦检查（**直接复用其导出的 runChecks，不复制判据**）。 */
export async function collectDecoupling({ root = TOOLS_DIR } = {}) {
  try {
    // 动态 import：check-decoupling 的入口守卫保证被 import 时不会跑 main
    const mod = await import(pathToFileURL(path.join(TOOLS_DIR, 'check-decoupling.mjs')).href);
    if (typeof mod.runChecks !== 'function') return { ok: false, reason: 'check-decoupling 未导出 runChecks' };
    const res = mod.runChecks({ root });
    const r5 = res?.r5 ?? {};
    return {
      ok: true,
      r1HardCount: res?.r1?.hardCount ?? 0,
      r1SoftCount: res?.r1?.softCount ?? 0,
      r1HardPackages: res?.r1?.hardPackages ?? [],
      // R5 判据唯一源 = check-decoupling 的 level（不自己比 sha）
      r5Ok: r5.level === 'ok',
      r5Note: r5.note ?? null,
      r4BrokenCount: (res?.r4?.violations ?? []).length,
      exitCode: res?.exitCode ?? null,
    };
  } catch (e) {
    return { ok: false, reason: `解耦检查失败：${e?.message ?? e}` };
  }
}

/**
 * 词表守卫输入（**复用其导出函数，不复制判据**）。
 * @param {{scan?:boolean, roots?:string[]}} [opts] scan=false 跳过裸字面量扫描（快模式）
 */
export async function collectVocabGuard({ scan = true, roots = null } = {}) {
  try {
    const mod = await import(pathToFileURL(path.join(TOOLS_DIR, 'dsh-vocab-guard.mjs')).href);
    const insp = await mod.inspectVocab({});
    if (insp?.ok !== true) return { ok: false, reason: insp?.reason ?? '词表守卫判定不可用（样本缺失？）' };
    const gone = (insp.judgeRows ?? []).filter((r) => r.verdict === 'GONE').length;
    let scanHits = 0;
    let scanDecisionHits = 0;
    let r4Broken = 0;
    if (scan) {
      const scanRoots = roots ?? mod.defaultScanRoots();
      const removed = new Set(insp.diff?.removed ?? []);
      const s = mod.scanRemovedLiterals(scanRoots, removed);
      const hints = s?.hits ?? [];
      scanHits = hints.length;
      scanDecisionHits = hints.filter((h) => h.hint === '判定').length;
      const r4 = await mod.crossCheckR4({ root: TOOLS_DIR, removedSet: removed });
      r4Broken = r4?.ok === false ? 0 : (r4?.broken?.length ?? 0);
      return {
        ok: true, gone, scanHits, scanDecisionHits, r4Broken,
        oldVersion: insp.oldSide?.version ?? null, newVersion: insp.newSide?.version ?? null,
        removed: insp.diff?.removed ?? [], added: insp.diff?.added ?? [],
        // 判定类命中的前几处位置（供报告定位；不参与判定）
        scanDecisionPlaces: hints.filter((h) => h.hint === '判定').slice(0, 8).map((h) => `${h.file}:${h.line}|${h.literal}`),
        scanTruncated: s?.truncated === true, scanSkipped: false,
      };
    }
    return {
      ok: true, gone, scanHits, scanDecisionHits, r4Broken,
      oldVersion: insp.oldSide?.version ?? null, newVersion: insp.newSide?.version ?? null,
      removed: insp.diff?.removed ?? [], added: insp.diff?.added ?? [], scanSkipped: true,
    };
  } catch (e) {
    return { ok: false, reason: `词表守卫失败：${e?.message ?? e}` };
  }
}

/**
 * L0 审计（断裂符号）输入：**需目标版 tarball 样本**，无样本 → 证据缺口（fail-closed）。
 * 有样本时跑 `dsh-upgrade-audit.mjs`，并从其报告里取 🔴 行（报告是它的输出契约）。
 *
 * ★2026-09-18（施工卡 ①-4）：新增 `spawn` 开关（默认 `true` = 行为与改造前逐字节一致）。
 *   `spawn:false` = **只读既有报告、不跑审计脚本**（"缓存优先"路径用；审计脚本带
 *   `RUN_TIMEOUT_MS = 180_000`，面板每次打开都不该跑它）。此时不要求 tarball 样本存在
 *   （不跑就不需要样本），但报告缺失仍是 `ok:false`（证据缺口，绝不静默当"没问题"）。
 */
export function collectAudit({
  tarballs = process.env.DSH_L0_TARBALLS || path.join(process.env.DSH_OFFSYNC_ROOT || path.join(os.homedir(), 'dsh-offsync'), 'upgrade-canary', 'tarballs'),
  report = path.join(DSH_ROOT, '_tmp', 'l0-audit-report.md'),
  enabled = true,
  spawn = true,
} = {}) {
  if (!enabled) return { ok: false, reason: '本次跳过 L0 审计（--no-audit）' };
  const doSpawn = spawn !== false;
  if (doSpawn && !fs.existsSync(tarballs)) return { ok: false, reason: `目标版 tarball 样本缺失：${tarballs}（离线判定不可用）` };
  let r = { status: null };
  if (doSpawn) {
    r = spawnSync(NODE, [path.join(TOOLS_DIR, 'dsh-upgrade-audit.mjs'), tarballs], {
      encoding: 'utf8', windowsHide: true, timeout: RUN_TIMEOUT_MS,
    });
  }
  let md = '';
  try { md = fs.readFileSync(report, 'utf8'); } catch { /* 报告可能未生成 */ }
  if (!md) {
    return {
      ok: false,
      reason: doSpawn
        ? `L0 审计报告读不到（exit=${r.status}）：${report}`
        : `L0 审计报告不存在（未跑过；--refresh 可生成）：${report}`,
      report, spawned: doSpawn,
    };
  }
  // 解析成**包级**清单（口径的"断裂符号命中"必须落到具体包，否则一个包的断点会误伤全部插件）：
  //   · `- 🔴 本地已装 <pkg>@<ver> → <说明>`（审计的「本地已装插件」段）
  //   · `| <pkg> | <ver> | \`<sdkPkg>\` | 🔴 BROKEN | <符号> |`（SDK 符号表）
  //   · `| \`<sdkPkg>\` | \`<符号>\` | <用途> | 🔴 缺失 |`（运行时 API 面）
  // 引用行（`>`）与说明行（`⚠️`）一律排除 —— 它们只是解释文案，不是命中。
  const brokenByPackage = {};
  const globalNotes = [];
  for (const raw of md.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('>') || line.startsWith('⚠️')) continue;
    const m1 = /^-\s*🔴\s*本地已装\s+([^\s@]+)@[^\s]+\s*→\s*(.+)$/.exec(line);
    if (m1) { (brokenByPackage[m1[1]] ??= []).push(m1[2].slice(0, 160)); continue; }
    if (line.startsWith('|') && /🔴\s*(BROKEN|缺失)/.test(line)) {
      const cells = line.split('|').map((c) => c.trim()).filter(Boolean);
      const pkg = (cells[0] ?? '').replace(/`/g, '');
      const desc = cells.filter((c) => !/^🔴/.test(c)).join(' · ').slice(0, 200);
      if (pkg) (brokenByPackage[pkg] ??= []).push(desc);
      continue;
    }
    if (/🔴/.test(line)) globalNotes.push(line.slice(0, 200));
  }
  return {
    ok: true,
    brokenByPackage,
    brokenSymbols: Object.values(brokenByPackage).flat(),
    globalNotes,
    report, exitCode: r.status ?? null, spawned: doSpawn,
  };
}

/** B 线体检（本地实体版本 vs npm latest）—— 复用 `dsh-upgrade-watch.mjs --json`。 */
export function collectWatch({ jsonOut = path.join(os.tmpdir(), `dsh-upgrade-watch-${process.pid}.json`), remote = true } = {}) {
  const args = [path.join(TOOLS_DIR, 'dsh-upgrade-watch.mjs'), '--json', jsonOut, '--quiet'];
  if (!remote) args.push('--no-remote');
  const r = spawnSync(NODE, args, { encoding: 'utf8', windowsHide: true, timeout: RUN_TIMEOUT_MS });
  let data = null;
  try { data = JSON.parse(fs.readFileSync(jsonOut, 'utf8')); } catch { /* 见下 */ }
  if (!data) return { ok: false, reason: `体检 JSON 读不到（exit=${r.status}）：${jsonOut}`, stdout: (r.stdout ?? '').slice(-800) };
  const lineB = Array.isArray(data.lineB) ? data.lineB : [];
  return {
    ok: true, checkedAt: data.generatedAt ?? null,
    // ⚠️ 字段名以 `dsh-upgrade-watch.mjs` 的 jsonResult 为准（mainPackage.local，不是 mainVersion）
    mainVersion: data.mainPackage?.local ?? null,
    candidates: lineB.filter((x) => x.flag === '可升级').map((x) => ({ name: x.name, local: x.local, target: x.latest, declared: x.declared, source: x.source })),
    all: lineB,
    json: jsonOut,
  };
}

/**
 * 采集一次完整输入（全局部分只取一遍，per-package 部分按包名取）。
 * @param {{pkg:string, scan?:boolean, audit?:boolean, remote?:boolean, decisionTableFile?:string, root?:string}} o
 */
export async function collectInputsFor(o = {}) {
  const pkgName = String(o.pkg ?? '').trim();
  const decisionTable = readDecisionTable(o.decisionTableFile);
  const decoupling = await collectDecoupling({ root: o.root ?? TOOLS_DIR });
  const vocabGuard = await collectVocabGuard({ scan: o.scan !== false });
  const audit = collectAudit({ enabled: o.audit !== false });
  const patches = inspectPatchRegistry(pkgName);
  return { decisionTable, decoupling, vocabGuard, audit, patches };
}
