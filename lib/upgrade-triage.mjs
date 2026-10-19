#!/usr/bin/env node
/**
 * upgrade-triage.mjs —— 「升级分级授权」定档函数（纯逻辑 · 零 fs · 零副作用）
 *
 * ⚠️ **本件只做判定，不做升级**。分级授权本身**尚未启用**（口径 §6 D1 = 暂不启用），
 *    本库是生效前置 ③ 的地基：把口径 §2 的判据落成可测的纯函数。
 *    口径原文：`docs\升级分级授权-生效口径-20260915.md`（判据唯一源）
 *
 * 为什么单独成库（而不是写在编排入口里）：
 *   · 定档逻辑必须**可单测、可注入假输入**，不许拿真插件做测试（卡【升级分级授权·A3】硬约束）；
 *   · 编排入口只负责"取输入 → 调本函数 → 执行/干跑"，判据在本文件里唯一一份（不复制）。
 *
 * 输入（全部由 `lib\upgrade-inputs.mjs` 采集；本库不读盘）：
 *   {
 *     pkg:          { name, localVersion, targetVersion },
 *     decisionTable:{ ok, forbidden:[{name, reason}], reason? },     // docs\插件升级决策表.md 🔴 禁升区
 *     decoupling:   { ok, r1HardCount, r1HardPackages, r5Ok, r4BrokenCount, reason? },
 *                   · `r1HardPackages` = **精确包名清单**（有 R1 静态违规的包，源 = `check-decoupling.runChecks()`）
 *                     ⇒ 判据④ **按目标包过滤**（2026-10-09 · G13④前置2；仓库级合计 `r1HardCount` 降为证据提示项）；
 *     vocabGuard:   { ok, gone, scanHits, scanDecisionHits, r4Broken, exitCode, reason? },
 *     audit:        { ok, brokenSymbols:[], reason? },               // dsh-upgrade-audit v3（断裂符号）
 *     patches:      { entries:[{ script, idempotent, exists }] },     // 维护清单登记表（该包的魔改补丁）
 *     hostUpgradeRequired: boolean,                                   // 是否"要升主包才能升"
 *   }
 *
 * 输出：
 *   { tier:'green'|'yellow'|'red', reasons:[], checks:[], evidenceGaps:[], requiredSteps:[], hasPatches }
 *
 * 【fail-closed 三条】
 *   ① 任何输入 `ok === false`（工具跑不了 / 文件解析失败 / 样本缺失）→ 该判据**不通过**并计入证据缺口；
 *   ② 只要有一条判据不通过且它属 🔴 触发项 → tier = red；
 *   ③ 既不是"全绿"也不是"合规的 🟡（有魔改且补丁已脚本化）"的一切情形 → red（宁可不自动，不猜）。
 *   ⇒ 结论只有三种：green / yellow / red；**没有第四档**（口径 §2 只定义三档，本库不自创语义）。
 *
 * 收尾口径：本文件无 CLI；调用方（或单测）处理 process.exitCode。
 */

// 1.0.1（2026-09-23 · 卡 L-18）：`parseDecisionTable()` 起点只认标题行 + 失败 reason 带起点行号/原文与段内表格形态诊断。
// 1.0.2（2026-10-09 · G13④前置2）：判据④「R1 静态违规 0」由**仓库级合计**改为**按目标包过滤**
//        （主人 2026-10-08 15:29 追认 `P2 = (c)`，真源 `docs\方案-G13升级分级授权前置④⑤-20260925.md` §7）；
//        仓库级合计降为**证据提示项**（`r1-repo`，照 ① ⑤`vocab-scan` 体例）。采集面未改（`r1HardPackages` 本就是包名清单）。
export const TRIAGE_VERSION = '1.0.2';

/** 主包名（红线 1：分级授权只覆盖插件，不覆盖主包）。 */
export const HOST_PKG = '@deepseek-ai/dsh';

/** 大跳版阈值：次版本差 > 该值 → 视为大跳（口径 §2 🔴 触发项之一，口径未量化 → 本卡定值，待拍板）。 */
export const MAJOR_JUMP_MINOR_GAP = 3;

export const TIER_ICON = { green: '🟢', yellow: '🟡', red: '🔴' };
export const TIER_LABEL = { green: '🟢 无魔改自动', yellow: '🟡 魔改+补丁重打自动', red: '🔴 只出方案（报主人）' };

/**
 * semver 解析（只取 major/minor/patch + prerelease 标识，够本库判定用）。
 * @returns {{major:number, minor:number, patch:number, pre:string[]}}
 */
export function parseVersion(v) {
  const s = String(v ?? '').trim().replace(/^v/, '');
  const noBuild = s.split('+')[0];
  const dash = noBuild.indexOf('-');
  const core = dash >= 0 ? noBuild.slice(0, dash) : noBuild;
  const pre = dash >= 0 ? noBuild.slice(dash + 1).split('.').filter(Boolean) : [];
  const nums = core.split('.').map((x) => Number.parseInt(x, 10));
  return {
    major: Number.isFinite(nums[0]) ? nums[0] : 0,
    minor: Number.isFinite(nums[1]) ? nums[1] : 0,
    patch: Number.isFinite(nums[2]) ? nums[2] : 0,
    pre,
  };
}

/**
 * 是否「大跳版」（口径 §2 🔴 触发项）。
 * 判据（本卡定值，口径未量化 → 报告里列"待拍板"）：
 *   · major 不同 → 大跳；或
 *   · minor 差 ≥ MAJOR_JUMP_MINOR_GAP → 大跳。
 * 版本解析不出来（缺失/非法）→ **返回 true**（fail-closed：判不了就当大跳，不自动）。
 */
export function isMajorJump(localVersion, targetVersion) {
  const a = parseVersion(localVersion);
  const b = parseVersion(targetVersion);
  if (!localVersion || !targetVersion) return true;
  if (!Number.isFinite(b.major)) return true;
  if (a.major !== b.major) return true;
  return b.minor - a.minor >= MAJOR_JUMP_MINOR_GAP;
}

/** 是否 Markdown 标题行（ATX 形态：`#`~`######` + 空白）。 */
function isTitleLine(l) {
  return /^#{1,6}\s/.test(String(l).trim());
}
/** 标题正文（去掉前缀 # 与空白）。 */
function titleBody(l) {
  return String(l).trim().replace(/^#{1,6}\s*/, '');
}
/** 段标题判据（2026-09-23 · 卡 L-18 收紧）：**必须是标题行**，且标题文本含「禁升区」或（含 🔴 且含「禁升」）。 */
function isForbiddenTitleLine(l) {
  if (!isTitleLine(l)) return false;
  const t = titleBody(l);
  return /禁升区/.test(t) || (/🔴/.test(t) && /禁升/.test(t));
}
/** 兜底命中（旧口径 · 非标题行也行）：**只在全文找不到标题行时**才允许（见 parseDecisionTable 注释）。 */
function isForbiddenLooseLine(l) {
  return /禁升区/.test(l) || (/🔴/.test(l) && /禁升/.test(l));
}
/** 诊断用短摘要（压空白 + 截断）。 */
function clipLine(s, n = 80) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/**
 * 解析决策表 Markdown 的「🔴 禁升区」段表格。
 * 口径：`docs\插件升级决策表.md` 是禁升区**权威源**，本库不内置名单（避免两处口径）。
 * 解析失败（找不到段/一行都没解析出）→ `{ok:false}`（fail-closed，调用方必须判 red）。
 *
 * **起点只认标题行**（2026-09-23 · 卡 L-18 修正）：
 *   ✅ `^#{1,6}\s` 且标题文本含「禁升区」（例：`## 🔴 禁升区（点了就崩…）`）；
 *   ✅ `^#{1,6}\s` 且标题文本同时含 🔴 与「禁升」。
 *   ⚠️ 反面教训（旧实现的真 bug）：旧正则 `/^#{1,6}\s*🔴|禁升区/` 是**交替**分支 —— 后半支
 *      「禁升区」不带锚点 ⇒ **任何含该字样的行**（含决策表顶部那段订正注："下文「🔴 禁升区 / 🟡 可升区」两表…"）
 *      都能被选成段首；起点一旦落在说明行上，紧接着扫到真标题就 `break` ⇒ 解析 0 行。
 *      实测后果：生态面板升级体检 19 项里 18 项显示"档位不可用"（ok:false ⇒ CLI 判 available:false）。
 *   · 兜底（兼容旧形态）：**仅当全文没有任何禁升区标题行时**，才退回"非标题行命中"当段首。
 *
 * 失败 reason 一律带**命中的起点行号 + 原文**与段内表格形态诊断（下次一眼定位，不再甩"表结构可能已改"）。
 *
 * 行的形态（历史实测）：
 *   | `@dickpy/dsh-imagegen` | 1.4.0 | 1.5.9 | 1.5.x 硬依赖 ... |
 *   | `dsh-emoji`（若市场反向提示） | 1.0.0 | 0.3.2 | ... |
 *
 * @param {string} md
 * @returns {{ok:boolean, forbidden:Array<{name:string, reason:string}>, reason?:string,
 *            startLine?:number, startKind?:'title'|'fallback'}}
 */
export function parseDecisionTable(md) {
  const text = String(md ?? '');
  if (!text.trim()) return { ok: false, forbidden: [], reason: '决策表内容为空' };
  const lines = text.split(/\r?\n/);

  // ── 起点：首选「标题行」；找不到才退回旧口径（非标题行命中） ──
  let start = lines.findIndex((l) => isForbiddenTitleLine(l));
  let startKind = 'title';
  if (start < 0) {
    const fb = lines.findIndex((l) => isForbiddenLooseLine(l));
    if (fb >= 0) { start = fb; startKind = 'fallback'; }
  }
  if (start < 0) {
    const mentioned = lines.map((l, i) => ({ i, l })).filter((x) => isForbiddenLooseLine(x.l));
    const hint = mentioned.length
      ? `；全文另有 ${mentioned.length} 行提到「🔴 禁升区」但都不是标题行：${mentioned.slice(0, 3).map((x) => `第 ${x.i + 1} 行「${clipLine(x.l, 60)}」`).join('；')}${mentioned.length > 3 ? ' …' : ''}`
      : '；全文也没有任何行提到「🔴 禁升区」';
    return {
      ok: false, forbidden: [],
      reason: `找不到「🔴 禁升区」标题行（判据：以 # 开头的标题行，标题文本含「禁升区」；或标题文本同时含 🔴 与「禁升」）；全文 ${lines.length} 行${hint}`,
    };
  }

  const forbidden = [];
  const diag = { tableRows: 0, sepRows: 0, headerRows: 0, noNameRows: 0, stopLine: null };
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isTitleLine(line)) { diag.stopLine = i; break; }  // 下一节开始 → 停
    if (!line.trim().startsWith('|')) continue;
    diag.tableRows += 1;
    if (/^\|[\s:|-]+\|$/.test(line.trim())) { diag.sepRows += 1; continue; }   // 分隔行
    const cells = line.split('|').map((c) => c.trim());
    // cells[0] 为空（行首 |），故取 cells[1] 起
    const nameCell = cells[1] ?? '';
    if (!nameCell || /^插件$/.test(nameCell)) { diag.headerRows += 1; continue; }   // 表头
    const m = /`([^`]+)`/.exec(nameCell);
    const name = (m ? m[1] : nameCell).replace(/（[^）]*）/g, '').trim();
    if (!name) { diag.noNameRows += 1; continue; }
    forbidden.push({ name, reason: (cells[4] ?? cells[cells.length - 2] ?? '').trim() });
  }
  if (!forbidden.length) {
    const segEnd = diag.stopLine === null ? lines.length : diag.stopLine;   // 1-based：最后一行被扫过的行
    return {
      ok: false, forbidden: [],
      reason: `「🔴 禁升区」段内一行插件都没解析出：`
        + `起点=第 ${start + 1} 行（${startKind === 'title' ? '标题行' : '⚠️ 兜底命中·非标题行'}）「${clipLine(lines[start], 70)}」`
        + `；扫描区间=第 ${start + 2}~${segEnd} 行（${diag.stopLine === null ? '到文件尾都没遇到下一个标题行' : `遇下一个标题行（第 ${diag.stopLine + 1} 行）停止`}）`
        + `；表格形态：以竖线开头的行 ${diag.tableRows} 行（其中分隔行 ${diag.sepRows} · 表头行 ${diag.headerRows} · 首列取不到插件名 ${diag.noNameRows}）`
        + `；判据：段内需有以竖线「|」开头、首列为包名（反引号包裹或裸名）的表格行`,
      startLine: start + 1, startKind,
    };
  }
  return { ok: true, forbidden, startLine: start + 1, startKind };
}

/** 决策表里是否命中该包（精确名 或 名字里带着包名，兼容"（若市场反向提示）"这类写法）。 */
export function findForbidden(decisionTable, pkgName) {
  const list = decisionTable?.forbidden ?? [];
  return list.filter((f) => f.name === pkgName || f.name.includes(pkgName) || pkgName.includes(f.name)) ?? [];
}

/**
 * 定档主函数（纯函数：同输入必同输出，不读盘不写盘）。
 * @param {object} input 见文件头
 * @returns {{tier:'green'|'yellow'|'red', reasons:string[], checks:object[], evidenceGaps:string[],
 *            requiredSteps:string[], hasPatches:boolean, patchReady:boolean, versions:object}}
 */
export function triageUpgrade(input = {}) {
  const pkg = input.pkg ?? {};
  const name = String(pkg.name ?? '').trim();
  const checks = [];
  const reasons = [];
  const evidenceGaps = [];

  /**
   * 登记一条判据。
   * @param {{id,label,pass,detail?,evidence?:boolean,red?:boolean,hint?:boolean}} c
   *   · `red:false` → 该判据**不参与定档**（只展示）
   *   · `hint:true` → **证据提示项**：渲染为 💡，不进 reasons / evidenceGaps（2026-09-15 · P4 拍板②）
   */
  const add = (c) => {
    const rec = {
      id: c.id,
      label: c.label,
      pass: c.pass === true,
      detail: c.detail ?? '',
      evidence: c.evidence !== false,
      red: c.red !== false,          // 默认：不通过即 red 触发项
      hint: c.hint === true,         // 提示项：只进报告，不影响定档
    };
    checks.push(rec);
    if (!rec.pass) {
      if (!rec.evidence) evidenceGaps.push(`${rec.label}：${rec.detail || '证据缺失'}`);
      if (rec.red) reasons.push(`${rec.label}${rec.detail ? ` —— ${rec.detail}` : ''}`);
    }
    return rec;
  };

  // ---- ① 非主包（红线 1） ----
  if (!name) {
    add({ id: 'pkg-name', label: '目标包名已知', pass: false, evidence: false, detail: '未给出包名（输入缺失）' });
  }
  add({ id: 'not-host', label: '① 非主包（分级授权不覆盖 @deepseek-ai/dsh）', pass: name !== HOST_PKG, detail: name === HOST_PKG ? '目标就是主包本身' : '' });

  // ---- ② 决策表无 🔴 ----
  const dt = input.decisionTable ?? {};
  if (dt.ok !== true) {
    add({ id: 'decision-table', label: '② 决策表 🔴 禁升区未命中', pass: false, evidence: false, detail: `决策表不可用：${dt.reason ?? '未采集'}` });
  } else {
    const hit = findForbidden(dt, name);
    add({
      id: 'decision-table', label: '② 决策表 🔴 禁升区未命中',
      pass: hit.length === 0,
      detail: hit.length ? `命中禁升区：${hit.map((h) => h.name).join('、')}` : '',
    });
  }

  // ---- ③ 魔改面（🟢 要求"无魔改"；🟡 要求"有魔改但补丁已脚本化幂等"） ----
  const patchEntries = input.patches?.entries ?? [];
  const hasPatches = patchEntries.length > 0;
  const missingScript = patchEntries.filter((p) => p.exists === false || !p.script);
  const notIdempotent = patchEntries.filter((p) => p.exists !== false && p.idempotent === false);
  const patchReady = hasPatches && missingScript.length === 0 && notIdempotent.length === 0;
  if (hasPatches && !patchReady) {
    add({
      id: 'patch-scripted', label: '③ 魔改补丁已脚本化（幂等 + 脚本存在）',
      pass: false,
      detail: [
        missingScript.length ? `补丁脚本缺失/未登记：${missingScript.map((p) => p.script || '(空)').join('、')}` : '',
        notIdempotent.length ? `未声明幂等：${notIdempotent.map((p) => p.script).join('、')}` : '',
      ].filter(Boolean).join('；'),
    });
  } else {
    add({ id: 'patch-scripted', label: '③ 魔改面（无魔改 → 🟢 路线；有魔改且脚本幂等 → 🟡 路线）', pass: true, detail: hasPatches ? `登记 ${patchEntries.length} 个补丁，全部可用` : '该包无魔改登记' });
  }

  // ---- ④ check-decoupling R1 静态 0（**按目标包过滤** · + R5 副本一致） ----
  // ⚠️ 2026-10-09（G13④前置2 · 主人 2026-10-08 15:29 追认 `P2 = (c)`）：本判据**只算目标包自己的违规**。
  //    改前取的是 `check-decoupling` **全仓库 12 包求和**（`r1HardCount`）⇒ **任何插件恒 🔴**
  //    （实测 `@liustack/modlens` 其余九项全 ✅、唯一 ❌ = 8 处违规全在无关的 `dsh-memory-local`）
  //    ⇒ 分级授权一旦启用即形同虚设（永远只出方案、永不自动）。这正是 2026-09-15 `vocab-scan` 的同型入口。
  //    包级数据源 = `check-decoupling.runChecks().r1.hardPackages`（**已是精确包名清单**，非汇总数）
  //    ⇒ 采集面（`lib\upgrade-inputs.mjs`）无需改动。仓库级卫生仍在报告里可见（`r1-repo` 证据提示项）。
  //    匹配口径 = **精确包名相等**（不做子串匹配 —— 否则 `@liustack/modlens` 会被 `@liustack/modlens-core` 误伤）。
  //    fail-closed 三条（**一条都没放宽**）：① 采集不可用 → 🔴 + 证据缺口；② 目标包名缺失 → 🔴 + 证据缺口；
  //    ③ 无包级清单 **且** 仓库级合计 > 0 → 判不了"这 N 处是不是本包的" → 🔴 + 证据缺口。
  //    （无包级清单但仓库级合计 = 0 ⇒ 逻辑蕴含本包为 0，可安全判通过；兼容旧结构注入。）
  const dc = input.decoupling ?? {};
  if (dc.ok !== true) {
    add({ id: 'r1-static', label: '④ 本包 check-decoupling R1 静态违规 0', pass: false, evidence: false, detail: `解耦检查不可用：${dc.reason ?? '未采集'}` });
    add({ id: 'r5-adapter', label: '④+ 适配层副本一致（R5）', pass: false, evidence: false, detail: '解耦检查不可用' });
  } else {
    const hardPkgs = Array.isArray(dc.r1HardPackages) ? dc.r1HardPackages.map((x) => String(x)) : null;
    const repoHard = Number(dc.r1HardCount ?? 0);
    let r1Pass = false;
    let r1Detail = '';
    let r1Evidence = true;   // false = 进 evidenceGaps（"判不了"，不是"确认违规"）
    if (!name) {
      r1Pass = false; r1Evidence = false;
      r1Detail = '目标包名缺失 ⇒ 无法与包级违规清单比对';
    } else if (hardPkgs) {
      const selfListed = hardPkgs.some((p) => p === name);
      r1Pass = !selfListed;
      r1Detail = selfListed
        ? `本包在仓库级硬违规名单中：${name}（仓库级合计 ${repoHard} 处）`
        : `本包不在名单中（名单覆盖面 = check-decoupling 扫描面：tools 源码目录 + profile 登记包）`;
    } else if (repoHard === 0) {
      r1Pass = true;   // 仓库级合计为 0 ⇒ 本包必为 0（逻辑蕴含，不靠猜）
    } else {
      r1Pass = false; r1Evidence = false;
      r1Detail = `包级违规清单缺失（r1HardPackages 非数组）且仓库级合计 ${repoHard} 处 ⇒ 本包是否在册不可判`;
    }
    add({
      id: 'r1-static', label: '④ 本包 check-decoupling R1 静态违规 0',
      pass: r1Pass, evidence: r1Evidence, detail: r1Detail,
    });
    // ④ 仓库级卫生：**证据提示项**（`red:false` + `hint:true`，不参与定档）——照 ⑤「仓库级扫描命中」体例。
    add({
      id: 'r1-repo',
      label: '④ 仓库级 R1 静态违规（证据提示 · 不参与定档）',
      pass: repoHard === 0,
      red: false,
      hint: true,
      detail: repoHard
        ? `仓库级命中 ${repoHard} 处（含与本包无关者，故不定档）${hardPkgs?.length ? `：${hardPkgs.slice(0, 3).join('、')}${hardPkgs.length > 3 ? ' …' : ''}` : ''}`
        : '',
    });
    add({
      id: 'r5-adapter', label: '④+ 适配层副本一致（R5）',
      pass: dc.r5Ok === true,
      detail: dc.r5Ok === true ? '' : '适配层副本 sha 与唯一源不一致（生产跑着旧副本）',
    });
  }

  // ---- ⑤ 词表守卫：GONE = 0 且扫描无"判定类"命中 ----
  const vg = input.vocabGuard ?? {};
  if (vg.ok !== true) {
    add({ id: 'vocab-gone', label: '⑤ 词表守卫 GONE = 0', pass: false, evidence: false, detail: `词表守卫不可用：${vg.reason ?? '未采集'}` });
    add({ id: 'vocab-scan', label: '⑤ 扫描无判定类命中', pass: false, evidence: false, detail: '词表守卫不可用' });
  } else {
    add({
      id: 'vocab-gone', label: '⑤ 词表守卫 GONE = 0（登记名跨线是否消失）',
      pass: Number(vg.gone ?? 0) === 0,
      detail: Number(vg.gone ?? 0) ? `GONE ${vg.gone} 项 → 升级后判定恒不命中（静默失准）` : '',
    });
    add({
      // ⚠️ 2026-09-15（P4 · 主人拍板②）：本项**降为证据提示项**（`red:false` + `hint:true`）。
      //    原因：它的扫描范围是**整个仓库** —— 任何一处与本包无关的写死事件名都会命中，
      //    当 red 触发项会让**任何包恒 🔴** ⇒ 分级授权形同虚设（实测 @liustack/modlens 十一项十绿仍 🔴，
      //    唯一不通过项命中 7 处全在 tools\ 的无关工具里，那 7 处本身不是待修 bug）。
      //    仓库级卫生属"健康度提示"，不属"这个包能不能自动升"的门；包级安全性由
      //    ④ R1/R5 · ⑤+ R4 跨线断裂 · 断裂符号（本就包级）三项负责。
      id: 'vocab-scan',
      label: '⑤ 仓库级扫描命中（证据提示 · 不参与定档）',
      pass: Number(vg.scanDecisionHits ?? 0) === 0,
      red: false,
      hint: true,
      detail: Number(vg.scanDecisionHits ?? 0)
        ? `仓库级命中 ${vg.scanDecisionHits} 处（含与本包无关者，故不定档）${(vg.scanDecisionPlaces ?? []).length ? `：${(vg.scanDecisionPlaces ?? []).slice(0, 3).join('；')}${(vg.scanDecisionPlaces ?? []).length > 3 ? ' …' : ''}` : ''}`
        : '',
    });
    add({
      id: 'vocab-r4', label: '⑤+ R4 跨线断裂 0',
      pass: Number(vg.r4Broken ?? 0) === 0,
      detail: Number(vg.r4Broken ?? 0) ? `R4 跨线断裂 ${vg.r4Broken} 处` : '',
    });
  }

  // ---- 断裂符号（dsh-upgrade-audit v3 · 目标版 SDK 导出面）----
  // ⚠️ **包级判定**：审计报告按包给断点，一个包的断点不许误伤全部插件（否则整仓恒 🔴）。
  const au = input.audit ?? {};
  if (au.ok !== true) {
    add({ id: 'audit-symbols', label: '断裂符号命中 0（dsh-upgrade-audit v3）', pass: false, evidence: false, detail: `L0 审计不可用：${au.reason ?? '未采集（缺目标版 tarball 样本？）'}` });
  } else {
    const mine = (au.brokenByPackage ?? {})[name] ?? [];
    const others = Object.entries(au.brokenByPackage ?? {}).filter(([k]) => k !== name);
    add({
      id: 'audit-symbols', label: '断裂符号命中 0（dsh-upgrade-audit v3）',
      pass: mine.length === 0,
      detail: mine.length
        ? `该包命中断裂面 ${mine.length} 项：${mine.slice(0, 3).join('；')}${mine.length > 3 ? ' …' : ''}`
        : (others.length ? `（本包无命中；审计报告里另有 ${others.length} 个包命中，与本包无关）` : ''),
    });
  }

  // ---- ⑥ 不要求"主包 0.1.2+ 前置" ----
  add({
    id: 'host-prereq', label: '⑥ 不要求先升主包',
    pass: input.hostUpgradeRequired !== true,
    detail: input.hostUpgradeRequired === true ? '该版本要求新主包前置（须与主包同批 → 归主人）' : '',
  });

  // ---- 大跳版 ----
  const jump = input.majorJump === undefined ? isMajorJump(pkg.localVersion, pkg.targetVersion) : input.majorJump === true;
  add({
    id: 'major-jump', label: '非大跳版',
    pass: !jump,
    detail: jump ? `跨度 ${pkg.localVersion ?? '?'} → ${pkg.targetVersion ?? '?'} 判为大跳（阈值：major 不同 或 minor 差 ≥ ${MAJOR_JUMP_MINOR_GAP}）` : '',
  });

  // ---- 汇总定档（fail-closed） ----
  const redHits = checks.filter((c) => !c.pass && c.red);
  let tier;
  if (redHits.length) tier = 'red';
  else if (hasPatches) tier = patchReady ? 'yellow' : 'red';   // patchReady=false 的情形上面已记 red，这里只是兜底
  else tier = 'green';

  const requiredSteps = tier === 'red'
    ? ['出方案 → 等主人在主会话批准（本链不执行）']
    : tier === 'yellow'
      ? ['静默窗', '快照', 'npm/部署升级', '全量补丁重打', '重启 + 验特征', '自检（含词表守卫 baseline 对比）', '记流水', '失败 → 自动回滚 + 报主人']
      : ['静默窗', '快照', 'npm/部署升级', '自检（含词表守卫 baseline 对比）', '记流水', '失败 → 自动回滚 + 报主人'];

  return {
    tier,
    reasons,
    checks,
    evidenceGaps,
    requiredSteps,
    hasPatches,
    patchReady,
    versions: {
      local: pkg.localVersion ?? null,
      target: pkg.targetVersion ?? null,
      isMajorJump: jump,
    },
    triageVersion: TRIAGE_VERSION,
  };
}

/**
 * 自动化总闸判定（纯函数 · **默认关**）。
 * 口径：开关读不到 / 损坏 / 字段缺失 / 类型不对 → 一律**视为关闭**（fail-closed，绝不放行）。
 * @param {object|null|undefined} cfg  `~/.dsh/upgrade-automation.json` 的解析结果
 * @returns {{enabled:boolean, reason:string, config:object|null}}
 */
export function resolveAutomationGate(cfg) {
  if (!cfg || typeof cfg !== 'object') return { enabled: false, reason: '配置文件缺失或不可解析 → 默认关（fail-closed）', config: null };
  if (cfg.enabled !== true) return { enabled: false, reason: `enabled=${JSON.stringify(cfg.enabled ?? null)}（非 true）→ 关`, config: cfg };
  return { enabled: true, reason: 'enabled=true', config: cfg };
}

/**
 * 编排步骤计划（纯函数，供 `--dry-run` 渲染与单测断言；**不含任何执行**）。
 * @param {object} o
 * @param {'green'|'yellow'|'red'} o.tier
 * @param {boolean} o.patrol      只读巡检模式（恒无副作用）
 * @param {boolean} o.gateEnabled 总闸是否打开
 * @returns {Array<{id:string,label:string,executor:string|null,willRun:boolean,skippedReason:string|null}>}
 */
export function planSteps({ tier, patrol = false, gateEnabled = false } = {}) {
  const mk = (id, label, executor, willRun, skippedReason = null) => ({ id, label, executor, willRun, skippedReason });
  if (patrol) {
    return [
      mk('collect', '采集判定输入（决策表 + 三件只读工具）', 'collectInputs', true),
      mk('triage', '定档（纯函数）', 'triageUpgrade', true),
      mk('report', '落只读报告 + 建议', 'writeReport', true),
      mk('upgrade', '（不执行任何升级）', null, false, 'patrol 模式恒不升级（口径 D3：只读报告 + 建议）'),
    ];
  }
  if (tier === 'red') {
    return [
      mk('collect', '采集判定输入', 'collectInputs', true),
      mk('triage', '定档 → 🔴', 'triageUpgrade', true),
      mk('proposal', '出方案（报主人）', 'writeReport', true),
      mk('upgrade', '（不执行任何升级）', null, false, '🔴 档只出方案（红线 3）'),
    ];
  }
  const steps = [
    mk('collect', '采集判定输入', 'collectInputs', true),
    mk('triage', `定档 → ${TIER_ICON[tier]}`, 'triageUpgrade', true),
    mk('silence', '开静默窗（停 tickd / 计划任务）', 'dsh-upgrade-silence.mjs --disable', gateEnabled, gateEnabled ? null : '总闸未开（默认关）'),
    mk('snapshot', '升级前快照（profile 四件套 + 插件实体）', 'snapshotUpgradePoint', gateEnabled, gateEnabled ? null : '总闸未开（默认关）'),
    mk('upgrade', 'npm / 部署升级', 'commands.upgrade（须在配置里显式声明）', gateEnabled, gateEnabled ? null : '总闸未开（默认关）'),
  ];
  if (tier === 'yellow') {
    steps.push(mk('repatch', '全量补丁重打（幂等）', 'patch-*.mjs', gateEnabled, gateEnabled ? null : '总闸未开（默认关）'));
  }
  steps.push(
    mk('selfcheck', '自检（冒烟 + 词表守卫 baseline 对比）', 'verify-after-restart / dsh-vocab-guard --baseline', gateEnabled, gateEnabled ? null : '总闸未开（默认关）'),
    mk('changelog', '记变更流水', 'changelog-add.mjs', gateEnabled, gateEnabled ? null : '总闸未开（默认关）'),
    mk('rollback', '失败 → 自动回滚 + 报主人', 'restore-*.mjs', gateEnabled, gateEnabled ? null : '总闸未开（默认关）'),
    mk('silence-enable', '关静默窗（恢复自动化）', 'dsh-upgrade-silence.mjs --enable', gateEnabled, gateEnabled ? null : '总闸未开（默认关）'),
  );
  return steps;
}
