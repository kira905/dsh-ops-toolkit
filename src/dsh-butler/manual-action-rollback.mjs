#!/usr/bin/env node
// dsh-butler / manual-action-rollback.mjs —— 手动动作的**备用回滚脚本真身**（D 域）
//
// 卡：「【冲刺600·D域】备用回滚脚本真身：写 manual-action-rollback.mjs + 每动作输出校验 + 单测」
// 缺口真源：`docs\交付报告-冲刺600-P域余与D域取证-20261010.md` §4 —— 实测 `lib\manual-actions.mjs`
//   的动作里 **4 个的 rollback 文案指着一个全库 0 命中的 `manual-action-rollback.mjs`**
//   （出事时照文案跑 = `Cannot find module`）⇒ 本文件把「看着有兜底」变成「真能回滚」。
//
// 用法：
//   node <pkg>/src/dsh-butler/manual-action-rollback.mjs --correlation <id>              # 缺省 dry-run（零写入）
//   node <pkg>/src/dsh-butler/manual-action-rollback.mjs --correlation <id> --apply      # 真回滚
//   node ...\manual-action-rollback.mjs --correlation <id> --apply --allow-production       # ⚠️ 打生产树必须显式放行（R-060）
//   node <pkg>/src/dsh-butler/manual-action-rollback.mjs --correlation <id> --json       # 机读（stdout 纯 JSON）
//   node <pkg>/src/dsh-butler/manual-action-rollback.mjs --correlation <id> --home <dir> # 覆盖 ~/.dsh（夹具/沙箱）
//   可选：--audit-dir <dir> · --board-url <url> · --to-card-mode archive|delete · --reason <备注>
//
// 行为（**只认审计原文，不猜**）：
//   ① 从 `<home>\butler-audit\*.jsonl` 找 `component=butler-manual-action` 且 `correlationId` 相符的记录；
//   ② 取**真执行**那条（dryRun=false）作为回滚依据；
//   ③ 按 actionId 反向做掉该动作（**旧值优先读审计的结构化 `rollbackData`，读不到才回落解析文案**）：
//        card-nudge        ⇒ 删掉 description 里那一行催办备注（rollbackData.nudgeLine 精确整行匹配；旧记录回落「行首前缀+审计日期」）
//        card-reschedule   ⇒ cron / enabled 改回审计里的旧值（rollbackData.{cron,enabled}；旧记录回落解析 rollbackScript 文案）
//        upgrade-precheck  ⇒ 删掉审计 outputs 记的报告文件（大小需与审计一致）
//        session-to-card   ⇒ 归档/删掉本动作建的那张卡（rollbackData.cardId 定位；旧记录回落 description 标记）
//        p4-candidate-*    ⇒ 转调既有 CLI `mark-p4-adopted.mjs --rollback <报告> [--apply]`
//        card-retry        ⇒ 注册表声明 reversible:false ⇒ 退出码 3（不是错误，是设计如此）
//   ④ 每个动作输出**回滚后校验**（目标字段值 / 文件存在性与字节+sha / 卡状态）。
//
// 四道硬口径（改这里前先读卡）：
//   ① **fail-closed**：审计里找不到 correlation、或"反向所需的旧值"缺失 ⇒ 拒绝执行并明确报错（**不许猜**）。
//   ② **幂等**：同一 correlation 重复跑 ⇒ 明确报「已回滚 / 无需回滚」，不报错、不重复动作。
//   ③ **缺省即 dry-run**，真执行必须显式 `--apply`（生态规矩）。dry-run **零写入**（不 dispatch、不删改文件、
//      不落审计；P4 那条会 spawn CLI 的 `--dry-run` 档取"将写什么"，**仍零写盘**）。
//   ④ Node 收尾一律 `process.exitCode`（发过 fetch 的进程强退会概率性崩 `UV_HANDLE_CLOSING`）。
//
// 退出码：0 = 已回滚 / 已回滚过（幂等）/ 无需回滚 ／ 1 = 执行出错 ／ 2 = 拒绝（用法错 / 缺 correlation / fail-closed）
//         ／ 3 = 该动作声明不可回滚（reversible:false）
//
// 已知边界（如实写，别当没有）：
//   · **旧审计行没有 `rollbackData`**（2026-10-10 之前落的）⇒ 走下面的「文案 / 标记兜底」路径，行为与上一版**一字不差**；
//     2026-10-10 起 `lib\manual-actions.mjs` 的真执行记录会带结构化旧值（改期 {cron,enabled} · 转卡 {cardId} ·
//     催办 {nudgeLine,taskId} · 预检 {reportFile,bytes}）⇒ 本脚本**优先读它**，读不到才回落。
//   · `card-reschedule` 的**旧记录**旧值只能从 `rollbackScript` 文案里解析 —— 解析不到一律拒绝。
//   · `session-to-card` 的**旧记录**审计里没有卡 id ⇒ 靠 description 里的
//     「大管家一键转卡：疑似中断会话 <sid>」标记定位；命中 0 张 = 已回滚，命中 >1 张 = 拒绝（不猜）。
//   · `card-nudge` 的**旧记录**没记戳记内容 ⇒ 命中多行时按审计时间戳的当日日期挑；挑不出唯一一条 = 拒绝。
//   · `p4-*` 的 CLI `--rollback` 自 2026-10-10 起**有 dry-run 档**（缺省 dry-run）⇒ 本脚本 dry-run 分支会带
//     `--dry-run` 真调它取计划（零写盘）；apply 分支带 `--apply` 真回写。CLI 探针失败只降级为"只打印命令"，**不写盘**。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { appendAudit } from './lib/audit.mjs';
import { COMPONENT_ROOT } from './lib/paths.mjs';
import { makeBoardClient, localDayKey } from './lib/manual-actions.mjs';
import { resolveStatePath } from './lib/state-paths.mjs';
// R-060 隔离闸（2026-10-16 接入）：本脚本缺省 home = 生产 `~/.dsh`，真回滚会删/改生产文件 + 写生产审计 ⇒
//   `--apply` 打生产树必须显式 `--allow-production`（判据与文案见 `tools\lib\production-guard.mjs` 头注）。
import { gateProductionWrite, refuseLine } from '../lib/production-guard.mjs';

export const ROLLBACK_VERSION = '0.1.0';
/** 催办备注的行首标记（与 `lib\manual-actions.mjs#execCardNudge` 的 stamp 前缀**必须一致**）。 */
export const NUDGE_PREFIX = '⏰ 大管家催办';
/** 转卡建卡时 description 的固定开头（与 `lib\manual-actions.mjs#execSessionToCard` 的 desc 同源）。 */
export const TOCARD_MARKER = '大管家一键转卡：疑似中断会话';
/** 候选池写入器（既有 CLI；回滚走它的 `--rollback` 分支）。realpath 兜住 junction 场景。 */
export const P4_CLI = path.join(COMPONENT_ROOT, 'mark-p4-adopted.mjs');

export const EXIT = Object.freeze({ OK: 0, ERROR: 1, REFUSED: 2, NOT_REVERSIBLE: 3 });

// ───────────────────────────── §1 纯函数（无 IO，可单测）─────────────────────────────

/**
 * 参数解析。**未知参数一律拒绝**（防拼错参数导致"静默按缺省跑"）。
 * @returns {{ok:boolean, code?:string, message?:string, opts?:object}}
 */
export function parseArgs(argv) {
  const opts = {
    correlation: '', home: '', auditDir: '', boardUrl: '',
    apply: false, json: false, reason: '', toCardMode: 'archive', help: false,
    allowProduction: false,
  };
  const need = (i, name) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) return { ok: false, code: 'missing-value', message: `参数 ${name} 缺值` };
    return { ok: true, value: v };
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') { opts.help = true; continue; }
    if (a === '--apply') { opts.apply = true; continue; }
    if (a === '--dry-run') { opts.apply = false; continue; }  // 缺省就是 dry-run，显式写也不报错
    if (a === '--json') { opts.json = true; continue; }
    if (a === '--allow-production') { opts.allowProduction = true; continue; }
    if (a === '--correlation' || a === '--home' || a === '--audit-dir' || a === '--board-url'
      || a === '--reason' || a === '--to-card-mode') {
      const r = need(i, a);
      if (!r.ok) return r;
      i += 1;
      if (a === '--correlation') opts.correlation = r.value;
      else if (a === '--home') opts.home = r.value;
      else if (a === '--audit-dir') opts.auditDir = r.value;
      else if (a === '--board-url') opts.boardUrl = r.value;
      else if (a === '--reason') opts.reason = r.value;
      else if (a === '--to-card-mode') opts.toCardMode = r.value;
      continue;
    }
    return { ok: false, code: 'unknown-arg', message: `未知参数：${a}（本脚本只认 --correlation/--home/--audit-dir/--board-url/--apply/--dry-run/--allow-production/--json/--reason/--to-card-mode/--help）` };
  }
  if (opts.help) return { ok: true, opts };
  if (!opts.correlation.trim()) return { ok: false, code: 'missing-correlation', message: '缺 --correlation <id>：回滚必须指名道姓（没有"全量回滚"通路）' };
  if (!['archive', 'delete'].includes(opts.toCardMode)) {
    return { ok: false, code: 'bad-to-card-mode', message: `--to-card-mode 只认 archive|delete（收到 ${opts.toCardMode}）` };
  }
  return { ok: true, opts };
}

/** 解析 home：--home > BUTLER_DSH_HOME > DSH_HOME > ~/.dsh（与 lib\paths.mjs#dshHome 同口径 + 显式覆盖）。 */
export function resolveHome(homeArg) {
  if (homeArg && String(homeArg).trim()) return path.resolve(String(homeArg).trim());
  const env = process.env.BUTLER_DSH_HOME || process.env.DSH_HOME;
  if (env && env.trim()) return path.resolve(env.trim());
  return path.join(os.homedir(), '.dsh');
}

/** 审计目录（`--audit-dir` 显式覆盖，便于夹具）。 */
export function resolveAuditDir(home, auditDirArg) {
  if (auditDirArg && String(auditDirArg).trim()) return path.resolve(String(auditDirArg).trim());
  return path.join(home, 'butler-audit');
}

/** 删掉第 i 行（按 \n 拆行后重新拼接）。⚠️ 若被删行是末行且原文以 \n 结尾，会少一个尾部换行（看板无功能影响，校验栏会打字节数）。 */
export function stripLineAt(desc, i) {
  const lines = String(desc ?? '').split('\n');
  if (!Number.isInteger(i) || i < 0 || i >= lines.length) return String(desc ?? '');
  lines.splice(i, 1);
  return lines.join('\n');
}

/** 找出 description 里以「⏰ 大管家催办」开头的行号（0 基）。 */
export function nudgeLineIndices(desc) {
  return String(desc ?? '').split('\n')
    .map((l, i) => (l.startsWith(NUDGE_PREFIX) ? i : -1))
    .filter((i) => i >= 0);
}

/**
 * 从审计 rollbackScript 文案里解析改期的**旧值**（审计唯一的旧值载体）。
 * 文案形态（现行）：`把 cron 改回 \`0 9 * * *\`、enabled 改回 true（…）`
 * @returns {{ok:boolean, cron?:string, enabled?:boolean, reason?:string}}
 */
export function parseRescheduleOld(rollbackScript) {
  const s = String(rollbackScript ?? '');
  const mc = /cron 改回\s*`([^`]+)`/.exec(s);
  const me = /enabled 改回\s*(true|false)/.exec(s);
  if (!mc) return { ok: false, reason: 'rollbackScript 里没有「cron 改回 `<旧值>`」' };
  if (!me) return { ok: false, reason: 'rollbackScript 里没有「enabled 改回 true|false」' };
  const cron = mc[1];
  if (cron === '(未设置)') {
    return { ok: false, reason: '旧 cron 记为「(未设置)」= 该卡当时没有 cron 表达式 ⇒ 用 set-schedule 还原会写入一个假表达式 ⇒ 拒绝' };
  }
  return { ok: true, cron, enabled: me[1] === 'true' };
}

/**
 * 取改期旧值：**优先结构化 `rollbackData`**，读不到再回落解析 `rollbackScript` 文案（两条路都保留）。
 * 判据顺序（fail-closed 只在**两条路都失败**时触发）：
 *   ① `rollbackData.{cron,enabled}` 形态齐（cron 非空 string + enabled boolean）⇒ 用它，`source='rollbackData'`；
 *      其中 `cron === '(未设置)'` 依然**拒绝**（原样记的真值 ⇒ 拿它 set-schedule 等于写一个假表达式）；
 *   ② 否则回落 `parseRescheduleOld(rec.rollbackScript)`，`source='rollbackScript'`
 *      —— **旧审计行（2026-10-10 之前）走这条路，行为与上一版一字不差**。
 * @returns {{ok:boolean, cron?:string, enabled?:boolean, source:string, reason?:string}}
 */
export function rescheduleOldFromRecord(rec) {
  const rd = rec?.rollbackData;
  if (rd && typeof rd === 'object' && !Array.isArray(rd)
    && typeof rd.cron === 'string' && rd.cron.trim() && typeof rd.enabled === 'boolean') {
    if (rd.cron === '(未设置)') {
      return {
        ok: false, source: 'rollbackData',
        reason: 'rollbackData 里旧 cron = 「(未设置)」= 该卡当时没有 cron 表达式 ⇒ 用 set-schedule 还原会写入一个假表达式 ⇒ 拒绝',
      };
    }
    return { ok: true, cron: rd.cron, enabled: rd.enabled, source: 'rollbackData' };
  }
  const p = parseRescheduleOld(rec?.rollbackScript);
  return p.ok
    ? { ok: true, cron: p.cron, enabled: p.enabled, source: 'rollbackScript' }
    : { ok: false, source: 'rollbackScript', reason: p.reason };
}

/** 取催办写入的那**一行原文**（结构化优先；旧记录没记 ⇒ 返回空串，走「行首前缀 + 审计日期」兜底）。 */
export function nudgeLineFromRecord(rec) {
  const v = rec?.rollbackData?.nudgeLine;
  return typeof v === 'string' && v.trim() ? v : '';
}

/** 取转卡建的真实卡 id（结构化优先；旧记录没记 ⇒ 返回空串，走 description 标记兜底）。 */
export function toCardIdFromRecord(rec) {
  const v = rec?.rollbackData?.cardId;
  return typeof v === 'string' && v.trim() ? v.trim() : '';
}

/** 从审计记录里取"真执行"那条（dryRun=false 的最后一条）。 */
export function pickExecuted(records) {
  const list = Array.isArray(records) ? records : [];
  const exec = list.filter((r) => r && r.dryRun === false);
  return exec.length ? exec[exec.length - 1] : null;
}

/** 从审计记录里取报告文件路径（outputs 优先，文案兜底）。 */
export function reportFromAudit(rec) {
  const outs = Array.isArray(rec?.outputs) ? rec.outputs : [];
  for (const o of outs) {
    const f = typeof o === 'string' ? o : (o && typeof o.file === 'string' ? o.file : '');
    if (f) return { file: f, bytes: typeof o?.bytes === 'number' ? o.bytes : null };
  }
  // 结构化旧值兜底（2026-10-10 起真执行记录带 `rollbackData`；outputs 缺失时才用得上）
  const rd = rec?.rollbackData;
  if (rd && typeof rd === 'object' && typeof rd.reportFile === 'string' && rd.reportFile) {
    return { file: rd.reportFile, bytes: typeof rd.bytes === 'number' ? rd.bytes : null };
  }
  const m = /删掉报告文件\s+(.+?)\s*(?:——|；|（|$)/.exec(String(rec?.rollbackScript ?? ''));
  if (m) return { file: m[1], bytes: null };
  const m2 = /--rollback\s+"([^"]+)"/.exec(String(rec?.rollbackScript ?? ''));
  if (m2) return { file: m2[1], bytes: null };
  return { file: '', bytes: null };
}

const sha256File = (f) => {
  try { return createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return null; }
};

/**
 * P4 CLI 子进程环境：把 `BUTLER_DSH_HOME` 钉到**本次回滚用的 home**。
 * 为什么必须（2026-10-10 卡「冲刺600·D域配套」）：该 CLI 的 RMW 锁 home 走 `dshHome()`（env 优先），
 *   **不认 `--file`** ⇒ 不钉的话「夹具 home + 真 CLI」仍会在**生产 `~/.dsh`** 下建锁目录（隔离不彻底）。
 * 生产路径下 `rt.home` 与 `dshHome()` 同值 ⇒ 覆盖是恒等的，行为零变化。
 */
const p4Env = (rt) => {
  const home = rt?.home || process.env.BUTLER_DSH_HOME || process.env.DSH_HOME || '';
  return home ? { ...process.env, BUTLER_DSH_HOME: home } : { ...process.env };
};
const sha256Text = (t) => createHash('sha256').update(String(t ?? ''), 'utf8').digest('hex');
const bytesOf = (t) => Buffer.byteLength(String(t ?? ''), 'utf8');
const refused = (code, reason, extra = {}) => ({ status: 'refused', code, reason, ...extra });
const already = (reason, extra = {}) => ({ status: 'already', reason, ...extra });

/** 归档/删除卡是否"已生效"（判据同时容下 archive 与 delete 两种收尾形态）。 */
export function cardGoneFromBoard(state, taskId, mode) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  const t = tasks.find((x) => x && x.id === taskId) ?? null;
  if (!t) return { gone: true, why: '卡已不在看板（已删除）' };
  if (t.archivedAt) return { gone: true, why: `卡已归档（archivedAt=${t.archivedAt}）` };
  return { gone: false, why: `卡仍在活动面（status=${t.status}${mode === 'delete' ? '，期望已删除' : '，期望已归档'}）` };
}

// ───────────────────────────── §2 每个动作的 observe / plan / verify ─────────────────────────────
// 约定：observe 只读；plan 纯函数；apply 只在 --apply 下被调用；verify 用**回滚后重新观测**的结果做核对。

/** ① card-nudge：删掉 description 里那行催办备注。 */
const H_NUDGE = {
  title: '挂起卡催办',
  async observe(rec, rt) {
    const taskId = String(rec.params?.taskId ?? '').trim();
    if (!taskId) return { missingTaskId: true };
    const st = await rt.board.getState();
    const tasks = Array.isArray(st?.tasks) ? st.tasks : [];
    const card = tasks.find((t) => t && t.id === taskId) ?? null;
    if (!card) return { cardFound: false, exists: false, tasks };
    if (card.archivedAt) return { cardFound: false, archived: true, archivedAt: card.archivedAt, tasks };
    return { cardFound: true, card: { id: card.id, title: card.title ?? '', description: typeof card.description === 'string' ? card.description : '' }, tasks };
  },
  plan(rec, obs) {
    const taskId = String(rec.params?.taskId ?? '').trim();
    if (obs.missingTaskId) return refused('audit-missing-taskId', '审计的 params 里没有 taskId ⇒ 不知道回滚哪张卡 ⇒ 拒绝（不许猜）');
    if (!obs.cardFound) {
      return already(obs.archived
        ? `卡已归档（archivedAt=${obs.archivedAt}）⇒ 活动面无此卡，催办行随之不可见，无需回滚`
        : '卡已不在看板（已删除）⇒ 催办行随之消失，无需回滚');
    }
    const desc = obs.card.description;
    const lines = desc.split('\n');
    const idxs = nudgeLineIndices(desc);
    if (idxs.length === 0) return already('description 里已经没有「⏰ 大管家催办」开头的行（已回滚过 / 本次从未写盘）');
    let target = null;
    let locatedBy = null;
    // ① 优先：结构化旧值 `rollbackData.nudgeLine` = 当时**写入的那一行原文** ⇒ 整行精确匹配（多行命中也能唯一定位）
    const wantLine = nudgeLineFromRecord(rec);
    if (wantLine) {
      const hit = idxs.filter((i) => lines[i] === wantLine);
      if (hit.length === 1) { target = hit[0]; locatedBy = 'rollbackData.nudgeLine（整行精确匹配）'; }
    }
    // ② 回落（旧审计行无该字段 / 结构化值对不上盘面）：唯一命中行直接删；多行按审计当日日期挑；挑不出唯一一条 ⇒ 拒绝
    if (target === null) {
      if (idxs.length === 1) { target = idxs[0]; locatedBy = '唯一命中行（行首前缀）'; }
      else {
        const day = localDayKey(new Date(rec.at).getTime());
        const hit = idxs.filter((i) => lines[i].startsWith(`${NUDGE_PREFIX} ${day}`));
        if (hit.length === 1) { target = hit[0]; locatedBy = `行首前缀 + 审计当日（${day}）`; }
        else {
          return refused('nudge-line-ambiguous',
            `description 里有 ${idxs.length} 行催办备注，按审计时间（${day}）也挑不出唯一一条（命中 ${hit.length} 条）`
            + `${wantLine ? '、且 rollbackData.nudgeLine 在盘面找不到整行匹配' : '⇒ 审计未记戳记内容'} ⇒ 拒绝，请人工删`,
            { lines: idxs.map((i) => lines[i]), nudgeLine: wantLine || null });
        }
      }
    }
    const after = stripLineAt(desc, target);
    return {
      status: 'ready',
      op: { op: 'board-update', taskId, patch: { description: after } },
      summary: `删掉「${obs.card.title || taskId}」description 里第 ${target + 1} 行催办备注`,
      steps: [
        `命中行（第 ${target + 1} 行）：${lines[target]}`,
        `定位依据：${locatedBy}`,
        `description：${bytesOf(desc)} B / ${lines.length} 行  →  ${bytesOf(after)} B / ${after.split('\n').length} 行`,
      ],
      before: { card: obs.card.id, title: obs.card.title, bytes: bytesOf(desc), lines: lines.length, nudgeLines: idxs.length },
      // ⚠️ 判据对准「**本次要删的那一行**」：盘面多行催办时，回滚后本来就该剩 idxs.length-1 条（不是 0）。
      //    2026-10-10 卡「冲刺600·D域配套」修正：旧判据把"残留催办行 == 0"写死 ⇒ 多行场景会把自己判成失败
      //    （即使 sha/字节/行数与计划完全一致）。单行场景下 nudgeLinesAfter 仍为 0 ⇒ 强度不变。
      expect: { sha256: sha256Text(after), bytes: bytesOf(after), lines: after.split('\n').length, nudgeLinesAfter: Math.max(idxs.length - 1, 0) },
    };
  },
  verify(plan, obsAfter) {
    if (!obsAfter.cardFound) return { ok: false, lines: ['❌ 卡已不在活动面，无法核对 description'] };
    const d = obsAfter.card.description;
    const got = { sha256: sha256Text(d), bytes: bytesOf(d), lines: d.split('\n').length, nudgeLines: nudgeLineIndices(d).length };
    const wantNudge = plan.expect.nudgeLinesAfter ?? 0;
    const ok = got.sha256 === plan.expect.sha256 && got.nudgeLines === wantNudge;
    return {
      ok,
      lines: [
        `description sha256：${got.sha256} ${got.sha256 === plan.expect.sha256 ? '==' : '!='} 预期 ${plan.expect.sha256}`,
        `description：${got.bytes} B / ${got.lines} 行（预期 ${plan.expect.bytes} B / ${plan.expect.lines} 行）`,
        `残留催办行：${got.nudgeLines} 条（预期 ${wantNudge}）`,
      ],
    };
  },
  async apply(plan, rt) {
    const r = await rt.board.dispatch({ kind: 'update', taskId: plan.op.taskId, patch: plan.op.patch }, `${rt.correlationId}-rb1`);
    return { dispatched: r?.revision ?? null };
  },
};

/** ② card-reschedule：cron / enabled 改回审计里记的旧值。 */
const H_RESCHEDULE = {
  title: '重复定时改期',
  async observe(rec, rt) {
    const taskId = String(rec.params?.taskId ?? '').trim();
    if (!taskId) return { missingTaskId: true };
    const st = await rt.board.getState();
    const tasks = Array.isArray(st?.tasks) ? st.tasks : [];
    const card = tasks.find((t) => t && t.id === taskId) ?? null;
    if (!card) return { cardFound: false, tasks };
    if (card.archivedAt) return { cardFound: false, archived: true, archivedAt: card.archivedAt, tasks };
    return { cardFound: true, card: { id: card.id, title: card.title ?? '', schedule: card.schedule ?? null }, tasks };
  },
  plan(rec, obs) {
    // 旧值来源：① 审计结构化字段 `rollbackData.{cron,enabled}`（2026-10-10 起）→ ② 回落解析 `rollbackScript` 文案（旧行）
    const old = rescheduleOldFromRecord(rec);
    if (!old.ok) return refused('audit-missing-old-values', `审计里没有可用的旧值（已试：rollbackData 结构化字段 → rollbackScript 文案兜底）⇒ 拒绝（不许猜）：${old.reason}`);
    if (obs.missingTaskId) return refused('audit-missing-taskId', '审计的 params 里没有 taskId ⇒ 拒绝');
    if (!obs.cardFound) return already(obs.archived ? `卡已归档（archivedAt=${obs.archivedAt}）⇒ 定时不再生效，无需回滚` : '卡已不在看板（已删除）⇒ 无需回滚');
    if (!obs.card.schedule) {
      return refused('card-schedule-gone',
        `卡当前**没有**定时（schedule=null），而审计记的旧值是 cron=\`${old.cron}\` / enabled=${old.enabled} ⇒ 用 set-schedule 会把定时重新挂上（语义不确定）⇒ 拒绝，请人工处理`);
    }
    const cur = { cron: obs.card.schedule.cron ?? null, enabled: obs.card.schedule.enabled === true };
    if (cur.cron === old.cron && cur.enabled === old.enabled) {
      return already(`当前值已经是审计里的旧值（cron=\`${old.cron}\` · enabled=${old.enabled}）⇒ 已回滚 / 无需回滚`);
    }
    const patch = {};
    if (cur.cron !== old.cron) patch.cron = old.cron;
    if (cur.enabled !== old.enabled) patch.enabled = old.enabled;
    return {
      status: 'ready',
      op: { op: 'board-set-schedule', taskId: obs.card.id, patch },
      summary: `把「${obs.card.title || obs.card.id}」的定时改回审计里的旧值`,
      steps: [
        `旧值来源：${old.source === 'rollbackData' ? '审计结构化字段 rollbackData（优先路径）' : '审计 rollbackScript 文案（兜底路径 · 旧记录）'}`,
        `cron：\`${cur.cron ?? '(未设置)'}\` → \`${old.cron}\`${patch.cron === undefined ? '（不变）' : ''}`,
        `enabled：${cur.enabled} → ${old.enabled}${patch.enabled === undefined ? '（不变）' : ''}`,
      ],
      before: { card: obs.card.id, cron: cur.cron, enabled: cur.enabled },
      expect: { cron: old.cron, enabled: old.enabled },
    };
  },
  verify(plan, obsAfter) {
    if (!obsAfter.cardFound) return { ok: false, lines: ['❌ 卡已不在活动面，无法核对定时'] };
    const s = obsAfter.card.schedule ?? null;
    const got = { cron: s?.cron ?? null, enabled: s?.enabled === true };
    const ok = got.cron === plan.expect.cron && got.enabled === plan.expect.enabled;
    return {
      ok,
      lines: [
        `cron：\`${got.cron ?? '(未设置)'}\` ${got.cron === plan.expect.cron ? '==' : '!='} 预期 \`${plan.expect.cron}\``,
        `enabled：${got.enabled} ${got.enabled === plan.expect.enabled ? '==' : '!='} 预期 ${plan.expect.enabled}`,
      ],
    };
  },
  async apply(plan, rt) {
    const r = await rt.board.dispatch({ kind: 'set-schedule', taskId: plan.op.taskId, patch: plan.op.patch }, `${rt.correlationId}-rb1`);
    return { dispatched: r?.revision ?? null };
  },
};

/** ③ upgrade-precheck：删掉本次落下的报告文件。 */
const H_PRECHECK = {
  title: '升级项 L0 预检',
  async observe(rec) {
    const { file, bytes } = reportFromAudit(rec);
    if (!file) return { missingFile: true };
    const abs = path.isAbsolute(file);
    const base = path.basename(file);
    const shapeOk = abs && base.startsWith('升级预检报告-') && base.endsWith('.md');
    const exists = fs.existsSync(file);
    const st = exists ? fs.statSync(file) : null;
    return { file, auditBytes: bytes, shapeOk, exists, size: st?.size ?? null, sha256: exists ? sha256File(file) : null };
  },
  plan(rec, obs) {
    if (obs.missingFile) {
      return refused('audit-missing-report', `审计里没有报告文件路径（outputs 为空且 rollbackScript 也解析不到）⇒ 拒绝（不许猜）：${String(rec.rollbackScript ?? '(无 rollbackScript)').slice(0, 120)}`);
    }
    if (!obs.shapeOk) {
      return refused('report-path-shape', `报告路径形态不符（须绝对路径 + 文件名以「升级预检报告-」开头 + .md）：${obs.file} ⇒ 拒绝（防误删无关文件）`);
    }
    if (!obs.exists) return already(`报告文件已不存在（${obs.file}）⇒ 已回滚 / 无需回滚`);
    if (obs.auditBytes !== null && obs.size !== obs.auditBytes) {
      return refused('report-size-mismatch',
        `报告大小与审计不符（盘上 ${obs.size} B ≠ 审计 ${obs.auditBytes} B）⇒ 这份不是本次产物（可能被重写过）⇒ 拒绝删`);
    }
    return {
      status: 'ready',
      op: { op: 'delete-file', file: obs.file, expectBytes: obs.auditBytes, expectSha256: obs.sha256 },
      summary: `删掉预检报告 ${obs.file}`,
      steps: [
        `文件：${obs.file}`,
        `回滚前：存在 · ${obs.size} B · sha256 ${obs.sha256}`,
        obs.auditBytes !== null ? `审计记的字节数：${obs.auditBytes}（一致）` : '审计未记字节数（只按存在性判）',
      ],
      before: { file: obs.file, exists: true, bytes: obs.size, sha256: obs.sha256 },
      expect: { exists: false },
    };
  },
  verify(plan, obsAfter) {
    const exists = fs.existsSync(plan.op.file);
    return {
      ok: !exists,
      lines: [`文件存在性：${exists ? '仍存在 ❌' : '已删除 ✅'}（${plan.op.file}）`],
    };
  },
  async apply(plan) {
    const before = sha256File(plan.op.file);
    if (before !== plan.op.expectSha256) {
      const e = new Error(`删除前 sha 变了（${before} ≠ ${plan.op.expectSha256}）—— 拒绝删除`);
      e.code = 'file-changed-since-plan'; throw e;
    }
    fs.unlinkSync(plan.op.file);
    return { deleted: plan.op.file };
  },
};

/** ④ session-to-card：归档/删掉本动作建的那张卡。 */
const H_TOCARD = {
  title: '中断会话转卡',
  async observe(rec, rt) {
    const sessionId = String(rec.params?.sessionId ?? '').trim();
    const st = await rt.board.getState();
    const tasks = Array.isArray(st?.tasks) ? st.tasks : [];
    // ① 优先：结构化旧值 `rollbackData.cardId` = 当时**回读确认过的真实卡 id** ⇒ 直接点名，无歧义
    const known = toCardIdFromRecord(rec);
    if (known) {
      const t = tasks.find((x) => x && x.id === known) ?? null;
      const matches = t && !t.archivedAt
        ? [{ id: t.id, title: t.title ?? '', status: t.status, createdAt: t.createdAt ?? null }]
        : [];
      return { sessionId, matches, tasks, locatedBy: 'rollbackData.cardId', knownCardId: known, knownArchivedAt: t?.archivedAt ?? null };
    }
    // ② 回落（旧审计行没有卡 id）：靠 description 里的固定标记定位（命中 0/1/>1 三态在 plan 里分派）
    const marker = `${TOCARD_MARKER} ${sessionId}`;
    const matches = sessionId
      ? tasks.filter((t) => t && !t.archivedAt && typeof t.description === 'string' && t.description.includes(marker))
        .map((t) => ({ id: t.id, title: t.title ?? '', status: t.status, createdAt: t.createdAt ?? null }))
      : [];
    return { sessionId, matches, tasks, locatedBy: 'description-marker' };
  },
  plan(rec, obs, rt) {
    const mode = rt?.toCardMode ?? 'archive';
    if (!obs.sessionId) {
      const applied = Array.isArray(rec.applied) ? rec.applied.find((k) => String(k).startsWith('create|session:')) : null;
      return refused('audit-missing-sessionId',
        `审计的 params 里没有 sessionId，applied 里也没法定位（applied=${JSON.stringify(rec.applied ?? null)}）⇒ 拒绝（不许猜）`);
    }
    if (obs.matches.length === 0) {
      if (obs.locatedBy === 'rollbackData.cardId') {
        return already(obs.knownArchivedAt
          ? `卡 ${obs.knownCardId} 已归档（archivedAt=${obs.knownArchivedAt}）⇒ 已回滚 / 无需回滚`
          : `看板上已经没有卡 ${obs.knownCardId} 了（已删除）⇒ 已回滚 / 无需回滚`);
      }
      return already(`看板上没有「${TOCARD_MARKER} ${obs.sessionId}」标记的在途卡（已归档/已删除 / 本次从未建卡）⇒ 已回滚 / 无需回滚`);
    }
    if (obs.matches.length > 1) {
      return refused('tocard-ambiguous', `命中 ${obs.matches.length} 张卡（${obs.matches.map((m) => m.id).join(', ')}）⇒ 无法判定哪张是本次建的 ⇒ 拒绝（不许猜）`);
    }
    const c = obs.matches[0];
    if (!['backlog', 'todo'].includes(c.status)) {
      return refused('tocard-not-idle',
        `卡「${c.title}」（${c.id}）当前状态是 ${c.status}（不是 backlog/todo）⇒ 归档/删除会打断或丢掉工作 ⇒ 拒绝，请人工按正常流程收尾`);
    }
    return {
      status: 'ready',
      op: { op: mode === 'delete' ? 'board-delete' : 'board-archive', taskId: c.id },
      summary: `${mode === 'delete' ? '删掉' : '归档'}本次转卡建的「${c.title}」（${c.id}）`,
      steps: [
        `卡：${c.title}（${c.id}）· status=${c.status}`,
        `定位依据：${obs.locatedBy === 'rollbackData.cardId'
          ? `审计结构化字段 rollbackData.cardId=${obs.knownCardId}（回读确认真值）`
          : `description 含「${TOCARD_MARKER} ${obs.sessionId}」（旧记录 · 审计没有记卡 id）`}`,
      ],
      before: { card: c.id, title: c.title, status: c.status },
      expect: { gone: true, mode },
    };
  },
  verify(plan, obsAfter, rt) {
    const g = cardGoneFromBoard({ tasks: obsAfter.tasks }, plan.op.taskId, rt?.toCardMode ?? 'archive');
    return { ok: g.gone, lines: [`卡 ${plan.op.taskId}：${g.why}`] };
  },
  async apply(plan, rt) {
    const kind = plan.op.op === 'board-delete' ? 'delete' : 'archive';
    const r = await rt.board.dispatch({ kind, taskId: plan.op.taskId }, `${rt.correlationId}-rb1`);
    return { dispatched: r?.revision ?? null, kind };
  },
};

/** ⑤ p4-candidate-adopt / -reject：转调既有 CLI 的 `--rollback` 分支。 */
const H_P4 = {
  title: '坑升级候选采纳/忽略',
  async observe(rec) {
    const { file } = reportFromAudit(rec);
    let before = null; let beforeCount = null;
    if (file && fs.existsSync(file)) {
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (j && j.before && typeof j.before === 'object') { before = j.before; beforeCount = Object.keys(j.before).length; }
      } catch { /* 读不动 ⇒ 下面按缺 before 处理 */ }
    }
    return { report: file, reportExists: Boolean(file) && fs.existsSync(file), before, beforeCount };
  },
  plan(rec, obs, rt) {
    const msg = String(rec.message ?? '');
    if (!obs.report) {
      if (/未改盘|幂等跳过/.test(msg)) return already(`审计记「${msg.slice(0, 60)}」= 本次为幂等跳过（没写盘、没产出报告）⇒ 无需回滚`);
      return refused('audit-missing-report', '审计里没有报告路径（outputs 为空且 rollbackScript 解析不到）⇒ 拒绝（不许猜）');
    }
    if (!obs.reportExists) {
      return refused('p4-report-missing', `报告不存在（${obs.report}）⇒ 拿不到 before 段 ⇒ 拒绝（不许猜；CLI 自己对这种情况也 fail-closed rc=2）`);
    }
    if (!obs.before || obs.beforeCount === 0) {
      return refused('p4-report-no-before', `报告里没有可用的 before 段（${obs.report}）⇒ 拒绝`);
    }
    const poolFile = resolveStatePath('butler-p4-candidates.json', { home: rt.home }).path;
    return {
      status: 'ready',
      op: { op: 'p4-rollback', report: obs.report, poolFile, ids: Object.keys(obs.before) },
      summary: `按报告把 ${obs.beforeCount} 条候选写回 before 值`,
      steps: [
        `报告：${obs.report}`,
        `将回写的候选：${Object.keys(obs.before).join(', ')}`,
        `dry-run 命令：node "${P4_CLI}" --rollback "${obs.report}" --file "${poolFile}" --dry-run`,
        `真回滚命令：node "${P4_CLI}" --rollback "${obs.report}" --file "${poolFile}" --apply`,
        '该 CLI 自 2026-10-10 起**缺省即 dry-run**（零写盘）⇒ 本脚本 dry-run 分支会真调一次 `--dry-run` 取计划（下方探针行）；apply 分支带 `--apply` 真回写。',
      ],
      before: { report: obs.report, ids: Object.keys(obs.before), statuses: Object.fromEntries(Object.entries(obs.before).map(([k, v]) => [k, v?.status ?? null])) },
      expect: { statuses: Object.fromEntries(Object.entries(obs.before).map(([k, v]) => [k, v?.status ?? null])) },
    };
  },
  verify(plan, obsAfter) {
    const poolFile = plan.op.poolFile;
    let pool = null;
    try { pool = JSON.parse(fs.readFileSync(poolFile, 'utf8')); } catch { /* 读不到 ⇒ 下面报失败 */ }
    if (!pool || !Array.isArray(pool.candidates)) return { ok: false, lines: [`❌ 候选池读不到或形态异常：${poolFile}`] };
    const lines = []; let ok = true;
    for (const id of plan.op.ids) {
      const cur = pool.candidates.find((c) => c?.id === id) ?? null;
      const want = plan.expect.statuses[id] ?? null;
      const got = cur?.status ?? null;
      if (got !== want) ok = false;
      lines.push(`候选 ${id}：status=${got} ${got === want ? '==' : '!='} 预期 ${want}`);
    }
    return { ok, lines };
  },
  async apply(plan, rt) {
    const r = spawnSync(process.execPath, [P4_CLI, '--rollback', plan.op.report, '--file', plan.op.poolFile, '--apply'],
      { encoding: 'utf8', timeout: 60_000, env: p4Env(rt) });
    return { rc: r.status, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
  },
  /**
   * dry-run 附加取证（2026-10-10 加）：CLI 现在有 dry-run 档 ⇒ 带 `--dry-run` **真调它**取"将写什么"。
   * **零写盘**（CLI 的 dry-run 分支不 acquireRmwLock / 不 updateJson / 不建池）；探针失败只降级成一行提示，
   * 不改本脚本结论（plan 本身已经算完）。
   */
  dryRunProbe(plan, rt) {
    const r = spawnSync(process.execPath, [P4_CLI, '--rollback', plan.op.report, '--file', plan.op.poolFile, '--dry-run'],
      { encoding: 'utf8', timeout: 60_000, env: p4Env(rt) });
    const lines = String(r.stdout ?? '').trim().split('\n').filter(Boolean);
    const out = [`CLI dry-run 探针（rc=${r.status}${r.error ? ` · ${r.error.message ?? r.error}` : ''} · 零写盘）：`];
    if (lines.length) for (const l of lines) out.push(`    ${l}`);
    else out.push(`    ${String(r.stderr ?? '').trim().slice(0, 200) || '(无输出)'}`);
    return { ok: r.status === 0, lines: out };
  },
};

/** ⑥ card-retry：注册表声明不可回滚（设计如此，不是缺陷）。 */
const H_RETRY = {
  title: '失败卡重试',
  notReversible: true,
  async observe() { return {}; },
  plan() {
    return {
      status: 'not-reversible',
      code: 'declared-not-reversible',
      reason: '该动作在注册表里声明 `reversible:false`（重试 = 已经开了一个真会话烧 token，会话不可回收）；不满意就等它跑完按正常流程 reject 收尾',
    };
  },
};

export const HANDLERS = Object.freeze({
  'card-nudge': H_NUDGE,
  'card-reschedule': H_RESCHEDULE,
  'upgrade-precheck': H_PRECHECK,
  'session-to-card': H_TOCARD,
  'p4-candidate-adopt': H_P4,
  'p4-candidate-reject': H_P4,
  'card-retry': H_RETRY,
});

// ───────────────────────────── §3 IO：读审计 ─────────────────────────────

/**
 * 按 correlationId 回溯审计原文（`component=butler-manual-action`）。
 * @returns {{ok:boolean, records:object[], files:string[], reason?:string}}
 */
export function readAuditRecords({ auditDir, correlationId }) {
  let files = [];
  try {
    files = fs.readdirSync(auditDir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort().reverse();
  } catch (e) {
    return { ok: false, records: [], files: [], reason: `审计目录读不到：${auditDir}（${e?.message ?? e}）` };
  }
  const records = [];
  for (const f of files) {
    const full = path.join(auditDir, f);
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.trim() || !line.includes(correlationId)) continue;
      let rec = null;
      try { rec = JSON.parse(line); } catch { continue; }
      if (rec?.component === 'butler-manual-action' && rec.correlationId === correlationId) records.push({ ...rec, _file: full });
    }
  }
  return { ok: true, records, files: files.map((f) => path.join(auditDir, f)) };
}

// ───────────────────────────── §4 主流程 ─────────────────────────────

/**
 * 从 plan 里收集"会被写/删的文件目标"（供 R-060 生产闸判定）。
 * 纯函数、只读、防御式：只认 `file|path|target|reportFile|report` 键上的**绝对路径**字符串，认不出就返回少（宁少不多）。
 * ⚠️ 2026-10-16 实测踩过：p4 类 plan 的键名是 **`report`**（不是 `reportFile`）⇒ 漏认它会让闸门看不见"要动的报告文件"。
 */
export function planPaths(plan) {
  const out = [];
  const KEYS = new Set(['file', 'path', 'target', 'reportFile', 'report']);
  const walk = (v, key) => {
    if (typeof v === 'string') {
      if (KEYS.has(key) && /^[a-zA-Z]:[\\/]/.test(v)) out.push(v);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, key); return; }
    if (v && typeof v === 'object') { for (const [k, vv] of Object.entries(v)) walk(vv, k); }
  };
  walk(plan, '');
  return [...new Set(out)];
}

/**
 * 回滚主流程（缺省 dry-run；`opts.apply !== true` 时**零写入**）。
 * @param {{correlation:string, home?:string, auditDir?:string, boardUrl?:string, apply?:boolean,
 *          toCardMode?:string, reason?:string, board?:object, silent?:boolean}} opts
 */
export async function runRollback(opts = {}) {
  const apply = opts.apply === true;
  const correlationId = String(opts.correlation ?? '').trim();
  const home = resolveHome(opts.home);
  const auditDir = resolveAuditDir(home, opts.auditDir);
  const toCardMode = opts.toCardMode ?? 'archive';
  const out = { version: ROLLBACK_VERSION, correlationId, home, auditDir, apply, dryRun: !apply, actionId: null, status: null, exitCode: EXIT.OK, plan: null, verify: null, auditTrail: null };

  const found = readAuditRecords({ auditDir, correlationId });
  if (!found.ok) { out.status = 'refused'; out.exitCode = EXIT.REFUSED; out.reason = found.reason; return out; }
  if (found.records.length === 0) {
    out.status = 'refused';
    out.exitCode = EXIT.REFUSED;
    out.reason = `审计里找不到 correlation=${correlationId} 的记录（component=butler-manual-action）⇒ 拒绝执行（不许猜）。扫过：${found.files.join(', ') || '(没有月度审计文件)'}`;
    return out;
  }
  const executed = pickExecuted(found.records);
  if (!executed) {
    out.status = 'already';
    out.reason = `该 correlation 只有**预览**记录（dryRun=true · ${found.records.length} 条）⇒ 没有任何真动作发生过 ⇒ 无需回滚`;
    out.records = found.records.map((r) => ({ at: r.at, result: r.result, dryRun: r.dryRun }));
    return out;
  }
  out.actionId = executed.actionId ?? null;
  out.executedAt = executed.at;
  out.recordResult = executed.result ?? null;
  if (['rejected'].includes(executed.result)) {
    out.status = 'already';
    out.reason = `该 correlation 的真执行记录是 result=${executed.result}（动作被拒，零写盘）⇒ 无需回滚`;
    return out;
  }
  const handler = HANDLERS[out.actionId];
  if (!handler) {
    out.status = 'refused';
    out.exitCode = EXIT.REFUSED;
    out.reason = `动作「${out.actionId}」没有登记回滚实现 ⇒ 拒绝（不许猜）：已实现 ${Object.keys(HANDLERS).join(' / ')}`;
    return out;
  }
  out.actionTitle = handler.title;

  const rt = {
    home,
    correlationId,
    toCardMode,
    board: opts.board ?? makeBoardClient({ baseUrl: opts.boardUrl || process.env.DSH_BUTLER_BOARD_URL || 'http://127.0.0.1:3080' }),
  };
  let obs;
  try { obs = await handler.observe(executed, rt); } catch (e) {
    out.status = 'refused'; out.exitCode = EXIT.REFUSED;
    out.reason = `读现状失败（不猜、不动手）：${e?.message ?? e}`;
    return out;
  }
  const plan = handler.plan(executed, obs, rt);
  out.plan = plan;
  out.status = plan.status;
  if (plan.status === 'refused') { out.exitCode = EXIT.REFUSED; out.reason = plan.reason; return out; }
  if (plan.status === 'already') { out.reason = plan.reason; return out; }
  if (plan.status === 'not-reversible') { out.exitCode = EXIT.NOT_REVERSIBLE; out.reason = plan.reason; return out; }

  if (!apply) {
    // dry-run 附加取证（可选 hook）：**只允许零写盘**的探针（当前仅 P4 用：调 CLI 的 `--dry-run` 档取真实计划）
    if (typeof handler.dryRunProbe === 'function') {
      try {
        const probe = await handler.dryRunProbe(plan, rt);
        if (probe?.lines?.length) out.plan = { ...plan, steps: [...(plan.steps ?? []), ...probe.lines] };
      } catch (e) {
        out.plan = { ...plan, steps: [...(plan.steps ?? []), `⚠️ dry-run 探针失败（不影响结论）：${e?.message ?? e}`] };
      }
    }
    out.reason = 'dry-run：未做任何写操作（真回滚请加 --apply）';
    return out;
  }

  // ── R-060 生产闸（**真回滚之前**· 只读 dry-run 已在上面 return ⇒ 走到这里必然要真写）──
  // 目标 = 审计 home + 审计目录 + plan 里点名的文件（如 upgrade-precheck 要删的报告文件）。
  // 夹具/沙箱（`--home <沙箱>`）⇒ 目标不在生产树 ⇒ 不需要放行开关，测试链路零改动。
  const gate = gateProductionWrite({
    targets: [home, auditDir, ...planPaths(plan)],
    allowProduction: opts.allowProduction === true,
    dryRun: false,
    op: '回滚',
    reason: `manual-action-rollback --apply · 动作=${out.actionId} · correlation=${correlationId}`,
  });
  if (!gate.ok) {
    out.status = 'refused';
    out.exitCode = EXIT.REFUSED;   // 2
    out.reason = refuseLine(gate);
    return out;
  }

  // ── 真回滚 ──
  try {
    out.applied = await handler.apply(plan, rt);
  } catch (e) {
    out.status = 'failed'; out.exitCode = EXIT.ERROR;
    out.reason = `回滚执行失败：${e?.message ?? e}`;
    out.verify = { ok: false, lines: [`❌ ${e?.message ?? e}`] };
    try {
      appendAudit({
        component: 'butler-manual-action-rollback', correlationId, actionId: out.actionId,
        result: 'failed', reason: String(e?.message ?? e).slice(0, 300), note: opts.reason || null, version: ROLLBACK_VERSION,
      }, { home, silent: true });
      out.auditTrail = 'written(failed)';
    } catch { out.auditTrail = 'append-failed'; }
    return out;
  }
  try {
    const obsAfter = await handler.observe(executed, rt);
    out.verify = handler.verify(plan, obsAfter, rt);
  } catch (e) {
    out.verify = { ok: false, lines: [`❌ 回滚后核对失败（写操作已完成，请人工确认）：${e?.message ?? e}`] };
  }
  out.status = out.verify?.ok ? 'rolled-back' : 'rolled-back-unverified';
  if (!out.verify?.ok) out.exitCode = EXIT.ERROR;
  try {
    appendAudit({
      component: 'butler-manual-action-rollback', correlationId, actionId: out.actionId,
      result: out.verify?.ok ? 'ok' : 'unverified',
      verified: out.verify?.lines ?? null, note: opts.reason || null, version: ROLLBACK_VERSION,
    }, { home, silent: true });
    out.auditTrail = out.verify?.ok ? 'written(ok)' : 'written(unverified)';
  } catch { out.auditTrail = 'append-failed'; }
  return out;
}

/** 人话清单（stdout）。 */
export function renderText(r) {
  const L = [];
  L.push('=== 手动动作回滚（手动动作备用回滚脚本 · ' + (r.dryRun ? 'dry-run · 零写入' : 'APPLY') + '）===');
  L.push(`correlation : ${r.correlationId}`);
  L.push(`home        : ${r.home}`);
  L.push(`审计目录    : ${r.auditDir}`);
  if (r.reason && !r.plan) L.push(`结论        : ${r.status} — ${r.reason}`);
  if (r.actionId) L.push(`动作        : ${r.actionId}（${r.actionTitle ?? '?'}）· 审计执行时间 ${r.executedAt ?? '?'} · result=${r.recordResult ?? '?'}`);
  const p = r.plan;
  if (p) {
    L.push(`回滚计划    : ${p.summary ?? p.reason ?? ''}`);
    for (const s of p.steps ?? []) L.push(`  · ${s}`);
    if (p.status === 'already') L.push(`结论        : 已回滚 / 无需回滚（幂等）`);
    else if (p.status === 'refused') L.push(`结论        : 拒绝执行（fail-closed）：${p.reason}`);
    else if (p.status === 'not-reversible') L.push(`结论        : 不可回滚（设计如此）：${p.reason}`);
    else L.push(`结论        : ${r.dryRun ? '（dry-run 未写盘）' : (r.status === 'rolled-back' ? '已回滚' : r.status)}`);
    if (r.reason && p.status === 'ready') L.push(`说明        : ${r.reason}`);
  }
  if (r.verify) {
    L.push(`回滚后校验  : ${r.verify.ok ? '✅ 全部一致' : '❌ 有不一致'}`);
    for (const l of r.verify.lines ?? []) L.push(`  · ${l}`);
  }
  if (r.auditTrail) L.push(`审计留痕    : ${r.auditTrail}`);
  L.push(`退出码      : ${r.exitCode}`);
  return L.join('\n');
}

const isMain = (() => {
  try { return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();

if (isMain) {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`❌ ${parsed.message}\n`);
    process.exitCode = EXIT.REFUSED;
  } else if (parsed.opts.help) {
    process.stdout.write([
      '用法：node manual-action-rollback.mjs --correlation <id> [--apply] [--json] [--home <dir>]',
      '      --correlation <id>   必填：要回滚哪一次动作（= lib\\manual-actions.mjs 审计里的 correlationId）',
      '      --apply              真回滚（缺省 = dry-run，只打印将做什么，零写入）',
      '      --allow-production   真回滚的目标落在生产树（~/.dsh / <workspace>）内时必须显式给（R-060 闸 · 否则 rc=2）',
      '      --home <dir>         覆盖 ~/.dsh（夹具/沙箱；也不写生产审计）',
      '      --audit-dir <dir>    覆盖审计目录（缺省 <home>\\butler-audit）',
      '      --board-url <url>    覆盖看板 Host API（缺省 http://127.0.0.1:3080）',
      '      --to-card-mode a|d   转卡回滚的收尾形态：archive（缺省，可恢复）/ delete',
      '      --reason <备注>      写进回滚审计留痕的一句话',
      '退出码：0 = 已回滚/已回滚过/无需回滚 ／ 1 = 执行出错 ／ 2 = 拒绝（用法错/缺 correlation/fail-closed）／ 3 = 动作声明不可回滚',
    ].join('\n') + '\n');
  } else {
    const o = parsed.opts;
    const r = await runRollback({
      correlation: o.correlation, home: o.home, auditDir: o.auditDir, boardUrl: o.boardUrl,
      apply: o.apply, toCardMode: o.toCardMode, reason: o.reason, allowProduction: o.allowProduction,
    });
    if (o.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    else process.stdout.write(renderText(r) + '\n');
    process.exitCode = r.exitCode;
  }
}
