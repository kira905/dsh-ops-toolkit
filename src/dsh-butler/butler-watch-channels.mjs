#!/usr/bin/env node
// dsh-butler / butler-watch-channels.mjs —— 桌宠（/whale/say）自动出话通道的一键开关
//
// 由来（V3.0.0 功能面 C 段 · 封口清单 §1 第 6 条）：判据要求「桌宠不再背告警；外部通道 + 日报 + 会话内
//   三条路都真能喊到人」。改造点 = `lib\watch-notify.mjs` 的投递链把桌宠降为**可选、默认关**，
//   载体 = `~/.dsh/butler-autonomy-limits.json` 的 `watchChannels.whale`（已登记状态文件，零新增文件）。
//   本 CLI 就是那句"一键开回 / 关回"。
//   【2026-10-21 · 功能面 C2】加 `heartbeat status|on|off`：会话通道心跳兜底（`watchChannels.sessionHeartbeat`，
//   **缺省开**）的一键开关；关 = 回到纯 `guard-session.id` mtime 判据（C2 之前的旧行为）。
//
// 用法（**默认 dry-run，--apply 才写盘**）：
//   node <pkg>/src/dsh-butler/butler-watch-channels.mjs status [--json]
//   node <pkg>/src/dsh-butler/butler-watch-channels.mjs off --apply --why "回到默认：桌宠不背告警" [--allow-production]
//   node <pkg>/src/dsh-butler/butler-watch-channels.mjs on  --apply --why "主人要看桌宠报一句"   [--allow-production]
//   node <pkg>/src/dsh-butler/butler-watch-channels.mjs heartbeat status [--json]      # C2 心跳兜底（缺省开）
//   node <pkg>/src/dsh-butler/butler-watch-channels.mjs heartbeat off --apply --why "回到纯 guard-session.id 判据" [--allow-production]
//
// 红线（与 butler-ctx-guard.mjs 的 --steer-* 同款 fail-closed）：
//   · 默认 dry-run（不加 --apply 一律不写盘）；
//   · 对**生产 home** 写盘必须显式 `--allow-production`（否则 exit 2）；
//   · 只改 `watchChannels.whale` 一个键（`updateStateJson` 原子写 + 锁），其余键原样保留；
//   · 写后**回读校验**（不信自己写的）；
//   · `--json` 时 stdout **只许 JSON**（诊断走 stderr）。
//
// 生效面：`sayWhale()` 函内第一道门 ⇒ P2 告警 / 卡死提醒 / 队列提示 / 收纳摘要**一并**受管。
//   改完**不需要重启 dsh**；但 `watch-notify.mjs` 由 tickd 常驻进程加载 ⇒ tickd 需重启一次才吃到新代码
//   （`node <pkg>/src/dsh-butler/butler-tickd.mjs --stop` 后靠 tickd-watchdog 自动 ensure）。
import fs from 'node:fs';
import path from 'node:path';

import {
  resolveWhaleChannel, whaleChannelLines, applyWhaleChannelWrite, WATCH_CHANNEL_LIMITS_KEY, WHALE_CHANNEL_SUBKEY,
  resolveSessionHeartbeatChannel, sessionHeartbeatChannelLines, applySessionHeartbeatWrite, SESSION_HEARTBEAT_SUBKEY,
} from './lib/watch-notify.mjs';
// 【2026-10-21 · C 补】外部告警通道（第四路）：开关 + 失败队列（只读查看）
import {
  resolveAlertChannel, alertChannelLines, applyAlertChannelWrite, readQueue as readAlertQueue,
  ALERT_CHANNEL_SUBKEY, DEFAULT_TARGET, QUEUE_FILE,
} from './lib/alert-hub.mjs';
import { dshHome } from './lib/paths.mjs';
import { isProductionHome } from './lib/state-paths.mjs';

const CLI_VERSION = '0.3.0';
const USAGE = [
  '用法（默认 dry-run，--apply 才写盘）：',
  '  桌宠：  node butler-watch-channels.mjs status [--json]',
  '          node butler-watch-channels.mjs off --apply --why "..." [--allow-production]',
  '          node butler-watch-channels.mjs on  --apply --why "..." [--allow-production]',
  '  心跳：  node butler-watch-channels.mjs heartbeat status [--json]',
  '          node butler-watch-channels.mjs heartbeat off --apply --why "回到纯 guard-session.id 判据" [--allow-production]',
  '          node butler-watch-channels.mjs heartbeat on  --apply --why "..." [--allow-production]',
  '  外部通道：  node butler-watch-channels.mjs alert status [--json]        # C 补：告警往手机推（hub 长连接）',
  '          node butler-watch-channels.mjs alert on  --apply --why "..." [--allow-production]',
  '          node butler-watch-channels.mjs alert off --apply --why "关回默认" [--allow-production]',
  '          node butler-watch-channels.mjs alert queue                   # 看发送失败留痕（只读）',
  '说明：载体 = ~/.dsh/butler-autonomy-limits.json 的 watchChannels.*；桌宠缺省/未配置 = 关（桌宠不背告警）；',
  '     心跳缺省/未配置 = 开（C2：guard-session.id 陈旧时用最近活跃会话兜底，仍受 15 分钟新鲜窗约束）；',
  '     外部通道缺省/未配置 = 关（C 补：开了才往主人本人单聊推；关回 = 一条命令，零残留）。',
].join('\n');

/** junction 下 import.meta.url 会解析为物理路径 ⇒ 必须 realpath 双方再比（否则静默退出 0）。 */
function isMainEntry() {
  try {
    const a = fs.realpathSync(process.argv[1] ?? '');
    const b = fs.realpathSync(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
    return a.toLowerCase() === b.toLowerCase();
  } catch {
    return false;
  }
}

export function parseArgs(argv = process.argv.slice(2)) {
  const has = (f) => argv.includes(f);
  const get = (f) => { const i = argv.indexOf(f); return i >= 0 ? argv[i + 1] : undefined; };
  const positional = argv.filter((a, i) => !a.startsWith('-') && !(i > 0 && String(argv[i - 1]).startsWith('--') && String(argv[i - 1]) !== '--'));
  return {
    sub: positional[0] ?? 'status',
    sub2: positional[1] ?? null,
    apply: has('--apply'),
    allowProduction: has('--allow-production'),
    json: has('--json'),
    quiet: has('--quiet'),
    help: has('--help') || has('-h'),
    why: get('--why'),
    by: get('--by'),
    home: get('--home'),
  };
}

async function main() {
  const args = parseArgs();
  const home = args.home ?? process.env.BUTLER_DSH_HOME ?? dshHome();
  const prod = isProductionHome(home);
  const lines = [];
  const json = {
    cli: 'butler-watch-channels', version: CLI_VERSION, sub: args.sub,
    home, production: prod, apply: args.apply === true,
  };
  const emit = (code, status) => {
    json.status = status;
    if (args.json) process.stdout.write(JSON.stringify(json, null, 2) + '\n');
    else if (!args.quiet) for (const l of lines) process.stdout.write(l + '\n');
    process.exitCode = code;
  };

  if (args.help) {
    lines.push(USAGE);
    return emit(0, 'help');
  }

  const curWhale = resolveWhaleChannel({ home });
  const curHeartbeat = resolveSessionHeartbeatChannel({ home });
  const curAlert = resolveAlertChannel({ home });
  json.current = {
    whale: { enabled: curWhale.enabled, reason: curWhale.reason, configured: curWhale.configured, source: curWhale.source, file: curWhale.file },
    sessionHeartbeat: { enabled: curHeartbeat.enabled, reason: curHeartbeat.reason, configured: curHeartbeat.configured, source: curHeartbeat.source, file: curHeartbeat.file },
    alert: { enabled: curAlert.enabled, reason: curAlert.reason, configured: curAlert.configured, source: curAlert.source, file: curAlert.file, target: curAlert.target },
  };

  // 三路通道共用一套路由（whale = 无前缀子命令；heartbeat / alert = 前缀子命令）
  const CHANNELS = {
    whale: { key: WHALE_CHANNEL_SUBKEY, lines: whaleChannelLines, write: applyWhaleChannelWrite, now: curWhale, fresh: () => resolveWhaleChannel({ home }) },
    heartbeat: { key: SESSION_HEARTBEAT_SUBKEY, lines: sessionHeartbeatChannelLines, write: applySessionHeartbeatWrite, now: curHeartbeat, fresh: () => resolveSessionHeartbeatChannel({ home }) },
    alert: { key: ALERT_CHANNEL_SUBKEY, lines: alertChannelLines, write: applyAlertChannelWrite, now: curAlert, fresh: () => resolveAlertChannel({ home }) },
  };

  if (args.sub === 'status') {
    for (const [i, name] of ['whale', 'heartbeat', 'alert'].entries()) {
      if (i > 0) lines.push('');
      lines.push(...CHANNELS[name].lines(CHANNELS[name].now));
    }
    return emit(0, 'read-only');
  }

  // `alert queue` / `queue` = 只读看发送失败留痕（不写盘、不重发）
  if ((args.sub === 'alert' && args.sub2 === 'queue') || args.sub === 'queue') {
    const q = readAlertQueue({ home });
    json.queue = { exists: q.exists, file: q.file, count: q.rows.length };
    lines.push(`📮 外部通道发送失败留痕：${q.exists ? `${q.rows.length} 条` : '无'}（${q.file}）`);
    lines.push(`   口径：只记「发不出去」的条目（原因 + 摘要前 80 字符），**不自动重发**；真相仍是 hub 的出口计数。`);
    for (const r of q.rows.slice(-10)) lines.push(`   · ${r.at} · ${r.reason} · ${r.error ?? ''} · ${r.preview ?? ''}`);
    return emit(0, 'read-only');
  }

  const chanName = (args.sub === 'heartbeat' || args.sub === 'alert') ? args.sub : 'whale';
  const chan = CHANNELS[chanName];
  const action = chanName === 'whale' ? args.sub : (args.sub2 ?? 'status');
  if (action === 'status') {
    lines.push(...chan.lines(chan.now));
    return emit(0, 'read-only');
  }
  if (action !== 'on' && action !== 'off') {
    lines.push(`❌ 用法错：子命令只能是 status / on / off（或 heartbeat|alert status/on/off），实得 "${[args.sub, args.sub2].filter(Boolean).join(' ')}"`);
    lines.push(USAGE);
    return emit(2, 'usage-error');
  }

  const target = chan.now;
  const keyPath = `${WATCH_CHANNEL_LIMITS_KEY}.${chan.key}`;
  const linesFor = chan.lines;
  const enabled = action === 'on';
  if (target.enabled === enabled) {
    lines.push(`✅ 已是目标态（${enabled ? '开' : '关'}）—— 幂等 noop，未写盘`);
    lines.push(...linesFor(target));
    return emit(0, 'noop');
  }
  lines.push(`[${args.apply ? 'apply' : 'dry-run'}] 目标态：${keyPath}.enabled = ${enabled}`);
  lines.push(`  载体：${target.file}`);
  lines.push(`  当前：enabled=${target.enabled} · reason=${target.reason}`);
  if (chanName === 'alert') lines.push(`  目标域：主人本人单聊（target=${target.target ?? DEFAULT_TARGET}）· 口径：只发主人单聊 + 已授 notify_family 的家人；@all / 第三方仍禁（**告警永远只发主人**）`);
  if (!args.apply) {
    lines.push('  （加 --apply 才真写；生产 home 另需 --allow-production）');
    return emit(0, 'dry-run');
  }
  if (prod && !args.allowProduction) {
    lines.push(`❌ 拒绝：对生产 home（${home}）写盘必须显式 --allow-production（fail-closed）`);
    return emit(2, 'refused');
  }
  const r = await chan.write({ home, enabled, why: args.why ?? undefined, by: args.by ?? undefined });
  json.written = { ok: r.ok, changed: r.changed, file: r.file, afterRead: r.afterRead ?? null };
  json.path = keyPath;
  lines.push(`${r.ok ? '✅' : '❌'} ${r.changed ? '已写盘' : '无变化'}（${r.file}）${r.ok ? ' · 回读校验通过' : ' · 回读校验失败'}`);
  lines.push(...linesFor(chan.fresh()));
  if (r.ok) lines.push('', '提醒：tickd 常驻进程已加载旧代码 ⇒ 要让 P2 投递链立刻按新开关走，重启一次 tickd（不必重启 dsh）。');
  return emit(r.ok ? 0 : 1, r.ok ? 'applied' : 'verify-failed');
}

if (isMainEntry()) {
  main().catch((e) => {
    process.stderr.write(`[butler-watch-channels] 失败：${e?.stack ?? e}\n`);
    process.exitCode = 1;
  });
}
