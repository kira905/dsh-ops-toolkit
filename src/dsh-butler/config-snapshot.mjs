#!/usr/bin/env node
/**
 * config-snapshot.mjs —— 关键配置整包快照（冷盘 · 可原样灌回）
 *
 * 出处 / 为什么要有它（真源 = `docs/方案-仓退役与隧道常驻-20261027.md` §3 批1 的 1-3 格，已过审 plan-gate）：
 *   仓1（`dsh-core`）退役后，`~\.dsh` 里的配置 / 预设 / 技能 / 账本 / 记忆库**就没有异地副本了** ——
 *   既有两条冷备链都盖不住它：
 *     · tickd `snapshot` job 的对端镜像**硬排除凭据**、只留 6 份/72h（是"会话 + 白名单目录"的快照）；
 *     · `rollback-points-offsite.mjs` 管的是"回滚点"（代码/文档改动的还原点），不是"配置整包"。
 *   ⇒ 本件补一格：一份**能逐文件 sha256 校验、能原样灌回**的配置整包。
 *
 * 它挂在哪：**不是**新开一条冷备链，而是 `coldbackup.mjs` 的第 ③ 件（凭据排除 / 自查 / rc=3 /
 *   保留策略全部沿用既有铁律）。手工跑：
 *     node <pkg>/src/dsh-butler/coldbackup.mjs --only config
 *
 * ── 打什么（清单口径：**不另造第二份名单**）──────────────────────────────
 *   关键目录名的**唯一来源** = `dsh-snapshot-tick.mjs` 的 `INCLUDE_DIRS`（那份是 `~\.dsh` 快照的权威清单）。
 *   本件从它里面**过滤**出自己要的几个（`skills` / `storages` / `task-board` / `memory` / `.agent-presets`），
 *   再补一个它没有的 `butler-audit`（方案 1-3 点名的"账本"另一半）。
 *   · 不含 `sessions`：本卡红线「不动 sessions」，且会话本身归 `snapshot` job 管（对端镜像）；
 *   · 不含 `memory-vectors`：方案 1-3 未点名（可用 `memory.db` + docs 重建），缺口写在交付报告；
 *   · `storages` 含在内：`workspace.json`（会话分组）+ `session_projcache*`（侧栏缓存），丢了大不了重建，
 *     但有它才算"能原样灌回来"；
 *   · 顶层 = `~\.dsh` 下的**全部普通文件**（≤16 MB/个，与 snapshot 同口径）。
 *   🔴 若哪天 `dsh-snapshot-tick.mjs` 改了自己的清单名，本件**拒绝执行**（rc=1，fail-loud）——
 *      静默漏备比报错危险得多（`dirListDrift()` 那道闸）。
 *
 * ── 落哪 ────────────────────────────────────────────────────────
 *   `<盘根>\dsh-config-snapshot\<YYYYMMDD-HHmm>\`
 *   盘根 = `tools/lib/rollback-points-root.mjs` 解析出的冷盘根取 `path.parse(root).root`
 *   （HOST-A ⇒ `<drive>\`、HOST-B ⇒ `<drive>\`、PEER-HOST ⇒ `<drive>\`）。🔴 **绝不在本件里写死盘符**
 *   （2026-09-11 写死 `<drive>:` 让 HOST-B 两个 job 每晚静默失败，就是这条铁律的来历）。
 *
 * ── 硬闸（任一不过 = fail-closed，绝不"先落盘再说"）──────────────────
 *   ① 凭据永不进包：遍历时按 `credentialRuleOf()` 排除（`.credentials*` / `*credentials*` / `keys\` /
 *      `*.key|pem|pfx|p12` / `id_rsa*` / `id_ed25519*` / `mailbox.key` / `known_hosts`，与 snapshot 同一条规则）；
 *      写完后**再扫一遍已落盘的文件名与内容**（私钥块 PEM 头），命中 ⇒ **删掉整包 + rc=1**。
 *   ② junction / 符号链接**一律 lstat 不跟随**（`_archive` / `logs` / `generated` / `backups` / `snapshots`
 *      在本机是 junction，跟随会拷出天量数据）。
 *   ③ **不写半截**：先写同盘临时目录 `.<份名>.partial` → 全部写完 + manifest + `DONE` 标记 →
 *      **才改名**成正名。任何一步失败/中断 ⇒ 清掉临时目录（正名目录要么不存在、要么是完整的）。
 *   ④ 轮转**只清自己生成的完整份**：名字匹配 `YYYYMMDD-HHmm[-N]` **且**带 `DONE`；按份名时间从旧到新删；
 *      **绝不动**名字不匹配的目录（手工件 / 别人放的 / 半截残骸）。
 *
 * ── manifest（对账 / 回灌的唯一依据）──────────────────────────────
 *   `{ relPath, bytes, sha256 }` 逐文件 + 汇总 `{ files, bytes, createdAt, host, sourceRoots, … }`。
 *   字段名与 `dsh-snapshot-tick.mjs` 的 manifest **同款为主**（`ts` / `sourceRoot` / `generator` / `ok` /
 *   `credentialCheck` …），卡面点名的 `createdAt` / `sourceRoots` 作为别名**同值写出**（一个变量两个名，
 *   不存在第二套口径）。两处刻意的偏差，都有理由：
 *     · 凭据**文件名不写进 manifest**（只写规则名 + 计数）—— 否则 `grep credentials` 会在包里命中；
 *     · 多一个 `entries[]`（逐文件清单）—— snapshot 靠硬链接+mtime 判增量，不需要；本件要能回灌校验。
 *
 * ── 退出码（与 coldbackup 的聚合语义对齐，tickd `benignExitCodes:[3]` 直接吃）────
 *   0 = 成功（含"无变化"：本轮没有文件要写 / 份已存在不重写）
 *   3 = **冷盘不可达**（盘不在 / 解析器给不出可用根）⇒ 打印一行告警、**不写任何东西**、让路
 *   1 = 真失败（写一半失败 / 自查命中凭据 / 回灌校验不过 / 名单漂移）
 *   2 = 用法错误（缺参数；coldbackup 侧按真失败聚合，不会被当成"让路"）
 *
 * 用法：
 *   node config-snapshot.mjs [--snapshot]              # 默认动作：打一份到冷盘
 *   node config-snapshot.mjs --dry-run                 # 只打印清单与体积（零写入）
 *   node config-snapshot.mjs --list                    # 列冷盘上现有的份（只读）
 *   node config-snapshot.mjs --verify <份名>           # 校验该份 manifest 与盘上实际一致（只读）
 *   node config-snapshot.mjs --restore --from <份名> --to <空目录> [--force]
 *   node config-snapshot.mjs --keep 14                 # 保留份数（缺省 14 = 方案 §4 #1）
 *   通用：`--home <dir>`（夹具源根）· `--out <dir>`（夹具/应急输出根，优先于盘根解析）· `--json` · `--help`
 *
 * 冷盘根改道（测试/应急，不改代码）：
 *   `ROLLBACK_POINTS_ROOT`（盘根解析口径，与回滚点/生图两件同源）或 `DSH_CONFIG_SNAPSHOT_ROOT`（直接给输出根）。
 *   注意：`ROLLBACK_POINTS_ROOT` 只影响"取哪个盘根"，输出仍是 `<盘根>\dsh-config-snapshot`；
 *   夹具要完全隔离请用 `--out` / `DSH_CONFIG_SNAPSHOT_ROOT`（否则会写到真盘根下）。
 *
 * **收尾一律 process.exitCode**（house rule：禁 process.exit）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  collectSource as collectSnapshotSource,
  credentialRuleOf,
  INCLUDE_DIRS as SNAPSHOT_INCLUDE_DIRS,
} from './dsh-snapshot-tick.mjs'
import { preflight, describeRollbackRoot } from '../lib/rollback-points-root.mjs'
import { planRemove, applyRemove } from '../safe-rm-tree.mjs'

export const CONFIG_SNAPSHOT_VERSION = '0.1.0'
export const CONFIG_SNAPSHOT_SCHEMA = 1
/** manifest.generator —— 轮转只认这个值（"只清自己生成的份"）。 */
export const GENERATOR = 'dsh-config-snapshot'
/** 冷盘上的整包子树名（所有机器同名，只差盘符）。 */
export const SUBDIR_NAME = 'dsh-config-snapshot'
/** 保留份数缺省（方案 §4 #1 建议值 14）。 */
export const DEFAULT_KEEP = 14
export const DONE_NAME = 'DONE'
export const MANIFEST_NAME = 'manifest.json'
/** 冷盘不可达 = 让路码（与 coldbackup / 回滚点 / 生图三件同一约定）。 */
export const EXIT_DRIVE_UNAVAILABLE = 3
/** 直接指定输出根的环境变量（夹具/应急；优先级高于盘根解析）。 */
export const OUT_ENV_VAR = 'DSH_CONFIG_SNAPSHOT_ROOT'
/** 份名：`YYYYMMDD-HHmm`（同分钟补跑带 `-2`/`-3`）。 */
export const NAME_RE = /^(\d{8})-(\d{4})(?:-(\d+))?$/
/** 临时目录名：`.<份名>.partial`（同盘；写完才改名）。 */
export const PARTIAL_RE = /^\.(\d{8}-\d{4}(?:-\d+)?)\.partial$/
/** 顶层单文件上限（与 snapshot 同口径，超过的登记跳过）。 */
export const TOP_LEVEL_MAX_BYTES = 16 * 1024 * 1024
// 注：`node_modules` / `.git` 的跳过逻辑在 `dsh-snapshot-tick.mjs` 的 collectSource 里（本件不复制一份）。

/**
 * 关键目录名单：**从 `dsh-snapshot-tick.mjs` 的 `INCLUDE_DIRS` 里取**（唯一来源），
 * 再补一个方案 1-3 点名、但那份清单里没有的 `butler-audit`。
 * `sessions` 与 `memory-vectors` 刻意不取，理由写在文件头。
 */
export const BASE_DIRS_FROM_SNAPSHOT = Object.freeze(['skills', 'storages', 'task-board', 'memory', '.agent-presets'])
export const EXTRA_DIRS = Object.freeze(['butler-audit'])
export const CONFIG_INCLUDE_DIRS = Object.freeze([...BASE_DIRS_FROM_SNAPSHOT, ...EXTRA_DIRS])

/**
 * 本件在 snapshot 口径之上的**唯一一条追加排除**（2026-10-27 真跑验收时实证发现）：
 *   `~\.dsh\settings.yaml.imported` 是"导入 settings.yaml 时的残件"，4.5 KB，里面**明文**写着
 *   `channelSecrets: siliconflow: sk-…`（活 key）。名字不含 credentials ⇒ `credentialRuleOf()` 挡不住，
 *   但它显然属于"凭据永远不进明文整包"这条铁律的射程。
 *   ⚠️ 这是**唯一**一条追加，删掉这一行即回到"与 snapshot 完全同口径"。
 *   （`--keep` 那套策略与它无关：这只是"不打进包"，不是"删谁的份"。）
 */
export const EXTRA_EXCLUDE_BASENAMES = Object.freeze(['settings.yaml.imported'])

/** 内容级凭据特征：PEM 私钥块（文件名规则之外的保险丝）——**命中即删包**。 */
const PEM_RE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const CONTENT_SCAN_MAX_BYTES = 2 * 1024 * 1024
/** 文档类扩展名不扫内容：文档里写"私钥长什么样"是正常事，真凭据不会藏在 .md/.txt 里。 */
const CONTENT_SCAN_SKIP_EXT = /\.(md|markdown|txt|rst|adoc)$/i

/**
 * 「疑似凭据**值**」形态（**不删包、只登记 + 告警**）。
 * 为什么与 PEM 那条分级：key 明文字样会出现在**文档/账本/状态**的正文里（本机实测：
 *   `settings.yaml.imported` 的 channelSecrets、看板账本里某张卡记录的本地服务 key）——
 *   这类"值出现在正文里"没法靠删包解决（删了就永远备不出一份），也不该由本件静默改内容
 *   （改了就不能"原样灌回"）。⇒ 做法 = 名字规则 + PEM 块 fail-closed，key 形态**如实登记**，
 *   由交付报告的「待拍板」段交主人定（清源头 / 脱敏 / 接受同机同盘）。
 * 正则口径：`sk-` 后面**不带连字符**的长串才算（否则 `ask-wait-apply-20261013` 这类文件名会误报，
 *   真跑第一次就踩到 14 处假阳性）；带厂商前缀的另一种形态 `sk-<厂商>-<长串>` 由第 2 条兜。
 */
/** 常见 API key 的前缀（拼装而来：规则表里不出现整条字面量）。 */
const KEY_PREFIX = `${'s'}${'k'}-`;

export const SECRET_VALUE_PATTERNS = Object.freeze([
  // 注意：前缀用常量拼装，别把整条规则写成字面量（否则脱敏扫器会把规则本身当成一把钥匙）
  { kind: 'api-key-sk', re: new RegExp(`${KEY_PREFIX}[A-Za-z0-9]{32,}`) },
  { kind: 'api-key-shaped', re: new RegExp(`${KEY_PREFIX}[A-Za-z]{3,12}-[A-Za-z0-9]{24,}`) },
  { kind: 'pem-private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'aws-access-key', re: /AKIA[0-9A-Z]{16}/ },
  { kind: 'github-token', re: /(ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}/ },
  { kind: 'slack-token', re: /xox[baprs]-[A-Za-z0-9-]{10,}/ },
])

const USAGE = [
  'config-snapshot —— 关键配置整包快照（冷盘 · 可原样灌回）· coldbackup 第 ③ 件',
  '  node config-snapshot.mjs [--snapshot] [--dry-run] [--keep 14] [--json]',
  '    [--home <源根>] [--out <输出根>]',
  '  node config-snapshot.mjs --list',
  '  node config-snapshot.mjs --verify <份名>',
  '  node config-snapshot.mjs --restore --from <份名> --to <空目录> [--force] [--dry-run]',
  '  退出码：0 成功 / 3 冷盘不可达（让路，不写任何东西）/ 1 真失败 / 2 用法',
  `  保留：缺省 ${DEFAULT_KEEP} 份（只清带 ${DONE_NAME} 且名字匹配的自建份）`,
  `  冷盘根：tools/lib/rollback-points-root.mjs 解析出的盘根 + \\${SUBDIR_NAME}` +
    '（改道用 ROLLBACK_POINTS_ROOT 或 DSH_CONFIG_SNAPSHOT_ROOT）',
].join('\n')

// ────────────────────────────── 基础工具 ──────────────────────────────

/** 源根缺省：`DSH_HOME`（DSH 官方口径，测试实例/夹具能用它改道）> `~\.dsh`。 */
function defaultHome() {
  const env = String(process.env.DSH_HOME ?? '').trim()
  return env ? path.resolve(env) : path.join(os.homedir(), '.dsh')
}

function pad2(n) { return String(n).padStart(2, '0') }

/** `YYYYMMDD-HHmm`（本地时间，与 `dsh-snapshot-tick.mjs` 的 `stampName` 同形）。 */
export function stampName(d = new Date()) {
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}`
}

function fmtTs(ms) {
  if (!Number.isFinite(ms)) return '-'
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`
}

export function fmtBytes(n) {
  const v = Number(n) || 0
  if (v >= 1024 ** 3) return `${(v / 1024 ** 3).toFixed(2)} GB`
  if (v >= 1024 ** 2) return `${(v / 1024 ** 2).toFixed(1)} MB`
  if (v >= 1024) return `${(v / 1024).toFixed(1)} KB`
  return `${v} B`
}

function lstatOrNull(p) { try { return fs.lstatSync(p) } catch { return null } }

/** 分块算 sha256（大文件也不吃内存；memory.db 8.7 MB / audit 单文件 13 MB 都走这条）。 */
export function fileSha256(abs) {
  const h = crypto.createHash('sha256')
  const fd = fs.openSync(abs, 'r')
  try {
    const buf = Buffer.allocUnsafe(1024 * 1024)
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null)
      if (n <= 0) break
      h.update(buf.subarray(0, n))
    }
  } finally {
    try { fs.closeSync(fd) } catch { /* ignore */ }
  }
  return h.digest('hex')
}

/** 名单漂移检查（`dsh-snapshot-tick.mjs` 改了自己的清单 ⇒ 本件拒绝执行，而不是静默漏备）。 */
export function dirListDrift(snapshotDirs = SNAPSHOT_INCLUDE_DIRS) {
  const have = new Set(Array.isArray(snapshotDirs) ? snapshotDirs : [])
  const missing = BASE_DIRS_FROM_SNAPSHOT.filter((d) => !have.has(d))
  return {
    ok: missing.length === 0,
    missing,
    detail: missing.length
      ? `dsh-snapshot-tick.mjs 的 INCLUDE_DIRS 里找不到 ${missing.join(' / ')} —— 名单已漂移，`
        + '要么改回那份清单、要么同步改本件的 BASE_DIRS_FROM_SNAPSHOT（别让配置整包静默少备一项）'
      : null,
  }
}

// ────────────────────────────── 落点解析 ──────────────────────────────

/**
 * 解析输出根（`<盘根>\dsh-config-snapshot`）。
 * 优先级：`--out` / `DSH_CONFIG_SNAPSHOT_ROOT`（直接给根） > 盘根解析器（`ROLLBACK_POINTS_ROOT` > 主机名默认）。
 * @returns {{ok:boolean, outRoot:string|null, drive:string|null, source:string, detail:string, reason:string|null, exitCode:number}}
 */
export function resolveOutRoot(opts = {}) {
  const env = opts.env ?? process.env
  const probe = opts.probe
  const rawArg = typeof opts.out === 'string' && opts.out.trim() ? opts.out.trim() : ''
  const rawEnv = String(env?.[OUT_ENV_VAR] ?? '').trim()
  const explicit = rawArg || rawEnv

  if (explicit) {
    const outRoot = path.resolve(explicit)
    const drive = path.parse(outRoot).root || null
    const reachable = drive ? driveReachableLocal(drive, probe) : false
    return {
      ok: reachable,
      outRoot,
      drive,
      source: rawArg ? 'arg:--out' : `env:${OUT_ENV_VAR}`,
      detail: rawArg ? '命令行 --out' : `环境变量 ${OUT_ENV_VAR}`,
      reason: reachable ? null : `输出根所在盘不可达（${drive ?? '(无法解析盘符)'}）—— ${outRoot}`,
      exitCode: reachable ? 0 : EXIT_DRIVE_UNAVAILABLE,
    }
  }

  const r = describeRollbackRoot({ env, host: opts.host, probe })
  const drive = r.root ? path.parse(path.resolve(r.root)).root : null
  const outRoot = drive ? path.join(drive, SUBDIR_NAME) : null
  const reachable = outRoot ? driveReachableLocal(drive, probe) : false
  return {
    ok: reachable,
    outRoot,
    drive,
    source: r.source,
    detail: r.detail,
    reason: reachable ? null : `冷盘不可达（${drive ?? '(无法解析盘符)'}）—— 冷盘根 ${r.root ?? '-'}（来源 ${r.source}）`,
    exitCode: reachable ? 0 : EXIT_DRIVE_UNAVAILABLE,
  }
}

function driveReachableLocal(drive, probe) {
  if (!drive) return false
  if (probe && typeof probe.exists === 'function') {
    try { return probe.exists(drive) === true } catch { return false }
  }
  try { return fs.existsSync(drive) } catch { return false }
}

/** 冷盘不可达时的**唯一一行**告警（tickd traces / 人手看都够用）。 */
export function unavailableLine(t) {
  return `[config-snapshot] 🧊 让路：${t.reason} ⇒ 本轮不写任何东西（rc=${EXIT_DRIVE_UNAVAILABLE}，tickd 记 deferred、不计失败）`
}

// ────────────────────────────── 清单 / 统计 ──────────────────────────────

/**
 * 收集源文件（**复用 `dsh-snapshot-tick.mjs` 的 collectSource**：lstat 不跟随 junction、
 * 凭据规则排除、顶层只收普通文件且 ≤16 MB —— 一条代码不复制）。
 */
export function collectPlan(opts = {}) {
  const home = path.resolve(opts.home ?? defaultHome())
  const includeDirs = opts.includeDirs ?? CONFIG_INCLUDE_DIRS
  const extraExclude = opts.extraExclude ?? EXTRA_EXCLUDE_BASENAMES
  const src = collectSnapshotSource({ home, includeDirs, topLevelMaxBytes: TOP_LEVEL_MAX_BYTES })
  const excluded = [...(src.excluded ?? [])]
  const files = (src.files ?? []).filter((f) => {
    const rel = String(f.rel)
    const base = path.basename(rel.replace(/\\/g, '/'))
    if (extraExclude.some((n) => n.toLowerCase() === base.toLowerCase())) {
      excluded.push({ rel, rule: 'extra-secret-file', hit: base })
      return false
    }
    return true
  })
  return {
    home,
    includeDirs,
    files,
    excluded,
    skipped: src.skipped ?? [],
    missing: src.missing ?? [],
    fatal: src.fatal ?? null,
  }
}

/** 按顶层分组统计（人看的那个表；顶层散文件归一组）。 */
export function groupStats(files) {
  const by = new Map()
  for (const f of files) {
    const rel = String(f.rel)
    const seg = rel.includes('/') ? rel.split('/')[0] : '(顶层文件)'
    const cur = by.get(seg) ?? { group: seg, files: 0, bytes: 0 }
    cur.files++
    cur.bytes += Number(f.size) || 0
    by.set(seg, cur)
  }
  return [...by.values()].sort((a, b) => b.bytes - a.bytes)
}

// ────────────────────────────── 凭据自查（fail-closed）──────────────────────────────

/**
 * 扫一棵已落盘的树：**文件名/目录名**规则 + **内容**私钥块特征。
 * @returns {Array<{rel:string, rule:string, hit?:string}>}
 */
export function scanTreeForCredentials(dir) {
  const hits = []
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const abs = path.join(d, e.name)
      const rel = path.relative(dir, abs).split(path.sep).join('/')
      if (e.isSymbolicLink()) { hits.push({ rel, rule: 'symlink-in-snapshot' }); continue }
      const cred = credentialRuleOf(rel)
      if (cred) { hits.push({ rel, rule: cred.rule, hit: cred.hit }); continue }
      if (e.isDirectory()) { stack.push(abs); continue }
      if (!e.isFile()) continue
      if (rel === MANIFEST_NAME || rel === DONE_NAME) continue      // 本件自己写的两件，内容我们自己控
      if (CONTENT_SCAN_SKIP_EXT.test(e.name)) continue
      const st = lstatOrNull(abs)
      if (!st || st.size > CONTENT_SCAN_MAX_BYTES) continue
      let buf
      try { buf = fs.readFileSync(abs) } catch { continue }
      if (buf.includes(0)) continue                                 // 含 NUL ⇒ 当二进制，不算文本凭据
      const m = buf.toString('utf8').match(PEM_RE)
      if (m) hits.push({ rel, rule: 'private-key-block', hit: m[0] })
    }
  }
  return hits
}

/**
 * 扫已落盘的树：**疑似凭据值**形态（不删包，只登记）。
 * @returns {Array<{rel:string, kind:string}>} 只回文件名与形态，**绝不回值本身**
 */
export function scanTreeForSecretValues(dir) {
  const hits = []
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let ents = []
    try { ents = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const abs = path.join(d, e.name)
      const rel = path.relative(dir, abs).split(path.sep).join('/')
      if (e.isSymbolicLink()) continue
      if (e.isDirectory()) { stack.push(abs); continue }
      if (!e.isFile()) continue
      if (rel === MANIFEST_NAME || rel === DONE_NAME) continue
      const st = lstatOrNull(abs)
      if (!st || st.size > CONTENT_SCAN_MAX_BYTES) continue
      let buf
      try { buf = fs.readFileSync(abs) } catch { continue }
      if (buf.includes(0)) continue
      const txt = buf.toString('utf8')
      for (const { kind, re } of SECRET_VALUE_PATTERNS) {
        if (re.test(txt)) { hits.push({ rel, kind }); break }
      }
    }
  }
  return hits
}

/**
 * 凭据规则 → **中性代号**（manifest 里只写代号，不写规则原名）。
 * 理由：规则原名里天然含 `credentials` / `key` 这些词 ⇒ 写进 manifest 会让"在整包里搜凭据特征"
 *   （`grep -ri credentials <份>`）**误判成本件自己造的**。代号到原名的映射就放在这里（唯一真源）。
 */
export const CRED_RULE_CODES = Object.freeze({
  'dot-credentials': 'r1',
  'credentials-in-name': 'r2',
  'key-ext': 'r3',
  'ssh-or-mailbox-key': 'r4',
  'key-dir': 'r5',
  'extra-secret-file': 'r6',
})

/**
 * 凭据排除的汇总（**只写代号与计数，不写文件名** —— 名字也是信息，别进包也别进 manifest）。
 * @param {Array<{rule:string}>} excluded
 */
export function summarizeExcluded(excluded) {
  const byRule = {}
  for (const x of excluded ?? []) {
    const code = CRED_RULE_CODES[x.rule] ?? 'r?'
    byRule[code] = (byRule[code] ?? 0) + 1
  }
  return {
    total: (excluded ?? []).length,
    byRule,
    ruleLegend: '代号码 → 规则原名见 config-snapshot.mjs 的 CRED_RULE_CODES（此处刻意不写原名，防内容级 grep 误判）',
  }
}

// ────────────────────────────── 份的枚举 / 轮转 ──────────────────────────────

/** 列 `outRoot` 下的份（新 → 旧）。只认自己命名规则的目录。 */
export function listSnapshots(outRoot) {
  let ents = []
  try { ents = fs.readdirSync(outRoot, { withFileTypes: true }) } catch { return [] }
  const rows = []
  for (const e of ents) {
    if (!e.isDirectory()) continue
    if (!NAME_RE.test(e.name)) continue
    const dir = path.join(outRoot, e.name)
    const st = lstatOrNull(dir)
    let mf = null
    try { mf = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8')) } catch { mf = null }
    rows.push({
      name: e.name,
      dir,
      mtimeMs: st?.mtimeMs ?? 0,
      done: fs.existsSync(path.join(dir, DONE_NAME)),
      generator: mf?.generator ?? null,
      files: Number.isFinite(mf?.files) ? mf.files : null,
      bytes: Number.isFinite(mf?.bytes) ? mf.bytes : null,
      ok: mf ? mf.ok !== false : null,
    })
  }
  rows.sort((a, b) => nameKey(b.name) - nameKey(a.name) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0))
  return rows
}

/** 份名排序键（同分钟补跑的 `-2` 要排在 `-1` 之后 ⇒ 解析成 (YYYYMMDDHHmm, -N)）。 */
function nameKey(name) {
  const m = String(name).match(NAME_RE)
  if (!m) return Number.NEGATIVE_INFINITY
  return Number(`${m[1]}${m[2]}`) * 1000 + Number(m[3] ?? 1)
}

/**
 * 轮转：保留 `keep` 份，**只清自己生成的完整份**（名字匹配 + 带 `DONE`），按份名从旧到新删。
 * @returns {{keep:number, decisions:Array, removed:Array, refused:Array, candidates:number, protectedName:string|null}}
 */
export function rotate(opts = {}) {
  const outRoot = path.resolve(opts.outRoot)
  const keep = Math.max(1, Number(opts.keep ?? DEFAULT_KEEP))
  const dryRun = opts.dryRun !== false
  const protect = opts.protect ?? null
  const rows = listSnapshots(outRoot)
  const ours = rows
    .filter((r) => r.done && (r.generator === GENERATOR || r.generator === null))
    .sort((a, b) => nameKey(a.name) - nameKey(b.name))            // 旧 → 新（按份名时间）

  // 名字匹配但**没有 DONE** 的（半截残骸 / 手工目录）⇒ 明确不碰，只登记
  const unmanaged = rows.filter((r) => !(r.done && (r.generator === GENERATOR || r.generator === null)))
    .map((r) => ({ name: r.name, why: r.done ? 'DONE 在但 generator 不是本件' : `没有 ${DONE_NAME}（半截/手工件，本件不碰）` }))

  const decisions = []
  const removed = []
  const refused = []
  let excess = ours.length - keep
  for (const r of ours) {
    const keepIt = protect && r.name === protect
    if (keepIt) { decisions.push({ name: r.name, action: 'keep', why: '本轮刚生成 / 点名保护' }); continue }
    if (excess > 0) {
      excess--
      decisions.push({ name: r.name, action: 'remove', why: `超出保留份数 ${keep}（自建完整份共 ${ours.length} 份）` })
      if (dryRun) { removed.push({ name: r.name, dryRun: true }); continue }
      const p = planRemove(r.dir, { roots: [outRoot] })
      if (!p.ok) { refused.push({ name: r.name, error: p.error }); continue }
      const res = applyRemove(p, { dryRun: false })
      removed.push({ name: r.name, files: p.files.length, bytes: p.bytes, errors: res.errors.length ? res.errors.slice(0, 3) : undefined })
      continue
    }
    decisions.push({ name: r.name, action: 'keep', why: '在保留窗口内' })
  }
  return { keep, decisions, removed, refused, candidates: ours.length, unmanaged, protectedName: protect }
}

// ────────────────────────────── 写一份 ──────────────────────────────

function uniqueName(outRoot, base) {
  let name = base
  let n = 1
  while (fs.existsSync(path.join(outRoot, name)) || fs.existsSync(path.join(outRoot, `.${name}.partial`))) {
    n++
    name = `${base}-${n}`
  }
  return name
}

/** 清掉历史残留的 `.<份名>.partial`（上次中断留下的）—— 只认自己的命名规则。 */
export function cleanupStalePartial(outRoot, { dryRun = false, log = () => {} } = {}) {
  let ents = []
  try { ents = fs.readdirSync(outRoot, { withFileTypes: true }) } catch { return [] }
  const out = []
  for (const e of ents) {
    if (!e.isDirectory()) continue
    if (!PARTIAL_RE.test(e.name)) continue
    const dir = path.join(outRoot, e.name)
    const p = planRemove(dir, { roots: [outRoot] })
    if (!p.ok) { out.push({ name: e.name, error: p.error }); continue }
    if (!dryRun) applyRemove(p, { dryRun: false })
    out.push({ name: e.name, files: p.files.length, bytes: p.bytes, dryRun })
    log(`[config-snapshot] 清理上次残留的临时目录：${e.name}（${p.files.length} 件 / ${fmtBytes(p.bytes)}）`)
  }
  return out
}

/**
 * 打一份整包快照。**唯一的写入口**（写临时目录 → manifest → DONE → 凭据自查 → 改名 → 轮转）。
 * @returns {object} result（`ok` / `exitCode` / `name` / `dir` / `files` / `bytes` / …）
 */
export function writeSnapshot(opts = {}) {
  const now = Number(opts.now ?? Date.now())
  const home = path.resolve(opts.home ?? defaultHome())
  const keep = Math.max(1, Number(opts.keep ?? DEFAULT_KEEP))
  const dryRun = opts.dryRun === true
  const doRotate = opts.rotate !== false
  const log = opts.log ?? ((s) => console.log(s))
  const includeDirs = opts.includeDirs ?? CONFIG_INCLUDE_DIRS
  const t0 = Date.now()
  const result = {
    ok: false, dryRun, home, outRoot: null, drive: null, rootSource: null,
    name: null, dir: null, partial: null,
    files: 0, bytes: 0, copied: 0, failedFiles: 0, dirs: 0,
    groups: [], manifest: null, excluded: null, skipped: [], missing: [],
    credentialCheck: { ok: true, hits: [] }, rotate: null, warnings: [], errors: [],
    elapsedMs: 0, now, exitCode: 1,
  }

  // ① 名单漂移（fail-loud）
  const drift = dirListDrift(opts.snapshotDirs)
  if (!drift.ok) {
    result.errors.push(`名单漂移：${drift.detail}`)
    result.elapsedMs = Date.now() - t0
    return result
  }

  // ② 冷盘根
  const tgt = resolveOutRoot({ env: opts.env, host: opts.host, probe: opts.probe, out: opts.out })
  result.outRoot = tgt.outRoot
  result.drive = tgt.drive
  result.rootSource = tgt.source
  if (!tgt.ok) {
    result.warnings.push(unavailableLine(tgt))
    result.exitCode = EXIT_DRIVE_UNAVAILABLE
    result.elapsedMs = Date.now() - t0
    return result
  }

  // ③ 清单
  const plan = collectPlan({ home, includeDirs })
  if (plan.fatal) {
    result.errors.push(plan.fatal)
    result.elapsedMs = Date.now() - t0
    return result
  }
  const totalBytes = plan.files.reduce((s, f) => s + (Number(f.size) || 0), 0)
  result.files = plan.files.length
  result.bytes = totalBytes
  result.dirs = new Set(plan.files.map((f) => path.dirname(String(f.rel)))).size
  result.groups = groupStats(plan.files)
  result.excluded = summarizeExcluded(plan.excluded)
  result.skipped = plan.skipped
  result.missing = plan.missing

  result.name = dryRun ? stampName(new Date(now)) : uniqueName(tgt.outRoot, stampName(new Date(now)))
  result.dir = path.join(tgt.outRoot, result.name)
  result.partial = path.join(tgt.outRoot, `.${result.name}.partial`)

  if (dryRun) {
    result.ok = true
    result.exitCode = 0
    result.elapsedMs = Date.now() - t0
    return result
  }

  // ④ 写临时目录
  cleanupStalePartial(tgt.outRoot, { log })
  const entries = []
  let copied = 0
  let failedFiles = 0
  try {
    fs.mkdirSync(result.partial, { recursive: true })
  } catch (e) {
    result.errors.push(`建临时目录失败：${e?.message ?? e}`)
    result.elapsedMs = Date.now() - t0
    return result
  }

  try {
    for (const f of plan.files) {
      const dest = path.join(result.partial, String(f.rel))
      const srcNow = lstatOrNull(f.abs)
      if (!srcNow || !srcNow.isFile()) {
        // 收集与拷贝之间源没了（`.tmp` 原子写件被重命名/删除是常态）⇒ 登记，不整体失败
        failedFiles++
        result.skipped.push({ rel: f.rel, reason: '拷贝前源已消失' })
        continue
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.copyFileSync(f.abs, dest)
      const shaDest = fileSha256(dest)
      const shaSrc = fileSha256(f.abs)
      entries.push({
        relPath: String(f.rel),
        bytes: fs.statSync(dest).size,
        sha256: shaDest,
        // 源在拷贝期间被改过（dsh 在跑，状态类文件本来就在变）⇒ 如实标记，**manifest 记的是落盘那份**
        ...(shaSrc !== shaDest ? { srcDrifted: true } : {}),
      })
      copied++
    }
  } catch (e) {
    result.errors.push(`复制阶段失败：${e?.message ?? e}`)
    result.copied = copied
    result.failedFiles = failedFiles
    safeRemove(result.partial, tgt.outRoot, log)
    result.elapsedMs = Date.now() - t0
    return result
  }

  const bytesWritten = entries.reduce((s, e) => s + e.bytes, 0)
  const drifted = entries.filter((e) => e.srcDrifted).length
  if (drifted) result.warnings.push(`${drifted} 个文件在拷贝期间源被改写（已按落盘内容记 sha256，回灌以 manifest 为准）`)

  // ⑤ 疑似凭据**值**登记（不删包；见 SECRET_VALUE_PATTERNS 注释里的分级理由）
  const secretHits = scanTreeForSecretValues(result.partial)
  if (secretHits.length) {
    result.warnings.push(
      `${secretHits.length} 个文件含疑似凭据值（属文档/配置正文，非凭据文件）：`
      + `${secretHits.map((h) => `${h.rel}[${h.kind}]`).join(', ')} —— 已登记进 manifest.secretValueScan，`
      + '处置见交付报告「待拍板」段（本件不擅自改内容、也不因此删包）',
    )
  }

  // ⑤ manifest（顺序：先写 manifest、再写 DONE —— 有 DONE 才代表"完整"）
  const iso = new Date(now).toISOString()
  const manifest = {
    schemaVersion: CONFIG_SNAPSHOT_SCHEMA,
    generator: GENERATOR,
    version: CONFIG_SNAPSHOT_VERSION,
    ts: iso,
    createdAt: iso,                       // 别名（卡面点名），与 ts 同值
    tsLocal: fmtTs(now),
    snapshot: result.name,
    sourceRoot: home,
    sourceRoots: [home],                  // 别名（卡面点名），与 sourceRoot 同值
    includeDirs,
    topLevelMaxBytes: TOP_LEVEL_MAX_BYTES,
    host: os.hostname(),
    files: entries.length,
    bytes: bytesWritten,
    dirs: result.dirs,
    skipped: plan.skipped.length,
    missing: plan.missing,
    excluded: result.excluded,
    secretValueScan: { total: secretHits.length, files: secretHits },
    credentialCheck: { ok: true, hits: [] },   // 下面自查通过后回填（先留位，字段顺序稳定）
    ok: true,
    elapsedMs: Date.now() - t0,
    entries,
  }

  try {
    fs.writeFileSync(path.join(result.partial, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  } catch (e) {
    result.errors.push(`写 manifest 失败：${e?.message ?? e}`)
    safeRemove(result.partial, tgt.outRoot, log)
    result.elapsedMs = Date.now() - t0
    return result
  }

  // ⑥ 凭据自查（**第一闸：临时目录里就查**，命中直接清掉，正名目录永远不会含凭据）
  const hits = scanTreeForCredentials(result.partial)
  result.credentialCheck = { ok: hits.length === 0, hits }
  if (hits.length) {
    result.errors.push(`凭据混入整包（${hits.map((h) => `${h.rel}[${h.rule}]`).join(', ')}）⇒ 已删除临时目录，fail-closed`)
    safeRemove(result.partial, tgt.outRoot, log)
    result.elapsedMs = Date.now() - t0
    return result
  }

  // ⑦ DONE 标记（有它才算"完整份"；轮转只认带 DONE 的）
  try {
    fs.writeFileSync(
      path.join(result.partial, DONE_NAME),
      `ok ${iso} files=${entries.length} bytes=${bytesWritten} host=${os.hostname()}\n`,
      'utf8',
    )
  } catch (e) {
    result.errors.push(`写 ${DONE_NAME} 失败：${e?.message ?? e}`)
    safeRemove(result.partial, tgt.outRoot, log)
    result.elapsedMs = Date.now() - t0
    return result
  }

  // ⑧ 改名（同盘 rename ⇒ 原子；失败就清临时目录，不留半截）
  try {
    fs.renameSync(result.partial, result.dir)
  } catch (e) {
    result.errors.push(`改名失败：${e?.message ?? e}（同盘 rename 不应失败，检查盘/权限）`)
    safeRemove(result.partial, tgt.outRoot, log)
    result.elapsedMs = Date.now() - t0
    return result
  }

  // ⑨ 第二闸：正名目录再扫一遍（防 rename 期间被塞东西 / rename 语义差异）
  const hits2 = scanTreeForCredentials(result.dir)
  if (hits2.length) {
    result.credentialCheck = { ok: false, hits: hits2 }
    result.errors.push(`凭据混入整包（改名后复查：${hits2.map((h) => `${h.rel}[${h.rule}]`).join(', ')}）⇒ 已删除整包，fail-closed`)
    safeRemove(result.dir, tgt.outRoot, log)
    result.elapsedMs = Date.now() - t0
    return result
  }

  result.copied = copied
  result.failedFiles = failedFiles
  result.files = entries.length
  result.bytes = bytesWritten
  result.manifest = {
    files: manifest.files, bytes: manifest.bytes, tsLocal: manifest.tsLocal,
    skipped: manifest.skipped, drifted, secretValueFiles: secretHits.length,
  }

  // ⑩ 轮转（只清自己生成的完整份）
  if (doRotate) {
    result.rotate = rotate({ outRoot: tgt.outRoot, keep, dryRun: false, protect: result.name })
    log(`[config-snapshot] 轮转：自建完整份 ${result.rotate.candidates} 份，保留 ${keep} 份，删 ${result.rotate.removed.length} 份`
      + `（拒动 ${result.rotate.refused.length} / 不碰 ${result.rotate.unmanaged.length}）`)
    if (result.rotate.refused.length) result.warnings.push(`轮转有 ${result.rotate.refused.length} 份拒动：${result.rotate.refused.map((x) => x.name).join(', ')}`)
  }

  result.ok = true
  result.exitCode = 0
  result.elapsedMs = Date.now() - t0
  return result
}

/** 删一棵树（走 safe-rm-tree；roots 只给 outRoot，**绝不给 <workspace>** —— 本件不碰 D 盘）。 */
function safeRemove(target, outRoot, log) {
  if (!target || !outRoot) return { ok: false, error: '缺参数' }
  const p = planRemove(target, { roots: [outRoot] })
  if (!p.ok) { log(`[config-snapshot] 🔴 清理失败（需人工处理）：${p.error}`); return { ok: false, error: p.error } }
  const res = applyRemove(p, { dryRun: false })
  if (res.errors.length) log(`[config-snapshot] 🔴 清理时有 ${res.errors.length} 件没删掉：${JSON.stringify(res.errors.slice(0, 3))}`)
  else log(`[config-snapshot] 已清掉 ${target}（${p.files.length} 件 / ${fmtBytes(p.bytes)}）`)
  return { ok: res.errors.length === 0, errors: res.errors }
}

// ────────────────────────────── 校验 / 回灌 ──────────────────────────────

/** 盘上实际件（排除 manifest.json / DONE）。 */
function walkTree(dir) {
  const out = []
  const stack = [[dir, '']]
  while (stack.length) {
    const [abs, rel] = stack.pop()
    let ents = []
    try { ents = fs.readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const e of ents) {
      const a = path.join(abs, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) { stack.push([a, r]); continue }
      if (!e.isFile()) continue
      if (r === MANIFEST_NAME || r === DONE_NAME) continue
      const st = lstatOrNull(a)
      out.push({ relPath: r, abs: a, bytes: st?.size ?? 0 })
    }
  }
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
  return out
}

/**
 * 校验一份：manifest 与盘上实际**逐文件**对齐（件数 / 字节 / sha256）。
 * @returns {{ok:boolean, dir:string, name:string, files:number, bytes:number, problems:Array, checked:number}}
 */
export function verifySnapshot(opts = {}) {
  const dir = path.resolve(opts.dir)
  const log = opts.log ?? (() => {})
  const problems = []
  const name = path.basename(dir)
  let mf = null
  try { mf = JSON.parse(fs.readFileSync(path.join(dir, MANIFEST_NAME), 'utf8')) } catch (e) {
    return { ok: false, dir, name, files: 0, bytes: 0, checked: 0, problems: [`读 manifest 失败：${e?.message ?? e}`] }
  }
  if (!fs.existsSync(path.join(dir, DONE_NAME))) problems.push(`缺 ${DONE_NAME} 标记（不是完整份）`)
  if (mf.generator !== GENERATOR) problems.push(`generator=${mf.generator ?? '(空)'}，不是本件生成的份`)
  if (mf.ok === false) problems.push('manifest.ok=false')

  const actual = walkTree(dir)
  const byRel = new Map(actual.map((a) => [a.relPath, a]))
  const listed = Array.isArray(mf.entries) ? mf.entries : []
  const listedRel = new Set(listed.map((e) => e.relPath))

  for (const e of listed) {
    const a = byRel.get(e.relPath)
    if (!a) { problems.push(`缺文件：${e.relPath}`); continue }
    if (a.bytes !== e.bytes) { problems.push(`字节不符：${e.relPath}（manifest ${e.bytes} / 盘上 ${a.bytes}）`); continue }
    const sha = fileSha256(a.abs)
    if (sha !== e.sha256) problems.push(`sha256 不符：${e.relPath}`)
  }
  for (const a of actual) if (!listedRel.has(a.relPath)) problems.push(`多出文件（manifest 未记）：${a.relPath}`)

  if (Number.isFinite(mf.files) && mf.files !== listed.length) problems.push(`manifest.files=${mf.files} 与 entries 数 ${listed.length} 不符`)
  if (Number.isFinite(mf.bytes)) {
    const sum = listed.reduce((s, e) => s + (Number(e.bytes) || 0), 0)
    if (mf.bytes !== sum) problems.push(`manifest.bytes=${mf.bytes} 与 entries 字节和 ${sum} 不符`)
  }
  const bad = problems.length
  log(`[config-snapshot] 校验 ${name}：件数 ${listed.length} / 字节 ${mf.bytes} · ${bad ? `🔴 ${bad} 处不符` : '✅ 逐文件 sha256 全过'}`)
  return { ok: bad === 0, dir, name, files: listed.length, bytes: Number(mf.bytes) || 0, checked: listed.length, problems }
}

/** 目标目录是否"空"（不存在算空）。 */
function dirIsEmptyOrMissing(dir) {
  try {
    const ents = fs.readdirSync(dir)
    return { ok: ents.length === 0, count: ents.length }
  } catch { return { ok: true, count: 0 } }
}

/**
 * 从某份**逐文件 sha256 校验**灌回目标目录（这是"可一键回灌"的证据，不是"删目录"）。
 * 安全闸：目标非空 ⇒ 拒绝（除非 force）；目标与 `~\.dsh` 有包含关系 ⇒ 一律拒绝（要覆盖生产走 P0 闸门）。
 */
export function restoreSnapshot(opts = {}) {
  const home = path.resolve(opts.home ?? defaultHome())
  const fromName = opts.from ? String(opts.from) : null
  const to = opts.to ? path.resolve(String(opts.to)) : null
  const force = opts.force === true
  const dryRun = opts.dryRun === true
  const log = opts.log ?? ((s) => console.log(s))
  const out = { ok: false, from: null, to, dryRun, files: 0, bytes: 0, verified: 0, problems: [], errors: [], exitCode: 1 }

  if (!to) { out.errors.push('缺 --to <目标目录>'); return out }

  // ① 目标与 home 的包含关系（防手滑把生产目录当灌回目标）
  const relHome = path.relative(to, home)
  const relTo = path.relative(home, to)
  const inside = (r) => r === '' || (!r.startsWith('..') && !path.isAbsolute(r))
  if (inside(relHome) || inside(relTo)) {
    out.errors.push(`拒动：目标 ${to} 与 ~\\.dsh（${home}）存在包含关系 —— 覆盖生产要走 P0 闸门，本件不代劳`)
    return out
  }
  // ② 目标必须空（除非 --force）
  const empty = dirIsEmptyOrMissing(to)
  if (!empty.ok && !force) {
    out.errors.push(`拒动：目标目录非空（${empty.count} 个条目）：${to} —— 要覆盖请显式 --force`)
    return out
  }

  // ③ 定位份（缺省最新一份完整份）
  const outRoot = opts.outRoot ? path.resolve(String(opts.outRoot)) : null
  let srcDir = null
  if (fromName) {
    if (outRoot) srcDir = path.join(outRoot, fromName)
    else {
      const tgt = resolveOutRoot({ env: opts.env, host: opts.host, probe: opts.probe, out: opts.out })
      if (!tgt.ok) { out.errors.push(unavailableLine(tgt)); out.exitCode = EXIT_DRIVE_UNAVAILABLE; return out }
      srcDir = path.join(tgt.outRoot, fromName)
    }
    if (!fs.existsSync(srcDir)) { out.errors.push(`份不存在：${srcDir}`); return out }
  } else {
    const tgt = outRoot ? { ok: true, outRoot } : resolveOutRoot({ env: opts.env, host: opts.host, probe: opts.probe, out: opts.out })
    if (!tgt.ok) { out.errors.push(unavailableLine(tgt)); out.exitCode = EXIT_DRIVE_UNAVAILABLE; return out }
    const latest = listSnapshots(tgt.outRoot).find((r) => r.done)
    if (!latest) { out.errors.push(`冷盘上没有完整份（带 ${DONE_NAME}）：${tgt.outRoot}`); return out }
    srcDir = latest.dir
    log(`[config-snapshot] 未指定 --from ⇒ 用最新完整份：${latest.name}`)
  }
  out.from = path.basename(srcDir)

  // ④ 先校验源份（不校验就灌 = 灌进去一堆假完整文件）
  const v = verifySnapshot({ dir: srcDir, log })
  out.problems = v.problems
  if (!v.ok) { out.errors.push(`源份校验不过（${v.problems.length} 处）⇒ 拒绝灌回`); return out }

  // ⑤ 逐文件灌回 + 回校验
  const mf = JSON.parse(fs.readFileSync(path.join(srcDir, MANIFEST_NAME), 'utf8'))
  const entries = Array.isArray(mf.entries) ? mf.entries : []
  if (dryRun) {
    out.files = entries.length
    out.bytes = Number(mf.bytes) || 0
    out.ok = true
    out.exitCode = 0
    log(`[config-snapshot] DRY-RUN：将灌回 ${entries.length} 件 / ${fmtBytes(out.bytes)} → ${to}（校验已过，零写入）`)
    return out
  }
  try {
    fs.mkdirSync(to, { recursive: true })
  } catch (e) {
    out.errors.push(`建目标目录失败：${e?.message ?? e}`)
    return out
  }
  let written = 0
  try {
    for (const e of entries) {
      const src = path.join(srcDir, e.relPath)
      const dst = path.join(to, e.relPath)
      fs.mkdirSync(path.dirname(dst), { recursive: true })
      fs.copyFileSync(src, dst)
      const sha = fileSha256(dst)
      if (sha !== e.sha256) { out.errors.push(`灌回后 sha256 不符：${e.relPath}`); return out }
      out.verified++
      written += e.bytes
    }
  } catch (e2) {
    out.errors.push(`灌回失败（第 ${written + 1} 件起）：${e2?.message ?? e2}`)
    return out
  }
  out.files = entries.length
  out.bytes = written
  out.ok = true
  out.exitCode = 0
  log(`[config-snapshot] ✅ 灌回完成：${entries.length} 件 / ${fmtBytes(written)}，逐文件 sha256 **全部**复校通过 → ${to}`)
  return out
}

// ────────────────────────────── 打印 ──────────────────────────────

function printPlan(r) {
  console.log(`[config-snapshot] 源根 ${r.home}（${r.files} 件 / ${fmtBytes(r.bytes)}；目录 ${r.dirs} 个）`)
  console.log('[config-snapshot] 分组：')
  for (const g of r.groups) console.log(`  ${String(g.group).padEnd(16)} ${String(g.files).padStart(6)} 件  ${fmtBytes(g.bytes)}`)
  if (r.excluded?.total) {
    // stdout 不进包 ⇒ 这里可以打规则原名（manifest 里只留代号）
    const legend = Object.fromEntries(Object.entries(CRED_RULE_CODES).map(([k, v]) => [v, k]))
    const rules = Object.entries(r.excluded.byRule).map(([code, v]) => `${legend[code] ?? code}×${v}`).join(' / ')
    console.log(`[config-snapshot] 凭据排除 ${r.excluded.total} 件（规则：${rules}）—— 文件名不入包、manifest 只留代号`)
  }
  if (r.skipped?.length) {
    console.log(`[config-snapshot] 跳过 ${r.skipped.length} 件（前 5）：`)
    for (const s of r.skipped.slice(0, 5)) console.log(`  - ${s.rel}（${s.reason}）`)
  }
  if (r.missing?.length) console.log(`[config-snapshot] 源根下缺失的白名单目录：${r.missing.join(' / ')}`)
}

function printResult(r) {
  if (r.exitCode === EXIT_DRIVE_UNAVAILABLE) { console.warn(r.warnings?.[0] ?? '[config-snapshot] 🧊 让路（冷盘不可达）'); return }
  if (!r.ok) {
    console.error(`[config-snapshot] 🔴 失败：${r.errors.join(' | ')}`)
    return
  }
  if (r.dryRun) {
    printPlan(r)
    console.log(`[config-snapshot] DRY-RUN：将写 ${r.name} → ${r.dir}（${r.files} 件 / ${fmtBytes(r.bytes)}，零写入）`)
    return
  }
  console.log(`[config-snapshot] ✅ 落盘 ${r.name} → ${r.dir}`)
  console.log(`[config-snapshot]    ${r.files} 件 / ${fmtBytes(r.bytes)} · 耗时 ${(r.elapsedMs / 1000).toFixed(1)}s · host=${os.hostname()}`)
  if (r.failedFiles) console.log(`[config-snapshot]    跳过 ${r.failedFiles} 件（拷贝前源已消失，多为 .tmp 原子写件）`)
  if (r.warnings.length) for (const w of r.warnings) console.log(`[config-snapshot]    ⚠️ ${w}`)
  if (r.rotate) console.log(`[config-snapshot]    轮转后剩 ${r.rotate.candidates - r.rotate.removed.length} 份`
    + `（删 ${r.rotate.removed.length}：${r.rotate.removed.map((x) => x.name).join(', ') || '无'}）`)
}

function printList(outRoot) {
  const rows = listSnapshots(outRoot)
  console.log(`[config-snapshot] ${outRoot} —— ${rows.length} 份（新 → 旧）`)
  if (!rows.length) { console.log('  （空）'); return 0 }
  for (const r of rows) {
    const flags = `${r.done ? 'DONE' : '  ✗ '} ${r.generator === GENERATOR ? 'ok' : `generator=${r.generator ?? '-'}`}`
    console.log(`  ${r.name}  ${String(r.files ?? '-').padStart(6)} 件 ${fmtBytes(r.bytes ?? 0).padStart(9)}  ${flags}  ${fmtTs(r.mtimeMs)}`)
  }
  return 0
}

// ────────────────────────────── CLI ──────────────────────────────

const isMain = (() => {
  try {
    const argv1 = process.argv[1]
    if (!argv1) return false
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(import.meta.url))
  } catch { return false }
})()

function main(argv) {
  const opt = { action: 'snapshot', keep: null, home: null, out: null, from: null, to: null, force: false, dryRun: false, json: false, outRoot: null, verifyName: null }
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i]
      if (a === '--snapshot') opt.action = 'snapshot'
      else if (a === '--dry-run') opt.dryRun = true
      else if (a === '--list') opt.action = 'list'
      else if (a === '--verify') { opt.action = 'verify'; opt.verifyName = argv[++i] }
      else if (a === '--restore') opt.action = 'restore'
      else if (a === '--keep') opt.keep = Number(argv[++i])
      else if (a === '--home') opt.home = argv[++i]
      else if (a === '--out') opt.out = argv[++i]
      else if (a === '--out-root') opt.outRoot = argv[++i]
      else if (a === '--from') opt.from = argv[++i]
      else if (a === '--to') opt.to = argv[++i]
      else if (a === '--force') opt.force = true
      else if (a === '--json') opt.json = true
      else if (a === '--help' || a === '-h') { console.log(USAGE); return 0 }
      else { console.error(`未知参数：${a}`); console.error(USAGE); return 2 }
    }
  } catch (e) {
    console.error(e?.message ?? e); console.error(USAGE); return 2
  }
  if (opt.keep !== null && (!Number.isFinite(opt.keep) || opt.keep < 1)) { console.error('--keep 需要 ≥1 的数字'); return 2 }

  const home = path.resolve(opt.home ?? defaultHome())
  const tgt = resolveOutRoot({ out: opt.out })

  if (opt.action === 'list') {
    if (!tgt.ok) { console.warn(unavailableLine(tgt)); return EXIT_DRIVE_UNAVAILABLE }
    return printList(tgt.outRoot)
  }

  if (opt.action === 'verify') {
    if (!opt.verifyName) { console.error('--verify 需要 <份名>'); return 2 }
    if (!tgt.ok) { console.warn(unavailableLine(tgt)); return EXIT_DRIVE_UNAVAILABLE }
    const dir = path.join(tgt.outRoot, opt.verifyName)
    if (!fs.existsSync(dir)) { console.error(`份不存在：${dir}`); return 1 }
    const v = verifySnapshot({ dir, log: (s) => console.log(s) })
    if (opt.json) process.stdout.write(JSON.stringify(v, null, 2) + '\n')
    else if (!v.ok) for (const p of v.problems) console.log(`  🔴 ${p}`)
    return v.ok ? 0 : 1
  }

  if (opt.action === 'restore') {
    const r = restoreSnapshot({
      home, from: opt.from, to: opt.to, force: opt.force, dryRun: opt.dryRun,
      outRoot: opt.outRoot, out: opt.out, log: (s) => console.log(s),
    })
    if (opt.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n')
    else if (!r.ok) for (const e of r.errors) console.error(`[config-snapshot] 🔴 ${e}`)
    return r.exitCode
  }

  // snapshot
  const r = writeSnapshot({
    home, keep: opt.keep ?? DEFAULT_KEEP, dryRun: opt.dryRun, out: opt.out, log: (s) => console.log(s),
  })
  if (opt.json) process.stdout.write(JSON.stringify(r, null, 2) + '\n')
  else { printResult(r) }
  return r.exitCode
}

if (isMain) {
  try { process.exitCode = main(process.argv.slice(2)) }
  catch (e) {
    console.error(`[config-snapshot] 致命错误：${e?.stack ?? e?.message ?? e}`)
    process.exitCode = 1
  }
}
