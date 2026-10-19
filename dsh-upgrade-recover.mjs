#!/usr/bin/env node
// ============================================================================
// dsh-upgrade-recover.mjs —— 升级中断现场「一键恢复」（2026-10-16）
//
// 来历：2026-10-16 早晨 <HOST_C> 的 DSH 停摆 48 分钟 —— ROG 侧跑升级的卡会话在对端
//   「停了 dsh + 持了升级锁 + 开了静默窗」之后断网、再没回来收尾；守护鱼的让路判据
//   只看「锁在不在」⇒ 永不起 dsh。恢复是**手工现敲**的（见
//   docs\事故-<HOST_C>升级锁卡死-20261016.md §3）。本脚本把那套固化 + 补上「该不该动」的判断。
//
// 一句话：**默认只报告（dry-run），`--apply` 才动**；判定 fail-closed ——
//   「升级可能真在进行中」一律拒动、退出码非 0。
//
// 用法：
//   node <DSH_ROOT>\tools\dsh-upgrade-recover.mjs [--target local|<HOST_C>|tuf] [--apply] [--json]
//
//   取证（只读）：目标机的 升级锁状态 / 静默窗状态 / 3080 是否 LISTEN / 守护鱼最近让路行
//   判定（fail-closed）：
//     · 锁 none          → 无需清锁（继续看静默窗与服务）
//     · 锁 done          → 已收尾未释放 ⇒ 同样挡住守护鱼 ⇒ 允许清
//     · 锁 held          → **拒动**：心跳新鲜 ⇒ 升级可能真在进行中
//     · 锁 uncertain     → **拒动**：心跳过期但持有进程仍活 ⇒ 人工确认
//     · 锁 unknown/corrupt → **拒动**：判不准 ⇒ 人工看
//     · 锁 interrupted   → 允许恢复：持有进程已退出 或 心跳超 TTL
//   恢复（仅 --apply）：清锁 → 释放静默窗 → 等守护鱼接管（轮询 3080）→ 验证 + 留痕
//
// 参数：
//   --target <local|<HOST_C>|tuf>  目标机（默认 local）
//   --apply                     真恢复（默认 dry-run；dry-run 零写入）
//   --json                      机读输出（stdout 只有 JSON）
//   --home <dir>                目标机上的 .dsh 目录（默认由对端 CLI 自己解析 ~/.dsh）
//   --state-dir <dir>           `--home` 的同义词（静默窗状态文件也在这个目录下）
//   --ssh <alias>               显式指定 SSH 别名（默认 <HOST_C>-lan→<HOST_C> / tuf-lan→tuf 自动探测）
//   --wait-sec <n>              apply 后等守护鱼接管的最长秒数（默认 120）
//   --poll-sec <n>              等待轮询间隔（默认 5）
//   --reason <text>             clear / enable 的原因（远端目标要求纯 ASCII）
//   --no-changelog              apply 后不写变更流水
//   --no-force-enable           静默窗开着但读不到 holder id 时，不许走逃生舱
//   --dry-run                   显式声明 dry-run（默认即是）
//   --help
//
// 退出码：
//   0 = 正常（无需恢复 / dry-run 打印了动作 / apply 成功且 3080 已监听）
//   1 = 拒动（fail-closed：升级可能真在进行中 / 判不准 → 人工）
//   2 = 用法错误
//   3 = 通道或执行失败（目标不可达 / CLI 跑不起来 / 输出不可解析）
//   4 = apply 之后验证失败（3080 仍未监听）
//
// 🔴 铁律：
//   · 绝不在本机生产的锁/静默窗上做实验 —— 演练用 `--home <夹具目录>` 隔离
//   · 夹具模式（自定义 --home）下，静默窗恢复**一律降级为 --dry-run**
//     （防"拿夹具 home 却把本机真服务放回来"；锁的 clear 只碰夹具文件，仍真执行）
//   · 不动锁/静默窗的机制 —— 只调用既有 CLI（upgrade-lock-cli.mjs / dsh-upgrade-silence.mjs）
//   · 静默窗语义反直觉：`--disable --holder <id>` = **开窗**；`--enable` = **释放**
//   · 本脚本只做「解锁 + 放窗 + 等接管」，**不做升级回滚**
//     （如本次升级已改动文件，先用锁里 backupDir 的 restore-upgrade.mjs 回滚，再解锁）
//   · 本脚本不碰本机 DSH 进程（只读 netstat + 调既有 CLI），绝不 taskkill
// ============================================================================
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------- 常量 / 目标表

const TOOLS_DIR = process.env.DSH_TOOLS_DIR || path.dirname(fileURLToPath(import.meta.url));
const BUTLER_DIR = path.join(TOOLS_DIR, 'dsh-butler');
const LOCK_CLI = path.join(BUTLER_DIR, 'upgrade-lock-cli.mjs');
const SILENCE_CLI = path.join(TOOLS_DIR, 'dsh-upgrade-silence.mjs');
const CHANGELOG_CLI = path.join(BUTLER_DIR, 'changelog-add.mjs');

const CONNECT_TIMEOUT_SEC = 8;
const DEFAULT_WAIT_SEC = 120;
const DEFAULT_POLL_SEC = 5;

/** 允许恢复的锁状态（判据 = 持有进程已退出 或 心跳超 TTL）。 */
const LOCK_RECOVERABLE = new Set(['interrupted', 'done']);
/** 一律拒动的锁状态（fail-closed 的核心）。 */
const LOCK_REFUSING = new Set(['held', 'uncertain', 'unknown']);
const LOCK_KNOWN = new Set(['none', 'done', 'interrupted', 'held', 'uncertain', 'unknown']);

const TARGETS = {
  local: {
    id: 'local', kind: 'local', label: '本机',
    expectHost: os.hostname(),
    guardLogLocal: path.join(os.tmpdir(), 'dsh-guard', 'guard2.log'),
  },
  'peer-a': {
    id: 'peer-a', kind: 'ssh', label: '对端 A（SSH 目标）',
    expectHost: process.env.DSH_PEER_A_HOST || '',
    sshCandidates: (process.env.DSH_PEER_A_SSH || 'peer-a').split(',').map((s) => s.trim()).filter(Boolean),
    guardLogRemote: '%TEMP%\\dsh-guard\\guard2.log',
    pathPrefix: 'set PATH=%ProgramFiles%\\nodejs;%PATH% & ',
  },
  'peer-b': {
    id: 'peer-b', kind: 'ssh', label: '对端 B（SSH 目标）',
    expectHost: process.env.DSH_PEER_B_HOST || '',
    sshCandidates: (process.env.DSH_PEER_B_SSH || 'peer-b').split(',').map((s) => s.trim()).filter(Boolean),
    guardLogRemote: '%TEMP%\\dsh-guard\\guard2.log',
    pathPrefix: 'set PATH=%ProgramFiles%\\nodejs;%PATH% & ',
  },
};

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  if (i < 0 || i + 1 >= argv.length) return null;
  const v = argv[i + 1];
  return v.startsWith('--') ? null : v;
};

const JSON_OUT = has('json');
const APPLY = has('apply');
const NO_CHANGELOG = has('no-changelog');
const NO_FORCE_ENABLE = has('no-force-enable');
const WAIT_SEC = Number(opt('wait-sec') ?? DEFAULT_WAIT_SEC);
const POLL_SEC = Number(opt('poll-sec') ?? DEFAULT_POLL_SEC);
const HOME_ARG = opt('home') ?? opt('state-dir');
const SSH_ARG = opt('ssh');
const REASON_ARG = opt('reason');
const TARGET_ID = (opt('target') ?? 'local').toLowerCase();

/** 夹具模式 = 显式传了自定义 home ⇒ 绝不用它去动本机真服务。 */
const IS_FIXTURE = !!HOME_ARG;

// ---------------------------------------------------------------- 小工具

const say = (...a) => { if (!JSON_OUT) process.stdout.write(a.join(' ') + '\n'); };
const warns = (...a) => process.stderr.write(a.join(' ') + '\n');

function decodeBuf(buf) {
  if (!buf || !buf.length) return '';
  const u = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (!u.includes('\uFFFD')) return u;
  try { return new TextDecoder('gbk').decode(buf); } catch { return u; }
}

function isMain() {
  try {
    const a = fs.realpathSync(fileURLToPath(import.meta.url));
    const b = process.argv[1] ? fs.realpathSync(process.argv[1]) : '';
    return a === b;
  } catch { return false; }
}

/** 纯 ASCII 检查（远端 cmd 走 GBK 码页：非 ASCII 传过去会变乱码 ⇒ 拒动）。 */
const isAscii = (s) => /^[\x20-\x7E]*$/.test(String(s ?? ''));

/**
 * cmd 参数安全引号（远端拼接用）。返回 null = 拒绝（fail-closed，绝不静默乱拼）。
 * · `%` 会展开、`"^&|<>` 是 cmd 元字符 ⇒ 一律拒（路径/取值里不该出现）
 * · 含空格 ⇒ 双引号包裹（经 ssh 客户端 argv → 远端 cmd，实测可行）
 */
function cmdQuote(a) {
  const s = String(a);
  if (/["%^&|<>]/.test(s)) return null;
  if (/^[-A-Za-z0-9._:\\/=+()]+$/.test(s)) return s;
  if (/[\s]/.test(s)) return `"${s}"`;
  return null;
}

/** 本地跑 node 子进程（不经 shell，避免引号地狱）。 */
function localNode(args, { timeoutMs = 120000 } = {}) {
  const r = spawnSync(process.execPath, args, {
    encoding: 'buffer', windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    code: r.status, timedOut: r.error?.code === 'ETIMEDOUT',
    out: decodeBuf(r.stdout), err: decodeBuf(r.stderr),
    error: r.error ? `${r.error.code ?? ''} ${r.error.message}`.trim() : null,
  };
}

/** 远端跑一条 cmd 命令（远端默认 shell = cmd.exe）。 */
function sshRun(alias, cmdline, { timeoutMs = 180000 } = {}) {
  const r = spawnSync('ssh', [
    '-o', 'BatchMode=yes', '-o', `ConnectTimeout=${CONNECT_TIMEOUT_SEC}`, alias, cmdline,
  ], {
    encoding: 'buffer', windowsHide: true, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return {
    code: r.status, timedOut: r.error?.code === 'ETIMEDOUT',
    out: decodeBuf(r.stdout), err: decodeBuf(r.stderr),
    error: r.error ? `${r.error.code ?? ''} ${r.error.message}`.trim() : null,
  };
}

/** 尽量把 CLI 的 JSON 解析出来（找第一个 { 到最后一个 }）。 */
function looseJson(text) {
  if (!text) return null;
  const s = text.indexOf('{');
  const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

/** 读文件尾部（大日志用）。 */
function tailText(file, bytes = 262144) {
  const st = fs.statSync(file);
  const len = Math.min(bytes, st.size);
  const start = Math.max(0, st.size - bytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, buf.length, start);
    return decodeBuf(buf);
  } finally { fs.closeSync(fd); }
}

// ---------------------------------------------------------------- 通道

/** 自动选 SSH 别名（lan 优先 → 隧道回落）；--ssh 显式指定则直接用。 */
function resolveChannel(target) {
  if (target.kind === 'local') return { alias: null, hostname: target.expectHost, probed: [] };
  if (SSH_ARG) {
    const r = sshRun(SSH_ARG, 'hostname', { timeoutMs: 20000 });
    return {
      alias: SSH_ARG, hostname: r.out.trim() || null,
      probed: [{ alias: SSH_ARG, ok: r.code === 0, hostname: r.out.trim() || null, err: firstLine(r.err || r.error) }],
    };
  }
  const probed = [];
  for (const alias of target.sshCandidates) {
    const r = sshRun(alias, 'hostname', { timeoutMs: 20000 });
    const host = r.out.trim();
    const ok = r.code === 0 && host.toLowerCase() === target.expectHost.toLowerCase();
    probed.push({ alias, ok, hostname: host || null, err: firstLine(r.err || r.error) });
    if (ok) return { alias, hostname: host, probed };
  }
  return { alias: null, hostname: null, probed };
}

const firstLine = (s) => String(s ?? '').trim().split(/\r?\n/)[0] || null;

/** 在目标机上跑一个 node 脚本（远端参数走 cmdQuote，拒绝即拒动）。 */
function runNodeOn(target, alias, args, opts) {
  if (target.kind === 'local') return localNode(args, opts);
  const quoted = [];
  for (const a of args) {
    const q = cmdQuote(a);
    if (q === null) {
      return { code: null, out: '', err: `内部错误：远端参数含 cmd 不安全字符，拒绝拼接：${a}`, error: 'unsafe-arg' };
    }
    quoted.push(q);
  }
  return sshRun(alias, `${target.pathPrefix}node ${quoted.join(' ')}`, opts);
}

/** 目标机上 .dsh 目录的展示名（未显式传 --home 时）。 */
const homeLabel = (target) => (HOME_ARG ? HOME_ARG
  : (target.kind === 'local' ? '本机默认 ~/.dsh' : '对端默认 %USERPROFILE%\\.dsh'));
const homeArgs = () => (HOME_ARG ? ['--home', HOME_ARG] : []);

// ---------------------------------------------------------------- 取证

function probeLock(target, alias) {
  const r = runNodeOn(target, alias, [LOCK_CLI, 'status', '--json', ...homeArgs()], { timeoutMs: 120000 });
  const json = looseJson(r.out);
  return {
    ok: r.code !== null && !!json,
    exitCode: r.code, json,
    stdout: r.out.trim().slice(0, 4000), stderr: r.err.trim().slice(0, 2000), error: r.error,
    state: json?.state ?? null,
    corrupt: json?.corrupt ?? null,
    pidAlive: json?.pidAlive ?? null,
    heartbeatAgeMs: json?.heartbeatAgeMs ?? null,
    ttlMs: json?.ttlMs ?? null,
    ageMs: json?.ageMs ?? null,
    lock: json?.lock ?? null,
    summary: json?.summary ?? null,
    hint: json?.hint ?? null,
    file: json?.file ?? null,
  };
}

function probeSilence(target, alias) {
  const r = runNodeOn(target, alias, [SILENCE_CLI, '--status', '--json', ...homeArgs()], { timeoutMs: 180000 });
  const json = looseJson(r.out);
  return {
    ok: r.code !== null && !!json,
    exitCode: r.code, json,
    stdout: r.out.trim().slice(0, 4000), stderr: r.err.trim().slice(0, 2000), error: r.error,
    inWindow: json?.inSilenceWindow ?? null,
    holders: Array.isArray(json?.holders) ? json.holders : [],
    staleHolders: Array.isArray(json?.staleHolders) ? json.staleHolders : [],
    verdict: json?.verdict ?? null,
    tickd: json?.tickd ?? null,
    state: json?.state ?? null,
    stateFile: json?.stateFile ?? null,
  };
}

function probeService(target, alias) {
  if (target.kind === 'local') {
    const r = spawnSync('netstat', ['-ano'], { encoding: 'buffer', windowsHide: true, timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    const lines = decodeBuf(r.stdout).split(/\r?\n/).filter((l) => /LISTENING/i.test(l) && /:3080\s/.test(l));
    return { listening: lines.length > 0, lines: lines.map((l) => l.trim()).slice(0, 5), via: 'netstat -ano（本机）' };
  }
  const r = sshRun(alias, 'netstat -ano | findstr LISTENING | findstr :3080', { timeoutMs: 60000 });
  const lines = (r.out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return { listening: lines.length > 0, lines: lines.slice(0, 5), via: `netstat -ano | findstr（${alias}）` };
}

/** 守护鱼最近与让路相关的日志行（只作旁证，不参与 fail-closed 判定）。 */
function probeGuardLog(target, alias) {
  const MAX = 5;
  try {
    if (target.kind === 'local') {
      if (!fs.existsSync(target.guardLogLocal)) {
        return { ok: false, path: target.guardLogLocal, reason: '日志不存在', lines: [], last: null, lettingGo: null };
      }
      const hits = tailText(target.guardLogLocal).split(/\r?\n/).filter((l) => l.includes('LANE-GATE')).slice(-MAX);
      return summarizeGuard(target.guardLogLocal, hits);
    }
    const r = sshRun(alias, `findstr /C:LANE-GATE ${target.guardLogRemote}`, { timeoutMs: 60000 });
    const hits = (r.out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-MAX);
    return summarizeGuard(target.guardLogRemote, hits);
  } catch (e) {
    return { ok: false, path: null, reason: `${e?.message ?? e}`, lines: [], last: null, lettingGo: null };
  }
}

function summarizeGuard(p, hits) {
  const last = hits.length ? hits[hits.length - 1] : null;
  const lettingGo = last ? /auto takeover suppressed|让路|不接管/.test(last) : null;
  return { ok: true, path: p, lines: hits, last, lettingGo };
}

// ---------------------------------------------------------------- 判定（fail-closed）

/**
 * 纯函数判定：该不该恢复。**这是本卡存在的意义** —— 「升级真在跑」必须拒动。
 * @param {{lock:object, silence:object, fixture:boolean, targetId:string}} inp
 */
function decide(inp) {
  const { lock, silence, targetId } = inp;
  const plan = [];
  const notes = [];
  const refuse = (reason, detail) => ({ verdict: 'refuse', code: 1, reason, detail: detail ?? {}, plan, notes });

  // ① 锁：CLI 跑不起来 / 输出不可解析 ⇒ 判不准 ⇒ 拒动
  if (!lock.ok) {
    return refuse('升级锁状态取不到（CLI 执行失败或输出不可解析）→ 拒绝恢复，请人工看',
      { exitCode: lock.exitCode, stderr: lock.stderr || lock.error || null });
  }
  const st = lock.state;
  if (!LOCK_KNOWN.has(st)) {
    return refuse(`锁状态无法识别（${st}）→ 拒绝恢复，请人工看 ${lock.file ?? ''}`.trim(), { state: st });
  }
  if (LOCK_REFUSING.has(st)) {
    const why = st === 'held'
      ? '心跳新鲜（升级流程每步 update 会刷心跳）⇒ 升级可能真在进行中'
      : (st === 'uncertain'
        ? '心跳已过期但持有进程仍存活 ⇒ 可能卡在长步骤里'
        : '锁文件损坏 / 时间戳不可解析 ⇒ 判不准');
    return refuse(`升级可能真在进行中，拒绝恢复（锁状态 ${st}：${why}）`, {
      state: st, corrupt: lock.corrupt, summary: lock.summary,
      pidAlive: lock.pidAlive, heartbeatAgeMs: lock.heartbeatAgeMs, ttlMs: lock.ttlMs,
      hint: '先人工确认该升级是否还在推进（看持有进程 / 心跳新鲜度）；确认已停再跑本脚本。'
        + '要强行动作请走人工 CLI：node tools\\dsh-butler\\upgrade-lock-cli.mjs clear --force',
    });
  }
  if (LOCK_RECOVERABLE.has(st)) {
    const why = st === 'done'
      ? '锁 phase=done（升级流程已宣告完成）但没释放 ⇒ 同样会挡住守护鱼接管'
      : '持有进程已退出 或 心跳超 TTL ⇒ 中断现场';
    plan.push({
      id: 'clear-lock', action: '释放升级锁（clear）', why,
      cmd: [LOCK_CLI, 'clear', ...(REASON_ARG ? ['--reason', REASON_ARG] : []), ...homeArgs()],
      stateBefore: st,
    });
    if (lock.lock?.backupDir) {
      notes.push(`⚠️ 解锁前请确认本次升级**未改动文件**；若已改动，先用 ${path.join(lock.lock.backupDir, 'restore-upgrade.mjs')} 回滚（本脚本不做回滚）`);
    } else {
      notes.push('⚠️ 解锁前请确认本次升级**未改动文件**（锁里没记 backupDir，回滚资产见 docs\\升级L1-资产与回滚-20260911.md）');
    }
    if (lock.lock?.step) {
      notes.push(`锁内现场：step=${lock.lock.step} · phase=${lock.lock.phase ?? '?'} · pid=${lock.lock.pid ?? '?'} · 起于 ${lock.lock.startedAt ?? '?'}`);
    }
  } else if (st === 'none') {
    notes.push('无锁：没有升级在进行 ⇒ 无需清锁');
  }

  // ② 静默窗
  if (!silence.ok) {
    return refuse('静默窗状态取不到（CLI 执行失败或输出不可解析）→ 拒绝恢复，请人工看',
      { exitCode: silence.exitCode, stderr: silence.stderr || silence.error || null });
  }
  if (silence.inWindow) {
    const ids = silence.holders.map((h) => h?.id).filter(Boolean);
    const bad = ids.find((id) => !/^[A-Za-z0-9._:-]+$/.test(id));
    if (bad) {
      return refuse(`静默窗持有者 id 含不安全字符（${bad}）→ 拒绝自动释放，请人工跑 --enable --holder <id>`, { holders: silence.holders });
    }
    if (ids.length) {
      for (const id of ids) {
        plan.push({
          id: 'release-silence',
          action: `释放静默窗持有者 ${id}（--enable = 释放；--disable 才是开窗）`,
          why: '静默窗开着会压住 tickd 看护（守护鱼 TICKD-WATCH 按红线跳过拉起）',
          cmd: [SILENCE_CLI, '--enable', '--holder', id, ...(REASON_ARG ? ['--reason', REASON_ARG] : []), ...homeArgs()],
          holder: id,
        });
      }
    } else if (NO_FORCE_ENABLE) {
      notes.push('⚠️ 静默窗开着但读不到任何 holder id（异常/半完成态）；已按 --no-force-enable 不走逃生舱 ⇒ 窗保持开着，需人工处置');
    } else {
      const reason = REASON_ARG ?? `upgrade-recover: silence window open but no holder on record (target=${targetId})`;
      const t = TARGETS[targetId];
      if (t.kind === 'ssh' && !isAscii(reason)) {
        return refuse('逃生舱 --reason 含非 ASCII（远端 cmd 按 GBK 解析会乱码）→ 拒绝；请改用纯 ASCII 的 --reason', { reason });
      }
      plan.push({
        id: 'force-enable-silence',
        action: '逃生舱：--force-enable 强制关闭静默窗',
        why: '窗开着但 holders 为空/读不到 ⇒ 没有正常路径可释放（该路径会写审计 + 告警）',
        cmd: [SILENCE_CLI, '--force-enable', '--reason', reason, ...homeArgs()],
        holder: null,
      });
    }
  } else if (silence.json) {
    notes.push('静默窗未开启 ⇒ 无需关窗');
  }

  if (!plan.length) return { verdict: 'no-action', code: 0, reason: '锁与静默窗都无需恢复', detail: {}, plan, notes };
  plan.push({
    id: 'wait-takeover',
    action: `等守护鱼自动接管（轮询 3080，最多 ${WAIT_SEC} 秒）`,
    why: '锁/窗一放开，守护鱼 4 秒内会自动 START dsh（2026-10-16 实测）',
  });
  return {
    verdict: 'recoverable', code: 0,
    reason: `判为可恢复：${plan.filter((p) => p.id !== 'wait-takeover').map((p) => p.action).join('；')}`,
    detail: {}, plan, notes,
  };
}

// ---------------------------------------------------------------- 执行（仅 --apply）

async function applyPlan(target, alias, plan, ctx) {
  const done = [];
  for (const step of plan) {
    if (step.id === 'wait-takeover') continue;
    say('');
    say(`▶ 将执行：${step.action}`);
    say(`   ${target.kind === 'ssh' ? `[${alias}] ` : ''}node ${step.cmd.join(' ')}`);

    let cmd = step.cmd;
    let fixtureDowngrade = false;
    if (ctx.fixture && (step.id === 'release-silence' || step.id === 'force-enable-silence')) {
      cmd = [...step.cmd, '--dry-run'];
      fixtureDowngrade = true;
      say('   （夹具模式：静默窗动作降级为 --dry-run —— 绝不用夹具 home 把本机真服务放回来）');
    }
    const rc = runNodeOn(target, alias, cmd, { timeoutMs: 240000 });
    const ok = rc.code === 0;
    if (!ok) {
      warns(`   ✗ 失败（exit ${rc.code}）：${tail(rc.err || rc.out, 300)}`);
      done.push({ ...slim(step), status: 'failed', exitCode: rc.code, out: tail(rc.out), err: tail(rc.err, 400) });
      return { ok: false, steps: done, failedAt: step.id };
    }
    say(`   ✓ ${tail(rc.out, 200)}`);
    done.push({
      ...slim(step), status: fixtureDowngrade ? 'dry-run(fixture)' : 'ok',
      exitCode: rc.code, out: tail(rc.out), err: tail(rc.err, 400),
    });
  }

  // 等服务自动接管：轮询 3080
  const deadline = Date.now() + Math.max(0, WAIT_SEC) * 1000;
  say('');
  say(`▶ 等待守护鱼自动接管（轮询 3080，最多 ${WAIT_SEC} 秒）`);
  await sleep(3000);
  let svc = probeService(target, alias);
  while (!svc.listening && Date.now() < deadline) {
    await sleep(Math.max(1, POLL_SEC) * 1000);
    svc = probeService(target, alias);
  }
  say(svc.listening ? '   ✓ 3080 已监听' : '   ✗ 超时：3080 仍未监听');
  done.push({
    id: 'wait-takeover', action: '等待守护鱼接管并验证 3080',
    status: svc.listening ? 'ok' : 'failed', listening: svc.listening, service: svc,
  });
  return { ok: !!svc.listening, steps: done, service: svc };
}

function slim(step) {
  return { id: step.id, action: step.action, holder: step.holder ?? null, stateBefore: step.stateBefore ?? null };
}
const tail = (s, n = 800) => String(s ?? '').trim().split(/\r?\n/).filter(Boolean).slice(0, 6).join(' | ').slice(0, n);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- 留痕

function recordChangelog(target, alias, text) {
  if (NO_CHANGELOG) return { skipped: true, reason: 'no-changelog' };
  const args = [CHANGELOG_CLI, '--text', text];
  if (target.kind === 'local') {
    const r = localNode(args, { timeoutMs: 60000 });
    return { ok: r.code === 0, exitCode: r.code, out: tail(r.out, 200), err: tail(r.err, 200) };
  }
  if (!isAscii(text)) return { ok: false, reason: 'ascii-required（远端留痕文本必须纯 ASCII）' };
  const r = runNodeOn(target, alias, args, { timeoutMs: 60000 });
  return { ok: r.code === 0, exitCode: r.code, out: tail(r.out, 200), err: tail(r.err, 200) };
}

// ---------------------------------------------------------------- 输出

function printHelp() {
  const L = [];
  L.push('dsh-upgrade-recover —— 升级中断现场一键恢复（默认 dry-run，--apply 才动）');
  L.push('');
  L.push('用法：node dsh-upgrade-recover.mjs [--target local|peer-a|peer-b] [--apply] [--json]');
  L.push('');
  L.push('目标（--target，默认 local）：local 本机 / peer-a / peer-b（对端由 DSH_PEER_A_* / DSH_PEER_B_* 配置）');
  L.push('  SSH 别名：默认取 DSH_PEER_A_SSH / DSH_PEER_B_SSH（逗号分隔、按序探测）；可用 --ssh <别名> 指定');
  L.push('参数：');
  L.push('  --apply              真恢复（清锁 → 释放静默窗 → 等守护鱼接管 → 验证 3080）；缺省 = dry-run 零写入');
  L.push('  --json               机读输出');
  L.push('  --home <dir>         目标机上的 .dsh 目录（缺省由对端 CLI 自己解析 ~/.dsh）');
  L.push('  --state-dir <dir>    --home 的同义词（静默窗状态文件同目录）');
  L.push('  --ssh <alias>        显式指定 SSH 别名');
  L.push('  --wait-sec <n>       apply 后等接管的最长秒数（默认 120）');
  L.push('  --poll-sec <n>       轮询间隔（默认 5）');
  L.push('  --reason <text>      clear / enable 的原因（远端目标要求纯 ASCII）');
  L.push('  --no-changelog       不写变更流水');
  L.push('  --no-force-enable    静默窗读不到 holder id 时不许走逃生舱');
  L.push('');
  L.push('判定（fail-closed）：');
  L.push('  锁 none             → 无需清锁（继续看静默窗与服务）');
  L.push('  锁 done             → 已收尾未释放 ⇒ 同样挡住守护鱼 ⇒ 允许清');
  L.push('  锁 held（心跳新鲜）  → **拒动**：升级可能真在进行中');
  L.push('  锁 uncertain（pid 活、心跳过期）→ **拒动**：人工确认');
  L.push('  锁 unknown/corrupt   → **拒动**：判不准，人工看');
  L.push('  锁 interrupted（pid 退出 或 心跳超 TTL）→ 允许恢复');
  L.push('');
  L.push('⚠️ 静默窗语义反直觉：`--disable --holder <id>` = 开窗；`--enable` = 释放');
  L.push('⚠️ 本脚本只解锁 + 放窗 + 等接管，**不做升级回滚**（改了文件先用锁里 backupDir 的 restore-upgrade.mjs）');
  L.push('⚠️ 夹具模式（自定义 --home）下静默窗动作自动降级 --dry-run，防误动本机真服务');
  L.push('退出码：0 正常 / 1 拒动 / 2 用法错 / 3 通道或执行失败 / 4 apply 后 3080 仍未监听');
  process.stdout.write(L.join('\n') + '\n');
  return 0;
}

function printHuman(rep) {
  const t = TARGETS[rep.target];
  say(`=== 升级中断恢复 · 目标 ${t.label}（${rep.target}）｜模式 ${rep.apply ? 'APPLY（真写）' : 'dry-run（零写入）'} ===`);
  say(`① 通道：${rep.channel.alias ? `ssh ${rep.channel.alias} → ${rep.channel.hostname}` : `本机（${rep.channel.hostname}）`} ${rep.channel.ok ? '✓' : '✗'}`);
  say(`   home：${homeLabel(t)}${rep.fixture ? '（夹具模式：静默窗动作一律降级 --dry-run）' : ''}`);

  const lk = rep.probes.lock;
  say('');
  say(`② 升级锁：${lk.state ?? '（取不到）'}${lk.summary ? ` — ${lk.summary}` : ''}`);
  say(`   文件：${lk.file ?? '?'}`);
  if (lk.corrupt) say(`   ⚠️ 锁文件不可解析：${lk.corrupt}`);
  if (lk.ok && lk.lock) {
    say(`   心跳：${lk.heartbeatAgeMs === null ? '?' : Math.round(lk.heartbeatAgeMs / 60000) + ' 分钟前'}`
      + `（TTL ${lk.ttlMs === null ? '?' : Math.round(lk.ttlMs / 60000) + ' 分钟'}）`
      + ` · pid ${lk.lock?.pid ?? '?'} ${lk.pidAlive ? '存活' : '已退出'}`);
  } else if (!lk.ok) {
    say(`   ⚠️ 取不到锁状态：exit ${lk.exitCode} ${lk.stderr || lk.error || ''}`.trim());
  }

  const sil = rep.probes.silence;
  say('');
  say(`③ 静默窗：${sil.inWindow ? `仍开着（${sil.holders.length} 个持有者）` : (sil.ok ? '未开启' : '（取不到）')}`);
  for (const h of sil.holders) {
    const age = h.ageMs === null || h.ageMs === undefined ? '?'
      : (h.ageMs >= 3600000 ? `${(h.ageMs / 3600000).toFixed(1)}h` : `${Math.round(h.ageMs / 60000)}min`);
    say(`   · ${h.id} — 持有 ${age}${h.stale ? ' ⚠️ 超期>4h' : ''}${h.reason ? `｜${h.reason}` : ''}`);
  }
  if (sil.tickd) say(`   tickd：${sil.tickd.running ? `running (pid ${sil.tickd.pid})` : 'not running'}`);

  const sv = rep.probes.service;
  say('');
  say(`④ 服务：3080 ${sv.listening ? 'LISTENING ✓' : '未监听 ✗'}（${sv.via}）`);

  const gl = rep.probes.guardLog;
  say('');
  say(`⑤ 守护鱼日志：${gl.ok ? gl.path : `不可读（${gl.reason ?? '?'}）`}`);
  if (gl.ok && gl.lines.length) {
    const tag = gl.lettingGo === true ? '（最近一条 = **仍在让路**）' : (gl.lettingGo === false ? '（最近一条 = 让路已解除）' : '');
    say(`   最近 LANE-GATE 行 ${gl.lines.length} 条${tag}：`);
    for (const l of gl.lines) say(`   ${l.slice(0, 200)}`);
  } else if (gl.ok) {
    say('   无 LANE-GATE 行（该日志里没出现过闸门判定）');
  }

  say('');
  say('---');
  const icon = { refuse: '⛔', recoverable: '🔧', 'no-action': '✅', unreachable: '📡' }[rep.verdict] ?? '❔';
  say(`${icon} 判定：${String(rep.verdict).toUpperCase()} — ${rep.reason}`);
  for (const n of rep.notes) say(`   ${n}`);
  if (rep.plan.length) {
    say('');
    say(rep.apply ? '执行：' : '将执行（dry-run 不落地）：');
    rep.plan.forEach((p, i) => {
      say(`   ${i + 1}. ${p.action}`);
      if (p.cmd) say(`      node ${p.cmd.join(' ')}`);
    });
  }
  if (rep.verdict === 'recoverable' && !rep.apply) {
    say('');
    say('（dry-run：零写入；确认无误后加 --apply 真恢复）');
  }
  if (rep.verdict === 'no-action' && !sv.listening) {
    say('');
    say('注意：无锁无窗但 3080 未监听 ⇒ 本脚本无事可做；服务为何没起请看守护鱼日志（guard2.log）。');
  }
  say('');
}

function printUnreachable(rep) {
  const t = TARGETS[rep.target];
  say(`=== 升级中断恢复 · 目标 ${t.label}（${rep.target}）｜模式 ${rep.apply ? 'APPLY' : 'dry-run'} ===`);
  say(`📡 通道不可达：${rep.reason}`);
  for (const p of rep.channel.probed) say(`   · ${p.alias} → ${p.err ?? '失败'}`);
  if (rep.hint) say(`   → ${rep.hint}`);
}

// ---------------------------------------------------------------- main

async function main() {
  if (has('help') || has('-h')) return printHelp();
  if (!Number.isFinite(WAIT_SEC) || WAIT_SEC < 0 || !Number.isFinite(POLL_SEC) || POLL_SEC < 1) {
    warns('用法错：--wait-sec / --poll-sec 必须是数字\n');
    return 2;
  }
  const target = TARGETS[TARGET_ID];
  if (!target) {
    warns(`用法错：未知目标 ${TARGET_ID}（可选 ${Object.keys(TARGETS).join(' / ')}）\n`);
    return 2;
  }
  // 远端目标 + 非 ASCII 的 --reason：cmd 按 GBK 解析 ⇒ 会写乱码进日志 ⇒ fail-closed
  if (target.kind === 'ssh' && REASON_ARG && !isAscii(REASON_ARG)) {
    warns('用法错：远端目标的 --reason 必须纯 ASCII（远端 cmd 按 GBK 解析，中文会写乱码进审计）\n');
    return 2;
  }

  const rep = {
    ok: false, tool: 'dsh-upgrade-recover', version: 1, at: new Date().toISOString(),
    from: os.hostname(), target: TARGET_ID, apply: APPLY, fixture: IS_FIXTURE,
    home: HOME_ARG ?? null, plan: [], notes: [], steps: [],
  };

  const ch = resolveChannel(target);
  rep.channel = { alias: ch.alias, hostname: ch.hostname, ok: !!ch.alias || target.kind === 'local', probed: ch.probed };
  if (!rep.channel.ok) {
    rep.verdict = 'unreachable';
    rep.reason = `目标 ${TARGET_ID} 不可达（候选别名全部失败）`;
    rep.hint = '公司有线网需按需短租隧道：node tools\\relay\\relay-cli.mjs enable && node tools\\relay\\relay-cli.mjs up（用完 down）';
    if (JSON_OUT) process.stdout.write(JSON.stringify(rep, null, 2) + '\n'); else printUnreachable(rep);
    return 3;
  }

  // 取证（全部只读）
  const lock = probeLock(target, ch.alias);
  const silence = probeSilence(target, ch.alias);
  const service = probeService(target, ch.alias);
  const guardLog = probeGuardLog(target, ch.alias);
  rep.probes = { lock, silence, service, guardLog };

  // 判定
  const d = decide({ lock, silence, fixture: IS_FIXTURE, targetId: TARGET_ID });
  rep.verdict = d.verdict;
  rep.reason = d.reason;
  rep.plan = d.plan;
  rep.notes = d.notes;
  rep.decision = d.detail ?? {};
  rep.ok = d.verdict !== 'refuse';

  // dry-run / 拒动：到此为止（零写入）
  if (!APPLY || d.verdict === 'refuse') {
    if (JSON_OUT) process.stdout.write(JSON.stringify(rep, null, 2) + '\n'); else printHuman(rep);
    return d.code;
  }

  if (!d.plan.length) {
    rep.ok = true;
    rep.steps = [{ id: 'none', action: '无需恢复', status: 'ok' }];
    if (JSON_OUT) process.stdout.write(JSON.stringify(rep, null, 2) + '\n'); else printHuman(rep);
    return 0;
  }

  if (!JSON_OUT) printHuman(rep);

  const res = await applyPlan(target, ch.alias, d.plan, { fixture: IS_FIXTURE });
  rep.steps = res.steps;
  rep.ok = res.ok;
  rep.serviceAfter = res.service ?? null;

  // 留痕：本机一行（必记）；对端尽可能也记一行
  const localText = `升级中断恢复（dsh-upgrade-recover）：目标=${TARGET_ID} 锁状态=${lock.state} `
    + `清锁=${d.plan.some((p) => p.id === 'clear-lock') ? 'yes' : 'no'} `
    + `静默窗释放=${d.plan.filter((p) => p.id === 'release-silence' || p.id === 'force-enable-silence').map((p) => p.holder ?? 'force-enable').join(',') || 'no'} `
    + `3080=${res.service?.listening ? 'LISTENING' : 'NOT-LISTENING'}`;
  rep.changelog = recordChangelog(TARGETS.local, null, localText);
  if (target.kind === 'ssh') {
    const remoteText = `upgrade-recover(${TARGET_ID}): lock=${lock.state} `
      + `cleared=${d.plan.some((p) => p.id === 'clear-lock') ? 'yes' : 'no'} `
      + `silence-released=${d.plan.filter((p) => p.id === 'release-silence' || p.id === 'force-enable-silence').length} `
      + `3080=${res.service?.listening ? 'LISTENING' : 'NOT-LISTENING'} by=${os.hostname()}`;
    rep.changelogRemote = recordChangelog(target, ch.alias, remoteText);
  }

  if (JSON_OUT) {
    process.stdout.write(JSON.stringify(rep, null, 2) + '\n');
  } else {
    say('');
    say(`留痕：本机流水 ${rep.changelog?.ok ? '✓' : `✗（${rep.changelog?.err || rep.changelog?.reason || rep.changelog?.exitCode}）`}`
      + (rep.changelogRemote ? ` · 对端流水 ${rep.changelogRemote.ok ? '✓' : `✗（${rep.changelogRemote.err || rep.changelogRemote.reason || rep.changelogRemote.exitCode}）`}` : ''));
    say(res.ok ? '✅ 恢复完成：3080 已监听' : '🔴 恢复未完成：3080 仍未监听（看守护鱼日志 guard2.log）');
    say('');
  }
  return res.ok ? 0 : 4;
}

if (isMain()) {
  let code = 0;
  try {
    code = await main();
  } catch (e) {
    process.stderr.write(`dsh-upgrade-recover 失败：${e?.stack ?? e}\n`);
    code = 3;
  }
  process.exitCode = typeof code === 'number' ? code : 0;
}
