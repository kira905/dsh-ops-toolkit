// tools/lib/rollback-points-root.mjs —— 回滚点冷盘根（dsh-rollback-points）的**唯一解析口径**
//
// 为什么单独一个模块（2026-09-14，看板卡「回滚点异地化」/ 方案《自愈与回滚-验收缺口与整改方案-20260911》§3.3）：
//   回滚点根目录 `<workspace>\_archive` 是 junction → `<offsync>\deep\_archive`，**三仓都不收**（R4 单点隐患）：
//   那块盘出事 = 304+ 个回滚点静默全失。整改的 D5 拍板（2026-09-12）= A：
//     **冷盘存数据 + 仓3 只存「恢复脚本 + manifest」**（仓库不膨胀、规避 git-crypt 大 blob 无 delta）。
//   冷盘落点按**主机名解析**（照 tools/lib/imagegen-backup-root.mjs 先例），**禁写死单机盘符**——
//   2026-09-11 imagegen 冷备就是写死 `<drive>\` 导致 HOST-B（无 H 盘）两个 job 每晚静默失败。
//
// 解析优先级（高 → 低）：
//   ① `--target <dir>`（命令行显式指定，测试/应急用）
//   ② 环境变量 `ROLLBACK_POINTS_ROOT`（临时改道，不改代码；**降级路径实测也靠它**）
//   ③ **本机默认**（按主机名判定，见 HOST_DEFAULT_DRIVE）
//         HOST-A  = host-a → <drive>\dsh-rollback-points（外接 SSD HUB）
//         HOST-B  = host-b    → <drive>\dsh-rollback-points（内置机械盘）
//   ④ 主机名不认识时**探测**：候选盘里「备份目录已存在」→「盘存在」→ 都没有则取第一个
//      （探测只为不崩，绝不写回任何配置；新机器想固定请往 HOST_DEFAULT_DRIVE 加一行）
//
// 与 imagegen 模块的关系：结构刻意同款、**但保持独立**——不去改 imagegen 那条已经在跑的生产链
//   （改它要连带动它的 job 与单测）。两处若将来要合并成通用工厂，以本模块注释为准。
//
// 本模块零副作用、纯函数 + 可注入探针（probe），单测不需要真实盘符。
import fs from 'node:fs';
import path from 'node:path';

import { hostTag } from '../dsh-butler/lib/host-tag.mjs';

export const ROLLBACK_POINTS_ROOT_VERSION = '0.1.0';

/** 环境变量名（改道用）。 */
export const ENV_VAR = 'ROLLBACK_POINTS_ROOT';

/** 备份目录名（所有机器同名，只是盘不同）。 */
export const ROOT_DIR_NAME = 'dsh-rollback-points';

/** 盘不可达时的统一退出码（与 imagegen 冷备同款：tickd / 日报看得见，**不静默**）。 */
export const EXIT_DRIVE_UNAVAILABLE = 3;

/** 冷盘内的快照子树名：`<root>/points/<回滚点名>/…`。 */
export const POINTS_SUBDIR = 'points';

/**
 * 本机默认盘 —— 按主机短码（hostTag 口径：小写主机名）判定。
 * 加新机器就往这里加一行；**绝不在别处再写第二条单机路径**。
 */
export const HOST_DEFAULT_DRIVE = {
  'host-a': 'H:', // 示例主机 A：外接 SSD
  'host-b': 'F:',  // 示例主机 B：内置机械盘
  'host-c': 'H:', // 示例主机 C：外接大容量盘
};

/** 未知主机时的候选盘（按优先级）。 */
export const CANDIDATE_DRIVES = ['H:', 'F:'];

/** 盘符 → 该盘的冷盘根（`F:` → `<drive>\dsh-rollback-points`）。 */
export function rootForDrive(drive) {
  const d = String(drive ?? '').trim();
  if (!d) return null;
  return path.join(d.endsWith('\\') || d.endsWith('/') ? d : d + '\\', ROOT_DIR_NAME);
}

/** 已知主机 → 本机默认根；未知主机返回 null。 */
export function rootForHost(host) {
  const tag = hostTag({ host });
  const drive = HOST_DEFAULT_DRIVE[tag];
  return drive ? rootForDrive(drive) : null;
}

/** 默认探针（真实文件系统）。 */
function defaultProbe() {
  return {
    dirExists: (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } },
    driveExists: (drive) => { try { return fs.existsSync(drive + '\\'); } catch { return false; } },
  };
}

/**
 * 解析回滚点冷盘根。
 * @param {{target?:string|null, env?:Record<string,string|undefined>, host?:string, probe?:object}} [opts]
 * @returns {{root:string, source:string, hostTag:string, knownHost:boolean, detail:string}}
 *   source: 'arg:--target' | 'env:ROLLBACK_POINTS_ROOT' | 'host:<tag>' | 'probe:existing' | 'probe:drive' | 'fallback:first'
 */
export function resolveRollbackRoot(opts = {}) {
  const env = opts.env ?? process.env;
  const host = opts.host ?? process.env.DSH_HOST_TAG ?? undefined;
  const tag = hostTag(host === undefined ? {} : { host });
  const probe = opts.probe ?? defaultProbe();

  // ① --target
  const argTarget = typeof opts.target === 'string' ? opts.target.trim() : '';
  if (argTarget) {
    return { root: path.resolve(argTarget), source: 'arg:--target', hostTag: tag, knownHost: false, detail: '命令行 --target' };
  }

  // ② 环境变量
  const envTarget = String(env?.[ENV_VAR] ?? '').trim();
  if (envTarget) {
    return { root: path.resolve(envTarget), source: `env:${ENV_VAR}`, hostTag: tag, knownHost: false, detail: `环境变量 ${ENV_VAR}` };
  }

  // ③ 主机名默认
  const byHost = rootForHost(host);
  if (byHost) {
    return { root: byHost, source: `host:${tag}`, hostTag: tag, knownHost: true, detail: `主机 ${tag} 默认盘 ${HOST_DEFAULT_DRIVE[tag]}` };
  }

  // ④ 未知主机 → 探测候选盘
  const candidates = CANDIDATE_DRIVES.map((d) => ({ drive: d, root: rootForDrive(d) })).filter((x) => x.root);
  const existing = candidates.find((x) => probe.dirExists(x.root));
  if (existing) {
    return { root: existing.root, source: 'probe:existing', hostTag: tag, knownHost: false, detail: `未知主机 ${tag}：候选盘 ${existing.drive} 已有冷盘目录` };
  }
  const live = candidates.find((x) => probe.driveExists(x.drive));
  if (live) {
    return { root: live.root, source: 'probe:drive', hostTag: tag, knownHost: false, detail: `未知主机 ${tag}：候选盘 ${live.drive} 存在` };
  }
  const first = candidates[0];
  return {
    root: first ? first.root : rootForDrive(CANDIDATE_DRIVES[0]),
    source: 'fallback:first',
    hostTag: tag,
    knownHost: false,
    detail: `未知主机 ${tag} 且候选盘均不存在：回落 ${CANDIDATE_DRIVES[0]}`,
  };
}

/** 当前解析结果的人类可读单行（日志 / 面板 / 日报文案统一用它）。 */
export function describeRollbackRoot(opts = {}) {
  try {
    const r = resolveRollbackRoot(opts);
    return { ...r, line: `${r.root}（来源 ${r.source}）` };
  } catch (e) {
    return { root: null, source: 'error', hostTag: hostTag({}), knownHost: false, detail: String(e?.message ?? e), line: `解析失败：${e?.message ?? e}` };
  }
}

/** 冷盘根所在盘是否可达（Windows 上根 = `X:\`）。可注入 probe（单测用假探针）。 */
export function driveReachable(root, probe) {
  const p = probe ?? { exists: (q) => { try { return fs.existsSync(q); } catch { return false; } } };
  if (!root) return false;
  try {
    return p.exists(path.parse(path.resolve(root)).root) === true;
  } catch {
    return false;
  }
}

/**
 * 打包/巡检前的统一预检 —— **盘不可达 = 明确失败（退出码 3），绝不假装成功**（方案 §3.3 T18）。
 * @returns {{ok:boolean, root:string|null, source:string, hostTag:string, detail:string, drive:string|null,
 *            reason:string|null, exitCode:number}}
 */
export function preflight(opts = {}) {
  const probe = opts.probe;
  const r = describeRollbackRoot(opts);
  const drive = r.root ? path.parse(path.resolve(r.root)).root : null;
  const reachable = driveReachable(r.root, probe);
  return {
    ok: reachable,
    root: r.root,
    source: r.source,
    hostTag: r.hostTag,
    detail: r.detail,
    drive,
    reason: reachable ? null : `冷盘不可达（${drive ?? '(无法解析盘符)'}）—— 冷盘根 ${r.root}（来源 ${r.source}）`,
    exitCode: reachable ? 0 : EXIT_DRIVE_UNAVAILABLE,
  };
}

export default resolveRollbackRoot;
