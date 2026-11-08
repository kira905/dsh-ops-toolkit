// ============================================================================
//  rulecheck-rules.mjs —— 「工程规则机制化」判据纯函数库（**零 IO · 零副作用**）
//  --------------------------------------------------------------------------
//  真源（规矩层，本文件只是它们的机器判据，**不改规矩**）：
//    · `docs\口径-需求粒度与验收粒度对齐-20261014.md`（需求层 10~20 条封顶 / 技术条目零次
//      出现在给人看的清单里 / 封版判据 = 欠账有归属）
//    · `docs\口径-验收两轨制与DoD十条-20261014.md`（§1 硬口径 / §3 台账四字段 / §5 封版六件套）
//    · `docs\口径-工程链条规则总纲-20261014.md`（§2 DoR / §3 缺陷分级 / §4 复盘）
//    · 方案 `docs\方案-V3.0.0工程规则机制化-R017R032-20261015.md` §3 / §5.3
//  设计红线（方案 §2.3）：
//    ① 「有不合规」不是错误 —— 本库不决定退出码，调用方默认 rc=0（`--fail-on-bad` 才非 0）
//    ② 判据全是**确定性**的（计数 / 枚举 / 正则 / 差集），不含任何语义判断
//    ③ **不可判 ⇒ 如实登记**（`unavailable` / `未查证`），绝不猜
//    ④ 本库不写任何文件、不读环境（IO 全在调用方）—— 便于夹具单测直接跑
//
//  判据编号：B# = 需求基线族 · D# = 技术债账本族（与方案 §3.1 / §3.3 逐条对应）
// ============================================================================

export const RULECHECK_RULES_VERSION = '0.4.2';   // 0.4.2 = 机器锁二：R4 扩「免方案改生产必须补等价判据」（2026-10-23）

/** 需求基线条数上下限（真源 = 三份口径档原文「10~20 条封顶」）。 */
export const BASELINE_MIN = 10;
export const BASELINE_MAX = 20;

/**
 * 技术细节模式集 —— 「技术条目零次出现在给人看的清单里」的机器判据（方案 §3.1 B4）。
 * ⚠️ 加词纪律：只收**高置信、低误报**的硬模式；宁可少报（漏报由人复核兜），
 *    绝不把「封口清单」「主线名」这类内部产物名收进来（V2.9 实例档里合法出现 ⇒ 必误报）。
 * 口径出处：`docs\需求清单-大管家V2.9-20261014.md` §3 自述「全档扫盘符路径 / 文件名 /
 *    调用符号 / 行号，命中 0」（本模式集即按这四类 + 反引号代码段实现）。
 */
export const TECH_PATTERNS = [
  { id: 'win-path', label: '盘符路径', re: /[A-Za-z]:[\\/]/ },
  { id: 'file-name', label: '带扩展名文件名', re: /\S+\.(mjs|js|json|md|ps1|cmd|bat|yml|yaml|ts|py|log|db|zip|exe|csv)\b/i },
  { id: 'line-ref', label: '行号引用', re: /\bL\d{2,}\b/ },
  { id: 'code-span', label: '反引号代码段', re: /`[^`]+`/ },
  { id: 'call-sym', label: '调用符号', re: /\b[A-Za-z_$][A-Za-z0-9_$]*\(\)/ },
];

/** 状态取值域（需求清单三态 · 真源 = 该档 §0「状态只有三种取值」）。 */
export const BASELINE_STATUS = ['已落地', '部分', '未落地'];

/** 台账表头必备字段（真源 = 两轨制档 §3「每条必带四样」+ 状态列）。 */
export const DEBT_HEADER_FIELDS = [
  { key: 'risk', label: '一句话风险', any: ['风险'] },
  { key: 'trigger', label: '触发条件', any: ['触发条件'] },
  { key: 'owner', label: 'owner', any: ['owner', '负责人'] },
  { key: 'basis', label: '依据', any: ['依据'] },
  { key: 'status', label: '状态', any: ['状态'] },
];

const CJK = /[\u4e00-\u9fff]/;
const PLACEHOLDER = /^(—|-+|待定|tbd|无|n\/a|none)$/i;

// ---------------------------------------------------------------------------
//  Markdown 表格解析（**按列位**，不猜语义 —— 方案 §5.3 硬设计 ①）
// ---------------------------------------------------------------------------
export function splitCells(line) {
  const s = String(line).trim().replace(/^\|/, '').replace(/\|\s*$/, '');
  return s.split('|').map((c) => c.trim());
}

const isTableLine = (l) => /^\s*\|/.test(l);
const isSepLine = (l) => /^\s*\|[\s:|-]+\|\s*$/.test(l);

/** 切出档内所有 markdown 表格（连续 `|` 行成块）。 */
export function findTables(md) {
  const lines = String(md).split(/\r?\n/);
  const tables = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    if (isTableLine(lines[i])) {
      if (!cur) cur = { startLine: i + 1, raw: [] };
      cur.raw.push({ no: i + 1, text: lines[i] });
    } else if (cur) { tables.push(finalizeTable(cur)); cur = null; }
  }
  if (cur) tables.push(finalizeTable(cur));
  return tables;
}

function finalizeTable(cur) {
  const rows = cur.raw.filter((r) => !isSepLine(r.text));
  const header = rows.length ? splitCells(rows[0].text) : [];
  return {
    startLine: cur.startLine,
    headerLineNo: rows.length ? rows[0].no : cur.startLine,
    header,
    dataRows: rows.slice(1).map((r) => ({ no: r.no, cells: splitCells(r.text), text: r.text })),
  };
}

export function pickColumn(headers, keywords) {
  for (let i = 0; i < headers.length; i++) {
    if (keywords.some((k) => headers[i].toLowerCase().includes(String(k).toLowerCase()))) return i;
  }
  return -1;
}

/**
 * 收集「一张**逻辑表**」的数据行 —— 按**列位**解析，且**容忍空行分隔**。
 * 为什么需要它（2026-10-15 真档实测踩到）：`docs\技术债台账-*.md` 用**空行**把同一条账本的
 *   行做视觉分组（D-1~D-3 / D-4~D-5 / D-6），`findTables` 的"连续块"口径会把后两组
 *   当成**没有表头的第二、三张表** ⇒ **整整漏掉 3 条**（实测：6 条只解析出 3 条）。
 *   台账/清单的**逻辑表 = 一个表头 + 其后所有数据行**，空行不算断。
 * 停止条件（三条，都写成显式判据，不猜）：① 非表格行（正文 / `---` 分隔线）② 第二个表头样行
 *   ③ 档结束。
 * @param {string} md
 * @param {{headerMatch:(cells:string[])=>boolean, rowRe:RegExp}} spec
 */
export function collectLogicalTable(md, spec) {
  const lines = String(md).split(/\r?\n/);
  let headerNo = -1; let header = null;
  for (let i = 0; i < lines.length; i++) {
    if (!isTableLine(lines[i])) continue;
    const cells = splitCells(lines[i]);
    if (spec.headerMatch(cells)) { headerNo = i; header = cells; break; }
  }
  if (headerNo < 0) return null;
  const dataRows = [];
  for (let i = headerNo + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;          // 空行 ⇒ 仍是同一张逻辑表
    if (!isTableLine(l)) break;       // 正文 / `---` ⇒ 表结束
    if (isSepLine(l)) continue;       // 表头下的分隔行
    if (!spec.rowRe.test(l)) break;   // 非数据行（多半个表头）⇒ 表结束
    const cells = splitCells(l);
    // 半写档信号：单元格数与表头不一致（被检档是**活档**，可能正被别的会话写到一半）
    dataRows.push({ no: i + 1, cells, text: l, raggedCells: cells.length !== header.length });
  }
  return { header, headerLineNo: headerNo + 1, dataRows };
}

/** 去掉 markdown 强调/链接装饰，取纯文本（判空用）。 */
export const plain = (s) => String(s ?? '').replace(/\*\*|__|~~/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').trim();

// ---------------------------------------------------------------------------
//  需求基线族（方案 §3.1 · B1–B7）
// ---------------------------------------------------------------------------
const BASELINE_ROW = /^\|\s*\*{0,2}(\d+)\*{0,2}\s*\|/;
const SUMMARY_RE = /已落地\s*(\d+)\s*条([\s\S]{0,120}?)部分\s*(\d+)\s*条([\s\S]{0,120}?)未落地\s*(\d+)\s*条/g;

/**
 * 校验一份「人话需求清单」（`docs\需求清单-*.md`）。
 * @returns {{unavailable:boolean, reason?:string, issues:Array, counts:Object, entries:Array, meta:Object}}
 */
export function checkBaseline(md, opts = {}) {
  const text = String(md ?? '');
  const issues = [];
  // 判据表 = 表头含「需求」列（缺「判据」列是 B2 的事，不是"结构不认识"）
  const table = collectLogicalTable(text, {
    headerMatch: (cells) => pickColumn(cells, ['需求']) >= 0,
    rowRe: BASELINE_ROW,
  });
  if (!table) {
    return {
      unavailable: true,
      reason: '找不到含「需求」列的需求清单表（结构不认识，不猜）',
      issues: [{ id: 'B0', level: '🔴', msg: '需求清单表结构不认识（缺「需求」列）' }],
      counts: { total: 0, byStatus: {} }, entries: [], meta: {},
    };
  }

  const cNeed = pickColumn(table.header, ['需求']);
  const cCrit = pickColumn(table.header, ['判据']);
  const cStat = pickColumn(table.header, ['状态']);
  const cEvid = pickColumn(table.header, ['核对', '证据', '出处']);
  const cNote = pickColumn(table.header, ['备注']);
  const rows = table.dataRows;

  const entries = rows.map((r) => ({
    no: Number(BASELINE_ROW.exec(r.text)[1]),
    line: r.no,
    need: plain(r.cells[cNeed]),
    crit: plain(r.cells[cCrit]),
    status: cStat >= 0 ? plain(r.cells[cStat]) : '',
    evidence: cEvid >= 0 ? plain(r.cells[cEvid]) : '',
    note: cNote >= 0 ? plain(r.cells[cNote]) : '',
    raw: r.cells,
  }));

  // B1 条数 10~20 封顶
  const total = entries.length;
  if (total === 0) {
    issues.push({ id: 'B1', level: '🔴', msg: '表里没有任何条目行（空表）', evidence: `表头 L${table.headerLineNo}` });
  } else if (total < BASELINE_MIN || total > BASELINE_MAX) {
    issues.push({ id: 'B1', level: '🔴', msg: `条目数 ${total} 超出 ${BASELINE_MIN}~${BASELINE_MAX} 封顶`, evidence: `表头 L${table.headerLineNo}` });
  }

  if (cStat < 0) issues.push({ id: 'B3', level: '🔴', msg: '表缺「状态」列，状态取值域无法判', evidence: `表头 L${table.headerLineNo}` });
  if (cEvid < 0) issues.push({ id: 'B6', level: '🟡', msg: '表缺「到哪去核对 / 证据」列（可追溯性无法判）', evidence: `表头 L${table.headerLineNo}` });
  if (cCrit < 0) issues.push({ id: 'B2', level: '🔴', msg: '表缺「判据」列', evidence: `表头 L${table.headerLineNo}` });

  for (const e of entries) {
    // B2 每条有人话判据（非空 / 非占位 / 够长 / 含中文）
    if (cCrit >= 0) {
      if (!e.crit || PLACEHOLDER.test(e.crit)) {
        issues.push({ id: 'B2', level: '🔴', msg: `#${e.no} 判据为空或占位符`, evidence: `L${e.line}「${e.crit || '(空)'}」` });
      } else if ([...e.crit].length < 8 || !CJK.test(e.crit)) {
        issues.push({ id: 'B2', level: '🔴', msg: `#${e.no} 判据不像"人能读的一句话"（长度/中文不足）`, evidence: `L${e.line}「${e.crit}」` });
      }
    }
    // B3 状态取值域
    if (cStat >= 0 && !BASELINE_STATUS.includes(e.status)) {
      issues.push({ id: 'B3', level: '🔴', msg: `#${e.no} 状态「${e.status || '(空)'}」不在取值域 ${BASELINE_STATUS.join('/')}`, evidence: `L${e.line}` });
    }
    // B4 技术细节零泄漏（需求列 + 判据列；--scan-all 由调用方另跑 checkTechLeak）
    for (const [col, val] of [['需求', e.need], ['判据', e.crit]]) {
      for (const p of TECH_PATTERNS) {
        const m = p.re.exec(val);
        if (m) {
          issues.push({ id: 'B4', level: '🔴', msg: `#${e.no} ${col}列泄漏技术细节（${p.label}）`, evidence: `L${e.line}「${m[0]}」` });
        }
      }
    }
    // B6 每条有证据出处
    if (cEvid >= 0 && !plain(e.evidence)) {
      issues.push({ id: 'B6', level: '🟡', msg: `#${e.no} 没有「到哪去核对」证据`, evidence: `L${e.line}` });
    }
  }

  // B8 半写档信号：行列不齐（被检档是活档，可能正被别的会话写到一半 —— 2026-10-15 审核轮三 I-4）
  const ragged = rows.filter((r) => r.raggedCells);
  if (ragged.length) {
    issues.push({
      id: 'B8', level: '🟡',
      msg: `${ragged.length} 行单元格数与表头不一致（疑半写档 / 表格被写坏 ⇒ 本次结论可能对截断档无效）`,
      evidence: ragged.slice(0, 3).map((r) => `L${r.no}`).join(' '),
    });
  }

  // B7 头部三要素（冻结日 / 性质 / 基准设备）—— 只看表之前的部分
  const head = text.split(/\r?\n/).slice(0, Math.max(0, table.headerLineNo - 1)).join('\n');
  for (const [key, re] of [['冻结日', /冻结/], ['性质', /性质/], ['基准设备', /设备/]]) {
    if (!re.test(head)) issues.push({ id: 'B7', level: '🟡', msg: `头部缺「${key}」要素`, evidence: '表之前的头部区' });
  }

  // B5 汇总数与表体逐行现数一致（**每一处都查、不取"末次"** —— 取末次会漏掉正文里的真错）
  //   分级口径（2026-10-15 审核轮二 B-3 + 轮三 I-3 处置）：
  //     · 档内**存在**与表体一致的汇总句 ⇒ 不符的那处降 🟡（现实常态：正文按"只加订正注不改原文"
  //       制度保留旧数，订正注已对齐 ⇒ 不该长期报红，否则告警疲劳）
  //     · 档内**不存在**任何一致的汇总句 ⇒ 🔴（真错，没人订正）
  const byStatus = {};
  for (const s of BASELINE_STATUS) byStatus[s] = entries.filter((e) => e.status === s).length;
  const summaries = [];
  for (const m of text.matchAll(SUMMARY_RE)) {
    // 分组：1=已落地数 · 2=中间填充 · 3=部分数 · 4=中间填充 · 5=未落地数
    const [full, a, , b, , c] = m;
    const line = text.slice(0, m.index).split(/\r?\n/).length;
    const got = { 已落地: Number(a), 部分: Number(b), 未落地: Number(c) };
    const mismatch = BASELINE_STATUS.filter((k) => got[k] !== byStatus[k]);
    summaries.push({ line, text: full.replace(/\s+/g, ' ').slice(0, 80), got, mismatch });
  }
  const anyConsistent = summaries.some((s) => s.mismatch.length === 0);
  for (const s of summaries) {
    if (!s.mismatch.length) continue;
    const got = s.got;
    const msg = `汇总数与表体不符：档内写「已落地 ${got['已落地']} / 部分 ${got['部分']} / 未落地 ${got['未落地']}」，逐行现数 = 「已落地 ${byStatus['已落地']} / 部分 ${byStatus['部分']} / 未落地 ${byStatus['未落地']}」`;
    issues.push({
      id: 'B5', level: anyConsistent ? '🟡' : '🔴',
      msg: msg + (anyConsistent ? '（档内另有与表体一致的汇总句 ⇒ 判为止损订正注，降 🟡）' : '（档内无任何一致的汇总句 ⇒ 真错）'),
      evidence: `L${s.line}「${s.text.slice(0, 60)}」`,
    });
  }
  if (!summaries.length) {
    issues.push({ id: 'B5', level: '🟡', msg: '档内找不到「已落地 X 条 · 部分 Y 条 · 未落地 Z 条」式汇总句（无法核对）', evidence: '未查证' });
  }

  return {
    unavailable: false,
    issues,
    entries,
    summaries,
    counts: { total, byStatus, rows: total },
    meta: { tableHeaderLine: table.headerLineNo, headerLineNo: table.headerLineNo, columns: { cNeed, cCrit, cStat, cEvid, cNote } },
  };
}

/** 全档技术细节扫描（`--scan-all` · B4 的加严形态）。 */
export function checkTechLeak(md) {
  const hits = [];
  const lines = String(md ?? '').split(/\r?\n/);
  lines.forEach((l, i) => {
    for (const p of TECH_PATTERNS) {
      const m = p.re.exec(l);
      if (m) hits.push({ line: i + 1, pattern: p.id, label: p.label, match: m[0], text: l.trim().slice(0, 80) });
    }
  });
  return hits;
}

/** 需求轨签字页草稿（方案 §3.2 / `--section`）—— **零技术细节**，只列条目 + 人话判据 + 状态。 */
export function signoffDraft(result, title = '需求清单') {
  if (result.unavailable) return `### ${title} · 需求轨签字页草稿\n\n${result.reason}（**未生成草稿**）\n`;
  const { counts, entries } = result;
  const out = [];
  out.push(`### ${title} · 需求轨签字页草稿（机器生成 · **不代主人签**）`);
  out.push('');
  out.push(`**条数小结**：共 ${counts.total} 条 —— 已落地 ${counts.byStatus['已落地']} · 部分 ${counts.byStatus['部分']} · 未落地 ${counts.byStatus['未落地']}`);
  out.push('');
  out.push('| # | 需求（一句人话） | 判据（这条做完了没） | 现值状态 |');
  out.push('|---|---|---|---|');
  for (const e of entries) out.push(`| ${e.no} | ${e.need} | ${e.crit} | ${e.status} |`);
  out.push('');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
//  技术债账本族（方案 §3.3 · D1–D7）
// ---------------------------------------------------------------------------
// 条目 id 前缀放宽到「1–2 个大写字母 + 连字符 + 数字」（2026-10-19 · V3 地基线接手会话）：
//   原写死 `D-\d+` ⇒ 别的台账用 `K-1` / `Q-2` 这类前缀时**整表识别不到**，会被判成「🔴 空表」假红
//   （实测：`docs\技术债台账-开源发布.md` 只有 K-1 一条 ⇒ 旧判据报「表里没有任何 D-n 条目行」）。
//   口径不变（一句话风险 / 触发条件 / owner / 依据 / 状态五列 + 未结数才是判据），只放宽 id 形态。
const DEBT_ROW = /^\|\s*\*{0,2}([A-Z]{1,2}-\d+)\*{0,2}\s*\|/;

/**
 * 校验一份技术债台账（`docs\技术债台账-*.md`）。
 * @param {string} md 台账全文
 * @param {{baselineRows?:number|null, baselineLabel?:string, baselineText?:string}} opts
 *        `baselineRows` = 上一版副本的**数据行数**（外部传入；校验器**不自己落基线**）
 */
export function checkDebt(md, opts = {}) {
  const text = String(md ?? '');
  const issues = [];
  // 台账的**逻辑表** = 一个表头 + 其后所有 `D-n` 行（**容忍空行分组**，实测见 collectLogicalTable 注释）
  const table = collectLogicalTable(text, {
    headerMatch: (cells) => pickColumn(cells, ['风险']) >= 0,
    rowRe: DEBT_ROW,
  });
  if (!table) {
    return {
      unavailable: true,
      reason: '找不到含「风险」列的台账表（结构不认识，不猜）',
      issues: [{ id: 'D0', level: '🔴', msg: '台账表结构不认识（缺「一句话风险」列）' }],
      counts: { total: 0, byStatus: {} }, entries: [],
    };
  }

  const cols = {};
  for (const f of DEBT_HEADER_FIELDS) cols[f.key] = pickColumn(table.header, f.any);

  // D1 表头五字段在位
  for (const f of DEBT_HEADER_FIELDS) {
    if (cols[f.key] < 0) issues.push({ id: 'D1', level: '🔴', msg: `表头缺「${f.label}」列`, evidence: `表头 L${table.headerLineNo}` });
  }

  const rows = table.dataRows;
  const ragged = rows.filter((r) => r.raggedCells);
  if (ragged.length) {
    issues.push({
      id: 'D8', level: '🟡',
      msg: `${ragged.length} 行单元格数与表头不一致（疑半写档 / 表格被写坏 ⇒ 本次结论可能对截断档无效）`,
      evidence: ragged.slice(0, 3).map((r) => `L${r.no}`).join(' '),
    });
  }
  const entries = rows.map((r) => {
    const id = DEBT_ROW.exec(r.text)[1];
    const cell = (k) => (cols[k] >= 0 ? plain(r.cells[cols[k]]) : '');
    // D3 状态 = **行内最后一次**出现的状态标记（依据：V2.9 实例 D-4 行先「未结 · 处置已定」后「✅ 已结」）
    //   词汇放宽（2026-10-19 · V3 地基线接手会话）：`已修/未修`（开源台账口径）、`已办`（收口类行）**同义**
    //   ⇒ 否则同义写法的台账会被判「状态未知」（实测：`docs\技术债台账-开源发布.md` K-1 行写「未修」）。
    const CLOSED_WORDS = new Set(['已结', '已修', '已办']);
    const marks = [...r.text.matchAll(/已结|未结|已修|未修|已办/g)].map((m) => ({ at: m.index, word: m[0] }));
    const last = marks.length ? (CLOSED_WORDS.has(marks[marks.length - 1].word) ? '已结' : '未结') : '';
    return {
      id, line: r.no,
      risk: cell('risk'), trigger: cell('trigger'), owner: cell('owner'), basis: cell('basis'),
      statusCell: cell('status'), status: last, statusMarks: marks.length, raw: r.cells,
    };
  });

  if (!entries.length) issues.push({ id: 'D2', level: '🔴', msg: '表里没有任何 `D-n` 条目行（空表）', evidence: `表头 L${table.headerLineNo}` });

  const byStatus = { 已结: 0, 未结: 0, 未知: 0 };
  for (const e of entries) {
    // D2 四字段非空
    for (const k of ['risk', 'trigger', 'owner', 'basis']) {
      if (!e[k]) {
        const label = DEBT_HEADER_FIELDS.find((f) => f.key === k).label;
        issues.push({ id: 'D2', level: '🔴', msg: `${e.id} 缺「${label}」（四字段缺一不算）`, evidence: `L${e.line}` });
      }
    }
    // D3 状态可判
    if (!e.status) {
      byStatus.未知 += 1;
      issues.push({ id: 'D3', level: '🟡', msg: `${e.id} 状态列识别不出「已结 / 未结」`, evidence: `L${e.line}「${e.statusCell.slice(0, 40)}」` });
    } else byStatus[e.status] += 1;

    // D5 未结行必须带 owner + 触发条件（防"坟场"）
    if (e.status === '未结') {
      if (!e.owner) issues.push({ id: 'D5', level: '🔴', msg: `${e.id} 未结但没 owner`, evidence: `L${e.line}` });
      if (!e.trigger) issues.push({ id: 'D5', level: '🔴', msg: `${e.id} 未结但没触发条件`, evidence: `L${e.line}` });
    }

    // D4 已结行必须带结案依据（日期 + 证据痕迹）
    if (e.status === '已结') {
      const hasDate = /\d{4}-\d{2}-\d{2}|\d{4}\s*年/.test(e.statusCell);
      const hasEvidence = /[A-Za-z]:\\|docs\\|_archive|\.mjs|\.md|\.json|sha|现跑|证据|卡/.test(e.statusCell);
      if (!hasDate || !hasEvidence || e.statusCell.length < 20) {
        issues.push({
          id: 'D4', level: '🟡',
          msg: `${e.id} 已结但结案依据不足（${hasDate ? '' : '缺日期 '}${hasEvidence ? '' : '缺证据痕迹 '}${e.statusCell.length < 20 ? '状态原文过短' : ''}）`,
          evidence: `L${e.line}「${e.statusCell.slice(0, 60)}」`,
        });
      }
    }
  }

  // D6 「判定行只减不增」—— 需外部传入基线（**没有就如实登记，不猜**）。
  //   ⚠️ 口径修正（2026-10-15 审核轮三 I-3 处置）：台账纪律原文是「修完 ⇒ 状态改『已结』并写依据，
  //     **行不删**」⇒ 对台账来说**行数只增不减是常态**，单看行数会**必然误报**（当日实测：别的会话
  //     正当追加 D-6 就被算成"破坏只减不增"）。正确形态是**双判据**：
  //       ① 新增行（现 − 基）必须带**归属标记**（入账申请 / R-\d+ / 归 V3 / V3 候选）⇒ 无标记才 🔴
  //       ② **未结行数**只减不增（这才是"欠账不被稀释"的真判据）⇒ 变多 🔴
  //       ③ 基线有、现在没有的行 ⇒ 行被删（台账纪律禁止）⇒ 🔴
  let growth = null;
  const b = opts.baseline && typeof opts.baseline === 'object' ? opts.baseline
    : (Number.isFinite(opts.baselineRows) ? { rows: opts.baselineRows, open: null, ids: null, openIds: null } : null);
  if (b) {
    const curOpen = entries.filter((e) => e.status === '未结');
    const curIds = entries.map((e) => e.id);
    const added = b.ids ? curIds.filter((id) => !b.ids.includes(id)) : [];
    const removed = b.ids ? b.ids.filter((id) => !curIds.includes(id)) : [];
    const ATTRIB = /入账申请|\bR-\d+\b|归 V3|V3 候选/;
    growth = {
      baselineRows: b.rows ?? null, currentRows: entries.length, delta: entries.length - (b.rows ?? entries.length),
      baselineOpen: b.open ?? null, currentOpen: curOpen.length, added, removed,
      label: opts.baselineLabel || '(外部传入)',
    };
    // ① 新增行**只有"未结"才增加欠账** ⇒ 只有新增的未结行须带归属（已结行进来就结案，不追）
    let unregisteredOpen = 0;
    for (const id of added) {
      const e = entries.find((x) => x.id === id);
      if (e.status !== '未结') { issues.push({ id: 'D6', level: 'ℹ️', msg: `新增判定行 ${id}（已结 / 状态未知 ⇒ 不增加欠账）`, evidence: `L${e.line}` }); continue; }
      const text = `${e.risk} ${e.trigger} ${e.basis} ${e.statusCell}`;
      if (!ATTRIB.test(text)) {
        unregisteredOpen += 1;
        issues.push({
          id: 'D6', level: '🔴',
          msg: `新增未结判定行 ${id} 未标归属（须走「入账申请」：谁提 / 为什么必须现在 / 不做会怎样，或标 R-xxx / 归 V3）`,
          evidence: `L${e.line} · 基线来源 ${growth.label}`,
        });
      } else {
        issues.push({ id: 'D6', level: '🟡', msg: `新增未结判定行 ${id}（带归属标记 ⇒ 合规登记，登记在案）`, evidence: `L${e.line}` });
      }
    }
    growth.unregisteredOpen = unregisteredOpen;
    // ② 未结只减不增（**新增的未结行若都已登记在案 ⇒ 降 🟡**：增加是合规的，不该长期报红）
    if (b.open !== null && b.open !== undefined && curOpen.length > b.open) {
      const reg = unregisteredOpen
        ? `其中 ${unregisteredOpen} 条未标归属`
        : '其中新增的未结行**均已登记在案**（合规登记 ⇒ 降 🟡）';
      issues.push({
        id: 'D6', level: unregisteredOpen ? '🔴' : '🟡',
        msg: `「未结」条数增加：基线未结 ${b.open} 条 → 现未结 ${curOpen.length} 条（${reg}）`,
        evidence: `基线来源 ${growth.label}`,
      });
    }
    // ③ 行不许删
    for (const id of removed) {
      issues.push({ id: 'D6', level: '🔴', msg: `基线里的 ${id} 现在不见了（台账纪律：修完只改状态，**行不删**）`, evidence: `基线来源 ${growth.label}` });
    }
    if (!added.length && !removed.length && (b.open === null || b.open === undefined)) {
      issues.push({ id: 'D6', level: 'ℹ️', msg: '基线已比：行数与 id 集合均无变化（档内无"未结条数"可用）', evidence: growth.label });
    }
  } else {
    issues.push({ id: 'D6', level: 'ℹ️', msg: '未查证：未传 `--baseline`，本次跳过「只减不增」比对', evidence: '未查证' });
  }

  return { unavailable: false, issues, entries, growth, counts: { total: entries.length, byStatus } };
}

/** 「债的现状一行」（两轨制档 §3 / §5 · 封版要件）—— 也是方案 §3.2 的输出之一。 */
export function debtStatusLine(result) {
  if (result.unavailable) return `债的现状一行：**判定不可用** —— ${result.reason}`;
  const open = result.entries.filter((e) => e.status === '未结');
  const withOwner = open.filter((e) => e.owner).length;
  const withTrigger = open.filter((e) => e.trigger).length;
  const closed = result.entries.filter((e) => e.status === '已结').length;
  const unknown = result.counts.byStatus.未知 || 0;
  return `债的现状一行：共 ${result.counts.total} 条 —— **未结 ${open.length} 条**（其中带 owner ${withOwner} 条 · 带触发条件 ${withTrigger} 条）· 已结 ${closed} 条${unknown ? ` · 状态未知 ${unknown} 条` : ''}`;
}

/** 汇总一份结果的级别统计（报告用）。 */
export function summarizeLevels(issues) {
  const out = { '🔴': 0, '🟡': 0, 'ℹ️': 0 };
  for (const i of issues) out[i.level] = (out[i.level] || 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
//  DoD 十条族 / DoR 八条族（方案 §3.4 / §3.5 · 机制层**第二批** · 判据 T1–T4 / R1–R3）
//  --------------------------------------------------------------------------
//  块格式真源（**本文件不另立第二套格式**；项名照抄，一个字不改）：
//    · `docs\口径-验收两轨制与DoD十条-20261014.md` **§10**（DoD 勾选块格式）
//    · `docs\口径-工程链条规则总纲-20261014.md` **§9**（DoR 八条闸门块格式）
//  设计红线（与第一批同口径）：
//    · **缺块 ≠ 判定不可用** —— 缺块本身就是 T1/R1 的结论（🔴），rc 3 只留给"档都读不到"；
//    · 判据全是确定性匹配（锚点 / 编号 / 勾选标记 / 关键词），**不判语义**（"靶子写得好不好"永远归人）；
//    · **不真跑**第 9 条那条命令（那是"拦"档的将来形态）；
//    · **存量不追溯**：生效日之前的报告 / 卡不在发现面内（发现面由调用方按 `--since` 决定，
//      本库只判"给的这份文本"，不判"该不该查它"）。
// ---------------------------------------------------------------------------

/** DoD 十条（项名照抄 `口径-验收两轨制与DoD十条-20261014.md` §2 表）。 */
export const DOD_ITEMS = [
  { no: 1, name: '语法 / 解析实测过' },
  { no: 2, name: '有隔离验证或夹具证据' },
  { no: 3, name: '有回滚点且演练过' },
  { no: 4, name: '生产改动有备份' },
  { no: 5, name: '变更流水记了行' },
  { no: 6, name: '受保护文件过 P5 门' },
  { no: 7, name: '文档 / 指针回写齐（六包）' },
  { no: 8, name: '不越 §11 红线' },
  { no: 9, name: '判据可现跑复现' },
  { no: 10, name: '未查证项如实登记' },
];

/** DoR 八条（项名照抄 `口径-工程链条规则总纲-20261014.md` §2 表）。 */
export const DOR_ITEMS = [
  { no: 1, name: '靶子明确' },
  { no: 2, name: '范围有边' },
  { no: 3, name: '依据在位' },
  { no: 4, name: '前置清了' },
  { no: 5, name: '落点与验收方式已定' },
  { no: 6, name: '风险与回滚' },
  { no: 7, name: '档位已判' },
  { no: 8, name: '成本估过' },
];

/** DoR **必勾三条**（口径原文：1 / 2 / 5 缺一不许开工）。 */
export const DOR_MUST = [1, 2, 5];

// ---------------------------------------------------------------------------
//  方案过审凭证（2026-10-23 · 卡「地基 · 方案过审闸」· dor 族 **R4**）
//  --------------------------------------------------------------------------
//  真源：用户要求「给方案没过审就建卡施工加一个机器锁」（锁在机器上，不在技能/卡面上）。
//  载体（两种合法痕迹之一，都由 `tools\board-card-add.mjs` 建卡时注入卡 description 头部）：
//    · `方案过审：<档相对路径>#<sha8> · round=<N> · runId=<uuid>`   ← 凭证器 `tools\dsh-butler\plan-gate.mjs` 判 pass
//    · `方案闸：无需方案（--no-plan）—— <为什么不需要方案，≤80 字>`
//  本库只判「卡面有没有这两种痕迹」（确定性字符串匹配）—— **判不出凭证真假**（那是建卡器的事：
//  它建卡时现跑 `evaluate()`，过期/缺失直接拒建）。R4 与 R1–R3 同档：**observe · 只报告不拦卡**。
// ---------------------------------------------------------------------------
export const PLAN_GATE_PASS_LINE = '方案过审：';
export const PLAN_GATE_NO_PLAN = '--no-plan';

// ---------------------------------------------------------------------------
//  机器锁二：免方案改生产件 ⇒ 必须补「默认等价 / 零生产影响」判据（2026-10-23 · 卡「机器锁二」）
//  --------------------------------------------------------------------------
//  主人原话（2026-10-23 11:49）：「**该生产可以免审但是要补判据**」。
//  起因：卡 `4b870fa9` 用 `--no-plan` 建卡，却**改了生产器具**
//        `tools\dsh-butler\memory-decay-shadow.mjs`（v1.0.0 → v1.1.0，声称"默认行为等价"）+ 新增一件工具
//        —— 旧闸只看「有没有写免方案理由」，不看「你到底改了什么」⇒ 这就是那个缺口。
//  本段判据（**全是确定性行级匹配 · 不判语义**）：
//    · `--no-plan` 卡面必须有 `生产影响：` 段（建卡器靠 `--no-plan-equiv` 注入，必填）；
//    · 该段命中「改了 / 改了生产 / 动生产 / 改生产」这类词 ⇒ **同段或紧邻一行**必须含
//      `等价判据：` + 一条**以 `node ` 开头**的可现跑命令（能现跑的命令 + 读数）；
//    · 生效**时刻** `NOPLAN_EQUIV_SINCE` 之后建的卡缺 ⇒ 🔴；之前的存量卡 ⇒ 🟡（**不回扫、不重写**）。
//  ⚠️ 行级（不认"讨论句里提一句"）：判据形态固定 = 凭证行里的 `｜生产影响：` 或独立一行 `生产影响：`。
//  ⚠️ **粒度 = 时刻**（主人 2026-10-23 12:38「按时刻吧」）：`2026-10-23T11:49` = 主人发话那一刻。
//     此前建的卡一律算存量 —— 日期级会把当天上午 10:0x–11:4x 建的 10 张免方案卡回溯判红（告警疲劳）。
//     写法只认两种：`'YYYY-MM-DD'`（= 当日 00:00）/ `'YYYY-MM-DDTHH:mm'`（本地 +08:00）；比较口径在
//     `tools\rulecheck.mjs` 的 `cardTimeMs()` **一处**（卡 createdAt / 档 mtime 都先归一成 epoch ms 再比）。
// ---------------------------------------------------------------------------
export const NOPLAN_EQUIV_SINCE = '2026-10-23T11:49';
export const NOPLAN_IMPACT_LABEL = '生产影响：';
export const NOPLAN_EQUIV_LABEL = '等价判据：';

/**
 * 两种痕迹的**行级**形态（2026-10-23 收紧 · 自己踩出来的假绿）：
 *   第一版用 `text.includes('--no-plan')` ⇒ **讨论里提一句就判"有凭证"**。
 *   实测：本卡执行完把「待拍板」写进自己的卡面，里面恰好提到 `--no-plan` ⇒ R4 立刻从红变绿（假绿）。
 * ⇒ 只认**从行首开始**的声明行（可带列表符）：
 *     `方案过审：<档>#<sha8> · …`            （凭证器注入的形态）
 *     `方案闸：无需方案（--no-plan）—— <理由>`（建卡器注入的形态）
 *     `--no-plan：<理由>`                     （人手工写的短形态）
 *   句中出现 / 反引号里讨论 / "以后用 --no-plan" 这类**不算**。
 */
const PLAN_PASS_LINE_RE = /(?:^|\n)[ \t]*(?:[-*+]\s*)?方案过审\s*[:：]/;
const PLAN_NO_PLAN_LINE_RE = /(?:^|\n)[ \t]*(?:[-*+]\s*)?(?:方案闸\s*[:：][^\n]*--no-plan|--no-plan(?=[\s：:（(—-]|$))/;

/**
 * `生产影响：` 段的**行级**形态（机器锁二）—— 只认两种，不认"句子里提一句"：
 *   ① 独立一行：`生产影响：<…>`（可带列表符 / 缩进）
 *   ② 与凭证行**同一行**：`… ｜生产影响：<…>`（建卡器 `--no-plan-equiv` 注入的就是这个形态）
 */
const IMPACT_STANDALONE_RE = /^[ \t]*(?:[-*+]\s*)?生产影响\s*[:：]/;
const IMPACT_INLINE_RE = /[｜|][ \t]*生产影响\s*[:：]/;
/**
 * 「这段声明了改生产件」的关键词（行级命中 · 带否定前缀护栏）：
 *   命中：改了 / 动了 / 改了生产 / 动生产 / 改生产 / 改动生产 / 生产改动 / 生产修改 …
 *   不算：「**没**改生产」「**未**动生产」「**零**生产改动」（否则"本次零生产改动"会被迫要判据 = 假红）
 */
const PROD_CHANGE_RE = /(?<![没未不无勿零])(?:(?:改|动)了|(?:改|动)生产|生产(?:改动|修改|变更))/;
/** 「等价判据」必须是一条**以 `node ` 开头**的可现跑命令（允许反引号/全角空格包裹）。 */
const EQUIV_CMD_RE = /等价判据\s*[:：][ \t]*`?[ \t]*node[ \t]/i;

/**
 * 找 `生产影响：` 段（行级）。返回 `null` = 没有这一段。
 * @param {string[]} lines 文本按行切好
 * @param {number} credIdx `--no-plan` 凭证行的下标（<0 = 没有）
 */
function findImpactSection(lines, credIdx) {
  for (let i = 0; i < lines.length; i++) {
    const m = IMPACT_STANDALONE_RE.exec(lines[i]);
    if (!m) continue;
    return { index: i, text: lines[i].slice(m[0].length).trim(), raw: lines[i].trim() };
  }
  if (credIdx >= 0) {
    const m = IMPACT_INLINE_RE.exec(lines[credIdx]);
    if (m) return { index: credIdx, text: lines[credIdx].slice(m.index + m[0].length).trim(), raw: lines[credIdx].trim() };
  }
  return null;
}

/**
 * 卡面「方案过审凭证」判据（纯函数 · 零 IO）。
 * @param {string} md 卡 description（或任何卡面文本）
 * @returns {{ok:boolean, hasPass:boolean, hasNoPlan:boolean, line:string, production:object}}
 *   `production` = 机器锁二那一段的读数：
 *     `{ present, text, line, mentionsChange, hasEquivCommand, probe }`
 *     - `present`   有没有 `生产影响：` 段
 *     - `mentionsChange` 该段是否声明改了生产件（关键词命中）
 *     - `hasEquivCommand` **同段或紧邻一行**有没有 `等价判据：node …`
 */
export function checkPlanGate(md) {
  const text = String(md ?? '');
  const lines = text.split(/\r?\n/);
  const hasPass = PLAN_PASS_LINE_RE.test(text);
  const hasNoPlan = PLAN_NO_PLAN_LINE_RE.test(text);
  const line = lines.find((l) => PLAN_PASS_LINE_RE.test(`\n${l}`) || PLAN_NO_PLAN_LINE_RE.test(`\n${l}`)) || '';
  const credIdx = lines.findIndex((l) => PLAN_NO_PLAN_LINE_RE.test(`\n${l}`));
  const sec = findImpactSection(lines, credIdx);
  // 「同段或紧邻一行」：段本身 + 下一行（凭证行同行形态就是段本身，下一行仍算紧邻）
  const probe = sec ? [sec.text, lines[sec.index + 1] ?? ''].join('\n') : '';
  const production = {
    present: !!sec,
    text: sec ? sec.text.slice(0, 300) : '',
    line: sec ? sec.index + 1 : -1,
    mentionsChange: sec ? PROD_CHANGE_RE.test(sec.text) : false,
    hasEquivCommand: sec ? EQUIV_CMD_RE.test(probe) : false,
    probe: probe.slice(0, 400),
  };
  return { ok: hasPass || hasNoPlan, hasPass, hasNoPlan, line: line.trim().slice(0, 160), lineNo: credIdx + 1, production };
}

/**
 * 第 9 条「当次命令」的痕迹模式（禁引历史读数 ⇒ 至少得看得见一条命令 / 路径 / 反引号代码段）。
 * 只收高置信形态：反引号代码段 · 盘符路径 · 常见命令与脚本扩展名。
 */
const CMD_TRACE = /`[^`]+`|[A-Za-z]:[\\/]|\b(node|npm|npx|pwsh|powershell|git|python|choco|winget)\b|Get-[A-Za-z]+|\.(mjs|ps1|cmd|bat|exe|sh)\b/;

/** 「引历史读数」的措辞（第 9 条出现即视为没给当次命令）。 */
const HISTORY_WORDS = /历史读数|见上次|同上|同前|沿用上次|之前跑过|上次跑过|见前次/;

/**
 * 第 10 条「未查证项如实登记」的空值判定 —— **「无」是合法答案**（口径原文：确实没有就明写「无」）。
 * ⚠️ 这里**不能复用 PLACEHOLDER**：那个含「无」，是给"判据 / 减项理由"用的（那里写"无"= 没写）。
 *    2026-10-15 夹具实测踩到一次（第 10 条写「无」被误报 🟡）。
 */
const EMPTY_NOTE = /^(—|-+|待定|tbd|n\/a|none)$/i;

/**
 * 条目行：`- [x] 3 项名 —— 说明`。
 * ⚠️ 分隔符**只认 `——`（两个 U+2014）或单个 `—`** —— **不认 `--`**：命令行开关里到处是
 *    `--self-test` / `--file`，把 `--` 当分隔符会把第 9 条的说明切碎（2026-10-15 实现时实测想到）。
 */
const CHECK_ITEM_RE = /^\s*[-*+]\s*\[([^\]]*)\]\s*(\d{1,2})\s*[.、:：)）]?\s*(.*)$/;

/**
 * 解析一个**勾选块**（`<!-- DoD:begin -->` … `<!-- DoD:end -->`）。
 * @param {string} md 被检文本（卡 description / 交付报告 / 建卡 prompt）
 * @param {'DoD'|'DoR'} kind 块类型
 * @returns {{found:boolean, unclosed:boolean, kind:string, items:Array, byNo:Map, beginLine:number, endLine:number}}
 *          `found=false` ⇒ 锚点都没有（**调用方按 T1/R1 报红，不判 rc 3**）
 */
export function parseCheckBlock(md, kind) {
  const lines = String(md ?? '').split(/\r?\n/);
  const bRe = new RegExp(`<!--\\s*${kind}:begin\\s*-->`, 'i');
  const eRe = new RegExp(`<!--\\s*${kind}:end\\s*-->`, 'i');
  let begin = -1; let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (begin < 0 && bRe.test(lines[i])) { begin = i; continue; }
    if (begin >= 0 && eRe.test(lines[i])) { end = i; break; }
  }
  if (begin < 0) return { found: false, unclosed: false, kind, items: [], byNo: new Map(), beginLine: -1, endLine: -1 };
  const unclosed = end < 0;
  const body = lines.slice(begin + 1, unclosed ? lines.length : end);
  const items = [];
  body.forEach((l, idx) => {
    const m = CHECK_ITEM_RE.exec(l);
    if (!m) return;
    const mark = m[1].trim();
    const checked = /^[xX]$/.test(mark);
    const rest = plain(m[3]);
    const parts = rest.split(/\s*(?:——|—)\s*/);
    items.push({
      no: Number(m[2]),
      name: parts.length > 1 ? parts[0] : rest,
      note: parts.length > 1 ? parts.slice(1).join(' —— ') : '',
      checked,
      malformed: !checked && mark !== '',   // 既不是 [x] 也不是 [ ]（如 [~] / [✓] / [√]）
      mark,
      line: begin + 2 + idx,
      raw: l.trim(),
    });
  });
  const byNo = new Map();
  for (const it of items) {
    if (!byNo.has(it.no)) byNo.set(it.no, []);
    byNo.get(it.no).push(it);
  }
  return { found: true, unclosed, kind, items, byNo, beginLine: begin + 1, endLine: unclosed ? lines.length : end + 1 };
}

/** 块内条目 ↔ 应有条目清单的**在位性**公共判据（T1 / R1 共用的部分）。 */
function checklistPresence(p, expected, tag, issues) {
  if (!p.found) {
    issues.push({
      id: tag, level: '🔴',
      msg: `找不到 ${p.kind} 块（缺 \`<!-- ${p.kind}:begin -->\` … \`<!-- ${p.kind}:end -->\`）⇒ 该交付物没有勾选留痕（格式真源 = 口径档 §${p.kind === 'DoD' ? '10' : '9'}）`,
      evidence: '全文本扫描未命中块锚点',
    });
    return;
  }
  if (p.unclosed) {
    issues.push({ id: tag, level: '🟡', msg: `${p.kind} 块只有 begin 没有 end（锚点未闭合，按"到档尾"解析）`, evidence: `块首 L${p.beginLine}` });
  }
  for (const it of expected) {
    if (!p.byNo.has(it.no)) issues.push({ id: tag, level: '🔴', msg: `缺第 ${it.no} 条「${it.name}」`, evidence: `块 L${p.beginLine}~L${p.endLine}` });
  }
  for (const [no, arr] of p.byNo) {
    if (arr.length > 1) issues.push({ id: tag, level: '🟡', msg: `第 ${no} 条重复出现 ${arr.length} 次`, evidence: arr.map((x) => `L${x.line}`).join(' ') });
    if (!expected.some((e) => e.no === no)) issues.push({ id: tag, level: '🟡', msg: `多出第 ${no} 条（不在 ${expected.length} 条清单内）`, evidence: `L${arr[0].line}` });
  }
  for (const it of p.items) {
    if (it.malformed) issues.push({ id: tag, level: '🟡', msg: `第 ${it.no} 条勾选标记畸形「[${it.mark}]」（只认 [x] 勾 / [ ] 未勾）`, evidence: `L${it.line}` });
  }
}

/**
 * DoD 十条勾选块校验（方案 §3.4 · T1–T4）。
 * @param {string} md 被检文本（交付报告 / 卡 description）
 */
export function checkDod(md) {
  const issues = [];
  const p = parseCheckBlock(md, 'DoD');
  checklistPresence(p, DOD_ITEMS, 'T1', issues);
  if (!p.found) return { unavailable: false, issues, items: [], counts: { total: 0, checked: 0, unchecked: 0, dropped: 0 }, meta: { blockFound: false } };

  for (const it of p.items) {
    if (it.checked) continue;
    // T2 减项必须写"减了哪几条 + 为什么"（口径：不许默默少过）
    const reason = it.note.replace(/减项[:：]?/, '').trim();
    if (!/减项/.test(it.note)) {
      issues.push({ id: 'T2', level: '🔴', msg: `第 ${it.no} 条未勾但没写「减项」+ 为什么（口径：不许默默少过）`, evidence: `L${it.line}「${it.raw.slice(0, 80)}」` });
    } else if ([...reason].length < 4 || PLACEHOLDER.test(reason)) {
      issues.push({ id: 'T2', level: '🔴', msg: `第 ${it.no} 条写了「减项」但没写清为什么`, evidence: `L${it.line}「${it.raw.slice(0, 80)}」` });
    }
  }

  // T3 第 9 条：不许减项 + 必须带**当次命令**
  const n9 = p.byNo.get(9)?.[0];
  if (n9) {
    if (!n9.checked) {
      issues.push({ id: 'T3', level: '🔴', msg: '第 9 条「判据可现跑复现」未勾（口径 §7 反例 3：没有独立验收方，唯一补偿 = 机器可复现 ⇒ 本条不许减项）', evidence: `L${n9.line}` });
    } else if (!CMD_TRACE.test(n9.note)) {
      issues.push({ id: 'T3', level: '🔴', msg: '第 9 条勾了但说明里没有当次命令（须给命令原文，禁引历史读数）', evidence: `L${n9.line}「${n9.note.slice(0, 80) || '(空)'}」` });
    } else if (HISTORY_WORDS.test(n9.note)) {
      issues.push({ id: 'T3', level: '🔴', msg: '第 9 条说明里出现"引历史读数"措辞（口径：禁引用历史读数，要给当次输出）', evidence: `L${n9.line}「${n9.note.slice(0, 80)}」` });
    }
  }

  // T4 第 10 条：非空 或 明写「无」
  const n10 = p.byNo.get(10)?.[0];
  if (n10 && (!n10.note.trim() || EMPTY_NOTE.test(n10.note.trim()))) {
    issues.push({ id: 'T4', level: '🟡', msg: '第 10 条「未查证项如实登记」说明为空或占位（确实没有就明写「无」）', evidence: `L${n10.line}「${n10.raw.slice(0, 80)}」` });
  }

  const checked = p.items.filter((x) => x.checked).length;
  return {
    unavailable: false, issues, items: p.items,
    counts: { total: p.items.length, checked, unchecked: p.items.length - checked, dropped: p.items.filter((x) => !x.checked).length },
    meta: { blockFound: true, beginLine: p.beginLine, endLine: p.endLine, unclosed: p.unclosed },
  };
}

/**
 * DoR 八条闸门块校验（方案 §3.5 · R1–R3；R4 = 方案过审凭证 + 机器锁二「免方案改生产必须补判据」）。
 * @param {string} md 被检文本（**卡 description** 为主）
 * @param {{strict?: boolean, subject?: string}} [opts]
 *   `strict` = 「生效**时刻**之后的新卡」口径：机器锁二那两条缺项判 **🔴**；缺省/`false` = 存量卡 ⇒ **🟡**（不回扫）。
 *   ⚠️ 严格度由**调用方**按卡 `createdAt` / 档 mtime 与 `NOPLAN_EQUIV_SINCE` 比出（比较器只有一处：
 *      `tools\rulecheck.mjs#cardTimeMs`）—— 本库只判"给的这份文本"，不自己判"该不该查它"（与 `--since` 发现面同一分工）。
 */
export function checkDor(md, opts = {}) {
  const strict = opts.strict === true;
  const issues = [];
  const text = String(md ?? '');
  // R4 方案过审凭证（2026-10-23）：两种痕迹都没有 ⇒ 🔴（与 R1–R3 同档 observe：只报告不拦卡）
  //   ⚠️ 只在**卡面**上有意义；`dor --file` 若拿一份普通档来跑，也会按同一判据报红 —— 如实（发现面由调用方定）
  const plan = checkPlanGate(text);
  const softLevel = strict ? '🔴' : '🟡';
  if (!plan.ok) {
    issues.push({
      id: 'R4', level: '🔴',
      msg: `卡面没有「${PLAN_GATE_PASS_LINE}」凭证行，也没有 ${PLAN_GATE_NO_PLAN} 说明（建卡时没过方案闸 / 老卡未回填 ⇒ 需补凭证或说明为什么不需要方案）`,
      evidence: '全文本扫描未命中两种痕迹（凭证器 = tools\\dsh-butler\\plan-gate.mjs）',
    });
  } else if (plan.hasNoPlan) {
    // 机器锁二（2026-10-23 · 卡「机器锁二」）：免方案可以，**改生产件必须补一条等价判据**
    const prod = plan.production;
    if (!prod.present) {
      issues.push({
        id: 'R4', level: softLevel, sub: 'R4-IMPACT',
        msg: `免方案卡（--no-plan）缺「${NOPLAN_IMPACT_LABEL}」段 ⇒ 没法判"这次到底改没改生产件"（用户要求 2026-10-23：该生产可以免审，但必须补判据）`,
        evidence: `凭证行 L${plan.lineNo || '?'} · 生效时刻 ${NOPLAN_EQUIV_SINCE}（+08:00）之后建的卡按 🔴 报（本份判 ${softLevel}）`,
      });
    } else if (prod.mentionsChange && !prod.hasEquivCommand) {
      issues.push({
        id: 'R4', level: softLevel, sub: 'R4-EQUIV',
        msg: `「${NOPLAN_IMPACT_LABEL}」段声明改了生产件，但同段 / 紧邻一行没有「${NOPLAN_EQUIV_LABEL}node …」（能现跑的命令 + 读数）⇒ 交不出等价证据就不许免审，得回去走方案审核`,
        evidence: `L${prod.line}「${prod.text.slice(0, 100)}」（生效时刻 ${NOPLAN_EQUIV_SINCE}（+08:00）之后按 🔴 报；本份判 ${softLevel}）`,
      });
    }
  }
  const p = parseCheckBlock(text, 'DoR');
  checklistPresence(p, DOR_ITEMS, 'R1', issues);
  if (!p.found) return { unavailable: false, issues, items: [], counts: { total: 0, checked: 0, unchecked: 0 }, meta: { blockFound: false, must: DOR_MUST, plan } };

  // R2 第 1 / 2 / 5 三条必勾（口径原文：缺一不许开工）
  for (const no of DOR_MUST) {
    const it = p.byNo.get(no)?.[0];
    if (it && !it.checked) {
      const name = DOR_ITEMS.find((x) => x.no === no).name;
      issues.push({ id: 'R2', level: '🔴', msg: `第 ${no} 条「${name}」未勾（口径：1 / 2 / 5 缺一不许开工，这三条连"减项"都不许写）`, evidence: `L${it.line}「${it.raw.slice(0, 80)}」` });
    }
  }

  // R3 其余五条未勾 ⇒ 卡面必须写明"哪几条没勾 + 为什么"
  //   两种合法写法（口径档 §9 规则 4）：① 该行说明非空；② 卡面另有一行列出未勾编号
  const saidIds = new Set();
  for (const l of text.split(/\r?\n/)) {
    if (!/未勾/.test(l)) continue;
    for (const m of l.matchAll(/\d{1,2}/g)) { const n = Number(m[0]); if (n >= 1 && n <= DOR_ITEMS.length) saidIds.add(n); }
  }
  const unsaid = [];
  for (const no of DOR_ITEMS.map((x) => x.no).filter((n) => !DOR_MUST.includes(n))) {
    const it = p.byNo.get(no)?.[0];
    if (!it || it.checked) continue;
    const inRow = it.note.trim().length >= 2 && !PLACEHOLDER.test(it.note.trim());
    if (!inRow && !saidIds.has(no)) unsaid.push(no);
  }
  if (unsaid.length) {
    issues.push({ id: 'R3', level: '🟡', msg: `未勾的第 ${unsaid.join(' / ')} 条没写明原因（口径：其余五条未勾时须写清哪几条没勾 + 为什么）`, evidence: `块 L${p.beginLine}~L${p.endLine}` });
  }

  const checked = p.items.filter((x) => x.checked).length;
  return {
    unavailable: false, issues, items: p.items,
    counts: { total: p.items.length, checked, unchecked: p.items.length - checked, unsaid: unsaid.length },
    meta: { blockFound: true, beginLine: p.beginLine, endLine: p.endLine, unclosed: p.unclosed, must: DOR_MUST, unsaid, plan },
  };
}

/** 勾选块的人话摘要（渲染用：`10 条 · 勾 8 / 未勾 2（减项 2）`）。 */
export function checklistLine(result, expected = []) {
  if (!result || !result.meta || !result.meta.blockFound) return '块未找到（无勾选留痕）';
  const c = result.counts;
  const miss = expected.filter((it) => !result.items.some((x) => x.no === it.no)).map((it) => it.no);
  return `${c.total} 条 · 勾 ${c.checked} / 未勾 ${c.unchecked}${miss.length ? ` · 缺号 ${miss.join(',')}` : ''}`;
}

// ---------------------------------------------------------------------------
//  缺陷分级族 / 复盘族 / 惯例对照族（方案 §3.6 / §3.7 / §3.8 · 机制层**第三批**）
//  --------------------------------------------------------------------------
//  载体形态真源（**本文件不另立第二套格式**）：
//    · `docs\口径-工程链条规则总纲-20261014.md` **§10**（缺陷段 / 复盘档 / 惯例对照小节的形态）
//  规矩层真源（本文件只是它们的机器判据，**不改规矩**）：同档 **§3**（P0–P3 + 判 P0 三句）·
//    **§4**（复盘五段 + 缺落点即未复盘）· **§5**（惯例取舍表：抄 / 不抄 / 待定）。
//  三条设计红线（与第一、二批同口径）：
//    ① **缺段 ≠ 判定不可用** —— 缺陷段缺 = "没有缺陷要报"（ℹ️）；复盘段缺 = 结论（🔴）；
//       rc 3 只留给"连档都读不到"；
//    ② 判据全是**确定性**匹配（级别标记 / 段名 / 关键词 / 落点模式），**不判语义**
//       （"这级定得对不对 / 复盘写得深不深 / 惯例选得对不对"永远归人）；
//    ③ **存量不追溯**（发现面由调用方按 `--since` 决定，本库只判"给的这份文本"）。
// ---------------------------------------------------------------------------

export const DEFECT_LEVELS = ['P0', 'P1', 'P2', 'P3'];

/** 判 P0 的三句（真源 = 总纲 §3「判 P0 必须答得出三句 —— 谁受影响 / 影响多广多久 / 有没有替代路」）。 */
export const P0_QUESTIONS = [
  { key: 'who', label: '谁受影响', re: /谁受影响|受影响的是|影响对象|受影响方|影响的是/ },
  { key: 'scope', label: '影响多广多久', re: /影响多广|多广[\s/、和及与]*多久|影响范围|范围|时长|持续|多久/ },
  { key: 'alt', label: '替代路', re: /替代路|有没有替代|替代|绕路|变通|workaround/i },
];

/** 复盘五段（段名照抄总纲 §4 模板表）。 */
export const POSTMORTEM_SECTIONS = [
  { no: 1, name: '时间线' },
  { no: 2, name: '影响' },
  { no: 3, name: '根因' },
  { no: 4, name: '行动项' },
  { no: 5, name: '沉淀' },
];

/**
 * 第 5 段「沉淀」的**具体落点**模式（真源 = §4「进坑库 / 记忆 / 技能 / 技术债台账；**写清落点**；
 * 没落点 = 没复盘」）—— 只收高置信形态：库名 / 路径 / 编号 / 档名。
 */
const PM_LANDING = /坑库|记忆|技能|技术债|台账|SKILL\.md|memory|docs[\\/]|_archive|复盘-|#\d{1,5}\b|D-\d+|\S+\.md/i;

/** 惯例对照小节里的判定词（真源 = §5 判定列「抄了 / 不抄 / 待定」三态）。 */
const PRACTICE_VERDICT = /(?:✅|⛔|⏸|✔|❌)\s*(?:抄|不抄|待定)|抄了|部分抄|不抄|待定|tbd/i;
/** 判定必须带的「理由 / 代价」（真源 = §5 表的「代价」列）。 */
const PRACTICE_REASON = /代价|理由|为什么|权衡|成本/;

/**
 * 行首级别标记。**分两种形态判，别混**（2026-10-15 真档实测踩到）：
 *   · 列表行：`- P0 …` / `- **P0** …` / `- 【P0】…` ⇒ 级别**贴着**列表符号后（正文里提"P0 的定义"不算）；
 *   · 表格行：级别必须是**第一格的全部内容**（`| P0 | 说明 |`）—— 若只要求"行首有 P0"，
 *     报告里 `| P0 额外要求 | … |` 这类**说明表**也会被当成 P0 缺陷条目 ⇒ 假红。
 */
const DEFECT_MARK_LIST = /^\s*[-*+]\s+(?:[*_[(【]*\s*)?P([0-3])\b/;
const DEFECT_MARK_TABLE = /^\s*\|\s*[*_[(【]*\s*P([0-3])\s*[*_\]】]*\s*\|/;
const LIST_ITEM = /^\s*[-*+]\s+\S/;
/**
 * 「本卡无缺陷」这类**声明行**不是缺陷条目（不参与 S1 的"必须带级别标记"）。
 * 为什么要有它（2026-10-15 实现时想到）：报告里写「缺陷段：无」是**合法结论**，
 *   若把 `- 无 P0–P3 缺陷` 当条目 ⇒ 必报 🔴 S1 = 合格的"零缺陷报告"被误判。
 */
const NO_DEFECT_LINE = /无\s*(任何\s*)?缺陷|没有缺陷|零缺陷|无\s*P0\b/;
/**
 * 「缺陷小节标题」的判据（**不是"含『缺陷』二字就算"** —— 2026-10-15 真档实测踩到）：
 *   本卡的交付报告**档名（H1）**里就带"缺陷分级校验"字样 ⇒ 含词即认会把**整份档**当成缺陷段
 *   （实测刷出 62 条假 🔴）。正确口径两条：
 *     ① **只认 2–4 级标题**（H1 通常是档名，不认）；
 *     ② 标题**以"缺陷 / 问题分级 / 已知问题"开头**，或**以它（可带一个小括号括注）结尾**。
 */
const DEFECT_TITLE_HEAD = /^(缺陷|问题分级|已知问题|缺陷清单)/;
const DEFECT_TITLE_TAIL = /(缺陷|问题分级|已知问题)(\s*[（(【][^）)】]{0,16}[）)】])?\s*$/;
/** 去掉标题前的序号 / 装饰（`§7 ` / `7. ` / `三、` / `###` 已由捕获组处理）。 */
const stripTitlePrefix = (t) => String(t).replace(/^[\s§#]*[\d.]*[\s、,.:：)）(（【】\-—]*\s*/, '');
/** 档内标题行（`#` 开头）—— 用于切小节 / 切段落。 */
const HEAD_ATX = /^(\s*)(#{1,6})\s*(.+?)\s*$/;

export const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 找「缺陷段」：锚点优先（`<!-- Defect:begin/end -->`），否则按小节标题认（工具会标注依据）。 */
function findDefectSection(lines) {
  let b = -1; let e = -1;
  for (let i = 0; i < lines.length; i++) {
    if (b < 0 && /<!--\s*Defect:begin\s*-->/i.test(lines[i])) { b = i; continue; }
    if (b >= 0 && /<!--\s*Defect:end\s*-->/i.test(lines[i])) { e = i; break; }
  }
  if (b >= 0) {
    const end = e < 0 ? lines.length : e;
    return {
      by: 'anchor', anchorFound: true, unclosed: e < 0, title: 'Defect 锚点',
      beginLine: b + 1, endLine: e < 0 ? lines.length : e + 1, bodyStart: b + 2, body: lines.slice(b + 1, end),
    };
  }
  for (let i = 0; i < lines.length; i++) {
    const m = HEAD_ATX.exec(lines[i]);
    if (!m) continue;
    if (m[2].length < 2) continue;                       // ① H1 = 档名，不认（防"档名带缺陷 ⇒ 整档被当缺陷段"）
    const title = plain(m[3]);
    const t = stripTitlePrefix(title);
    if (!DEFECT_TITLE_HEAD.test(t) && !DEFECT_TITLE_TAIL.test(t)) continue;   // ② 标题须"以缺陷词开头 / 结尾"
    const lvl = m[2].length;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const m2 = HEAD_ATX.exec(lines[j]);
      if (m2 && m2[2].length <= lvl) { end = j; break; }
    }
    return { by: 'heading', anchorFound: false, unclosed: false, title, beginLine: i + 1, endLine: end, bodyStart: i + 2, body: lines.slice(i + 1, end) };
  }
  return null;
}

/**
 * 缺陷分级校验（方案 §3.6 · 判据 S1–S3）。
 * @param {string} md 被检文本（**交付报告**「缺陷」小节 / **卡 description** 缺陷行）
 */
export function checkDefect(md) {
  const text = String(md ?? '');
  const lines = text.split(/\r?\n/);
  const issues = [];
  const sec = findDefectSection(lines);
  if (!sec) {
    return {
      unavailable: false,
      issues: [{
        id: 'S1', level: 'ℹ️',
        msg: '全档没有「缺陷」小节（= 没有缺陷要报；真要有缺陷，按总纲 §10.1 写 `### 缺陷（分级 P0–P3）`）',
        evidence: '未命中小节标题 / 锚点',
      }],
      entries: [], counts: { total: 0, byLevel: {}, p0: 0 }, meta: { sectionFound: false },
    };
  }
  if (sec.unclosed) {
    issues.push({ id: 'S1', level: '🟡', msg: '缺陷段只有 begin 没有 end（锚点未闭合，按"到档尾"解析）', evidence: `块首 L${sec.beginLine}` });
  }

  const entries = [];
  sec.body.forEach((l, k) => {
    const line = sec.bodyStart + k;
    const inTable = /^\s*\|/.test(l);
    if (inTable) {
      if (isSepLine(l)) return;
      const next = sec.body[k + 1];
      if (next && isSepLine(next)) return;   // 表头行不是缺陷条目
    }
    const isList = LIST_ITEM.test(l);
    if (!inTable && !isList) return;
    // 「无缺陷」声明行不是缺陷条目（否则"零缺陷报告"必被误判 🔴 S1）
    if (!inTable && NO_DEFECT_LINE.test(plain(l))) return;
    const m = inTable ? DEFECT_MARK_TABLE.exec(l) : DEFECT_MARK_LIST.exec(l);
    if (inTable && !m) return;   // 表格里**第一格不是级别** ⇒ 这不是缺陷行（说明表不算条目）
    entries.push(m
      ? { level: `P${m[1]}`, line, text: plain(l), raw: l.trim() }
      : { level: null, line, text: plain(l), raw: l.trim() });
  });

  // S1 每条缺陷行必须带级别标记（P0–P3）—— **合并报一条**（防"段里 N 行没级别 ⇒ 刷 N 条 🔴"）
  const noLevel = entries.filter((e) => !e.level);
  if (noLevel.length) {
    issues.push({
      id: 'S1', level: '🔴',
      msg: `缺陷段里 ${noLevel.length} 行没有级别标记（P0–P3）—— 每条缺陷行都要以级别开头`,
      evidence: noLevel.slice(0, 5).map((e) => `L${e.line}「${e.text.slice(0, 40)}」`).join(' ')
        + (noLevel.length > 5 ? ` …（另 ${noLevel.length - 5} 行）` : ''),
    });
  }

  const p0s = entries.filter((e) => e.level === 'P0');
  for (const e of p0s) {
    // S2 判 P0 必须答得出三句（缺哪句点名）—— 口径原文：答不上来 ⇒ 降到 P1
    const missing = P0_QUESTIONS.filter((q) => !q.re.test(e.text)).map((q) => q.label);
    if (missing.length) {
      issues.push({
        id: 'S2', level: '🟡',
        msg: `标 P0 但没答全三句（缺「${missing.join('」/「')}」）—— 口径：答不上来就降到 P1`,
        evidence: `L${e.line}「${e.text.slice(0, 70)}」`,
      });
    }
    // S3 标 P0 的行必须指向一份复盘（§3.7 / §10.2）
    if (!/复盘/.test(e.text)) {
      issues.push({ id: 'S3', level: '🟡', msg: '标 P0 但没有指向任何复盘档（口径：P0 修完必须出复盘）', evidence: `L${e.line}「${e.text.slice(0, 70)}」` });
    } else if (!/复盘[^\s|]{0,60}?\.md|复盘档\s*[:：]|docs[\\/]复盘/.test(e.text)) {
      issues.push({ id: 'S3', level: '🟡', msg: '提了复盘但没给档名 / 落点（写成 `docs\\复盘-<主题>-<日期>.md` 才算对上）', evidence: `L${e.line}「${e.text.slice(0, 70)}」` });
    }
  }

  const byLevel = {};
  for (const e of entries) { const k = e.level || '(无级别)'; byLevel[k] = (byLevel[k] || 0) + 1; }
  return {
    unavailable: false, issues, entries,
    counts: { total: entries.length, byLevel, p0: p0s.length },
    meta: { sectionFound: true, by: sec.by, anchorFound: sec.anchorFound, unclosed: sec.unclosed, beginLine: sec.beginLine, endLine: sec.endLine, title: sec.title },
  };
}

/**
 * 复盘档校验（方案 §3.7 · 判据 **P2 / P3**；P1 是覆盖度，见 checkPostmortemCoverage）。
 * @param {string} md 被检文本（`docs\复盘-<主题>-<日期>.md`）
 */
export function checkPostmortem(md) {
  const text = String(md ?? '');
  const lines = text.split(/\r?\n/);
  const issues = [];
  const sections = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEAD_ATX.exec(lines[i]);
    if (!m) continue;
    const title = plain(m[3]);
    for (const s of POSTMORTEM_SECTIONS) {
      if (sections.some((x) => x.no === s.no)) continue;
      if (title.includes(s.name)) sections.push({ no: s.no, name: s.name, line: i + 1, title });
    }
  }
  const missing = POSTMORTEM_SECTIONS.filter((s) => !sections.some((x) => x.no === s.no)).map((s) => s.no);
  if (missing.length === POSTMORTEM_SECTIONS.length) {
    issues.push({
      id: 'P2', level: '🔴',
      msg: '五段标题一个都没有（这份档不像复盘档 / 没按总纲 §4 模板写：时间线 · 影响 · 根因 · 行动项 · 沉淀）',
      evidence: '全档扫描未命中任何段名',
    });
  } else {
    for (const no of missing) {
      const s = POSTMORTEM_SECTIONS.find((x) => x.no === no);
      issues.push({ id: 'P2', level: '🔴', msg: `缺第 ${no} 段「${s.name}」`, evidence: `已有段：${sections.map((x) => x.name).join(' / ')}` });
    }
  }

  // P3 第 5 段「沉淀」必须写清落点（口径原文：没落点 = 没复盘）
  const sec5 = sections.find((x) => x.no === 5);
  let landing = '';
  if (sec5) {
    let end = lines.length;
    for (let j = sec5.line; j < lines.length; j++) { if (HEAD_ATX.test(lines[j])) { end = j; break; } }
    landing = lines.slice(sec5.line, end).join('\n').trim();
    if (!landing) {
      issues.push({ id: 'P3', level: '🔴', msg: '第 5 段「沉淀」是空的（口径：没落点 = 没复盘）', evidence: `L${sec5.line}` });
    } else if (!PM_LANDING.test(landing)) {
      issues.push({
        id: 'P3', level: '🔴',
        msg: '第 5 段「沉淀」里找不到具体落点（坑库 / 记忆 / 技能 / 技术债台账的路径或编号）—— 只写"下次注意"不算复盘',
        evidence: `L${sec5.line}「${plain(landing).slice(0, 70)}」`,
      });
    }
  }

  const hasLanding = !!landing && PM_LANDING.test(landing);
  return {
    unavailable: false, issues, sections, missing,
    counts: { sections: sections.length, missing: missing.length, landing: sec5 ? (hasLanding ? '有落点' : '无落点') : '(无第5段)' },
    meta: { sectionNames: sections.map((x) => x.name), beginLine: sections.length ? sections[0].line : null },
  };
}

/**
 * P1 复盘覆盖度：**有 P0 却对不上一份复盘档 ⇒ 🟡**（方案 §3.7 P1 · 口径：P0 修完必须出复盘）。
 * @param {Array<{label:string, source?:string, cardId?:string, id?:string, key?:string}>} p0s 触发源（checkDefect 抽出的 P0）
 * @param {Array<{file:string, text:string}>} pmDocs 已在位的复盘档
 */
export function checkPostmortemCoverage(p0s, pmDocs) {
  const issues = [];
  const missing = [];
  for (const p of p0s) {
    const keys = [p.source, p.cardId, p.id, p.key].filter(Boolean).map(String);
    const hit = keys.length ? pmDocs.find((d) => keys.some((k) => new RegExp(escapeRe(k), 'i').test(d.text))) : null;
    if (!hit) missing.push({ ...p, keys });
  }
  for (const m of missing) {
    issues.push({
      id: 'P1', level: '🟡',
      msg: `触发源「${m.label}」标了 P0，但没有一份复盘档对得上它（口径：P0 修完必须出复盘）`,
      evidence: m.keys.length ? `比对键：${m.keys.join(' / ')}` : '触发源没给可比对的标识（未查证）',
    });
  }
  return { issues, p0: p0s.length, covered: p0s.length - missing.length, missing };
}

/**
 * 惯例对照校验（方案 §3.8 · 判据 I1–I2）。
 * ⚠️ **发现面由调用方定**（缺省 = 生效日之后**新增**的 `docs\方案-*.md`；**存量不追溯**）
 *    —— 本函数只判"给的这份文本"。
 * ⚠️ **小节识别是"符合形态才认"，不是"取第一个含『惯例』的标题"**（2026-10-15 真档实测踩到）：
 *    方案档里"讲惯例对照机制"的段落（如 §3.8「惯例对照提醒（…的机制化）」）**先于**真正的
 *    惯例对照小节（§5.6）出现 ⇒ 取第一个必然选错小节（实测：选中 §3.8、把它当合格小节）。
 *    正确口径 = 符合形态的小节才认：① 标题含「惯例」② 小节内有**表格** ③ 表内有「抄 / 不抄 / 待定」判定词。
 * @param {string} md 被检文本（新方案档 / 新功能需求档）
 */
export function checkPractice(md) {
  const text = String(md ?? '');
  const lines = text.split(/\r?\n/);
  const issues = [];
  const cands = [];
  for (let i = 0; i < lines.length; i++) {
    const m = HEAD_ATX.exec(lines[i]);
    if (!m) continue;
    const title = plain(m[3]);
    if (!/惯例/.test(title) && !(/业界|行业/.test(title) && /对照|做法|实践|取舍/.test(title))) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const m2 = HEAD_ATX.exec(lines[j]);
      if (m2 && m2[2].length <= m[2].length) { end = j; break; }
    }
    const body = lines.slice(i + 1, end);
    cands.push({
      title, line: i + 1, body: body.join('\n'),
      hasTable: body.some((l) => isTableLine(l)),
      hasVerdict: PRACTICE_VERDICT.test(body.join('\n')),
    });
  }
  const good = cands.find((c) => c.hasTable && c.hasVerdict);
  if (!good) {
    const withTable = cands.find((c) => c.hasTable);
    if (withTable) {
      issues.push({ id: 'I2', level: '🟡', msg: '惯例对照小节里没有「抄 / 不抄 / 待定」判定（口径：每个惯例都要有判定）', evidence: `L${withTable.line}「${withTable.title}」` });
    } else {
      issues.push({
        id: 'I1', level: '🟡',
        msg: '档里没有（符合形态的）「行业惯例对照」小节 —— 口径：提新想法 / 新功能 / 新流程 / 新方向前先给业界对照，判定要落在表里',
        evidence: cands.length
          ? `只找到讲机制的段落（L${cands[0].line}「${cands[0].title}」），里面没有惯例判定表`
          : '全档扫描未命中含「惯例」的小节标题',
      });
    }
    return { unavailable: false, issues, meta: { sectionFound: false, candidates: cands.length }, counts: { verdicts: 0, hasReason: false } };
  }
  const verdicts = (good.body.match(new RegExp(PRACTICE_VERDICT.source, 'gi')) || []).length;
  const hasReason = PRACTICE_REASON.test(good.body);
  if (!hasReason) {
    issues.push({ id: 'I2', level: '🟡', msg: '惯例对照小节里没有理由 / 代价（口径：判定要带代价）', evidence: `L${good.line}「${good.title}」` });
  }
  return {
    unavailable: false, issues,
    meta: { sectionFound: true, title: good.title, line: good.line, candidates: cands.length },
    counts: { verdicts, hasReason },
  };
}

// ---------------------------------------------------------------------------
//  第五批：六包回写「可判的一半」（R-054 · 2026-10-22 · observe 档）
//  --------------------------------------------------------------------------
//  真源 = `docs\交付报告-V3功能面-待核7条定性-20261022.md` §4（现核结论）+ §8 待拍板表第 4 行。
//  需求原文自己承认「该回写没回写机器难判」（要判"谁引用了这个事实"得先有事实指纹）⇒
//    本族只做**可判的那一半**：输入 = 改了哪份口径档 ⇒ 输出 =「该扫什么（关键词）+ 扫到谁（引用面）」；
//    四类处置（A 就地订正 / B 历史件加头指针 / C 判定不改+理由 / D 待主人）**机器不填**，
//    只出空表 —— 逼人出表，不判人语义（**处置列为空是设计，不是没实现**）。
//  纪律：
//    ① observe 档：只报告 · 不拦卡 · 不发通知 · 不改开关 · **不追溯存量**
//    ② 关键词全机械抽取（标题实词 / 档内路径 / 编号与口径词 / `--kw` 人工追加），**不上语义模型**
//    ③ 行号**真去 grep**（整篇小写后 indexOf + 行首偏移二分定位），不许只报文件名糊弄
//    ④ 本库仍**零 IO**：走目录 / 读文件全在调用方（CLI），本库只判"给的这份文本"
// ---------------------------------------------------------------------------

export const SIXPACK_VERSION = '0.1.0';

/** 四类处置（**机器不填这一列** —— 人来判；口径真源 = 六包纪律）。 */
export const SIXPACK_DISPOSITIONS = [
  { code: 'A', name: '就地订正', hint: '碰到的旧档就地加一行订正注（只标注、不改原文），真源指向新档' },
  { code: 'B', name: '历史件加头指针', hint: '历史 / 归档件在头部加指针，指向现行真源' },
  { code: 'C', name: '判定不改', hint: '确认此处不需要改，写清理由（并留真源出处）' },
  { code: 'D', name: '待主人', hint: '要主人拍板才能动 —— 登记进报告的待拍板表，不攒成清单' },
];

/**
 * 「口径词」（泛词）词表 —— 只在被检档里**真出现**时才算关键词，且一律标 `generic`
 * （区分度低：命中面天然很宽，只做**抽样**提示，不进待填表，免得把表灌满）。
 */
export const SIXPACK_GENERIC_WORDS = ['口径', '判据', '回写', '六包', '验收', '红线', '封版', '技术债', '需求清单', '交付报告', '交接档', '方案档'];

/** 抽取与命中的上限（`--limit` 只改 `hits`；其余是防"关键词爆炸"的硬帽，超了如实打印）。 */
export const SIXPACK_LIMITS = {
  keywords: 60, titles: 24, paths: 12, codes: 12, sections: 6, generic: 8, manual: 20, hits: 30,
};

/**
 * 标题切词的**结构分隔集**（**不切 `-`**，否则 `R-054` / `V3.0.0` / 日期全被切碎；**也不切空格** ——
 * 中文标题里的空格多用来隔数字 / emoji（「留 V3.1.0 的 11 条」「🔴 本版应做但「无卡」的 13 条」），
 * 按空格切必出「留」「的 11 条」这类残片）。
 */
const KW_SPLIT_STRUCT = /[、，,；;：:（）()【】\[\]{}「」『』《》<>|/\\+*_`~"'“”‘’·•—–=…]+/;

/** 残片收尾：掐掉 token 首尾的虚词 / 标点 / emoji（「本版应做但」→「本版应做」）。 */
const KW_EDGE = /^[的了和与及或是在对从到这那但而且并其等为把被也就才又还已\s.,;:，。；：、!?！？\-—–·"'“”‘’【】\[\]（）()…]+|[的了和与及或是在对从到这那但而且并其等为把被也就才又还已\s.,;:，。；：、!?！？\-—–·"'“”‘’【】\[\]（）()…]+$/g;

/** 标题切出来的"虚词/过程词"—— 命中面必宽，收了只会制造噪音。 */
const KW_STOP = new Set([
  '的', '了', '和', '与', '及', '以及', '或', '等', '为', '是', '把', '被', '在', '对', '从', '到', '这', '那', '本', '份', '条', '个', '项',
  '其中', '如下', '以上', '以下', '注意', '备注', '小结', '结论', '现状', '补充', '说明', '问题', '内容', '其他', '同时', '因此', '所以', '但是', '并且',
  '汇总', '一句话', '怎么', '什么', '为什么', '要不要', '能不能', '有没有', '可以', '需要', '一个', '两个', '三个', '一份', '两份', '三份', '全部', '所有', '部分',
  '主人', '用户要求', '助手', '本卡', '本次', '本版', '本档', '当次', '今天', '明天', '昨天', '日期', '附录', '参考', '正文', '头部', '尾部', '一览', '速查', '表格', '清单', '字段', '一句话结论',
]);

/** 路径类关键词的四种抽取形态（绝对路径 / 反引号文件名 / 相对目录路径 / 裸文件名）。 */
const KW_PATH_RES = [
  { re: /[A-Za-z]:\\(?:[^\s`"'|<>，。；：、）)]*\\)?[^\s`"'|<>，。；：、）)]+/g, label: '绝对路径' },
  { re: /`([^`\n]{1,200}?\.(?:md|mjs|cjs|js|ps1|cmd|bat|json|ya?ml))`/g, label: '反引号文件名' },
  { re: /\b(?:docs|tools|lib|_archive|generated|skills|apps|src)[\\/][^\s`"'|<>，。；：、）)]+/g, label: '相对路径' },
  { re: /[\u4e00-\u9fffA-Za-z0-9_.\-]+\.(?:md|mjs|cjs|ps1|cmd|bat|json|ya?ml)\b/g, label: '裸文件名' },
];

/** 一个标题 token 值不值得当关键词（机械判，讲得出理由）。 */
function kwTokenUsable(tok) {
  const t = String(tok ?? '').replace(/^[.,;:，；：、]+|[.,;:，；：、]+$/g, '').trim();
  if (!t || t.length > 40) return false;
  if (KW_STOP.has(t)) return false;
  if (/^[\d.\-—–/]+$/.test(t)) return false;              // 纯数字 / 版本碎片 / 日期片段
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return false;
  if (/^R-\d{3}$/i.test(t)) return false;                 // 编号走 code 抽取（有限帽）
  if (/^[§#]+/.test(t)) return false;
  if (CJK.test(t)) return (t.match(/[\u4e00-\u9fff]/g) || []).length >= 2;
  return /^[A-Za-z][A-Za-z0-9._\-]{2,}$/.test(t);
}

/** 标题 → 去编号 / 去装饰 / 去括号补注后的干净文本（括号里多是日期·会话·备注，收了必是噪音）。 */
function cleanHeading(raw) {
  let s = String(raw ?? '').replace(/[*_`~]/g, '').trim();
  s = s.replace(/^[§#\s]*(?:\d+(?:\.\d+)*[.、)）]?\s*)+/, '');   // `1.` / `1.1` / `§4`
  s = s.replace(/^\s*R-\d{3}\s*/, '');                          // 开头的 R-0xx
  s = s.replace(/[（(][^（()）]*[）)]/g, ' ');                    // 括号补注整段丢
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * 从一份口径档里**机械抽取**关键词（纯函数 · 零 IO · 不上语义模型）。
 * 四类来源：档内路径 / 编号（R-0xx，按出现次数取前 N） / 标题实词短语（H1–H3） / 口径泛词；外加 `--kw` 人工。
 * @param {string} md 被检文本（改了的那份口径档）
 * @param {{extra?:string[], limits?:object}} [opts]
 * @returns {{keywords:Array, byKind:object, dropped:object, meta:object}}
 *          keywords 元素：`{ kw, kind, weight, generic, sources[] }`
 */
export function extractSixpackKeywords(md, opts = {}) {
  const text = String(md ?? '');
  const lines = text.split(/\r?\n/);
  const caps = { ...SIXPACK_LIMITS, ...(opts.limits || {}) };
  const byKw = new Map();
  const kindCount = { self: 0, manual: 0, path: 0, code: 0, title: 0, section: 0, generic: 0 };
  const dropped = { keywords: [], manual: [], path: [], code: [], title: [], section: [], generic: [] };
  const order = { self: 8, manual: 10, path: 6, code: 4, title: 3, section: 1, generic: 1 };
  const kindCap = { self: 1, manual: caps.manual, path: caps.paths, code: caps.codes, title: caps.titles, section: caps.sections, generic: caps.generic };

  const add = (kw, kind, source) => {
    const k = String(kw ?? '').replace(/\s+/g, ' ').trim();
    if (!k || k.length > 60) return;
    const prev = byKw.get(k);
    if (prev) { if (source && !prev.sources.includes(source)) prev.sources.push(source); return; }
    if (byKw.size >= caps.keywords) { dropped.keywords.push(k); return; }
    if (kindCount[kind] >= kindCap[kind]) { dropped[kind].push(k); return; }
    kindCount[kind] += 1;
    byKw.set(k, { kw: k, kind, weight: order[kind] || 1, generic: kind === 'generic' || kind === 'section', sources: source ? [source] : [] });
  };

  // ① 输入档**自己的文件名** —— 这是"这个事实"最硬的一枚指纹（别人引用这份口径档时写的就是这个名字）
  if (opts.file) {
    const base = String(opts.file).split(/[\\/]/).pop();
    if (base) add(base, 'self', '输入档自身文件名');
  }

  // ② 人工追加（高优）
  for (const x of (opts.extra || [])) add(x, 'manual', '人工 --kw');

  // ② 档内路径 / 文件名（取 basename —— 别人引用这个事实时，写的就是这个名字）
  const pathHits = [];
  for (const { re, label } of KW_PATH_RES) {
    for (const m of text.matchAll(re)) {
      const raw = String(m[1] || m[0] || '').replace(/[.,;:，；：、)）】\]]+$/, '');
      const base = raw.split(/[\\/]/).pop();
      if (!base || base.length < 5 || base.length > 80) continue;
      if (!/\.[A-Za-z0-9]{2,5}$/.test(base)) continue;
      pathHits.push({ base, label, at: m.index ?? 0 });
    }
  }
  pathHits.sort((a, b) => a.at - b.at);
  for (const h of pathHits) add(h.base, 'path', `档内${h.label}`);

  // ③ 编号（R-0xx）：按出现次数降序取前 N，超出如实登记（其余可用 --kw 追加）
  const codeFreq = new Map();
  for (const m of text.matchAll(/\bR-\d{3}\b/g)) codeFreq.set(m[0], (codeFreq.get(m[0]) || 0) + 1);
  const codes = [...codeFreq.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [k, n] of codes) add(k, 'code', `编号（档内出现 ${n} 次）`);

  // ④ 小节号（§x.y）—— 区分度低，归到抽样区
  const secSeen = new Set();
  for (const m of text.matchAll(/§\s?\d+(?:\.\d+)*/g)) {
    const k = m[0].replace(/\s+/g, '');
    if (secSeen.has(k)) continue;
    secSeen.add(k);
    add(k, 'section', '小节号');
  }

  // ⑤ 标题实词短语（H1–H3）：整条标题（够精）+ 切出来的实词
  const heads = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(#{1,6})\s+(.+?)\s*$/.exec(lines[i]);
    if (!m || m[1].length > 3) continue;
    heads.push({ level: m[1].length, line: i + 1, raw: m[2], clean: cleanHeading(m[2]) });
  }
  for (const h of heads) {
    if (!h.clean) continue;
    const src = `标题 L${h.line}（${'#'.repeat(h.level)}）`;
    if (CJK.test(h.clean) && h.clean.length >= 4) add(h.clean, 'title', src);
    for (const tok of h.clean.split(KW_SPLIT_STRUCT)) {
      const t = String(tok).replace(KW_EDGE, '').trim();   // 掐掉首尾虚词 / 标点 / emoji
      if (kwTokenUsable(t)) add(t, 'title', src);
    }
  }

  // ⑥ 口径泛词（只收"档里真出现"的）
  for (const w of SIXPACK_GENERIC_WORDS) if (text.includes(w)) add(w, 'generic', '口径词（档内出现）');

  const keywords = [...byKw.values()].sort((a, b) => b.weight - a.weight || b.kw.length - a.kw.length);
  return {
    keywords,
    byKind: kindCount,
    dropped,
    meta: {
      headings: heads.length,
      total: keywords.length,
      droppedKeywords: dropped.keywords.length,
      droppedByKind: Object.fromEntries(Object.entries(dropped).filter(([k, v]) => k !== 'keywords' && v.length).map(([k, v]) => [k, v.length])),
      genericCount: keywords.filter((k) => k.generic).length,
    },
  };
}

/**
 * 在一份文本里找这些关键词的命中位置（**逐处给真实行号**）。
 * 两条纪律（都是 2026-10-22 真档实测逼出来的）：
 *  ① 泛词（generic / 小节号）**只计数、不记行** —— 「口径」「判据」这类词在 4600 份档里能命中 8 万处，
 *     逐处记行只会把 JSON 撑到十几 MB、把待填表灌满；它们天生区分度低，给「命中数 + 涉及份数」足够。
 *  ② 具体关键词按**跨文件总量**封顶（`acct.kept` 由调用方持有并跨文件传递）—— 单关键词最多记 `limit` 处，
 *     但**命中总数照实累计**（截断要报出来，不许假装"就这么多"）。
 * @param {string} file 该文本的文件路径（原样写进 refs，便于人回查）
 * @param {string} text 该文本内容
 * @param {Array} keywords `extractSixpackKeywords()` 的产出
 * @param {{limit?:number, acct?:{kept:object}}} [opts]
 * @returns {{refs:Array, counts:object}} refs 元素：`{ file, line, keyword, kind, generic:false, disposition:null }`
 */
export function matchSixpackInText(file, text, keywords, opts = {}) {
  const src = String(text ?? '');
  const low = src.toLowerCase();
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : SIXPACK_LIMITS.hits;
  const acct = opts.acct && opts.acct.kept ? opts.acct : { kept: {} };
  // 行首偏移表（一次建好）：命中位置 → 行号用二分，**不靠子串再数一遍**
  const lineStarts = [0];
  for (let i = 0; i < low.length; i++) if (low.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (pos) => {
    let lo = 0; let hi = lineStarts.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (lineStarts[mid] <= pos) lo = mid; else hi = mid - 1; }
    return lo + 1;
  };
  const refs = [];
  const counts = {};
  for (const k of (keywords || [])) {
    const needle = String(k.kw || '').toLowerCase();
    if (!needle) continue;
    const cap = k.generic ? 0 : limit;          // 泛词 cap=0 ⇒ 只计数
    let hits = 0; let from = 0; let at;
    while ((at = low.indexOf(needle, from)) >= 0) {
      hits += 1; from = at + needle.length;
      if (acct.kept[k.kw] === undefined) acct.kept[k.kw] = 0;
      if (acct.kept[k.kw] < cap) {
        acct.kept[k.kw] += 1;
        refs.push({ file, line: lineOf(at), keyword: k.kw, kind: k.kind, generic: false, disposition: null });
      }
    }
    if (hits) counts[k.kw] = hits;
  }
  return { refs, counts };
}

/**
 * 待填表的一行（**处置格恒为 null/空** —— 机器不填这一列）。
 * 只收**具体关键词**的命中（泛词 / 宽词已按 `generic` / `exclude` 剔出，另块提示）；
 * 每关键词最多 `limit` 行（超出记进 `truncatedKeywords`，不静默丢）。
 * @param {Array} refs `matchSixpackInText()` 或跑完全库后聚合的命中
 * @param {{limit?:number, exclude?:Set<string>|string[]}} [opts]
 */
export function sixpackTableRefs(refs, opts = {}) {
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? opts.limit : SIXPACK_LIMITS.hits;
  const exclude = opts.exclude instanceof Set ? opts.exclude : new Set(opts.exclude || []);
  const keptByKw = {};
  const truncated = new Set();
  const out = [];
  const sorted = [...(refs || [])]
    .filter((r) => !r.generic && !exclude.has(r.keyword))
    .sort((a, b) => String(a.file).localeCompare(String(b.file)) || a.line - b.line);
  for (const r of sorted) {
    const n = keptByKw[r.keyword] || 0;
    if (n >= limit) { truncated.add(r.keyword); continue; }
    keptByKw[r.keyword] = n + 1;
    // ⚠️ `matchSixpackInText()` 产出的 ref 已带 `disposition:null` ⇒ **原样返回（保持对象同一性）**，
    //    调用方才能用 index 反查（2026-10-22 实测踩到：这里 {...r} 复制一份 ⇒ 调用方 Map 反查全 miss ⇒ 表空）
    out.push(r.disposition === null ? r : { ...r, disposition: null });
  }
  return { rows: out, truncatedKeywords: [...truncated], perKeyword: keptByKw };
}
