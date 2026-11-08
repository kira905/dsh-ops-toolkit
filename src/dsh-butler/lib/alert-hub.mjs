// dsh-butler / lib/alert-hub.mjs —— 外部推送出口（第四路 · 通道以「注入」方式接进来）
//
// 设计铁律三条：
//   ① **不带任何具体厂商协议**：本模块只管「开关 + 目标 + 留痕 + 诚实回报」。
//      真正把字发出去的那一层由宿主注入（`installAlertTransport(fn)`）；本包默认**没有**传输实现，
//      所以默认状态下 `sayAlert()` 只会如实返回 `no-transport`，一个字节都不外发。
//   ② **只发一个指定目标**：目标只能来自常量 / env 覆盖，**不接受来自告警正文的任意目标**
//      （避免"内容决定发给谁"这类越权面）。目标域与白名单由宿主那层自己兜底。
//   ③ **默认关 + 一键关回 + 失败留痕**：开关载体沿用 `butler-autonomy-limits.json#watchChannels.alert`
//      （与 `whale` / `sessionHeartbeat` 同父，零新增状态文件）；关回 =
//      `butler-watch-channels.mjs alert off --apply`。失败 ⇒ 审计一行 + 本地队列一行（**绝不静默吞掉**）。
//
// 宿主怎么接真实通道（示例，不在本包内）：
//   import { installAlertTransport } from './lib/alert-hub.mjs';
//   installAlertTransport(async ({ target, text, kind }) => ({ ok: true, msgid: '…' }));
//   fn 返回 `{ ok, msgid?, stage?, error? }`；抛错也按失败处理（会入队 + 审计）。
//
// 生效面：`deliverPush()` 每轮调一次 `sayAlert()` ⇒ P2 告警一并带出去；卡死提醒 / 队列提示**不接**
//   （它们量大、且不是「出事了要喊人」的语义；要接再单独定）。

import fs from 'node:fs';
import path from 'node:path';

import { dshHome } from './paths.mjs';
import { readLimits, limitsPath } from './autonomy-actions.mjs';
import { appendAudit } from './audit.mjs';
import { hostTag } from './host-tag.mjs';

export const ALERT_HUB_VERSION = '0.2.0';

// ───────────────────────────────────────────── 常量（全部可 env 覆盖，便于夹具与跨机）
export const ALERT_CHANNEL_SUBKEY = 'alert';
/** 缺省值：**关**（开源版同理：不接传输就不该有机会外发）。 */
export const ALERT_CHANNEL_DEFAULT_ENABLED = false;
/** 告警目标占位符。**本模块只允许一个目标**，真实值由部署方用 `DSH_ALERT_TARGET` 覆盖。 */
export const DEFAULT_TARGET = 'owner';
/** 单条文本上限 1500 B（UTF-8），留足余量给各家消息通道的 2048 B 限制。 */
export const MAX_TEXT_BYTES = 1500;
/** 发送超时（外层保险；传输层自己另有超时）。 */
export const SEND_TIMEOUT_MS = 12000;
/** 失败队列文件名（本地，仅最近 200 条）。 */
export const QUEUE_FILE = 'alert-queue.jsonl';
export const QUEUE_MAX = 200;

/** 判定 reason 取值域（CLI / 报告 / 审计共用一套字面量）。 */
export const ALERT_CHANNEL_REASONS = Object.freeze([
  'explicit-override', 'enabled', 'default-off', 'shape-unrecognized', 'read-failed',
]);
export const ALERT_CHANNEL_REASON_TEXT = Object.freeze({
  'explicit-override': '调用方显式指定（单轮覆盖，不读配置）',
  enabled: '配置里明确开了 ⇒ 告警往外部通道推',
  'default-off': '未配置 / 值非 true ⇒ 默认关（外部通道不参与告警）',
  'shape-unrecognized': '载体形状不认 ⇒ fail-safe：按关处理',
  'read-failed': '载体读取失败 ⇒ fail-safe：按关处理（判不出就不外发）',
});

// ───────────────────────────────────────────── 传输注入点
let TRANSPORT = null;
let TRANSPORT_NAME = null;
/**
 * 装真实传输实现。`fn({target,text,kind,at,src}) => {ok,msgid?,stage?,error?}`；
 * 传 `null` 卸载（回到"不接传输 = 不外发"）。
 */
export function installAlertTransport(fn, meta = {}) {
  if (fn !== null && typeof fn !== 'function') throw new TypeError('installAlertTransport: 需要函数或 null');
  TRANSPORT = fn;
  TRANSPORT_NAME = fn ? (meta?.name ?? 'custom') : null;
  return { installed: Boolean(fn), name: TRANSPORT_NAME };
}
export function getAlertTransport() {
  return TRANSPORT;
}
export function alertTransportInfo() {
  return { installed: Boolean(TRANSPORT), name: TRANSPORT_NAME };
}

// ───────────────────────────────────────────── 开关（与 whale / heartbeat 同款：唯一判据源）
function normOverride(v) {
  if (v === true) return true;
  if (v === false) return false;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'on' || s === 'true') return true;
    if (s === 'off' || s === 'false') return false;
  }
  return null;
}
function normTarget(v) {
  const s = typeof v === 'string' ? v.trim() : '';
  return s || null;
}

/** 外部推送通道的配置（只读；永不抛）。 */
export function resolveAlertChannel(opts = {}) {
  const target = normTarget(opts.target ?? process.env.DSH_ALERT_TARGET ?? DEFAULT_TARGET);
  const override = normOverride(opts.alertChannel ?? opts.channels?.alert);
  const file0 = (() => { try { return limitsPath({ home: opts.home }); } catch { return null; } })();
  if (override !== null) {
    return { enabled: override, reason: 'explicit-override', configured: true, source: 'override', file: file0, target, note: ALERT_CHANNEL_REASON_TEXT['explicit-override'] };
  }
  let limits = opts.limits;
  let source = opts.limits ? 'caller' : 'file';
  const file2 = file0;
  if (!limits) {
    try {
      limits = readLimits({ home: opts.home });
    } catch {
      return { enabled: false, reason: 'read-failed', configured: false, source: 'fallback', file: file2, target, note: ALERT_CHANNEL_REASON_TEXT['read-failed'] };
    }
  }
  const raw = limits?.watchChannels?.[ALERT_CHANNEL_SUBKEY];
  if (raw === undefined || raw === null) {
    return { enabled: false, reason: 'default-off', configured: false, source, file: file2, target, note: ALERT_CHANNEL_REASON_TEXT['default-off'] };
  }
  if (typeof raw === 'boolean') {
    return { enabled: raw, reason: raw ? 'enabled' : 'default-off', configured: true, source, file: file2, target, note: ALERT_CHANNEL_REASON_TEXT[raw ? 'enabled' : 'default-off'] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { enabled: false, reason: 'shape-unrecognized', configured: true, source, file: file2, target, note: ALERT_CHANNEL_REASON_TEXT['shape-unrecognized'] };
  }
  if (raw.enabled === true) {
    return { enabled: true, reason: 'enabled', configured: true, source, file: file2, target, note: ALERT_CHANNEL_REASON_TEXT.enabled };
  }
  return { enabled: false, reason: 'default-off', configured: true, source, file: file2, target, note: ALERT_CHANNEL_REASON_TEXT['default-off'] };
}

export function alertChannelLines(ch) {
  const c = ch ?? {};
  const L = [];
  L.push(`📱 外部告警通道（注入式出口）：${c.enabled ? '✅ 已开' : '⛔ 关（默认）'}`);
  L.push(`   载体：\`${c.file ?? '?'}\` · \`watchChannels.${ALERT_CHANNEL_SUBKEY}.enabled\` · 来源 ${c.source ?? '?'} · reason ${c.reason ?? '?'}`);
  L.push(`   目标：单一目标（target=${c.target ?? DEFAULT_TARGET}，可用环境变量 DSH_ALERT_TARGET 覆盖）`);
  const t = alertTransportInfo();
  L.push(`   传输：${t.installed ? `已注入（${t.name}）` : '未注入 ⇒ 只会如实返回 no-transport，一个字节都不外发'}`);
  L.push(`   说明：${c.note ?? ALERT_CHANNEL_REASON_TEXT[c.reason] ?? ''}`);
  return L;
}

// ───────────────────────────────────────────── 写开关（只改一个键 + 回读校验）
export function planAlertChannelWrite(input = {}) {
  const limits = input.limits ?? {};
  const before = resolveAlertChannel({ limits: input.limits });
  const prevRaw = limits?.watchChannels?.[ALERT_CHANNEL_SUBKEY];
  const after = {
    enabled: input.enabled === true,
    at: new Date(input.now ?? Date.now()).toISOString(),
    by: input.by ?? null,
    why: input.why ?? null,
  };
  return { before, prevRaw: prevRaw ?? null, after, changed: JSON.stringify(prevRaw ?? null) !== JSON.stringify(after) };
}

/** 落盘（只在 CLI `--apply` 路径调用；只改 `watchChannels.alert` 一个键）。 */
export async function applyAlertChannelWrite(opts = {}) {
  const home = opts.home;
  const file = limitsPath({ home });
  let limits = {};
  try {
    limits = readLimits({ home }) ?? {};
  } catch { limits = {}; }
  const plan = planAlertChannelWrite({ limits, enabled: opts.enabled, why: opts.why, by: opts.by, now: opts.now });
  if (!plan.changed) return { ok: true, changed: false, file, before: plan.before, after: plan.after };
  const parent = limits.watchChannels && typeof limits.watchChannels === 'object' ? limits.watchChannels : {};
  const next = { ...limits, schemaVersion: limits.schemaVersion ?? 1, watchChannels: { ...parent, [ALERT_CHANNEL_SUBKEY]: plan.after } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
  // 回读校验（不信自己写的）
  let afterRead = null;
  try {
    const rt = resolveAlertChannel({ home, limits: readLimits({ home }) });
    afterRead = { enabled: rt.enabled, reason: rt.reason };
  } catch (e) {
    afterRead = { error: String(e?.message ?? e) };
  }
  const ok = afterRead?.enabled === plan.after.enabled;
  return { ok, changed: true, file, before: plan.before, after: plan.after, afterRead };
}

// ───────────────────────────────────────────── 失败队列（只记「发不出去」，绝不自动重发）
function queuePath(opts = {}) {
  try { return path.join(dshHome(opts), QUEUE_FILE); } catch { return path.join(process.cwd(), QUEUE_FILE); }
}

export function enqueueFailed(entry = {}, opts = {}) {
  const file = queuePath(opts);
  const row = {
    at: new Date(opts.now ?? Date.now()).toISOString(),
    target: entry.target ?? null,
    reason: entry.reason ?? null,
    error: entry.error ? String(entry.error).slice(0, 300) : null,
    preview: String(entry.text ?? '').replace(/\s+/g, ' ').slice(0, 80),
  };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rows = readQueue(opts);
    const keep = [...rows.rows, row].slice(-QUEUE_MAX);
    fs.writeFileSync(file, keep.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
    return { ok: true, file };
  } catch (e) {
    return { ok: false, file, error: String(e?.message ?? e) };
  }
}

export function readQueue(opts = {}) {
  const file = queuePath(opts);
  if (!fs.existsSync(file)) return { exists: false, file, rows: [] };
  const rows = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const s = line.trim();
    if (!s) continue;
    try { rows.push(JSON.parse(s)); } catch { /* 坏行跳过，不影响其余 */ }
  }
  return { exists: true, file, rows };
}

// ───────────────────────────────────────────── 发送
function truncateBytes(text, max) {
  const s = String(text ?? '');
  if (Buffer.byteLength(s, 'utf8') <= max) return s;
  let out = '';
  let n = 0;
  for (const ch of s) {
    const b = Buffer.byteLength(ch, 'utf8');
    if (n + b > max - 3) break;
    out += ch;
    n += b;
  }
  return out + '…';
}

/**
 * 把一段文本推到外部告警通道。
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, error:string|null,
 *   channelEnabled:boolean, via:string, target:string, bytes:number, ms:number,
 *   stage?:string|null, msgid?:string|null}>}
 */
export async function sayAlert(text, opts = {}) {
  const now = opts.now ?? Date.now();
  const channel = resolveAlertChannel(opts);
  const body0 = truncateBytes(text, MAX_TEXT_BYTES);
  const base = {
    ok: false, skipped: false, error: null, channelEnabled: channel.enabled,
    via: 'transport', target: channel.target, bytes: Buffer.byteLength(body0, 'utf8'), ms: 0,
  };
  if (!channel.enabled) return { ...base, skipped: true, reason: channel.reason };
  if (opts.dryRun === true) return { ...base, skipped: true, reason: 'dry-run' };
  const transport = getAlertTransport();
  if (!transport) {
    enqueueFailed({ target: channel.target, reason: 'no-transport', text: body0 }, opts);
    return { ...base, skipped: true, reason: 'no-transport' };
  }
  const t0 = Date.now();
  let r = null;
  let err = null;
  try {
    r = await transport({
      target: channel.target, text: body0, kind: opts.kind ?? 'alert',
      at: new Date(now).toISOString(), src: `alert-hub@${ALERT_HUB_VERSION}`, host: safeHostTag(),
    });
  } catch (e) {
    err = String(e?.message ?? e);
  }
  const ms = Date.now() - t0;
  const ok = !err && r?.ok === true;
  const stage = ok ? null : (r?.stage ?? (err ? 'exception' : 'send'));
  const error = ok ? null : (err ?? r?.error ?? 'not-delivered');
  if (!ok) enqueueFailed({ target: channel.target, reason: stage, error, text: body0 }, opts);
  try {
    appendAudit({
      type: 'alert-hub', action: 'send', ok, via: 'transport', target: channel.target,
      bytes: base.bytes, ms, stage: stage ?? null, msgid: r?.msgid ?? null,
      note: ok ? null : String(error).slice(0, 200),
    }, { home: opts.home, silent: opts.silent });
  } catch { /* 留痕失败不影响投递结果（告警能力优先） */ }
  return { ...base, ok, ms, stage, error, msgid: r?.msgid ?? null };
}

function safeHostTag() {
  try { return hostTag(); } catch { return null; }
}

export function alertResultLine(r) {
  if (!r) return '📱 外部通道：未尝试';
  if (r.skipped) return `📱 外部通道：⛔ 跳过（${r.reason ?? 'default-off'}）`;
  if (r.ok) return `📱 外部通道：✅ 已送达（${r.bytes} B · ${r.ms} ms${r.msgid ? ` · ${String(r.msgid).slice(0, 16)}` : ''}）`;
  return `📱 外部通道：❌ 未送达（${r.stage ?? '?'} · ${String(r.error ?? '').slice(0, 160)}）`;
}
