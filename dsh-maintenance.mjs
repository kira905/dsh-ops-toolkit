#!/usr/bin/env node
/**
 * dsh-maintenance.mjs —— 「停机维护」编排器：停 DSH → 跑维护任务 → 起回 DSH → 出报告
 *
 * 为什么需要它：有些维护动作（动 memory.db schema / 不可逆删除 / 换依赖）必须在
 * **DSH 完全停机**的窗口里做（唯一写者消失）。而 DSH 会话自己跑它 = 把自己杀了 ⇒
 * 必须从「与 DSH 无亲缘的独立进程」启动（桌面 .cmd 双击 / 独立 cmd 窗口）。
 *
 * ⚠️⚠️ 2026-09-20 实测血案（本脚本第一次上线即踩）：
 *   `dsh-shutdown.ps1` 清「DSH 相关 node」时按**命令行特征**匹配 `*<DSH_ROOT>*`
 *   ⇒ 编排器自己（`node <DSH_ROOT>\tools\dsh-maintenance.mjs`）**在射程内**：
 *     证据 `logs\dsh-shutdown.log` 22:18 段 = guard stopped → dsh killed → DSH node killed(tickd) 后戛然而止，
 *     报告目录建了、**维护步骤一步没跑、报告没写**，DSH 靠人工起回。
 *   ⇒ 修法 = **自举**：脚本若发现自己运行在 DSH 工作区内，先把自身复制到 `%TEMP%\dsh-maint\`
 *     再以副本继续执行（副本命令行不含 <DSH_ROOT> ⇒ 不在停机脚本射程内）。
 *
 * 用法：
 *   node <DSH_ROOT>\tools\dsh-maintenance.mjs --task <任务名>            # 缺省 = dry-run（只预检，不停机）
 *   node <DSH_ROOT>\tools\dsh-maintenance.mjs --task <任务名> --go       # 真跑（会停 DSH！）
 *   node <DSH_ROOT>\tools\dsh-maintenance.mjs --list
 *   node <DSH_ROOT>\tools\dsh-maintenance.mjs --help
 *
 * 【2026-09-28 · 0.1.5 遗留 L23 · 危险脚本闸门批 1B】缺省改为 **dry-run**：
 *   真动作（停 DSH → 跑维护 → 起回）必须显式 --go。范式 = tools\guard-notify-prod-verify.mjs
 *   （缺省 dry-run / --go 才真跑 / 未知参数 exit 2）。
 *
 * 【2026-09-29 · 卡 S9 · portUp 判活回归】判活**不再手搓**，改引单一真源 `guard-http.mjs`（H1 · 2026-09-22）：
 *   0.1.5 token 门下**无 token 访问 `/` 返回 401**，旧判据 `res.status === 200` 恒假 ⇒ 停机窗口「起回」段
 *   白等 600s → `start-timeout`/exit 1 → 兜底再跑一次 `dsh-start.ps1` 再白等 600s（≈20 分钟白烧，
 *   且报告把成功写成失败）。口径 = **2xx/3xx/401/403 活；404 等其它 4xx、5xx、无应答不活**。
 *   ⚠️ import **必须用绝对 `file:///guard-http.mjs`**：本脚本会把**自身单文件**自举复制到
 *   `%TEMP%\dsh-maint\` 再跑，相对 specifier 在副本里会解析到 `%TEMP%\guard-http.mjs`（不存在）
 *   ⇒ 首次真跑会死在 import 上（比原缺陷更糟）。依据：docs\带外-停机维护编排器portUp判活回归-20260929.md §3.1。
 *
 * 【2026-09-29 · 卡 S11 · M-2 管道捕获 ⇒ 起回段白烧 900s】`run()` 原先一律用
 *   `spawnSync(..., {encoding:"buffer"})` **管道捕获**子进程输出；而「起回」段调的 `dsh-start.ps1`
 *   收尾会 `& node guard-ctl.mjs start`（:473）与 `& node $tickd --ensure`（:502）拉起**常驻**进程
 *   ⇒ 直接子进程（powershell）退出后，那条 stdout 管道仍被常驻孙进程持有、**永不到 EOF**
 *   ⇒ `spawnSync` 一路等到 `timeout`（起回段 = 900s）。**timeout 救不了它**：
 *      这是"管道未关"，不是"进程未退"（实测：用时 ≈ 那个孙进程的存活时长，与它退出与否无关）。
 *   铁证（第一方日志）：`_archive\maint-05-3-add-columns-2026-09-20T14-34-28\console.log:284`
 *   = `[spawn error] spawnSync powershell.exe ETIMEDOUT`；同报告时间线 22:34:44 进起回 + 900s
 *   = 22:49:44 结束，**秒级吻合** ⇒ 那次 `result: success`（总耗时 916s）里约 15 分钟是纯空转。
 *   修法：`run()` 增 `opts.stdio` 透传（缺省 `"pipe"`＝原行为，不动其它调用点）+ `opts.logFile`
 *   便捷形态（stdout/stderr 重定向到**文件 fd**）⇒ **没有管道可等**：spawnSync 只等**直接子进程退出**
 *   就返回，常驻孙进程活多久都不影响；且那段输出照旧留档（能看见 `guard started (PID …)` /
 *   `tickd started (PID …)`），不像 `stdio:"ignore"` 会丢证据。
 *   「②停服 / ⑤起回 / 兜底」三处**会拉起常驻进程**的调用点一律走 `logFile`。
 *   依据：docs\带外-停机维护编排器-增补-双重隐性成本与L25待办订正-20260929.md §5；
 *        机理实测证据见内部交付记录 §3。
 *
 * 退出码：0 成功 / 1 维护任务失败（DSH 已尽力起回）/ 2 用法错 / 3 前置不满足（零副作用）
 * 收尾一律 process.exitCode（Windows + fetch 后 process.exit() 会概率性崩，见 persona）。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
// 判活单一真源（H1 · 2026-09-22）。**绝对 file:/// URL 不可改成相对路径**（自举只复制本单文件，见头注）。
import { isHttpAlive, judgeHttp, ALIVE_RULE_TEXT, RULE_VERSION } from "./lib/guard-http.mjs";

const DSH = process.env.DSH_ROOT || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 【2026-10-09 · 卡「360弹窗治本-pwsh7」】PowerShell 一律走统一工具（pwsh 7 优先）：
//   360 企业版 EDR（公司下发 · 终端只读）只对 5.1（powershell.exe）弹「PowerShell 命令执行攻击」。
//   ⚠️ 用**绝对 file:/// URL**：本文件会被自举单文件复制，相对路径解析不到（见头注）。工具缺失 ⇒ 兜底 5.1。
const PS = await import("./lib/powershell-exe.mjs").then((m) => m.powerShellExe()).catch(() => "powershell.exe");
const HOME = os.homedir();
const PROD_DB = path.join(HOME, ".dsh", "memory", "memory.db");
const MEMTOOLS = path.join(DSH, "tools", "memory-db-tools");
const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d = null) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : d; };

const GO = has("--go");
const EXPLICIT_DRY = has("--dry-run");
const DRY = !GO;   // 缺省 dry-run（2026-09-28 L23）：真动作（停/起 DSH）必须显式 --go
const TASK = val("--task");
const HELPME = has("--help") || has("-h");
const HELP_TEXT = [
  "usage: node dsh-maintenance.mjs --task <任务名> [--go | --dry-run] [--list] [--help]",
  "",
  "  停机维护编排器：停 DSH → 跑维护任务 → 复核 → 起回 DSH → 出报告。",
  "",
  "  （不带开关）  dry-run：缺省行为，只跑预检（不停机、零副作用）。",
  "  --go          真跑：会停 DSH、跑维护任务、复核、起回（- - 会打断正在跑的会话）。",
  "  --dry-run     显式 dry-run（与 --go 互斥）。",
  "  --task <名>   要跑的任务（缺省列出已登记任务）。",
  "  --list        列出已登记任务。",
  "  --help        本帮助。",
  "",
  "  判活口径（单一真源 guard-http.mjs · RULE_VERSION=" + RULE_VERSION + "）：",
  "    " + ALIVE_RULE_TEXT,
  "    ＝有 HTTP 应答即活：0.1.5+ token 门下无 token 访问 / 返回 401 ⇒ 仍判活（不是没起来）。",
  "    停机等关闭用的是同一条口径取反。超时原因分三种：no-answer（一次应答都没有＝真没起来）／",
  "    no-alive-answer（有应答但判据不认＝口径问题，别再怪 dsh）／still-alive（等关闭时仍在应答）。",
  "",
  "  退出码：0 成功 · 1 维护任务失败（DSH 已尽力起回）· 2 用法错 · 3 前置不满足（零副作用）",
].join("\n");
const TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const logLines = [];
let LOGFILE = null; // 由 main() 设置：**实时**落盘（不依赖窗口/父进程存活；2026-09-20 教训：黑窗口被提前关 ⇒ 连坐死、啥都没留下）
function log(msg) {
  logLines.push(msg);
  console.log(msg);
  if (LOGFILE) { try { fs.appendFileSync(LOGFILE, msg + "\n", "utf8"); } catch { /* 落盘失败不阻断主流程 */ } }
}
// 解码子进程输出。⚠️ 单一固定编码两边都会错（2026-09-28 L25 实测 hex 证据）：
//   · powershell.exe(5.1) / cmd.exe 默认输出 **GBK**（d6d0cec4…）；
//   · node.exe 输出 **UTF-8**（e4b8ade69687…）。
// 原实现写死 GBK ⇒ node 子进程（memory-db-tools 系列）的中文全乱码；
// 若改成写死 UTF-8 ⇒ powershell 子进程（②停 DSH / ⑤起回）的中文反向乱码。
// ⇒ 取「UTF-8 优先 + 非法序列回落 GBK」：合法 UTF-8（含纯 ASCII）按 UTF-8 解，否则按 GBK 解。
function decodeBuf(buf) {
  if (!buf) return "";
  const b = Buffer.from(buf);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(b); }
  catch { try { return new TextDecoder("gbk").decode(b); } catch { return b.toString("latin1"); } }
}
/** 读文本文件并按「UTF-8 优先 → GBK 回落」解码（子进程日志与 stdout 同源，见 decodeBuf 说明） */
function readTextFile(p) { try { return decodeBuf(fs.readFileSync(p)); } catch { return ""; } }
/**
 * 跑一个子进程。
 *
 * ⚠️【2026-09-29 · 卡 S11 · M-2】stdio 形态是**语义的一部分**，不是性能细节：
 *   · 缺省 `"pipe"`（原行为）：spawnSync 需要把管道**读到 EOF** 才返回 ⇒ 只要还有别的进程
 *     持有那条管道的写端（典型：直接子进程拉起的**常驻孙进程**继承了句柄），就会一路卡到
 *     `timeout`，报 `ETIMEDOUT` —— **timeout 挡不住它，因为它压根不是"进程没退"**。
 *   · `logFile`（= stdout/stderr 指向**文件 fd**，非管道）：**没有管道可等**，spawnSync 只等
 *     **直接子进程退出**就返回；孙进程活多久、持有多少句柄都拖不住，而且那段输出留在文件里
 *     （证据不丢，优于 `"ignore"`）。⇒ **凡会拉起常驻进程的调用点一律传 logFile**。
 *   · 传入 `stdio` 时原样透传给 spawnSync（单测/特殊场景用；传 `"ignore"` 会丢证据，慎用）。
 * @param {{cwd?:string, timeout?:number, env?:object, stdio?:any, logFile?:string}} [opts]
 * @returns {{status:number, out:string, err:string, error:Error|null, ms:number, logFile:string|null}}
 */
export function run(file, args, opts = {}) {
  let fd = null;
  let stdio = opts.stdio ?? "pipe";
  if (opts.logFile) {
    try {
      fs.mkdirSync(path.dirname(opts.logFile), { recursive: true });
      fd = fs.openSync(opts.logFile, "a");   // 追加：同一文件被多次调用时证据累积，且不截断前人写的
      stdio = ["ignore", fd, fd];
    } catch (e) {
      log(`[run] ⚠️ 打不开子进程日志 ${opts.logFile}（${e?.message ?? e}）⇒ 回落 stdio:"ignore"（仍然不占管道）`);
      fd = null; stdio = "ignore";
    }
  }
  const t0 = Date.now();
  const r = spawnSync(file, args, {
    cwd: opts.cwd ?? DSH, encoding: "buffer", timeout: opts.timeout ?? 600_000, windowsHide: true,
    stdio, env: { ...process.env, ...(opts.env ?? {}) },
  });
  const ms = Date.now() - t0;
  if (fd !== null) { try { fs.closeSync(fd); } catch { /* 关不掉不影响判定 */ } }
  const out = decodeBuf(r.stdout);
  const err = decodeBuf(r.stderr);
  if (out.trim()) log(out.trimEnd());
  if (err.trim()) log("[stderr] " + err.trimEnd());
  if (r.error) {
    log("[spawn error] " + r.error.message);
    if (r.error.code === "ETIMEDOUT") {
      log(`[spawn error] ⚠️ 直接子进程 ${Math.round((opts.timeout ?? 600_000) / 1000)}s 内未收尾——`
        + (opts.logFile
          ? "该调用点已走**文件重定向** ⇒ 属「进程真的没退」这一类，请查它自己的日志（不是管道被占）。"
          : "该调用点仍是**管道捕获** ⇒ 若它会拉起常驻进程，那是「管道被常驻孙进程持有」（应改传 logFile）。"));
    }
  }
  // 文件形态：把那段输出读回主日志 / 报告（既不占管道，证据也不丢）
  if (opts.logFile && fd !== null) {
    const t = readTextFile(opts.logFile);
    if (t.trim()) log(`──── 子进程输出（${opts.logFile}）────\n${t.trimEnd()}`);
  }
  return { status: r.status ?? (r.error ? -1 : 0), out, err, error: r.error, ms, logFile: opts.logFile ?? null };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 探一次 3080。判活走 **单一真源** `guard-http.mjs`（H1 · 2026-09-22）的 judgeHttp/isHttpAlive
 * —— **不许在本文件里再手搓 `=== 200`**（那正是 2026-09-29 修的回归：token 门下 `/` 返回 401）。
 * @param {{timeoutMs?:number, url?:string, fetchImpl?:Function}} [opts]
 *   fetchImpl 可注入（单测用假 fetch，避免真打网络）
 * @returns {Promise<{status:number, answered:boolean, alive:boolean, reason:string, rule:string, ms:number, err?:string}>}
 *   answered=false ⇒ 连 HTTP 应答都没有（fetch 抛错/超时）；reason 取自 judgeHttp：
 *   ok-2xx | redirect-3xx | auth-401 | auth-403 | not-found-404 | client-4xx | server-5xx | no-answer
 */
export async function portProbe(opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 4000;
  const doFetch = opts.fetchImpl ?? fetch;
  const url = opts.url ?? "http://localhost:3080/";
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    const res = await doFetch(url, { signal: ac.signal, cache: "no-store" });
    const j = judgeHttp(res?.status);
    const answered = j.code !== null && j.code > 0;   // 0/非三位数 = 拿不到可用状态码
    return {
      status: j.code ?? 0, answered, alive: j.alive,
      reason: answered ? j.reason : "no-answer", rule: j.rule, ms: Date.now() - t0,
    };
  } catch (e) {
    return { status: 0, answered: false, alive: false, reason: "no-answer", rule: RULE_VERSION, ms: Date.now() - t0, err: e?.message ?? String(e) };
  } finally { clearTimeout(t); }
}
/** 只要布尔（保留旧调用形状；兜底判据与单测用）。判活真源同上。 */
export async function portUp(timeoutMs = 4000, opts = {}) { return (await portProbe({ ...opts, timeoutMs })).alive; }

/** 超时原因 → 人话（日志/报告共用；避免"口径恒假"被误读成"dsh 起不来"） */
export const WAIT_REASON_TEXT = {
  "time-out-no-answer": "一次 HTTP 应答都没有 ⇒ DSH 真没起来（看 dsh-start 日志 / 双击桌面快捷方式）",
  "time-out-no-alive-answer": "有 HTTP 应答但不满足判活口径 ⇒ 是**判活口径**的问题，不是 dsh 没起来",
  "time-out-still-alive": "仍在应答 ⇒ 没关掉（停机失败）",
};
/**
 * 等 3080 变成 want（true=判活 / false=关闭）。
 * @returns {Promise<{ok:true,sec:number,probes:number,status:number,reason:string}
 *                 | {ok:false,sec:null,probes:number,status:number,reason:string,sawAnswer:boolean}>}
 *   ok=false 时 reason 见 WAIT_REASON_TEXT（区分「超时」与「判据恒假」—— 2026-09-29 卡 S9 附带建议①）
 */
export async function waitPort(want, maxMs, opts = {}) {
  const pollMs = opts.pollMs ?? 3000;
  const t0 = Date.now();
  let probes = 0, sawAnswer = false, lastStatus = 0;
  while (Date.now() - t0 < maxMs) {
    const p = await portProbe(opts);
    probes++;
    if (p.answered) sawAnswer = true;
    lastStatus = p.status;
    if (p.alive === want) return { ok: true, sec: Math.round((Date.now() - t0) / 1000), probes, status: p.status, reason: want ? "alive" : "closed" };
    await sleep(pollMs);
  }
  const reason = want
    ? (sawAnswer ? "time-out-no-alive-answer" : "time-out-no-answer")
    : "time-out-still-alive";
  return { ok: false, sec: null, probes, status: lastStatus, reason, sawAnswer };
}
async function dbInfo(p) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync("file:" + p.replace(/\\/g, "/") + "?mode=ro", { readOnly: true });
  const cols = db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
  const n = db.prepare("SELECT COUNT(*) AS n FROM memories").get().n;
  db.close();
  return { cols, count: n };
}

// ─────────────────────────────────────────── 任务注册表
const TASKS = {
  "05-3-add-columns": {
    title: "⑤-3 · 给 memory.db 加 owner_user / visibility 两列（停机窗口）",
    async precheck(ctx) {
      const info = await dbInfo(PROD_DB);
      ctx.before = info;
      log(`[预检] 生产库列(${info.cols.length})：${info.cols.join(", ")} · 条数=${info.count}`);
      if (info.cols.includes("owner_user") && info.cols.includes("visibility")) {
        log("[预检] ⏭ 两列已存在 ⇒ 无需停机维护，直接退出（不停机、零副作用）");
        return { skip: true };
      }
      for (const f of ["memory-schema-migrate.mjs", "memory-fieldname-check.mjs", "memory-identity-check.mjs"]) {
        if (!fs.existsSync(path.join(MEMTOOLS, f))) return { fail: `缺工具 ${f}` };
      }
      const mm = fs.readFileSync(path.join(DSH, "tools", "dsh-butler", "lib", "merge-memory.mjs"), "utf8");
      const dyn = mm.includes("PRAGMA table_info(memories)");
      log(`[预检] 加列硬前置（合并器动态列）：${dyn ? "✅ 已满足（PRAGMA table_info 在位）" : "❌ 未满足 → 必须先改 merge-memory.mjs"}`);
      if (!dyn) return { fail: "加列硬前置未满足：merge-memory.mjs 仍硬编码列名" };
      ctx.snapshotDir = path.join(ctx.reportDir, "snapshot");
      return { ok: true };
    },
    async maintain(ctx) {
      log("[维护] ① 停机自证 + dry-run（期望输出含「停机窗口：3080 未监听」）");
      const dry = run(process.execPath, [path.join(MEMTOOLS, "memory-schema-migrate.mjs"), "--json"]);
      ctx.dryRunOut = dry.out;
      log("[维护] ② 真迁移（--allow-production --apply --snapshot）");
      const mig = run(process.execPath, [
        path.join(MEMTOOLS, "memory-schema-migrate.mjs"),
        "--allow-production", "--apply", "--snapshot", ctx.snapshotDir, "--json",
      ]);
      ctx.migrateOut = mig.out;
      ctx.migrateStatus = mig.status;
      return mig.status === 0;
    },
    async verify(ctx) {
      const after = await dbInfo(PROD_DB);
      ctx.after = after;
      log(`[复核] 迁移后列(${after.cols.length})：${after.cols.join(", ")} · 条数=${after.count}`);
      log(`[复核] 列数 6→8：${ctx.before.cols.length === 6 && after.cols.length === 8 ? "✅" : "⚠️ 与预期不符"}`);
      log(`[复核] 条数不变（${ctx.before.count} → ${after.count}）：${ctx.before.count === after.count ? "✅" : "⚠️ 条数变了"}`);
      log("[复核] 判据 3（库侧两列）：");
      run(process.execPath, [path.join(MEMTOOLS, "memory-fieldname-check.mjs"), "--db", PROD_DB]);
      log("[复核] 判据 4（身份表缺位 ⇒ 预期 exit 2「不可用」，不是失败）：");
      run(process.execPath, [path.join(MEMTOOLS, "memory-identity-check.mjs"), "--db", PROD_DB]);
      log("[复核] ⑤-4 撤回链可用性（预期不再 fail-closed exit 3）：");
      const r = run(process.execPath, [path.join(DSH, "tools", "dsh-butler", "memory-retract.mjs"), "--dry-run", "--user", "LiJianXiao"]);
      ctx.retractStatus = r.status;
      log(`      → memory-retract --dry-run exit=${r.status}`);
      return after.cols.includes("owner_user") && after.cols.includes("visibility") && after.count === ctx.before.count;
    },
  },

  /**
   * 演练任务（2026-10-08 新增 · 卡 S10 停机窗口**前置载体** · 主人当场拍板）：
   *   **不做任何数据变更**，唯一目的 = 让 ②停服 / ⑤起回 两段**通用流程**真跑一次，
   *   从而产出 M-1（判活 401 回归）与 M-2（管道捕获 ⇒ 起回段白烧 900s）的**真机判据**：
   *     · `report.json` 的 `startSpawn{ms,error}` / `startWait.sec` / `stopSpawn`
   *     · `start-console.log` / `stop-console.log`
   *   判据（带外档 §2 W-1）：总耗时从 09-20 的 **916s → 30–60s**；**无** `[spawn error] … ETIMEDOUT`；**无**第二次 `dsh-start.ps1`。
   *   ⚠️ 为什么需要它：原唯一任务 `05-3-add-columns` 的预检见到「两列已存在」⇒ `skip` 在停机**之前**返回
   *      ⇒ ②/⑤ 段永远跑不到，M-1/M-2 的真机验收**没有载体**（2026-10-08 10:42 dry-run 实测）。
   *   ⚠️ 老任务 `05-3-add-columns` **一行未改**；本任务只在显式 `--task drill-stop-start --go` 时被选中。
   */
  "drill-stop-start": {
    title: "演练 · 只停服 + 起回（验起回段判活/管道修复 · 不动任何数据）",
    async precheck(ctx) {
      log("[预检] 演练任务：**不做数据变更**（不写文件、不动 memory.db / 会话 / 看板）");
      const need = ["dsh-shutdown.ps1", "dsh-start.ps1", "guard.mjs"];
      const miss = need.filter((f) => !fs.existsSync(path.join(DSH, f)));
      if (miss.length) return { fail: "缺启动链文件：" + miss.join(", ") };
      log("[预检] 启动链文件在位：" + need.join(" / ") + " ✅");
      log("[预检] 判活口径：" + RULE_VERSION + " —— " + ALIVE_RULE_TEXT);
      return { ok: true };
    },
    async maintain(ctx) {
      log("[维护] 演练任务：**空步骤**（本段唯一作用 = 让编排器走到 ⑤起回段；零写入）");
      return true;
    },
    async verify(ctx) {
      log("[复核] 演练任务：**无数据判据** —— 成败以 ⑤起回段（startSpawn / startWait）为准");
      return true;
    },
  },
};

// ─────────────────────────────────────────── 主流程
async function main() {
  if (has("--list") || !TASK) {
    console.log("已登记任务：");
    for (const [k, v] of Object.entries(TASKS)) console.log("  " + k + " —— " + v.title);
    console.log("\n用法：node dsh-maintenance.mjs --task <任务名>            # 缺省 dry-run（只预检，不停机）");
    console.log("      node dsh-maintenance.mjs --task <任务名> --go     # 真跑（会停 DSH！）");
    console.log("      node dsh-maintenance.mjs --list                   # 本列表");
    console.log("");
    console.log("判活口径（单一真源 guard-http.mjs · RULE_VERSION=" + RULE_VERSION + "）：" + ALIVE_RULE_TEXT);
    console.log("  ⇒ 0.1.5+ token 门下无 token 访问 / 返回 401 仍判活（旧「必须 200」判据已于 2026-09-29 修掉）。");
    process.exitCode = has("--list") ? 0 : 2;
    return;
  }
  const task = TASKS[TASK];
  if (!task) { console.error("未知任务：" + TASK); process.exitCode = 2; return; }

  const reportDir = path.join(DSH, "_archive", "maint-" + TASK + "-" + TS);
  fs.mkdirSync(reportDir, { recursive: true });
  const ctx = { reportDir, startedAt: new Date().toISOString() };
  LOGFILE = path.join(reportDir, "console.log"); // 实时日志：先于任何停机动作打开
  /** 每步落盘状态（即使进程被杀，也能看出死在哪一步） */
  const bump = (phase, note) => {
    try {
      fs.writeFileSync(path.join(reportDir, "state.json"), JSON.stringify(
        { task: TASK, pid: process.pid, self: process.argv[1], phase, note: note ?? null, at: new Date().toISOString() }, null, 2), "utf8");
    } catch { /* 状态写失败不阻断主流程 */ }
  };

  log("════ 停机维护编排器 ════");
  log("任务：" + task.title);
  log("报告目录：" + reportDir);
  log("模式：" + (DRY ? "DRY-RUN（不停机，只预检；真跑加 --go）" : "真跑（会停 DSH！）——由显式 --go 授权"));
  log("");

  let phase = "precheck";
  let result = "unknown";
  bump(phase, "编排器启动");
  try {
    log("──── ① 预检（DSH 仍在跑）────");
    const pre = await task.precheck(ctx);
    if (pre?.skip) { result = "skipped-already-done"; bump("end", result); return; }
    if (pre?.fail) { result = "precheck-failed: " + pre.fail; process.exitCode = 3; bump("end", result); return; }

    if (DRY) {
      log("");
      log("──── DRY-RUN 结束：预检通过，未执行任何停机/写入（真跑加 --go）────");
      result = "dry-run-ok";
      bump("end", result);
      return;
    }

    log("");
    log("──── ② 停 DSH（本机全部 DSH 进程；当前 DSH 会话会在此中断）────");
    phase = "stop"; bump(phase, "调 dsh-shutdown.ps1 -Yes");
    // ⚠️ M-2：停服脚本同样会动常驻进程（kill 守护鱼 / tickd），机制同源 ⇒ 一并走**文件重定向**
    //    （不给管道，就没有"管道被常驻孙进程持有"这个失败面）；顺带把这段留成独立证据文件。
    //    09-20 日志显示本段当前正常收尾（≈10s）⇒ 属**预防性**同口径处置，不改变任何判据。
    ctx.stopConsoleLog = path.join(reportDir, "stop-console.log");
    const st = run(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(DSH, "dsh-shutdown.ps1"), "-Yes"],
      { timeout: 300_000, logFile: ctx.stopConsoleLog, env: { DSH_HANDOFF_ENABLE: "0" } }); // 跳过停机 Depart 钩子（无对端在线=空转，实测可省最长 330s）
    ctx.stopOut = st.out;
    ctx.stopSpawn = { ms: st.ms, error: st.error ? (st.error.code ?? st.error.message) : null };
    const down = await waitPort(false, 90_000);
    ctx.stopWait = down;
    if (!down.ok) {
      log(`[停机] ⚠️ 90s 内 3080 仍未关闭（探 ${down.probes} 次 · 最后状态码 ${down.status} · ${down.reason}：${WAIT_REASON_TEXT[down.reason] ?? ""}）`);
      result = "stop-timeout"; bump("end", result); process.exitCode = 1; return;
    }
    log(`[停机] ✅ 3080 已关闭（${down.sec}s · 探 ${down.probes} 次）`);

    log("");
    log("──── ③ 维护任务 ────");
    phase = "maintain"; bump(phase, "跑迁移");
    const ok = await task.maintain(ctx);
    if (!ok) { result = "maintain-failed"; bump("end", result); process.exitCode = 1; return; }

    log("");
    log("──── ④ 复核 ────");
    phase = "verify"; bump(phase, "复核");
    const vok = await task.verify(ctx);
    ctx.verified = vok;
    result = vok ? "success" : "verify-warn";

    log("");
    log("──── ⑤ 起回 DSH ────");
    phase = "start"; bump(phase, "调 dsh-start.ps1");
    // ⚠️ M-2 靶心：`dsh-start.ps1` 收尾会拉起 guard.mjs / butler-tickd.mjs **常驻**进程，
    //    它们继承 stdout ⇒ 用管道捕获时 spawnSync 等不到 EOF，一路卡到 timeout（900s，已发生过）。
    //    ⇒ 本段（及兜底）一律走 **logFile**：无管道可等，spawnSync 只等 powershell 自己退出即返回；
    //    输出照旧留档到 start-console.log 并读回主日志/报告。
    ctx.startConsoleLog = path.join(reportDir, "start-console.log");
    log(`（本段子进程输出重定向到 ${ctx.startConsoleLog}；不再管道捕获 ⇒ 不会被它拉起的常驻进程拖住）`);
    const sp = run(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(DSH, "dsh-start.ps1")],
      { timeout: 900_000, logFile: ctx.startConsoleLog, env: { DSH_HANDOFF_ENABLE: "0" } }); // 跳过开机 Arrive 钩子（同上：无对端在线，纯空转最长 330s）
    ctx.startOut = sp.out;
    ctx.startSpawn = { ms: sp.ms, error: sp.error ? (sp.error.code ?? sp.error.message) : null };
    log(`[起回] dsh-start.ps1 自身收尾用时 ${(sp.ms / 1000).toFixed(1)}s · spawn error=${ctx.startSpawn.error ?? "无"}`);
    // 开机链含 P9 交接器 Arrive 钩子（预算 300s / 硬超时 330s）⇒ 就绪可能要 5–6 分钟
    const up = await waitPort(true, 600_000);
    ctx.startWait = up;
    if (!up.ok) {
      log(`[起回] ⚠️ 600s 内 3080 未就绪（探 ${up.probes} 次 · 最后状态码 ${up.status} · ${up.reason}）`);
      log(`[起回]    原因：${WAIT_REASON_TEXT[up.reason] ?? up.reason}`);
      result = "start-timeout"; bump("end", result); process.exitCode = 1; return;
    }
    log(`[起回] ✅ 3080 已就绪（${up.sec}s · 探 ${up.probes} 次 · 最后状态码 ${up.status} · 判活口径 ${RULE_VERSION}）`);
    process.exitCode = result === "success" ? 0 : 1;
  } catch (e) {
    log("[异常] " + (e?.stack ?? e));
    result = "exception: " + (e?.message ?? e);
    process.exitCode = 1;
  } finally {
    try {
      if (phase !== "precheck" && !DRY) {
        const p = await portProbe();
        if (!p.alive) {
          log(`[兜底] 3080 仍未就绪（状态码 ${p.status} · ${p.reason}）⇒ 再试一次 dsh-start.ps1`);
          // ⚠️ M-2：与 ⑤ 同口径（同一个 dsh-start.ps1、同样会拉常驻进程）⇒ 同样走文件重定向。
          ctx.fallbackConsoleLog = path.join(reportDir, "fallback-console.log");
          const fb = run(PS, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path.join(DSH, "dsh-start.ps1")],
            { timeout: 900_000, logFile: ctx.fallbackConsoleLog });
          ctx.fallbackSpawn = { ms: fb.ms, error: fb.error ? (fb.error.code ?? fb.error.message) : null };
          log(`[兜底] dsh-start.ps1 自身收尾用时 ${(fb.ms / 1000).toFixed(1)}s · spawn error=${ctx.fallbackSpawn.error ?? "无"}（日志 ${ctx.fallbackConsoleLog}）`);
          const up2 = await waitPort(true, 600_000);
          if (up2.ok) log(`[兜底] ✅ 已起回（${up2.sec}s · 判活口径 ${RULE_VERSION}）`);
          else log(`[兜底] ⚠️ 仍失败（${up2.reason}：${WAIT_REASON_TEXT[up2.reason] ?? ""}）—— 请双击桌面「DeepSeek Harness」`);
        }
      }
    } catch (e2) { log("[兜底] 异常：" + (e2?.message ?? e2)); }

    const summary = {
      task: TASK, title: task.title, mode: DRY ? "dry-run" : "real",
      result, startedAt: ctx.startedAt, endedAt: new Date().toISOString(),
      reportDir, prodDb: PROD_DB, selfPath: process.argv[1],
      before: ctx.before ?? null, after: ctx.after ?? null,
      verified: ctx.verified ?? null, migrateStatus: ctx.migrateStatus ?? null,
      retractStatus: ctx.retractStatus ?? null, snapshotDir: ctx.snapshotDir ?? null,
      probeRule: RULE_VERSION, startWait: ctx.startWait ?? null, stopWait: ctx.stopWait ?? null,
      // M-2（2026-09-29 · 卡 S11）：三处「会拉起常驻进程」调用点各自的子进程日志 + 收尾耗时/spawn error
      //   ⇒ 带外真跑时可直接判：`startSpawn.error` 不得是 ETIMEDOUT（管道形态的 M-2 是否真的消失）。
      startConsoleLog: ctx.startConsoleLog ?? null, stopConsoleLog: ctx.stopConsoleLog ?? null,
      fallbackConsoleLog: ctx.fallbackConsoleLog ?? null,
      startSpawn: ctx.startSpawn ?? null, stopSpawn: ctx.stopSpawn ?? null, fallbackSpawn: ctx.fallbackSpawn ?? null,
    };
    try {
      fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(summary, null, 2), "utf8");
      fs.writeFileSync(path.join(reportDir, "console.log"), logLines.join("\n") + "\n", "utf8");
      fs.writeFileSync(path.join(reportDir, "report.md"), [
        "# 停机维护报告 —— " + task.title,
        "",
        "- 结果：**" + result + "**",
        "- 模式：" + summary.mode,
        "- 起：" + summary.startedAt + " · 止：" + summary.endedAt,
        "- 执行脚本：" + summary.selfPath,
        "- 生产库：" + PROD_DB,
        "- 迁移前：" + (ctx.before ? ctx.before.cols.length + " 列 / " + ctx.before.count + " 条（" + ctx.before.cols.join(", ") + "）" : "未取"),
        "- 迁移后：" + (ctx.after ? ctx.after.cols.length + " 列 / " + ctx.after.count + " 条（" + ctx.after.cols.join(", ") + "）" : "未取"),
        "- 复核通过：" + (ctx.verified ?? "未跑"),
        "- 快照：" + (ctx.snapshotDir ?? "无"),
        "- 撤回链 dry-run exit：" + (ctx.retractStatus ?? "未跑"),
        "- 判活口径：" + RULE_VERSION + "（" + ALIVE_RULE_TEXT + "）",
        "- 停机等待：" + (ctx.stopWait ? JSON.stringify(ctx.stopWait) : "未跑"),
        "- 起回等待：" + (ctx.startWait ? JSON.stringify(ctx.startWait) : "未跑"),
        "- 起回子进程收尾：" + (ctx.startSpawn ? ctx.startSpawn.ms + "ms · spawn error=" + (ctx.startSpawn.error ?? "无") + " · 日志 " + ctx.startConsoleLog : "未跑"),
        "- 停机子进程收尾：" + (ctx.stopSpawn ? ctx.stopSpawn.ms + "ms · spawn error=" + (ctx.stopSpawn.error ?? "无") + " · 日志 " + ctx.stopConsoleLog : "未跑"),
        "- 兜底子进程收尾：" + (ctx.fallbackSpawn ? ctx.fallbackSpawn.ms + "ms · spawn error=" + (ctx.fallbackSpawn.error ?? "无") + " · 日志 " + ctx.fallbackConsoleLog : "未跑（未触发兜底）"),
        "",
        "## 完整控制台输出",
        "",
        "```",
        logLines.join("\n"),
        "```",
        "",
      ].join("\n"), "utf8");
      bump("end", result);
    } catch (e3) { console.log("[报告] 写盘失败：" + (e3?.message ?? e3)); }
    console.log("");
    console.log("════ 结束：result=" + result + " ════");
    console.log("报告：" + reportDir + "\\report.md");
    console.log("（DSH 是否起回请看上面 [起回] 一行；失败则双击桌面「DeepSeek Harness」快捷方式）");
  }
}

// ─────────────────────────────────────────── 参数闸门（先于自举与 main，任何动作之前）
// 未知参数一律 fail-closed（exit 2）：拼错的 `--dryrun` 若被静默忽略 ⇒ 按缺省/--go 真跑 = 停 DSH。
function validateArgs() {
  let skipNext = false;
  for (const a of argv) {
    if (skipNext) { skipNext = false; continue; }
    if (a === "--task") { skipNext = true; continue; }
    if (a === "--go" || a === "--dry-run" || a === "--list" || a === "--help" || a === "-h") continue;
    return `unknown arg: ${a}（拼错的开关会被忽略 → 必须报错而不是静默继续）`;
  }
  if (GO && EXPLICIT_DRY) return "--go 与 --dry-run 互斥，请二选一";
  return null;
}
const argErr = validateArgs();

// ─────────────────────────────────────────── 入口判定（被 import 时绝不执行编排）
// ⚠️ 必须 realpath 双边比对：junction/软链下 process.argv[1] 是**逻辑路径**、import.meta.url 是**物理路径**，
//    直接比字符串会不相等 ⇒ 守卫静默不成立 ⇒ 单测一 import 就会真跑编排器（这是最危险的失败模式）。
// 被 import 时只暴露 portProbe/waitPort/portUp/WAIT_REASON_TEXT，**不设 exitCode、不 spawn**。
function realpathOrRaw(p) { try { return fs.realpathSync(p); } catch { return String(p ?? ""); } }
const SELF_REAL = realpathOrRaw(process.argv[1] ?? "");
const MODULE_REAL = realpathOrRaw(fileURLToPath(import.meta.url));
const IS_ENTRY = !!SELF_REAL && SELF_REAL.toLowerCase() === MODULE_REAL.toLowerCase();

// ─────────────────────────────────────────── 自举（先于 main 执行）
// 判据：自身脚本路径落在 DSH 工作区内 ⇒ 复制到 %TEMP%\dsh-maint\ 后以副本继续跑，
// 否则 dsh-shutdown.ps1 的 '*<DSH_ROOT>*' 命令行特征会在停机时把本编排器一起杀掉（血案见头注）。
if (!IS_ENTRY) {
  /* 被 import：不执行任何编排动作 */
} else if (!argErr && !HELPME) {
  const self = SELF_REAL;
  if (self.toLowerCase().startsWith(DSH.toLowerCase() + path.sep)) {
    const outDir = path.join(os.tmpdir(), "dsh-maint");
    fs.mkdirSync(outDir, { recursive: true });
    const copy = path.join(outDir, "dsh-maintenance.mjs");
    fs.copyFileSync(self, copy);
    console.log("[自举] 脚本位于工作区内：" + self);
    console.log("[自举] ⚠️ 停机脚本按命令行 '*DSH 根*' 清 node ⇒ 会误杀本编排器");
    console.log("[自举] ⇒ 已复制到工作区外：" + copy + "，改由副本继续执行");
    const r = spawnSync(process.execPath, [copy, ...argv], { stdio: "inherit" });
    process.exitCode = r.status ?? 1;
  } else {
    console.log("[自举] 已在工作区外执行（" + self + "）⇒ 停机脚本射程外 ✅");
    await main();
  }
} else if (HELPME) {
  console.log(HELP_TEXT);
  process.exitCode = 0;
} else {
  console.error("用法错：" + argErr);
  console.error("");
  console.error(HELP_TEXT);
  process.exitCode = 2;
}
