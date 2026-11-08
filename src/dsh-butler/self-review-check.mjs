#!/usr/bin/env node
// ============================================================================
//  self-review-check.mjs —— 「交付前自批（Self-Refine）」只读器具 · H-12
//  --------------------------------------------------------------------------
//  它解决的问题：DoD 十条一直只是嘴上纪律 —— 交付前「该修哪几处」全靠人记得去翻。
//  本器具把它变成一条命令：**给一份交付报告，出「建议修 N 处」的人话清单**。
//
//  口径真源：`<workspace>\docs\口径-交付前自批-20261022.md`
//  DoD 判据真源：`<tools>/lib\rulecheck-rules.mjs#checkDod`（**复用，不另写一份**）
//    规矩本体 = `docs\口径-验收两轨制与DoD十条-20261014.md` §2 / §10
//
//  【只读承诺】不改任何被检文件、不写盘（`--self-test` 例外：只在系统临时目录建夹具，
//  退出前删净）、不联网、不调 LLM、不碰看板、不发通知。
//
//  用法：
//    node <pkg>/src/dsh-butler/self-review-check.mjs --file <交付报告> \
//         [--kw <关键词>]... [--touched <路径>[,<路径>]...] [--since <目录>] \
//         [--changelog-dir <目录>] [--month YYYY-MM] [--json]
//    node <pkg>/src/dsh-butler/self-review-check.mjs --self-test
//    node <pkg>/src/dsh-butler/self-review-check.mjs --help
//
//  六条机械判据（全部确定性匹配，**不判语义**）：
//    ① DoD 十条块在不在 · 勾了几条 · 未勾有没有写「减项 + 为什么」
//    ② 第 9 条有没有**当次命令原文**（出现「见上次 / 历史读数 / 同前」= 没给）
//    ③ 有「待主人 / 待拍板 / 待批」类未决项，却没有「待拍板」段 ⇒ 读报告的人不知道要批什么
//    ④ 引用的 `docs\…` / `_archive\…` / `tools\…` 路径**存在性**（悬空指针当场报）
//    ⑤ 变更流水（`docs\变更流水\<月>.md`）里有没有本件/本卡的行（靠 `--kw`）
//    ⑥ prompt 点名的「顺手件」有没有真改（`--touched` 对存在性 + mtime；少一个就报）
//
//  退出码：0 = 无建议 · 3 = 有建议（**不阻断**，给的是「该修哪几处」）· 2 = 用法错/输入读不到
//  档位：observe —— 默认什么都不改，也永远不替人签字。
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkDod, DOD_ITEMS } from '../lib/rulecheck-rules.mjs';

export const SELF_REVIEW_VERSION = '1.0.0';

const WORKSPACE = process.env.DSH_ROOT || path.resolve(process.env.USERPROFILE || process.env.HOME || '.', 'dsh-workspace');
const CHANGELOG_DIR_DEFAULT = path.join(WORKSPACE, 'docs', '变更流水');
/** 工作根在不在。不在（例：本包被装到别处、或夹具临时目录）⇒ 相对路径一律不可判，别把"没工作区"报成"悬空"。 */
const WORKSPACE_EXISTS = fs.existsSync(WORKSPACE);
/**
 * 顺手件的时间窗口：mtime 早于「时间锚 − 窗口」⇒ 判「这次没动过」。
 * 为什么是**小时级窗口**而不是「60 秒内必须改」：顺手件天然在**写报告之前**改，
 * 拿报告 mtime 当锚时差几分钟是常态（2026-10-22 本卡实测：照 60 秒写会把自己三件全报成"没改"）。
 */
const TOUCH_WINDOW_DEFAULT_H = 12;

const EXIT = { OK: 0, USAGE: 2, SUGGEST: 3 };

const USAGE = `self-review-check —— 交付前自批只读器具（H-12 · observe 档 · 默认零写盘）

用法：
  node <pkg>/src/dsh-butler/self-review-check.mjs --file <交付报告> [选项]
  node <pkg>/src/dsh-butler/self-review-check.mjs --self-test
  node <pkg>/src/dsh-butler/self-review-check.mjs --help

必填：
  --file <路径>            要自批的交付报告（只给一份）

可选：
  --kw <词>                ⑥ 变更流水里要能找到的词（卡号 / 件名 / 标题片段；可多次，命中任一即算）
  --touched <路径>         ⑥ prompt 点名的「顺手件」清单（逗号或分号分隔；可多次）
  --since <目录>           ⑥ 的时间锚改从该目录取（目录内文件**最新 mtime**，与报告 mtime 取较新者）
                            用途：报告先落骨架、之后才改代码的顺序 ⇒ 不该拿报告 mtime 当锚
  --changelog-dir <目录>   变更流水目录（缺省 <workspace>\\docs\\变更流水；夹具/隔离验证用）
  --window <小时>          ⑥ 的时间窗口（缺省 ${TOUCH_WINDOW_DEFAULT_H}）；顺手件 mtime 早于「锚 − 窗口」⇒ 判没动过
  --month YYYY-MM          只查指定月份的流水（缺省 = 报告 mtime 月份 + 本月，两次都查）
  --json                   stdout 只出 JSON（人话改走 stderr）

判据（六条）：
  ① DoD 十条块（勾数 / 缺条 / 未勾没写「减项 + 为什么」）
  ② 第 9 条「判据可现跑复现」必须有当次命令原文（禁「见上次 / 历史读数 / 同前」）
  ③ 有「待主人 / 待拍板 / 待批 / 待定」类未决项，却没有「待拍板」段
  ④ 引用的 docs\\ / _archive\\ / tools\\ 路径存在性（悬空指针）
  ⑤ 变更流水里有没有本件/本卡的行（需要 --kw）
  ⑥ 顺手件有没有真改（需要 --touched；判据 = 存在 + mtime 不早于「时间锚 − 12 小时窗口」）

退出码：0 = 无建议 · 3 = 有建议（不阻断）· 2 = 用法错 / 报告读不到
【不做什么】不改报告、不改任何文件、不替人签字、不当验收（自批 ≠ 验收）。
`;

// ---------------------------------------------------------------------------
//  参数
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  const a = {
    file: null, kws: [], touched: [], since: null, changelogDir: CHANGELOG_DIR_DEFAULT,
    month: null, json: false, selfTest: false, help: false,
  };
  const args = [...argv];
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === '--file' || t === '-f') {
      const v = args[++i];
      if (!v) return { err: '--file 需要路径' };
      if (a.file) return { err: '--file 只接受一份报告（本器具按「一份报告一份自批」设计；多份请分次跑）' };
      a.file = path.resolve(v);
    } else if (t === '--kw') {
      const v = args[++i];
      if (!v) return { err: '--kw 需要一个关键词' };
      a.kws.push(v);
    } else if (t === '--touched') {
      const v = args[++i];
      if (!v) return { err: '--touched 需要一个路径清单' };
      for (const x of v.split(/[,;]/)) if (x.trim()) a.touched.push(x.trim());
    } else if (t === '--since') {
      const v = args[++i];
      if (!v) return { err: '--since 需要目录路径' };
      a.since = path.resolve(v);
    } else if (t === '--changelog-dir') {
      const v = args[++i];
      if (!v) return { err: '--changelog-dir 需要目录路径' };
      a.changelogDir = path.resolve(v);
    } else if (t === '--month') {
      const v = args[++i];
      if (!v || !/^\d{4}-\d{2}$/.test(v)) return { err: `--month 形态不对：${v ?? '(空)'}（要 YYYY-MM）` };
      a.month = v;
    } else if (t === '--window') {
      const v = args[++i];
      if (!v || !/^\d+(?:\.\d+)?$/.test(v) || Number(v) <= 0) return { err: `--window 需要正数（小时）：${v ?? '(空)'}` };
      a.window = Number(v);
    } else if (t === '--json') {
      a.json = true;
    } else if (t === '--self-test') {
      a.selfTest = true;
    } else if (t === '--help' || t === '-h') {
      a.help = true;
    } else {
      return { err: `未知参数：${t}` };
    }
  }
  if (!a.help && !a.selfTest && !a.file) return { err: '缺 --file <交付报告>' };
  return a;
}

// ---------------------------------------------------------------------------
//  小工具
// ---------------------------------------------------------------------------
const plainLines = (md) => String(md ?? '').replace(/^\uFEFF/, '').split(/\r?\n/);
const monthOf = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
const fmtTime = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const clip = (s, n = 110) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

// ---------------------------------------------------------------------------
//  ④ 路径引用提取（只认工作根下有判头的三类前缀 + D: 绝对路径）
// ---------------------------------------------------------------------------
/** 路径尾部的「行号引用 / 结尾标点 / 尾分隔符」统一剥掉。 */
function normalizeRef(raw) {
  let p = String(raw).trim();
  p = p.replace(/[.,;:!?。，；：！？、）】》」』"'`]+$/u, '');
  p = p.replace(/#L\d+(?:-L?\d+)?$/i, '');
  p = p.replace(/:\d+(?:-\d+)?$/, '');
  p = p.replace(/[\\/]+$/u, '');
  return p;
}

const REF_CHECKABLE = new Set(['docs', '_archive', 'tools', 'generated', 'logs', 'snapshots', 'backups']);
// 分隔符集：空白 + 半角/全角引号括号 + 中文标点 + 全角竖线/斜杠（中文文档常拿它们当「路径 ｜ 说明」的分隔）。
const REF_STOP = /[^\s`'"|<>*?{}，。；、：！？（）()【】\[\],;）｜／＼～]/u.source;
const ABS_REF_RE = new RegExp(`[A-Za-z]:[\\\\/]${REF_STOP}*`, 'gu');
const REL_REF_RE = new RegExp(`(?<![\\w.\\\\/-])(docs|_archive|tools|generated|logs|snapshots|backups)[\\\\/]${REF_STOP}*`, 'gu');
/** 反引号代码段「整段就是一个路径」的形态 —— 用来兜住**带空格的中文档名**（`docs\交接-大管家 · V3.0.0 …md`）。 */
const CODE_PATH_RE = /^(?:[A-Za-z]:[\\/])?(?:docs|_archive|tools|generated|logs|snapshots|backups)[\\/]/;
/** 「这串到底是不是一个可判的路径」—— 收窄口径：**带扩展名的文件** 或 **以分隔符结尾的目录写法**；
 *  其余（半截档名 / 纯目录名 / 变量占位）一律标"不可判"，宁可不报也不制造假阳性。 */
const HAS_EXT = /\.[A-Za-z0-9]{1,8}$/;

/**
 * 抽一份报告里所有「可判」的路径引用。
 * @returns {{refs:Array<{raw:string,abs:string,line:number}>, skipped:number}}
 */
export function extractPathRefs(lines, wsRoot = WORKSPACE) {
  const seen = new Map();
  let skipped = 0;
  /** 尾部紧跟 `*` `<` `>` 这类字符 ⇒ 这是被通配/占位写法切开的半截路径，整条不可判（别报假阳性）。 */
  const CUT_BY_WILD = /[<>{}$*?…]/;
  const push = (raw, line, text, index, len) => {
    const nextChar = text[index + len] ?? '';
    if (CUT_BY_WILD.test(nextChar)) { skipped++; return; }
    const rawTrim = String(raw).trim();
    const isDirRef = /[\\/]$/.test(rawTrim);                       // 目录写法（尾分隔符）—— 先记，后面 normalize 会剥掉
    const norm = normalizeRef(raw);
    if (!norm || norm.length > 240) { skipped++; return; }
    if (/[*?<>{}|$%…｜]/.test(norm) || /\.{3,}/.test(norm)) { skipped++; return; }  // 通配 / 占位 / 省略号 ⇒ 不可判
    if (/xx/i.test(norm)) { skipped++; return; }                   // 模糊时间/占位写法（`…-1612xx\rows.jsonl`）⇒ 不可判
    if (!isDirRef && !HAS_EXT.test(norm)) { skipped++; return; }   // 半截档名 / 纯目录名 ⇒ 不可判（低误报优先）
    let abs = null;
    if (/^[A-Za-z]:[\\/]/.test(norm)) {
      if (!/^[Dd]:[\\/]/.test(norm)) { skipped++; return; }        // 只判 D 盘（其它盘可能是别的机器）
      // 工作根 `<workspace>\…` 真正的「面」是**第二段**（docs / tools / _archive / …），不是盘符后那段 `DSH`。
      const rel = norm.replace(/^[A-Za-z]:[\\/]/, '');
      const parts = rel.split(/[\\/]/);
      const segAbs = (/^dsh$/i.test(parts[0] ?? '') ? (parts[1] ?? '') : (parts[0] ?? '')).toLowerCase();
      if (!REF_CHECKABLE.has(segAbs)) { skipped++; return; }       // 只判工作根下的正式目录面（_tmp 等临时件不判）
      abs = path.normalize(norm);
    } else {
      if (!fs.existsSync(wsRoot)) { skipped++; return; }              // 工作根不存在 ⇒ 相对路径没有参照系
      const seg = norm.split(/[\\/]/)[0].toLowerCase();
      if (!REF_CHECKABLE.has(seg)) { skipped++; return; }
      abs = path.normalize(path.join(wsRoot, norm));
    }
    if (!abs) { skipped++; return; }
    const key = abs.toLowerCase();
    if (!seen.has(key)) seen.set(key, { raw: norm, abs, line });
  };

  // 围栏代码块按**语言**分两类（2026-10-22 本卡自批自己时实测定下的口径）：
  //   · text / txt / log / output / md  —— 语义是「输出 / 日志 / 示例」，里面的路径**不判**
  //     （否则「贴一次器具输出」会让下一次自批把输出里的悬空路径报成新缺口 = 自指死循环）
  //   · 裸块（无语言）/ powershell / bash / js … —— 语义是「命令」，里面的路径**照判**
  //     （验收命令跑不通正是最该抓的缺口：例 `node tools\xxx.mjs` 而脚本其实在 _archive）
  const SKIP_LANGS = /^(?:text|txt|log|output|md|markdown)$/i;
  let fenceLang = null;
  lines.forEach((text, idx) => {
    const line = idx + 1;
    const fence = /^\s*(?:```|~~~)\s*([A-Za-z0-9_-]*)/.exec(text);
    if (fence) { fenceLang = fenceLang === null ? (fence[1] || '') : null; return; }
    if (fenceLang !== null && SKIP_LANGS.test(fenceLang)) return;
    // ① 先把「反引号里整段就是路径」的捞出来 —— 只有它能把**带空格的路径**当整体（空格是路径的正常字符）
    const claimed = [];
    for (const sp of text.matchAll(/`([^`\n]{1,400})`/g)) {
      const inner = sp[1].trim();
      if (!inner || !CODE_PATH_RE.test(inner)) continue;
      if (/[|｜<>*?{}]/.test(inner) || /\s--/.test(inner)) continue;  // 命令行 / 占位 / 通配 ⇒ 不整体认
      if (!/\s/.test(inner)) continue;                                // 无空格：常规扫描已能完整识别，别重复
      claimed.push([sp.index, sp.index + sp[0].length]);
      push(inner, line, text, sp.index + 1, inner.length);
    }
    const isClaimed = (i) => claimed.some(([a, b]) => i >= a && i < b);
    // ② 常规逐 token 扫描（裸文本 / 反引号内的单 token 路径）
    for (const m of text.matchAll(ABS_REF_RE)) { if (!isClaimed(m.index)) push(m[0], line, text, m.index, m[0].length); }
    for (const m of text.matchAll(REL_REF_RE)) { if (!isClaimed(m.index)) push(m[0], line, text, m.index, m[0].length); }
  });
  return { refs: [...seen.values()], skipped };
}

// ---------------------------------------------------------------------------
//  ③ 待拍板段
// ---------------------------------------------------------------------------
/** 「有未决项」的**强信号** —— 只认「明确在等一个人拍板」的说法。
 *  ⚠️ **不把「待拍板」三个字单独当信号**：它太常作为**名词**出现（锚点词表 / `待拍板债` / 历史状态描述），
 *     那样会把几乎每份报告都误报成「缺待拍板段」（2026-10-22 批量 sweep 实测：24 份报告里 15 份是这类假阳性）。 */
const PENDING_SIGNAL = /(待主人(拍板|决定|确认|点头|过目|挑|选)|请主人(拍板|决定|确认|选)|等主人(拍板|决定|确认)|待批(准|示)|二选一|三选一|待定|未决)/;
const PENDING_NEGATION = /(?:零|无|没有|不再|暂无|不涉及|不需要)\s*[\*`_\s]*(?:待拍板|未决|待定)[\*`_\s]*/gu;
/** 段判定放宽到「heading 含 待拍板/待主人/待批/未决/待定」—— 摆在哪不重要，读报告的人看得见就行。 */
const SECTION_WORDS = /待拍板|待主人|待批|未决|待定/;

function findPending(lines) {
  const headingRe = /^#{1,6}\s/;
  let sectionLine = 0;
  const signals = [];
  lines.forEach((text, idx) => {
    const line = idx + 1;
    if (!sectionLine && headingRe.test(text) && SECTION_WORDS.test(text)) sectionLine = line;
    // 反引号里的**短词**（锚点词表 / 开关名）整段剔掉，别把它当信号
    const bare = text.replace(/`[^`\n]{1,10}`/g, '').replace(PENDING_NEGATION, '');
    const m = PENDING_SIGNAL.exec(bare);
    if (m) signals.push({ line, word: m[1], text: clip(bare, 100) });
  });
  return { sectionLine, signals };
}

// ---------------------------------------------------------------------------
//  ② 第 9 条（块外兜底检测）
// ---------------------------------------------------------------------------
const CMD_TRACE = /`[^`]+`|[A-Za-z]:[\\/]|\b(node|npm|npx|pwsh|powershell|git|python|choco|winget)\b|Get-[A-Za-z]+|\.(mjs|ps1|cmd|bat|exe|sh)\b/;
const HISTORY_WORDS = /历史读数|见上次|同上|同前|沿用上次|之前跑过|上次跑过|见前次/;

/** 第 9 条不在 DoD 块里时的兜底：全文找「第 9 条 / 判据可现跑复现」的落点，判它有没有当次命令。 */
function checkNinthOutsideBlock(lines, blockHasNinth) {
  if (blockHasNinth) return null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (!/第\s*9\s*条|判据可现跑复现/.test(text)) continue;
    if (HISTORY_WORDS.test(text)) {
      return { line: i + 1, msg: '第 9 条的说明里出现「引历史读数」措辞（见上次 / 历史读数 / 同前）—— 口径：禁引历史读数，要给当次命令原文', evidence: clip(text) };
    }
    if (!CMD_TRACE.test(text)) {
      return { line: i + 1, msg: '第 9 条写了但看不见任何当次命令 / 路径（口径：第 9 条不许减项，必须带命令原文）', evidence: clip(text) };
    }
    return { line: i + 1, msg: '第 9 条的命令写在 DoD 块**外面**（rulecheck 的 T3 只认块内第 9 条 ⇒ 等于没登记）', evidence: clip(text) };
  }
  return null;
}

// ---------------------------------------------------------------------------
//  ⑤ 变更流水
// ---------------------------------------------------------------------------
function checkChangelog(kws, months, dir) {
  const hits = [];
  const missingFiles = [];
  for (const m of months) {
    const f = path.join(dir, `${m}.md`);
    if (!fs.existsSync(f)) { missingFiles.push({ month: m, file: f }); continue; }
    const lines = plainLines(fs.readFileSync(f, 'utf8'));
    lines.forEach((text, idx) => {
      for (const kw of kws) {
        if (text.toLowerCase().includes(kw.toLowerCase())) hits.push({ month: m, kw, line: idx + 1, text: clip(text, 160) });
      }
    });
  }
  return { hits, missingFiles };
}

// ---------------------------------------------------------------------------
//  ⑥ 顺手件
// ---------------------------------------------------------------------------
function checkTouched(list, anchorMs, windowMs) {
  return list.map((p) => {
    const abs = path.isAbsolute(p) ? path.normalize(p) : path.normalize(path.join(WORKSPACE, p));
    if (!fs.existsSync(abs)) return { input: p, abs, exists: false };
    const st = fs.statSync(abs);
    return { input: p, abs, exists: true, mtimeMs: st.mtimeMs, mtime: fmtTime(new Date(st.mtimeMs)), stale: st.mtimeMs < anchorMs - windowMs };
  });
}

/** `--since <目录>` ⇒ 该目录内文件的最新 mtime（递归一层足够；再深就扫描太慢）。 */
function latestMtimeIn(dir) {
  let max = 0;
  const walk = (d, depth) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const full = path.join(d, e.name);
      try {
        if (e.isDirectory()) { if (depth > 0) walk(full, depth - 1); }
        else { const st = fs.statSync(full); if (st.mtimeMs > max) max = st.mtimeMs; }
      } catch { /* 单条读不到不影响整体 */ }
    }
  };
  walk(dir, 1);
  return max;
}

// ---------------------------------------------------------------------------
//  主判据编排
// ---------------------------------------------------------------------------
/**
 * 对一份报告做自批（纯读）。
 * @param {string} filePath 报告绝度路径
 * @param {{kws?:string[],touched?:string[],since?:string,changelogDir?:string,month?:string}} opts
 */
export function selfReview(filePath, opts = {}) {
  const st = fs.statSync(filePath);
  const md = fs.readFileSync(filePath, 'utf8');
  const lines = plainLines(md);
  const reportMtimeMs = st.mtimeMs;
  const suggestions = [];
  const checks = [];
  const add = (s) => suggestions.push(s);

  // --- ① + ②：DoD 块（复用 rulecheck 的单一真源）
  const dod = checkDod(md);
  const blockFound = dod.meta?.blockFound === true;
  const ninthInBlock = blockFound && dod.items.some((x) => x.no === 9);
  const unchecked = dod.items.filter((x) => !x.checked).map((x) => x.no);
  checks.push({
    id: 'dod', label: '① DoD 十条块',
    status: blockFound ? (dod.issues.length ? 'warn' : 'ok') : 'warn',
    detail: blockFound
      ? `在（L${dod.meta.beginLine}~L${dod.meta.endLine}）· 勾 ${dod.counts.checked}/${DOD_ITEMS.length}${unchecked.length ? ` · 未勾 ${unchecked.join(',')}` : ''}`
      : '找不到块（缺 `<!-- DoD:begin -->` … `<!-- DoD:end -->`）',
  });
  for (const iss of dod.issues) {
    if (iss.id === 'T3') continue;                                  // T3 归 ②
    add({ id: '①', tag: 'DoD 块', line: iss.counts?.line ?? null, msg: iss.msg, evidence: iss.evidence });
  }
  // 从 evidence 里抠行号（rulecheck 的 T1/T2/T4 把行号塞在 evidence 字符串里）
  for (const s of suggestions.filter((x) => x.id === '①' && x.line == null)) {
    const m = /L(\d+)/.exec(s.evidence ?? '');
    if (m) s.line = Number(m[1]);
  }

  const t3 = dod.issues.filter((x) => x.id === 'T3');
  const ninthOutside = checkNinthOutsideBlock(lines, ninthInBlock);
  const ninthOk = blockFound && ninthInBlock && t3.length === 0;
  checks.push({
    id: 'ninth', label: '② 第 9 条当次命令',
    status: ninthOk ? 'ok' : 'warn',
    detail: ninthOk ? '有当次命令原文' : (blockFound ? (ninthInBlock ? '有第 9 条但不合规（见建议）' : '块里没有第 9 条') : '块不在 ⇒ 无第 9 条'),
  });
  for (const iss of t3) {
    const m = /L(\d+)/.exec(iss.evidence ?? '');
    add({ id: '②', tag: '第 9 条', line: m ? Number(m[1]) : null, msg: iss.msg, evidence: iss.evidence });
  }
  if (ninthOutside) add({ id: '②', tag: '第 9 条', line: ninthOutside.line, msg: ninthOutside.msg, evidence: ninthOutside.evidence });
  if (!ninthOutside && !ninthInBlock && !t3.length && blockFound) {
    add({ id: '②', tag: '第 9 条', line: dod.meta.endLine, msg: 'DoD 块里没有第 9 条「判据可现跑复现」（口径：本条不许减项）', evidence: `块 L${dod.meta.beginLine}~L${dod.meta.endLine}` });
  }

  // --- ③ 待拍板段
  const pending = findPending(lines);
  if (!pending.sectionLine && pending.signals.length) {
    const first = pending.signals[0];
    checks.push({ id: 'board', label: '③ 待拍板段', status: 'warn', detail: `没有段，但正文有 ${pending.signals.length} 处未决信号` });
    add({
      id: '③', tag: '待拍板段', line: first.line,
      msg: `正文有「${first.word}」类未决项（共 ${pending.signals.length} 处），但报告里没有「待拍板」段 ⇒ 主人/验收方不知道要批什么、卡 description 也没处对齐`,
      evidence: `首个信号 L${first.line}「${first.text}」`,
    });
  } else {
    checks.push({
      id: 'board', label: '③ 待拍板段',
      status: 'ok',
      detail: pending.sectionLine ? `有（L${pending.sectionLine}）` : '正文无未决信号（不需要段）',
    });
  }

  // --- ④ 路径存在性
  const { refs, skipped } = extractPathRefs(lines, opts.workspaceRoot ?? WORKSPACE);
  const dangling = refs.filter((r) => !fs.existsSync(r.abs));
  checks.push({
    id: 'refs', label: '④ 引用路径存在性',
    status: dangling.length ? 'warn' : 'ok',
    detail: `可判 ${refs.length} 处 · 悬空 ${dangling.length} 处${skipped ? ` · 不可判 ${skipped} 处（通配/占位/外机）` : ''}`,
  });
  for (const d of dangling) {
    add({ id: '④', tag: '悬空指针', line: d.line, msg: `引用的路径盘上不存在：${d.raw}`, evidence: d.abs });
  }

  // --- ⑤ 变更流水
  const kws = (opts.kws ?? []).filter(Boolean);
  const months = opts.month
    ? [opts.month]
    : [...new Set([monthOf(new Date(reportMtimeMs)), monthOf(new Date())])];
  if (!kws.length) {
    checks.push({ id: 'changelog', label: '⑤ 变更流水', status: 'skip', detail: `未判（没给 --kw）· 查 ${months.map((m) => `${m}.md`).join(' / ')}` });
  } else {
    const cl = checkChangelog(kws, months, opts.changelogDir ?? CHANGELOG_DIR_DEFAULT);
    const ok = cl.hits.length > 0;
    checks.push({
      id: 'changelog', label: '⑤ 变更流水',
      status: ok ? 'ok' : 'warn',
      detail: ok
        ? `命中 ${cl.hits.length} 处（${months.map((m) => `${m}.md`).join(' / ')}）`
        : `关键词一个都没命中（查 ${months.map((m) => `${m}.md`).join(' / ')}）`,
    });
    if (!ok) {
      add({
        id: '⑤', tag: '变更流水', line: null,
        msg: `变更流水里找不到 ${kws.map((k) => `「${k}」`).join(' / ')} 的行 ⇒ 收尾漏了 changelog-add（或关键词与流水写法对不上）`,
        evidence: cl.missingFiles.length ? `流水文件不存在：${cl.missingFiles.map((x) => x.file).join(' · ')}` : `已查 ${months.join(',')}`,
      });
    }
  }

  // --- ⑥ 顺手件
  const touched = (opts.touched ?? []).filter(Boolean);
  let anchorMs = reportMtimeMs;
  let anchorWhy = '报告 mtime';
  if (opts.since) {
    const sinceMax = latestMtimeIn(opts.since);
    if (sinceMax > anchorMs) { anchorMs = sinceMax; anchorWhy = `--since 目录最新改动（${fmtTime(new Date(sinceMax))}）`; }
    else anchorWhy = `报告 mtime（--since 目录更旧，取其新者）`;
  }
  if (!touched.length) {
    checks.push({ id: 'touched', label: '⑥ 顺手件', status: 'skip', detail: '未判（没给 --touched）' });
  } else {
    const windowH = Number.isFinite(opts.window) ? opts.window : TOUCH_WINDOW_DEFAULT_H;
    const res = checkTouched(touched, anchorMs, windowH * 3600_000);
    const bad = res.filter((x) => !x.exists || x.stale);
    checks.push({
      id: 'touched', label: '⑥ 顺手件',
      status: bad.length ? 'warn' : 'ok',
      detail: `${res.length - bad.length}/${res.length} 都动过 · 时间锚 ${fmtTime(new Date(anchorMs))}（${anchorWhy}）· 窗口 ${windowH} h`,
    });
    for (const r of bad) {
      if (!r.exists) add({ id: '⑥', tag: '顺手件缺件', line: null, msg: `点名的顺手件不存在：${r.input}（解析到 ${r.abs}）⇒ 这活没交付，不是"忘了写进报告"`, evidence: r.abs });
      else add({ id: '⑥', tag: '顺手件没动', line: null, msg: `顺手件 mtime 停在 ${r.mtime}，早于时间锚 ${windowH} 小时以上 ⇒ 疑似这次没动过（报告可能只是自述「已顺手修」）`, evidence: `${r.abs} · mtime=${r.mtime}` });
    }
  }

  return {
    version: SELF_REVIEW_VERSION,
    file: filePath,
    bytes: st.size,
    mtime: fmtTime(new Date(reportMtimeMs)),
    lines: lines.length,
    checks,
    suggestions,
    counts: { suggestions: suggestions.length, checks: checks.length, skipped: checks.filter((c) => c.status === 'skip').length },
    anchor: { ms: anchorMs, why: anchorWhy },
  };
}

// ---------------------------------------------------------------------------
//  输出
// ---------------------------------------------------------------------------
const ICON = { ok: '✅', warn: '⚠️ ', skip: '○ ' };

function renderHuman(r) {
  const out = [];
  out.push(`🪞 交付前自批 · ${path.basename(r.file)}`);
  out.push(`   ${r.bytes} B · ${r.lines} 行 · mtime ${r.mtime}`);
  out.push(`   ${r.file}`);
  out.push('');
  for (const c of r.checks) {
    out.push(`   ${ICON[c.status] ?? '·'} ${c.label} —— ${c.detail}`);
  }
  out.push('');
  if (!r.suggestions.length) {
    out.push('   建议修 0 处 —— 六条机械判据全过（**注意：这不等于验收通过**，自批只挡机械缺口，语义与需求轨仍归人）');
  } else {
    out.push(`   建议修 ${r.suggestions.length} 处（不阻断交付，逐条看要不要改）：`);
    r.suggestions.forEach((s, i) => {
      const where = s.line ? `L${s.line}` : '—';
      out.push(`   ${i + 1}) [${s.id} ${s.tag}] ${where} —— ${s.msg}`);
      if (s.evidence) out.push(`      证据：${clip(s.evidence, 160)}`);
    });
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
//  自测夹具（只在系统临时目录，退出前删净）
// ---------------------------------------------------------------------------
// ⚠️ 夹具正文一律用**单引号数组 + join**，不用模板字符串 —— 模板里 `\\` 紧跟反引号会把字符串
//    提前闭合（2026-10-22 本文件首次 --check 就踩到，实测）。
const OK_DOD = [
  '<!-- DoD:begin -->',
  '- [x] 1 语法 / 解析实测过 —— `node --check <tools>/rulecheck.mjs`（rc 0）',
  '- [x] 2 有隔离验证或夹具证据 —— 夹具 12/12',
  '- [x] 3 有回滚点且演练过 —— `<workspace>\\_archive\\v3face-h12-20261022\\` 演练 3/3',
  '- [x] 4 生产改动有备份 —— 备份 sha 逐字节一致',
  '- [x] 5 变更流水记了行 —— `changelog-add.mjs`',
  '- [x] 6 受保护文件过 P5 门 —— 未涉及',
  '- [x] 7 文档 / 指针回写齐（六包） —— 见 `docs\\口径-验收两轨制与DoD十条-20261014.md`',
  '- [x] 8 不越 §11 红线 —— 四问全绿',
  '- [x] 9 判据可现跑复现 —— 当次命令：`node <tools>/rulecheck.mjs dod --file <workspace>\\docs\\口径-验收两轨制与DoD十条-20261014.md`',
  '- [x] 10 未查证项如实登记 —— 见文末：2 项',
  '<!-- DoD:end -->',
].join('\n');

function makeFixtureDir() {
  const root = path.join(os.tmpdir(), `dsh-selfreview-${process.pid}-${Date.now()}`);
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/** 一个用例 = 建夹具文件 → 跑 selfReview → 断言。 */
function runCase(name, build, assert) {
  const root = makeFixtureDir();
  const ctx = { root };
  try {
    const r = build(root);
    const report = selfReview(r.report, r.opts ?? {});
    const errs = [];
    assert(report, errs, r);
    return { name, ok: errs.length === 0, errs, suggestions: report.suggestions, report };
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* 临时目录残留不致命 */ }
  }
}

function selfTest() {
  const results = [];
  let assertions = 0;
  let passed = 0;
  const expect = (cond, label, errs) => { assertions++; if (cond) passed++; else errs.push(label); };
  const has = (r, id) => r.suggestions.some((s) => s.id === id);

  // 夹具 0：合规报告 ⇒ 建议 0（假阳性控制）
  results.push(runCase('合规夹具 ⇒ 0 建议', (root) => {
    const clDir = path.join(root, 'changelog');
    fs.mkdirSync(clDir, { recursive: true });
    // 流水文件名必须跟「查证时的当月」对齐（否则夹具自己会随日历翻月变红）
    const _now = new Date();
    const curMonth = `${_now.getFullYear()}-${String(_now.getMonth() + 1).padStart(2, '0')}`;
    fs.writeFileSync(path.join(clDir, `${curMonth}.md`), '## 10-22\n- 10:00 [HOST-A] 自测夹具：H12-FIXTURE 一行\n', 'utf8');
    const touched = path.join(root, 'touched.mjs');
    fs.writeFileSync(touched, '// touched\n', 'utf8');
    const report = path.join(root, 'ok.md');
    fs.writeFileSync(report, [
      OK_DOD,
      '',
      '# 交付报告 · 合规夹具',
      '',
      '真源：`docs\\口径-验收两轨制与DoD十条-20261014.md`；工具 `tools\\rulecheck.mjs`；备份 `_archive\\v3face-h12-20261022\\`。',
      '',
      '## §6 待拍板',
      '',
      '无（本件零待批项）。',
    ].join('\n'), 'utf8');
    return { report, opts: { kws: ['H12-FIXTURE'], touched: [touched], changelogDir: clDir } };
  }, (r, errs) => {
    expect(r.suggestions.length === 0, `期望 0 建议，实得 ${r.suggestions.length}：${r.suggestions.map((s) => s.id).join(',')}`, errs);
    expect(r.checks.find((c) => c.id === 'dod').status === 'ok', '① 应判 ok', errs);
    expect(r.checks.find((c) => c.id === 'ninth').status === 'ok', '② 应判 ok', errs);
    expect(r.checks.find((c) => c.id === 'changelog').status === 'ok', '⑤ 应判 ok', errs);
    expect(r.checks.find((c) => c.id === 'touched').status === 'ok', '⑥ 应判 ok', errs);
  }));

  // 夹具 1：缺 DoD 块 ⇒ ①
  results.push(runCase('缺 DoD 块 ⇒ 报 ①', (root) => {
    const report = path.join(root, 'nodod.md');
    fs.writeFileSync(report, '# 报告\n\n随手写的，没有 DoD 块。\n', 'utf8');
    return { report };
  }, (r, errs) => {
    expect(has(r, '①'), '应报 ①（缺块）', errs);
    expect(r.checks.find((c) => c.id === 'dod').status === 'warn', '① 应判 warn', errs);
  }));

  // 夹具 2：块在但第 9 条写「见上次」⇒ ②
  results.push(runCase('第 9 条写「见上次」⇒ 报 ②', (root) => {
    const report = path.join(root, 'ninth.md');
    const bad = OK_DOD.replace(
      /- \[x\] 9 .*/,
      '- [x] 9 判据可现跑复现 —— 见上次跑过的那套夹具，结果一样（历史读数）',
    );
    fs.writeFileSync(report, `${bad}\n\n## 待拍板\n\n无。\n`, 'utf8');
    return { report };
  }, (r, errs) => {
    expect(has(r, '②'), '应报 ②（第 9 条引历史读数）', errs);
    expect(!has(r, '①'), '不应连带报 ①', errs);
  }));

  // 夹具 3：块外写第 9 条 ⇒ ② 兜底
  results.push(runCase('第 9 条写在块外 ⇒ 报 ②', (root) => {
    const report = path.join(root, 'outside.md');
    fs.writeFileSync(report, '# 报告\n\n第 9 条：见上次那条命令。\n', 'utf8');
    return { report };
  }, (r, errs) => {
    expect(has(r, '②'), '应报 ②（块外 + 引历史读数）', errs);
  }));

  // 夹具 4：有未决项、没有待拍板段 ⇒ ③
  results.push(runCase('有未决项无待拍板段 ⇒ 报 ③', (root) => {
    const report = path.join(root, 'nopending.md');
    fs.writeFileSync(report, `${OK_DOD}\n\n# 报告\n\n这里有一个取舍待主人拍板：A 还是 B？\n`, 'utf8');
    return { report };
  }, (r, errs) => {
    expect(has(r, '③'), '应报 ③', errs);
  }));

  // 夹具 5：待拍板段在 + 否定写法 ⇒ 不报 ③
  results.push(runCase('「待拍板：无」不算未决 ⇒ 不报 ③', (root) => {
    const report = path.join(root, 'pend-ok.md');
    fs.writeFileSync(report, `${OK_DOD}\n\n# 报告\n\n## §6 待拍板\n\n无待拍板项。\n`, 'utf8');
    return { report };
  }, (r, errs) => {
    expect(!has(r, '③'), '不应报 ③', errs);
  }));

  // 夹具 6：路径悬空 ⇒ ④
  results.push(runCase('路径悬空 ⇒ 报 ④', (root) => {
    const report = path.join(root, 'dangling.md');
    const body = ['', '# 报告', '', '见 `docs\\交付报告-不存在-29991010.md` 与 `_archive\\no-such-dir-29991010\\`。'].join('\n');
    fs.writeFileSync(report, OK_DOD + body, 'utf8');
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'docs', '口径-验收两轨制与DoD十条-20261014.md'), '# stub\n', 'utf8');
    fs.mkdirSync(path.join(ws, '_archive', 'v3face-h12-20261022'), { recursive: true });
    return { report, opts: { workspaceRoot: ws } };
  }, (r, errs) => {
    const byDangling = r.suggestions.filter((s) => s.id === '④');
    expect(byDangling.length === 2, `应报 2 处悬空，实得 ${byDangling.length}`, errs);
  }));

  // 夹具 7：通配 / 占位路径不误报 ⇒ ④ 不报
  results.push(runCase('通配/占位路径不误报 ⇒ 不报 ④', (root) => {
    const report = path.join(root, 'wild.md');
    const body = ['', '# 报告', '', '扫 `docs\\*.md` · 模板 `docs\\交付报告-<主题>-<日期>.md` · 流水 `docs\\变更流水\\<当月>.md`。'].join('\n');
    fs.writeFileSync(report, OK_DOD + body, 'utf8');
    return { report };
  }, (r, errs) => {
    expect(!has(r, '④'), `不应报 ④，实得：${r.suggestions.filter((s) => s.id === '④').map((s) => s.msg).join(' | ')}`, errs);
  }));

  // 夹具 8：流水查不到 ⇒ ⑤
  results.push(runCase('流水查不到 ⇒ 报 ⑤', (root) => {
    const clDir = path.join(root, 'changelog');
    fs.mkdirSync(clDir, { recursive: true });
    fs.writeFileSync(path.join(clDir, '2026-10.md'), '## 10-22\n- 10:00 [HOST-A] 别的事\n', 'utf8');
    const report = path.join(root, 'nolog.md');
    fs.writeFileSync(report, `${OK_DOD}\n\n# 报告\n\n## 待拍板\n\n无。\n`, 'utf8');
    return { report, opts: { kws: ['H12-NOT-THERE'], changelogDir: clDir } };
  }, (r, errs) => {
    expect(has(r, '⑤'), '应报 ⑤', errs);
  }));

  // 夹具 9：顺手件没动 ⇒ ⑥
  results.push(runCase('顺手件 mtime 陈旧 ⇒ 报 ⑥', (root) => {
    const old = path.join(root, 'old.mjs');
    fs.writeFileSync(old, '// old\n', 'utf8');
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600_000);
    fs.utimesSync(old, threeDaysAgo, threeDaysAgo);
    const report = path.join(root, 'touch.md');
    fs.writeFileSync(report, `${OK_DOD}\n\n# 报告\n\n## 待拍板\n\n无。\n`, 'utf8');
    return { report, opts: { touched: [old] } };
  }, (r, errs) => {
    expect(has(r, '⑥'), '应报 ⑥（mtime 陈旧）', errs);
  }));

  // 夹具 10：顺手件缺件 ⇒ ⑥
  results.push(runCase('顺手件缺件 ⇒ 报 ⑥', (root) => {
    const report = path.join(root, 'miss.md');
    fs.writeFileSync(report, `${OK_DOD}\n\n# 报告\n\n## 待拍板\n\n无。\n`, 'utf8');
    return { report, opts: { touched: [path.join(root, 'never-created.mjs')] } };
  }, (r, errs) => {
    expect(r.suggestions.some((s) => s.id === '⑥' && /不存在/.test(s.msg)), '应报 ⑥（缺件）', errs);
  }));

  // 夹具 11：减项写了理由 ⇒ 不算建议（不误报）
  results.push(runCase('减项写了理由 ⇒ 不误报', (root) => {
    const report = path.join(root, 'drop.md');
    const md = OK_DOD.replace('- [x] 3 有回滚点且演练过 —— `<workspace>\\_archive\\v3face-h12-20261022\\rollback.mjs` 演练 3/3',
      '- [ ] 3 有回滚点且演练过 —— 减项：本件零生产改动，删文件即回滚');
    fs.writeFileSync(report, `${md}\n\n# 报告\n\n## 待拍板\n\n无。\n`, 'utf8');
    return { report };
  }, (r, errs) => {
    expect(!has(r, '①'), `不应报 ①，实得：${r.suggestions.filter((s) => s.id === '①').map((s) => s.msg).join(' | ')}`, errs);
  }));

  // 夹具 12：未勾且没写减项 ⇒ ① 要报（必须报）
  results.push(runCase('未勾没写减项 ⇒ 报 ①', (root) => {
    const report = path.join(root, 'drop-bad.md');
    const md = OK_DOD.replace('- [x] 4 生产改动有备份 —— 备份 sha 逐字节一致', '- [ ] 4 生产改动有备份 —— 没弄');
    fs.writeFileSync(report, `${md}\n\n# 报告\n\n## 待拍板\n\n无。\n`, 'utf8');
    return { report };
  }, (r, errs) => {
    expect(has(r, '①'), '应报 ①（未勾没写减项）', errs);
  }));

  // 夹具 13：反引号里「带空格的中文档名」⇒ 整段判、不截成半截（依赖生产里那份带空格的交接档存在）
  results.push(runCase('带空格路径整段判 ⇒ 不误报 ④', (root) => {
    const report = path.join(root, 'space.md');
    const body = ['', '# 报告', '', '真源 `docs\\交接-大管家 · V3.0.0 功能面-20261022.md`。'].join('\n');
    fs.writeFileSync(report, OK_DOD + body, 'utf8');
    return { report };
  }, (r, errs) => {
    expect(!has(r, '④'), `不应报 ④，实得：${r.suggestions.filter((s) => s.id === '④').map((s) => s.msg).join(' | ')}`, errs);
  }));

  // 夹具 14：半截档名 / 模糊时间 / 省略号 / 纯目录名 ⇒ 一律不判（宁漏不误）
  results.push(runCase('半截·模糊·省略号 ⇒ 不误报 ④', (root) => {
    const report = path.join(root, 'fuzzy.md');
    const body = [
      '', '# 报告', '',
      '见 `docs\\交付报告-被表格截断-20261013` · `_archive\\memory-removed\\20261022-1612xx\\rows.jsonl` · `_archive\\...\\drill` · `docs\\交接-大管家`。',
    ].join('\n');
    fs.writeFileSync(report, OK_DOD + body, 'utf8');
    return { report };
  }, (r, errs) => {
    expect(!has(r, '④'), `不应报 ④，实得：${r.suggestions.filter((s) => s.id === '④').map((s) => s.msg).join(' | ')}`, errs);
  }));

  // 夹具 15：卡面点名的「反向夹具」—— 一份报告同时缺 DoD 块 + 第 9 条写「见上次」+ 路径悬空 ⇒ 三类都要报
  results.push(runCase('反向夹具（三类同现）⇒ ①②④ 全报', (root) => {
    const report = path.join(root, 'reverse.md');
    const body = [
      '# 反向夹具 · 三类缺口同现',
      '',
      '第 9 条 · 判据可现跑复现 —— 见上次跑过的那套夹具，结果一样（历史读数）。',
      '',
      '真源：`docs\\交付报告-这份档不存在-29991010.md`。',
    ].join('\n');
    fs.writeFileSync(report, body, 'utf8');
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'docs', '口径-验收两轨制与DoD十条-20261014.md'), '# stub\n', 'utf8');
    fs.mkdirSync(path.join(ws, '_archive', 'v3face-h12-20261022'), { recursive: true });
    return { report, opts: { workspaceRoot: ws } };
  }, (r, errs) => {
    expect(has(r, '①'), '应报 ①（缺 DoD 块）', errs);
    expect(has(r, '②'), '应报 ②（第 9 条引历史读数）', errs);
    expect(has(r, '④'), '应报 ④（路径悬空）', errs);
  }));

  // 夹具 16：围栏代码块内的路径不判 —— 否则「贴一次器具输出」会让下一次自批把输出里的悬空路径报成新缺口
  results.push(runCase('围栏代码块内路径 ⇒ 不判 ④', (root) => {
    const report = path.join(root, 'fence.md');
    const body = [
      OK_DOD, '', '# 报告', '',
      '下面这段是器具输出原文（不该被当成"我引用了它"）：',
      '```text',
      '1) [④ 悬空指针] L12 —— 引用的路径盘上不存在：docs\\交付报告-输出里的悬空档-29991010.md',
      '```',
      '代码块外面的同一路径才该判：`docs\\确实悬空的档-29991010.md`',
    ].join('\n');
    fs.writeFileSync(report, body, 'utf8');
    const ws = path.join(root, 'ws');
    fs.mkdirSync(path.join(ws, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'docs', '口径-验收两轨制与DoD十条-20261014.md'), '# stub\n', 'utf8');
    fs.mkdirSync(path.join(ws, '_archive', 'v3face-h12-20261022'), { recursive: true });
    return { report, opts: { workspaceRoot: ws } };
  }, (r, errs) => {
    const got = r.suggestions.filter((s) => s.id === '④').map((s) => s.msg);
    expect(got.length === 1, `应只报代码块外那 1 处，实得 ${got.length}：${got.join(' | ')}`, errs);
    expect(got.some((m) => m.includes('确实悬空')), '代码块外那处应被报', errs);
  }));

  // 输出
  const out = [];
  out.push(`self-review-check 自测（夹具 ${results.length} 个 · 只在系统临时目录建，退出前删净）`);
  out.push('');
  for (const r of results) {
    const icon = r.ok ? '✅' : '❌';
    const s = r.suggestions?.length ?? 0;
    out.push(`${icon} ${r.name} —— 建议 ${s} 处`);
    if (!r.ok) for (const e of r.errs) out.push(`     ✗ ${e}`);
  }
  const bad = results.filter((r) => !r.ok).length;
  out.push('');
  out.push(`用例 ${results.length - bad}/${results.length}`);
  out.push(`${passed}/${assertions}`);
  const text = out.join('\n');
  process.stdout.write(`${text}\n`);
  return bad === 0 && passed === assertions ? EXIT.OK : EXIT.SUGGEST;
}

// ---------------------------------------------------------------------------
//  入口
// ---------------------------------------------------------------------------
function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.err) {
    process.stderr.write(`用法错：${a.err}\n\n${USAGE}\n`);
    process.exitCode = EXIT.USAGE;
    return;
  }
  if (a.help) { process.stdout.write(USAGE); process.exitCode = EXIT.OK; return; }
  if (a.selfTest) { process.exitCode = selfTest(); return; }

  if (!fs.existsSync(a.file) || !fs.statSync(a.file).isFile()) {
    process.stderr.write(`用法错：报告读不到 —— ${a.file}\n`);
    process.exitCode = EXIT.USAGE;
    return;
  }

  const r = selfReview(a.file, a);
  if (a.json) {
    process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
  } else {
    process.stdout.write(`${renderHuman(r)}\n`);
  }
  process.exitCode = r.suggestions.length ? EXIT.SUGGEST : EXIT.OK;
}

/**
 * 只在「当脚本跑」时执行 main —— 供夹具/批量 sweep `import { selfReview }` 复用而不触发 CLI。
 * ⚠️ junction 下 `import.meta.url` 是物理路径、`argv[1]` 是逻辑路径 ⇒ **两边都过 realpath 再比**，
 *    否则守卫不触发、静默退出 0（本机 `<workspace>\card-sessions` 就是 junction 场景）。
 */
function isEntryModule() {
  try {
    const self = fs.realpathSync(fileURLToPath(import.meta.url)).toLowerCase();
    const argv1 = process.argv[1] ? fs.realpathSync(process.argv[1]).toLowerCase() : '';
    return self === argv1;
  } catch {
    return false;
  }
}

if (isEntryModule()) main();
