#!/usr/bin/env node
// ============================================================================
//  plan-gate.mjs —— 「方案过审凭证器」（2026-10-23 · 卡「地基 · 方案过审闸」）
//  --------------------------------------------------------------------------
//  它解决什么：以前「方案没过审就建卡施工」只能靠人自觉（技能靠自律、卡面只是留痕）。
//    本器具把「这份方案过审了、且过审之后正文没被改过」变成**一个能被机器读到的凭证**，
//    建卡器（`tools\board-card-add.mjs`）与复核器（`tools\rulecheck.mjs dor` 的 R4）
//    都只认这个凭证。
//
//  凭证形态（写在方案档**头部**，首个 `##` 标题之前的一行 HTML 注释）：
//    <!-- PLAN-REVIEW:pass round=2 runId=<uuid> sha=<正文 sha256 前 12 位> at=<ISO> reviewer=<who> -->
//    <!-- PLAN-REVIEW:pass round=4 runId=<uuid> sha=<…> spine=<骨架 sha12> batch=<小节号:该节 sha12,…> at=… reviewer=… -->
//    <!-- PLAN-REVIEW:fail round=1 runId=<uuid> sha=<…> at=<ISO> reviewer=<who> -->
//
//  「正文」的定义（**别自欺：哈希必须与自己的锚点无关**）：
//    正文字节 = 原档 **去掉所有 PLAN-REVIEW 锚点行** + **CRLF→LF 归一** + **去 BOM**，
//    其余逐字节参与 sha256（所以正文改一个字符 ⇒ sha 变 ⇒ 判过期）。
//    行尾归一是有意的：同一份正文在 CRLF / LF 两种落盘形态下必须判「同一份」，
//    否则换个编辑器存一次就全库过期。
//
//  ⭐ 0.2.0（2026-11-04 · 卡「B1 施工 · 卡 A」· 方案 `docs\方案-plan-gate同批一次终审-V5.md`）：
//    「同批改动 · 一次终审」。锚点里可多两个字段：
//      spine=<骨架 sha12>  = 把 batch 点名的小节的**正文段**挖掉（标题行保留）之后算的 sha
//      batch=<小节号:该节 sha12,…>  = 批区清单（最多 8 处）
//    ⇒ 正文改了但**骨架没动**、且每个批区小节都还在 ⇒ 第五态 `pass-batch`（ok=true · rc 0）。
//    批区外改一个字节、批区小节标题行变了、批区小节被删/拆/搬、老锚点 ⇒ 照旧 `stale`。
//    🔴 `sha=` 的语义**一个字节都没改**；`--batch` 是**可选**的，不带你完全等于 0.1.0 的行为。
//    🔴 器具**不验身份**（`--reviewer` 是自由文本）：批区"只能由复核方声明"是**纪律闸**，不是机制闸。
//
//  五态（`--check` · 只读）：
//    pass       = 有 pass 锚点，且锚点里的 sha 与当前正文 sha 一致
//    pass-batch = sha 变了，但 spine 与 batch 成对在位、骨架 sha 一致、每个批区小节都唯一解析得到
//    stale      = 有 pass 锚点但正文变了（**必须重新过审**）—— 老锚点（无 spine/batch）永远走这一支
//    missing    = 没有锚点（或档不存在 / 锚点行畸形）
//    fail       = 有 fail 锚点（审核没过 ⇒ 等同不能建卡）
//
//  用法：
//    node <pkg>/src/dsh-butler/plan-gate.mjs --check --file <方案档>
//    node <pkg>/src/dsh-butler/plan-gate.mjs --pass  --file <方案档> [--round N] [--reviewer <谁审的>] [--batch "<小节号,…>"] [--apply]
//    node <pkg>/src/dsh-butler/plan-gate.mjs --fail  --file <方案档> [--round N] [--reviewer <谁审的>] [--apply]
//    （缺省 dry-run：只打印「会写哪一行 / 落在哪」，不落盘）
//
//  退出码（只给 CLI 用；模块调用看 `evaluate()` 的 state）：
//    0 = 成功（check 判 pass / pass-batch / 写入完成 / dry-run 打印完毕）
//    1 = check 判 stale（正文已变，凭证过期）
//    2 = 用法错（含 --batch 校验不过：小节不存在 / 撞号 / 超 8 处 / 点名一级标题 / 超 1/3 / 骨架不足 2/3 / 哨兵冲突）
//    3 = check 判 missing（档不存在 / 没有锚点）
//    4 = check 判 fail（审核没过）
//
//  设计红线：
//    · 幂等：同内容重复 `--pass` **不叠加**（永远只留一行锚点；同 round/reviewer/batch 且正文没变 ⇒ 连写都不写）
//      🔴 幂等键 0.2.0 起 = kind + sha + round + reviewer + **batch（按规范化小节号集合比）+ spine**
//      —— 否则"收窄/加宽批区"会被静默吞掉（判幂等 + 文件零改动 ⇒ 宽的那一版还生效 = 假绿）。
//    · 不猜：档读不到就如实报，不建锚点
//    · 零联网、零外部依赖、不碰看板账本（建卡只走 Host API，那是建卡器的事）
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import process from 'node:process';

export const PLAN_GATE_VERSION = '0.2.0';

/** 批区上限（2026-11-04 主人拍：8 处 / 正文 1/3 字节 / 骨架 ≥2/3 · 属可改点）。 */
export const MAX_BATCH = 8;

/** 哨兵：批区正文段被换成这一行（正文天然不含 NUL ⇒ 签时先查一次，含就拒签）。 */
const SENTINEL = (loc) => `\u0000BATCH:${loc}\u0000`;

/** 锚点行（整行匹配；判「这一行是不是锚点」只认整行，正文里提到这个词不算）。 */
const ANCHOR_LINE_RE = /^[ \t]*<!--\s*PLAN-REVIEW:(pass|fail)\b([^>]*)-->[ \t]*$/;

export const PLAN_GATE_EXIT = { OK: 0, STALE: 1, USAGE: 2, MISSING: 3, FAIL: 4 };

/** 把「正文」归一：去锚点行 → 去 BOM → CRLF→LF。**所有 hash 都必须走它**。 */
export function normalizeBody(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter((l) => !ANCHOR_LINE_RE.test(l));
  return lines.join('\n').replace(/^\uFEFF/, '');
}

/** 正文 sha256（全 64 位十六进制）。锚点里存的是它的前 12 位。 */
export function bodySha(text) {
  return crypto.createHash('sha256').update(Buffer.from(normalizeBody(text), 'utf8')).digest('hex');
}

/** 解析档内第一个锚点（没有返回 null）。 */
export function parseAnchor(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = ANCHOR_LINE_RE.exec(lines[i]);
    if (!m) continue;
    const attrs = {};
    for (const a of String(m[2] ?? '').matchAll(/([A-Za-z][A-Za-z0-9_]*)=([^\s]+)/g)) attrs[a[1]] = a[2];
    return { kind: m[1], attrs, line: i + 1, raw: lines[i].trim() };
  }
  return null;
}

// ---------------------------------------------------------------------------
//  围栏感知切节 + 小节号（locator）—— 方案 §3.2 规则 1 / 规则 2
// ---------------------------------------------------------------------------

/**
 * 扫出「围栏外」的标题行（`#`~`####`）。
 * 为什么要围栏：全库带锚点档 46%（39%）里有围栏内的 `# 签：…` 这类伪标题（本方案自己就有 3 处），
 * naive 切节会把代码块切成一级节 ⇒ 1/3 字节上限的算基直接失真。
 * @returns {{line:number, level:number, text:string}[]}
 */
export function scanHeadings(lines) {
  const heads = [];
  let fence = null; // { ch:'`'|'~', len:number }
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (fence) {
      // 围栏关：同字符、长度 ≥ 开启者、其后只有空白
      const m = /^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/.exec(l);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      continue;
    }
    // 围栏开：行首最多 3 空格 + ≥3 个反引号或波浪号（其后可有 info string）
    const open = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/.exec(l);
    if (open) { fence = { ch: open[1][0], len: open[1].length }; continue; }
    const h = /^(#{1,4})\s+/.exec(l);
    if (h) heads.push({ line: i, level: h[1].length, text: l.trim() });
  }
  return heads;
}

/**
 * 小节号：标题文本剥前导 `§`（可重复）后，数字开头且数字串之后是分隔符 ⇒ 取数字串；
 * 否则 `h` + sha256(标题文本) 前 6 位（同一标题在任何档里同一个号）。
 * @returns {string} 如 `4.2` / `0` / `h3f2a1b`
 */
export function locatorOfTitle(rawTitleLine) {
  let t = String(rawTitleLine ?? '').replace(/^#{1,4}\s+/, '').trim();
  t = t.replace(/^(?:§[ \t]*)+/, '').trim();
  const m = /^(\d+(?:[.．]\d+)*)(?=$|[\s:：.,，)）\]】\-—/])/.exec(t);
  if (m) return m[1].replace(/．/g, '.');
  return 'h' + crypto.createHash('sha256').update(Buffer.from(t, 'utf8')).digest('hex').slice(0, 6);
}

/**
 * 切节：节 = 标题行 + 它后面所有行，直到下一个「层级 ≤ 自己」的标题。
 * ⚠️ 节区间是**嵌套**的，不是划分（`##` 包含它里面的 `###`）。
 * @param {string} body normalizeBody() 的结果（LF）
 * @returns {{lines:string[], sections:Array<{level:number,line:number,end:number,locator:string,dup:boolean,title:string}>}}
 */
export function buildSections(body) {
  const lines = String(body ?? '').split('\n');
  const heads = scanHeadings(lines);
  const sections = heads.map((h) => {
    const next = heads.find((x) => x.line > h.line && x.level <= h.level);
    return { level: h.level, line: h.line, end: next ? next.line : lines.length, locator: locatorOfTitle(h.text), title: h.text };
  });
  const cnt = new Map();
  for (const s of sections) cnt.set(s.locator, (cnt.get(s.locator) || 0) + 1);
  for (const s of sections) s.dup = cnt.get(s.locator) > 1;
  return { lines, sections };
}

/** 一个节的整节字节数（标题行 + 正文段，**不含**末尾换行）。 */
function sectionBytes(lines, sec) {
  return Buffer.byteLength(lines.slice(sec.line, sec.end).join('\n'), 'utf8');
}

/** 整节 sha12（标题行 + 正文段）—— 只用于「这一节自签后动过没」的人读提示，**不参与 state**。 */
function sectionSha12(lines, sec) {
  return crypto.createHash('sha256').update(Buffer.from(lines.slice(sec.line, sec.end).join('\n'), 'utf8')).digest('hex').slice(0, 12);
}

/** 父节吞子节：同一份档里父节与子节同时点名 ⇒ 子节字节不重复计、也只替换父节一次。 */
function dedupeNested(picked) {
  const sorted = [...picked].sort((a, b) => a.line - b.line);
  const keep = [];
  for (const s of sorted) if (!keep.some((k) => s.line >= k.line && s.line < k.end)) keep.push(s);
  return keep;
}

/**
 * 骨架 sha12：批区小节的**正文段**（不含标题行）整段换成一行哨兵，标题行保留，再算 sha256 前 12 位。
 * 标题行保留 ⇒ 改名 / 升级降级 / 拆节 / 搬节 都会改骨架 ⇒ 判 stale（符合预期）。
 * @param {string} body normalizeBody() 的结果
 * @param {Array} picked 批区节（未去重也行，内部按父吞子去重）
 */
export function computeSpine(body, picked) {
  const lines = String(body ?? '').split('\n');
  const uniq = dedupeNested(picked);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const host = uniq.find((s) => i > s.line && i < s.end);
    if (!host) { out.push(lines[i]); continue; }
    if (i === host.line + 1) out.push(SENTINEL(host.locator)); // 正文段第一行 ⇒ 换成一枚哨兵
  }
  return crypto.createHash('sha256').update(Buffer.from(out.join('\n'), 'utf8')).digest('hex').slice(0, 12);
}

/** 解析锚点里的 `batch=` 字段（`小节号:该节 sha12` 逗号分隔）。 */
export function parseBatchField(v) {
  const out = [];
  for (const seg of String(v ?? '').split(',')) {
    const t = seg.trim();
    if (!t) continue;
    const i = t.lastIndexOf(':');
    if (i <= 0 || i === t.length - 1) return { err: `batch 字段格式不对（要「小节号:该节 sha12」）：${t}` };
    out.push({ locator: t.slice(0, i), sha12: t.slice(i + 1) });
  }
  return out.length ? { entries: out } : { err: 'batch 字段是空的' };
}

/**
 * 签之前校验批区（方案 §3.2 规则 4：错一条就拒签，档不被写）。
 * @returns {{ok:boolean, errors:string[], spine?:string, batchField?:string, entries?:Array, bodyBytes?:number, batchBytes?:number, locators?:string[]}}
 */
export function prepareBatch(text, batchStr) {
  const errors = [];
  const body = normalizeBody(text);
  if (body.includes('\u0000')) errors.push('正文里含 NUL 字符（U+0000）—— 与批区哨兵冲突，拒签');

  const toks = String(batchStr ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!toks.length) errors.push('--batch 给的是空清单（要写小节号，如 --batch "4.2,4.3"）');
  if (toks.length > MAX_BATCH) errors.push(`批区最多 ${MAX_BATCH} 处（你给了 ${toks.length} 处）⇒ 请分两次终审`);
  const seen = new Set();
  for (const tok of toks) {
    if (!/^[0-9A-Za-z.]+$/.test(tok)) errors.push(`小节号只能含数字 / 字母 / 点：${tok}`);
    if (seen.has(tok)) errors.push(`批区小节号重复点名：${tok}`);
    seen.add(tok);
  }

  const { lines, sections } = buildSections(body);
  const picked = [];
  for (const tok of [...seen]) {
    const hits = sections.filter((s) => s.locator === tok);
    if (!hits.length) {
      errors.push(`小节号「${tok}」在本档里不存在（本档现有：${sections.map((s) => s.locator).join(' ')}）`);
    } else if (hits.length > 1) {
      errors.push(`小节号「${tok}」在本档里撞号（${hits.length} 处命中）⇒ 不可用于批区（改标题让它唯一，或换号）`);
    } else picked.push(hits[0]);
  }
  for (const s of picked) {
    if (s.level < 2) errors.push(`「${s.locator}」是一级标题（# 开头）—— 一级标题不许进批区（那等于把全文放行）`);
  }

  const uniq = dedupeNested(picked);
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  const batchBytes = uniq.reduce((a, s) => a + sectionBytes(lines, s), 0);
  if (bodyBytes > 0 && batchBytes * 3 > bodyBytes) {
    errors.push(`批区合计 ${batchBytes} B > 正文 1/3 = ${Math.floor(bodyBytes / 3)} B ⇒ 拒签（批区过宽，等于放行全文；请分两次终审）`);
  }
  if (bodyBytes > 0 && bodyBytes - batchBytes < (bodyBytes * 2) / 3) {
    errors.push(`掩掉批区后的骨架只剩 ${bodyBytes - batchBytes} B < 正文 2/3 = ${Math.floor((bodyBytes * 2) / 3)} B ⇒ 拒签（批区外没有骨架可对账）`);
  }
  if (errors.length) return { ok: false, errors };

  const ordered = uniq.sort((a, b) => a.line - b.line);
  return {
    ok: true,
    errors: [],
    locators: ordered.map((s) => s.locator),
    spine: computeSpine(body, ordered),
    batchField: ordered.map((s) => `${s.locator}:${sectionSha12(lines, s)}`).join(','),
    entries: ordered.map((s) => ({ locator: s.locator, sha12: sectionSha12(lines, s), bytes: sectionBytes(lines, s), lines: s.end - s.line })),
    bodyBytes,
    batchBytes,
  };
}

/** 生成一行锚点（reviewer 里的空白/尖括号/注释结束符会破坏解析 ⇒ 就地净化）。 */
export function makeAnchorLine({ kind, round, runId, sha, at, reviewer, spine, batch }) {
  if (kind !== 'pass' && kind !== 'fail') throw new Error(`kind 只能是 pass / fail：${kind}`);
  const who = String(reviewer ?? '未填').trim().replace(/[\s>]+/g, '_').replace(/--/g, '-') || '未填';
  const r = Number.isFinite(Number(round)) && Number(round) > 0 ? Number(round) : 1;
  let s = `<!-- PLAN-REVIEW:${kind} round=${r} runId=${runId} sha=${String(sha).slice(0, 12)}`;
  if (spine) s += ` spine=${spine}`;
  if (batch) s += ` batch=${batch}`;
  s += ` at=${at} reviewer=${who} -->`;
  return s;
}

/**
 * 把锚点放到档头部：**首个 `## ` 标题之前**；档里没有 `##` 就放最前面。
 * 已有锚点先全部摘掉（保证「永远只有一行」）。
 *
 * ⚠️ 关键设计（第一版踩过）：**插入锚点这一行，不许额外加空行**。
 *   否则 `normalizeBody()` 摘掉锚点行后会留下一个多余空行 ⇒ 写完自检立刻判 stale
 *   （实测：写完 sha=974752db… vs 现值 838976ac…，而且每重写一次再多叠一个空行）。
 *   现在的做法 = 把锚点当成「首 ## 那一行的前一行」插进去 ⇒ 摘掉后逐字节还原。
 * @returns {string} 新全文（LF；调用方按原行尾再转回）
 */
export function placeAnchor(text, anchorLine, { bom = '' } = {}) {
  const body = normalizeBody(text);
  const lines = body.split('\n');
  const h2 = lines.findIndex((l) => /^##[ \t]/.test(l));
  if (h2 >= 0) lines.splice(h2, 0, anchorLine);
  else lines.unshift(anchorLine);
  return `${bom}${lines.join('\n')}`;
}

// ---------------------------------------------------------------------------
//  评估
// ---------------------------------------------------------------------------

/**
 * 批区诊断（只读）：解析 batch 字段、逐区解析到节、算 spine 现值、算逐区漂移。
 * @returns {{ok:boolean, reason?:string, spineNow?:string, entries?:Array, driftCount?:number, batchBytes?:number, bodyBytes?:number, overLimit?:boolean, unmatched?:string[]}}
 */
function inspectBatch(text) {
  const body = normalizeBody(text);
  const { lines, sections } = buildSections(body);
  if (!sections.length) return { ok: false, reason: '本档结构无法切节（一个标题都没有）⇒ 漂移表略（fail-closed）' };
  const anchor = parseAnchor(text);
  const parsed = parseBatchField(anchor?.attrs?.batch);
  if (parsed.err) return { ok: false, reason: `批区字段读不出来：${parsed.err}（fail-closed）` };

  const unmatched = [];
  const picked = [];
  const entries = [];
  for (const e of parsed.entries) {
    const hits = sections.filter((s) => s.locator === e.locator);
    if (hits.length !== 1) { unmatched.push(e.locator); continue; }
    const s = hits[0];
    const cur = sectionSha12(lines, s);
    picked.push(s);
    entries.push({ locator: e.locator, sha12: e.sha12, currentSha12: cur, same: cur === e.sha12, bytes: sectionBytes(lines, s), lines: s.end - s.line });
  }
  if (unmatched.length) {
    return { ok: false, reason: `批区小节号解析不到：${unmatched.map((x) => `「${x}」`).join(' ')}（整节被删 / 标题改成不含数字的名字 / 撞号）⇒ 结构已变`, entries, unmatched, spineNow: null };
  }
  const spineNow = computeSpine(body, picked);
  const bodyBytes = Buffer.byteLength(body, 'utf8');
  const batchBytes = dedupeNested(picked).reduce((a, s) => a + sectionBytes(lines, s), 0);
  return {
    ok: true,
    spineNow,
    entries,
    driftCount: entries.filter((e) => !e.same).length,
    batchBytes,
    bodyBytes,
    overLimit: bodyBytes > 0 && batchBytes * 3 > bodyBytes,
  };
}

/**
 * 只读评估一份方案档的过审状态。
 * @param {string} file 方案档路径
 * @returns {{ok:boolean, file:string, state:'pass'|'pass-batch'|'stale'|'missing'|'fail', reasons:string[], anchor:object|null, currentSha:string, bytes:number|null, batch?:object}}
 */
export function evaluate(file) {
  const abs = path.resolve(String(file ?? ''));
  const reasons = [];
  let text;
  try { text = fs.readFileSync(abs, 'utf8'); }
  catch (e) {
    return { ok: false, file: abs, state: 'missing', reasons: [`档读不到：${e.code || e.message}`], anchor: null, currentSha: '', bytes: null };
  }
  const currentSha = bodySha(text);
  const anchor = parseAnchor(text);
  const base = { file: abs, anchor, currentSha, bytes: Buffer.byteLength(text) };
  if (!anchor) {
    return { ...base, ok: false, state: 'missing', reasons: ['没有 `<!-- PLAN-REVIEW:… -->` 锚点（这份方案没留过审凭证）'] };
  }
  if (anchor.kind === 'fail') {
    return { ...base, ok: false, state: 'fail', reasons: [`锚点是 fail（审核没过 · round=${anchor.attrs.round ?? '?'} · reviewer=${anchor.attrs.reviewer ?? '?'}）`] };
  }
  if (!anchor.attrs.sha) {
    return { ...base, ok: false, state: 'stale', reasons: ['pass 锚点里没有 sha 字段 ⇒ 无法判正文是否同一份（按过期处理）'] };
  }
  // 优先级：pass（正文与审过的逐字节相同）> pass-batch > stale。
  //   pass 里**不检查**批区字段是否畸形/超上限 —— 正文一致的时点，"这份正文被审过"是既成事实，
  //   此处 fail-closed 只会制造假红（方案 §4.3 写死）。
  if (anchor.attrs.sha === currentSha.slice(0, 12)) {
    const hasSpine = !!anchor.attrs.spine;
    const hasBatch = !!anchor.attrs.batch;
    const extra = hasSpine ? ` · spine=${anchor.attrs.spine}` : '';
    return {
      ...base, ok: true, state: 'pass',
      reasons: [`pass · round=${anchor.attrs.round ?? '?'} · runId=${anchor.attrs.runId ?? '?'} · reviewer=${anchor.attrs.reviewer ?? '?'}${extra}${hasBatch ? ` · batch=${anchor.attrs.batch}` : ''}`],
    };
  }

  // ---- 以下：正文已变（sha 不等）----
  const hasSpine = !!anchor.attrs.spine;
  const hasBatch = !!anchor.attrs.batch;
  if (!hasSpine && !hasBatch) {
    // 🔴 老锚点（0.1.0 时代）：这一句逐字保持 0.1.0 的文案，行为与今天完全一致（A5 / N9）
    return {
      ...base, ok: false, state: 'stale',
      reasons: [`正文已变：锚点 sha=${anchor.attrs.sha}（过审时）≠ 现值 sha=${currentSha.slice(0, 12)} ⇒ 必须重新过审`],
    };
  }
  if (hasSpine !== hasBatch) {
    return {
      ...base, ok: false, state: 'stale',
      reasons: ['批区字段不成对（只有 spine 没有 batch，或只有 batch 没有 spine）⇒ 按过期处理（fail-closed）',
        `锚点现值：spine=${anchor.attrs.spine ?? '(无)'} · batch=${anchor.attrs.batch ?? '(无)'}`],
    };
  }

  const ins = inspectBatch(text);
  if (!ins.ok) {
    return {
      ...base, ok: false, state: 'stale',
      reasons: [ins.reason, `正文已变：锚点 sha=${anchor.attrs.sha}（过审时）≠ 现值 sha=${currentSha.slice(0, 12)}`],
      batch: { spineInAnchor: anchor.attrs.spine, entries: ins.entries || [], driftCount: (ins.entries || []).filter((e) => !e.same).length, unmatched: ins.unmatched || [] },
    };
  }
  if (ins.spineNow !== anchor.attrs.spine) {
    return {
      ...base, ok: false, state: 'stale',
      reasons: [
        `骨架不一致：终审时 spine=${anchor.attrs.spine}（骨架 sha12）≠ 现值 ${ins.spineNow}`
          + ' ⇒ 批区外的字节变了、或批区小节的标题行/结构变了（改名 · 升级降级 · 拆节 · 搬节）',
        '批区外零放行 ⇒ 必须重新过审（不受 batch 清单保护）',
      ],
      batch: { spineInAnchor: anchor.attrs.spine, spineNow: ins.spineNow, entries: ins.entries, driftCount: ins.driftCount, batchBytes: ins.batchBytes, bodyBytes: ins.bodyBytes, overLimit: ins.overLimit, unmatched: [] },
    };
  }

  const reasons2 = [`pass-batch · round=${anchor.attrs.round ?? '?'} · runId=${anchor.attrs.runId ?? '?'} · reviewer=${anchor.attrs.reviewer ?? '?'}`,
    `骨架一致（spine=${anchor.attrs.spine}）：批区外的字节与终审时相同`,
    `批区 ${ins.entries.length} 处 · 漂移 ${ins.driftCount} 处（正文 sha 变了，但差异只在批区正文段内）`];
  return {
    ...base, ok: true, state: 'pass-batch', reasons: reasons2,
    batch: { spineInAnchor: anchor.attrs.spine, spineNow: ins.spineNow, entries: ins.entries, driftCount: ins.driftCount, batchBytes: ins.batchBytes, bodyBytes: ins.bodyBytes, overLimit: ins.overLimit, list: anchor.attrs.batch },
  };
}

// ---------------------------------------------------------------------------
//  写锚点
// ---------------------------------------------------------------------------
const normReviewer = (s) => String(s ?? '未填').trim().replace(/[\s>]+/g, '_').replace(/--/g, '-') || '未填';

/** 锚点里 batch 的小节号集合（规范化：排序后 join）—— 幂等键按**集合**比，不按原串比（N13）。 */
function batchSetOf(batchField) {
  if (!batchField) return '';
  const p = parseBatchField(batchField);
  if (p.err) return `!${batchField}`;
  return p.entries.map((e) => e.locator).sort().join(',');
}

/**
 * 写锚点（`--apply` 才调）。
 * 幂等判据（0.2.0 起六样）：同 kind + 同正文 sha + 同 round + 同 reviewer + 同 batch 集合 + 同 spine
 * ⇒ 不写、保留原 runId（"同内容重复 --pass 不叠加"）。
 * ⚠️ batch 不进幂等键会造出**假绿**：复核方想收窄窗口时会被判「幂等」+ 文件零改动 ⇒ 宽的那版还生效。
 * @returns {{written:boolean, skipped:boolean, reason:string, anchor?:object, text?:string|null, line?:string, error?:string, batch?:object, batchBefore?:string, batchAfter?:string}}
 */
export function writeAnchor(file, { kind, round, reviewer, runId, at, batch } = {}) {
  const abs = path.resolve(String(file ?? ''));
  const text = fs.readFileSync(abs, 'utf8');
  const sha12 = bodySha(text).slice(0, 12);
  const cur = parseAnchor(text);
  const r = Number(round ?? 1);
  const who = normReviewer(reviewer);

  let prep = null;
  const batchGiven = batch !== undefined && batch !== null && String(batch).trim() !== '';
  if (batchGiven) {
    if (kind !== 'pass') return { written: false, skipped: false, reason: '', error: '`--fail` 不能配 `--batch`：批区只在「终审通过」时才有意义（要么去掉 --batch，要么改成 --pass）' };
    prep = prepareBatch(text, batch);
    if (!prep.ok) return { written: false, skipped: false, reason: '', error: `批区校验不过 ⇒ 拒签（档一个字节都没动）：\n${prep.errors.map((e) => `   · ${e}`).join('\n')}`, batchErrors: prep.errors };
  }

  // 幂等：六样都要同（batch 按集合比）
  if (cur && cur.kind === kind && cur.attrs.sha === sha12
      && String(cur.attrs.round) === String(r) && cur.attrs.reviewer === who
      && batchSetOf(cur.attrs.batch) === (prep ? batchSetOf(prep.batchField) : '')
      && (cur.attrs.spine ?? '') === (prep ? prep.spine : '')) {
    return { written: false, skipped: true, reason: '同一份正文 · 同 round / reviewer / 批区已有同 kind 锚点 ⇒ 不重复写（幂等）', anchor: cur, text: null };
  }

  const line = makeAnchorLine({ kind, round: r, runId, sha: sha12, at, reviewer, spine: prep ? prep.spine : null, batch: prep ? prep.batchField : null });
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const next = placeAnchor(text, line, { bom });
  const out = /\r\n/.test(text) ? next.replace(/\n/g, '\r\n') : next;
  return {
    written: true, skipped: false, reason: '', anchor: parseAnchor(out), text: out, line,
    batch: prep,
    batchBefore: cur && cur.attrs.batch ? cur.attrs.batch : null,
    batchAfter: prep ? prep.batchField : null,
  };
}

// ---------------------------------------------------------------------------
//  CLI
// ---------------------------------------------------------------------------
const USAGE = `plan-gate —— 方案过审凭证器（0.2.0 · 2026-11-04 加「同批一次终审」· 零重启纯 CLI）

用法：
  # 只读五态（pass / pass-batch / stale / missing / fail）
  node <pkg>/src/dsh-butler/plan-gate.mjs --check --file <方案档>

  # 过审通过（缺省 dry-run；--apply 才落盘）
  node <pkg>/src/dsh-butler/plan-gate.mjs --pass --file <方案档> [--round N] [--reviewer <谁审的>] [--apply]

  # 同批改动 · 一次终审（把「本批允许继续机械修订的小节」声明出来）
  node <pkg>/src/dsh-butler/plan-gate.mjs --pass --file <方案档> --round 4 --batch "4.2,4.3,6.3" --reviewer <谁审的> --apply

  # 审核没过（写 fail 锚点；同样缺省 dry-run；**不能配 --batch**）
  node <pkg>/src/dsh-butler/plan-gate.mjs --fail --file <方案档> [--round N] [--reviewer <谁审的>] [--apply]

锚点（写在方案档头部，首个 "## " 标题之前的一行注释）：
  <!-- PLAN-REVIEW:pass round=<N> runId=<uuid> sha=<正文 sha256 前 12 位> at=<ISO> reviewer=<…> -->
  <!-- PLAN-REVIEW:pass round=<N> runId=<uuid> sha=<…> spine=<骨架 sha12> batch=<小节号:该节 sha12,…> at=… reviewer=… -->
  <!-- PLAN-REVIEW:fail round=<N> runId=<uuid> sha=<…> at=<ISO> reviewer=<…> -->

「正文」= 原档去掉所有 PLAN-REVIEW 锚点行 + CRLF→LF + 去 BOM（其余逐字节参与哈希）。
⇒ 正文改一个字符 ⇒ sha 变 ⇒ --check 判 stale（必须重新过审）；只重写锚点不会把自己判过期。

⭐ 同批一次终审（--batch）：
  · --batch 收的是**小节号**清单（逗号分隔，最多 ${MAX_BATCH} 处），如 "4.2,4.3,6.3"；
    小节号 = 标题文本剥前导 § 后开头的数字串（\`#### §4.2 问二\` ⇒ 4.2），否则 h+标题哈希 6 位。
  · 两个字段由工具在签时算好写进锚点：spine=（把批区正文段换成哨兵后的骨架 sha12）、
    batch=（小节号:该节签时 sha12 清单）。**人手不填 sha12、不填 spine。**
  · 判定：正文变了但骨架没动、且每个批区小节都还唯一解析得到 ⇒ 新第五态 \`pass-batch\`（ok · rc 0）；
    批区外改一个字节 / 批区小节标题行变了 / 被删 / 被拆 / 搬节 ⇒ 照旧 stale。
  · 三条上限（**只在签名那一刻校验**，超了拒签 rc 2）：① 最多 ${MAX_BATCH} 处 ② 合计字节 ≤ 正文 1/3
    ③ 掩掉批区后的骨架 ≥ 正文 2/3；一级 \`#\` 标题不许进批区。
  · 签后 --check 会打逐区漂移表，并给两条**只提示不改状态**的 ⚠️：
    ①「批区已超签时上限」 ②「某节 sha 与锚点不符」。
  · 🔴 器具**不验身份**：批区"只能由复核方声明"是纪律闸，不是机制闸（施工方不得自签）。

幂等：同一份正文 + 同 round / 同 reviewer / 同批区集合 重复 --pass ⇒ 不写、不叠加（原 runId 保留）；
      改批区（加宽 / 收窄 / 顺序对调）⇒ 加宽收窄会重写，只对调顺序按集合比 ⇒ 不写。

退出码：0 = pass / pass-batch / 写入完成 / dry-run 打印完毕 · 1 = stale · 2 = 用法错（含批区校验不过）· 3 = missing（档不存在 / 无锚点）· 4 = fail`;
const warn = (m) => process.stderr.write(m + '\n');
const out = (m) => process.stdout.write(m + '\n');

function parseArgs(argv) {
  const a = { file: null, round: 1, roundGiven: false, reviewer: '未填', check: false, pass: false, fail: false, apply: false, help: false, batch: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--file' || t === '-f') { const v = argv[++i]; if (!v) return { err: '--file 需要路径' }; a.file = v; }
    else if (t === '--round') { const v = argv[++i]; if (!v || !/^\d+$/.test(v) || Number(v) <= 0) return { err: '--round 需要正整数' }; a.round = Number(v); a.roundGiven = true; }
    else if (t === '--reviewer') { const v = argv[++i]; if (!v) return { err: '--reviewer 需要值（谁审的）' }; a.reviewer = v; }
    else if (t === '--batch') { const v = argv[++i]; if (!v) return { err: '--batch 需要小节号清单（如 "4.2,4.3"）' }; a.batch = v; }
    else if (t === '--check') a.check = true;
    else if (t === '--pass') a.pass = true;
    else if (t === '--fail') a.fail = true;
    else if (t === '--apply') a.apply = true;
    else if (t === '--help' || t === '-h') a.help = true;
    else return { err: `未知参数：${t}` };
  }
  const acts = [a.check, a.pass, a.fail].filter(Boolean).length;
  if (!a.help && acts !== 1) return { err: '必须且只能给 --check / --pass / --fail 之一' };
  if (!a.help && !a.file) return { err: '必须给 --file <方案档>' };
  if (!a.help && a.fail && a.batch) return { err: '`--fail` 不能配 `--batch`：批区只在「终审通过」时才有意义（要么去掉 --batch，要么改成 --pass）' };
  if (!a.help && a.check && a.batch) return { err: '`--batch` 只用于 `--pass`（签署时声明批区）；`--check` 直接读锚点里的 spine/batch，不用给' };
  return a;
}

function fmtBytes(n) { return `${n.toLocaleString('en-US')} B`; }

function printCheck(r) {
  const label = { pass: '✅ pass', 'pass-batch': '✅ pass-batch', stale: '🟠 stale', missing: '⛔ missing', fail: '🔴 fail' }[r.state] || r.state;
  const head = r.state === 'pass-batch' && r.batch
    ? `${label}（批区 ${r.batch.entries.length} 处 · 漂移 ${r.batch.driftCount} 处）`
    : label;
  out(`状态：${head}`);
  out(`档：${r.file}`);
  if (r.bytes != null) out(`正文 sha256（前 12 位）：${r.currentSha.slice(0, 12)} · ${r.bytes} B`);
  if (r.anchor) {
    const at = r.anchor.attrs;
    out(`锚点：L${r.anchor.line} · ${r.anchor.kind} · round=${at.round ?? '?'} · runId=${at.runId ?? '?'} · sha=${at.sha ?? '?'}`
      + `${at.spine ? ` · spine=${at.spine}` : ''}${at.batch ? ` · batch=${at.batch}` : ''} · at=${at.at ?? '?'} · reviewer=${at.reviewer ?? '?'}`);
  }
  for (const s of r.reasons) out(`  · ${s}`);
  // 漂移表：新锚点（有 spine）才打；老锚点保持今天那一句 sha 不等（A5 逐字不变）
  if (r.batch && Array.isArray(r.batch.entries) && r.batch.entries.length) {
    const parts = r.batch.entries.map((e) => (e.same
      ? `${e.locator}（${fmtBytes(e.bytes)} / ${e.lines} 行 · 与签时一致）`
      : `${e.locator}（${fmtBytes(e.bytes)} / ${e.lines} 行 · 节 sha 与签时不同）`));
    out(`  · 批区 ${parts.join(' · ')}`);
    if (r.batch.unmatched && r.batch.unmatched.length) out(`  · ⚠️ 解析不到的小节号：${r.batch.unmatched.join(' ')}`);
    for (const e of r.batch.entries) {
      if (!e.same) out(`  · ⚠️ ${e.locator} 节 sha 与锚点不符（${e.sha12} → ${e.currentSha12}）—— 仅提示，不改状态`);
    }
    if (r.batch.overLimit) {
      out(`  · ⚠️ 批区已超签时上限（现 ${fmtBytes(r.batch.batchBytes)} > 正文 1/3 = ${fmtBytes(Math.floor(r.batch.bodyBytes / 3))}）—— 仅提示，不改状态`);
    }
  }
}

function main(argv) {
  const a = parseArgs(argv);
  if (a.err) { warn(`用法错误：${a.err}`); warn(USAGE); return PLAN_GATE_EXIT.USAGE; }
  if (a.help) { out(USAGE); return PLAN_GATE_EXIT.OK; }

  if (a.check) {
    const r = evaluate(a.file);
    printCheck(r);
    if (r.state === 'pass' || r.state === 'pass-batch') return PLAN_GATE_EXIT.OK;
    if (r.state === 'stale') return PLAN_GATE_EXIT.STALE;
    if (r.state === 'fail') return PLAN_GATE_EXIT.FAIL;
    return PLAN_GATE_EXIT.MISSING;
  }

  const kind = a.pass ? 'pass' : 'fail';
  const cur = (() => { try { return parseAnchor(fs.readFileSync(path.resolve(a.file), 'utf8')); } catch { return null; } })();
  const res = writeAnchor(a.file, { kind, round: a.round, reviewer: a.reviewer, runId: crypto.randomUUID(), at: new Date().toISOString(), batch: a.batch ?? undefined });
  if (res.error) { warn(`❌ ${res.error}`); return PLAN_GATE_EXIT.USAGE; }
  if (res.skipped) {
    out(`✅ 幂等：${res.reason}`);
    out(`锚点：L${res.anchor.line}「${res.anchor.raw}」`);
    return PLAN_GATE_EXIT.OK;
  }
  // 位置预览（dry-run 也要看得见落在哪）
  const pos = (() => {
    const r = parseAnchor(res.text);
    return r ? `L${r.line}` : '(未找到)';
  })();
  out(`${a.apply ? '✅ 已写入' : '[dry-run] 将写入'} ${kind} 锚点 · 位置 ${pos}`);
  out(`  ${res.line}`);
  out(`  档：${path.resolve(a.file)} · 正文 sha256（前 12 位）= ${bodySha(res.text).slice(0, 12)}`);
  if (res.batch) {
    out(`  批区 ${res.batch.entries.length} 处：${res.batch.locators.join(' ')} · 合计 ${fmtBytes(res.batch.batchBytes)} / 正文 ${fmtBytes(res.batch.bodyBytes)}（上限 1/3 = ${fmtBytes(Math.floor(res.batch.bodyBytes / 3))}）`);
    out(`  spine=${res.batch.spine}`);
    if (res.batchBefore !== null && res.batchAfter !== res.batchBefore) {
      const before = res.batchBefore.split(',').map((s) => s.split(':')[0]).join(',');
      const after = res.batchAfter.split(',').map((s) => s.split(':')[0]).join(',');
      out(`  批区已更新：${before} → ${after}`);
    }
  }
  if (kind === 'pass' && cur && cur.attrs.round) {
    out(`  建议 round=${Number(cur.attrs.round) + 1}（本次终审；工具不自动递增，--round 自己给）`);
  }
  if (!a.apply) { out('  （dry-run：要落盘请加 --apply；本行不会写进档）'); return PLAN_GATE_EXIT.OK; }
  const abs = path.resolve(a.file);
  // 🔴 原子替换：先写 *.tmp-new，再同盘 renameSync 覆盖 —— 本器具是全库共用闸，
  //    别的线随时在建卡 / 过审时调用它，原地覆盖会出现「读到半个文件」的窗口（其它会话当场 SyntaxError）。
  const tmp = `${abs}.plan-gate-tmp-${process.pid}`;
  fs.writeFileSync(tmp, res.text, 'utf8');
  fs.renameSync(tmp, abs);
  // 写完立刻回读自检：pass 必须判 pass（防"写进去自己把自己判过期"这种自指 bug）
  //   （--fail 写完回读应判 fail；--pass 写完回读应判 pass / pass-batch —— 各自"写对了"）
  const after = evaluate(abs);
  const expect = kind === 'pass' ? ['pass', 'pass-batch'] : ['fail'];
  out(`  回读自检：${after.state}${expect.includes(after.state) ? ' ✅' : ' ❌'}`);
  return expect.includes(after.state) ? PLAN_GATE_EXIT.OK : (kind === 'pass' ? PLAN_GATE_EXIT.STALE : PLAN_GATE_EXIT.FAIL);
}

const isMain = (() => {
  try {
    const a = fs.realpathSync(process.argv[1] || '');
    const b = fs.realpathSync(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    return a.toLowerCase() === b.toLowerCase();
  } catch { return false; }
})();

if (isMain) {
  const code = main(process.argv.slice(2));
  if (typeof code === 'number') process.exitCode = code;
}

export { main };
