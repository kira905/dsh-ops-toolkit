#!/usr/bin/env node
/**
 * dsh-dl-scheduler.mjs — 多网卡下载调度器（双链路分流/聚合）
 *
 * 背景：电脑同时插网线 + 连手机热点时，Windows 默认只走一条链路。
 * 本工具把下载任务按两条链路的实测速度比例分配，实现"双份网速"：
 *   - 多任务队列：按速度加权轮询，把不同任务分给不同网卡（互不抢带宽）
 *   - 单任务：若源站支持 HTTP Range，按速度比例分段，各段绑定不同网卡并行下载后合并
 *
 * 设计约束（跨设备通用，ROG / TUF 两台机都直接用）：
 *   - 零依赖：纯 Node 标准库（node >= 18，fetch 不需要，用 http/https + localAddress）
 *   - 不硬编码用户名/路径：状态文件默认 <DSH_ROOT>\_tmp\dl-queue（可用 DSH_DL_DIR 覆盖）
 *   - 网卡自动枚举（os.networkInterfaces），类型有线/无线按名字启发式识别
 *   - 下载用系统 curl.exe（Win10+ 自带），不存在时退回 node 原生下载
 *
 * 用法：
 *   node dsh-dl-scheduler.mjs status                    列出在线网卡
 *   node dsh-dl-scheduler.mjs speedtest [--url <U>]     对每张网卡实测吞吐（缓存 15 分钟）
 *   node dsh-dl-scheduler.mjs add <url> [--out <path>] [--name <n>]   加入队列
 *   node dsh-dl-scheduler.mjs list                      查看队列
 *   node dsh-dl-scheduler.mjs remove <index>            移除任务（1-based）
 *   node dsh-dl-scheduler.mjs clear                     清空队列
 *   node dsh-dl-scheduler.mjs run [--force]             执行队列（自动测速/按比例分流）
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { spawn } from 'node:child_process';

const QUEUE_DIR = process.env.DSH_DL_DIR || path.join(os.homedir(), '.dsh', '_tmp', 'dl-queue');
const STATE_FILE = path.join(QUEUE_DIR, 'queue.json');
const DL_DIR = path.join(QUEUE_DIR, 'downloads');
const PROXY_SCRIPT = process.env.DSH_PROXY_SCRIPT || 'dsh-proxy.ps1'; // 按需代理自控脚本（可用 DSH_PROXY_SCRIPT 指定绝对路径）
const PROXY_URL = 'http://127.0.0.1:7897';            // Clash Verge 核心端口
const DEFAULT_SPEED_URL = 'https://speed.cloudflare.com/__down?bytes=2097152'; // 2MB 测速
const SPEED_CACHE_TTL_MS = 15 * 60 * 1000; // 测速结果缓存 15 分钟
const SPEED_MAX_BYTES = 2 * 1024 * 1024;   // 测速最多读 2MB
const SPEED_TIMEOUT_MS = 15000;            // 单卡测速超时 15s
const MIN_SEGMENT_BYTES = 256 * 1024;      // 分段最小 256KB，太小并入他段
const MAX_REDIRECTS = 3;

// ---------- 基础工具 ----------

function log(msg) { console.log(`[dl] ${msg}`); }
function err(msg) { console.error(`[dl] ${msg}`); process.exitCode = 1; }

function classifyNic(name) {
  if (/WLAN|Wi-?Fi|Wireless|无线|热点/i.test(name)) return 'wireless';
  if (/以太网|Ethernet|有线/i.test(name)) return 'wired';
  return 'unknown';
}

/** 枚举在线网卡：有 IPv4、非 loopback、非 link-local */
function listOnlineNics() {
  const ifaces = os.networkInterfaces();
  const out = [];
  for (const [name, addrs] of Object.entries(ifaces)) {
    const v4 = (addrs || []).find(a => a.family === 'IPv4' && !a.internal);
    if (!v4) continue;
    if (v4.address.startsWith('169.254.')) continue;
    out.push({ name, ip: v4.address, type: classifyNic(name) });
  }
  return out;
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    return { tasks: Array.isArray(raw.tasks) ? raw.tasks : [], speedCache: raw.speedCache || {} };
  } catch {
    return { tasks: [], speedCache: {} };
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function mbpsOf(bytes, ms) {
  if (!ms || ms <= 0) return 0;
  return (bytes * 8) / (ms / 1000) / 1e6;
}

// ---------- 测速（node 原生，绑定源 IP） ----------

function probeOnce(url, localIp, maxBytes, timeoutMs, redirectsLeft) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET',
      headers: { 'user-agent': 'dsh-dl-scheduler/1.0', 'accept-encoding': 'identity' },
      localAddress: localIp,
      timeout: timeoutMs,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft > 0) {
          const next = new URL(res.headers.location, url).toString();
          probeOnce(next, localIp, maxBytes, timeoutMs, redirectsLeft - 1).then(done);
        } else {
          done({ ok: false, reason: 'too many redirects' });
        }
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        done({ ok: false, reason: `HTTP ${res.statusCode}` });
        return;
      }
      let received = 0;
      const start = Date.now();
      res.on('data', (chunk) => {
        received += chunk.length;
        if (received >= maxBytes) {
          done({ ok: true, bytes: received, ms: Date.now() - start });
          req.destroy();
        }
      });
      res.on('end', () => done({ ok: true, bytes: received, ms: Date.now() - start }));
      res.on('error', (e) => done({ ok: false, reason: e.message }));
    });
    req.on('timeout', () => { req.destroy(); done({ ok: false, reason: 'timeout' }); });
    req.on('error', (e) => done({ ok: false, reason: e.message }));
    req.end();
  });
}

/** 直连可达性探测：收到任何 HTTP 响应头即视为可达（立即断开，不下载 body） */
function probeReachable(url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok) => { if (!settled) { settled = true; resolve(ok); } };
    const tryOnce = (target, depth) => {
      let req;
      try {
        const u = new URL(target);
        const mod = u.protocol === 'https:' ? https : http;
        req = mod.request(u, {
          method: 'GET',
          headers: { 'user-agent': 'dsh-dl-scheduler/1.0', 'accept-encoding': 'identity' },
          timeout: 8000,
        }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && depth < MAX_REDIRECTS) {
            res.resume();
            tryOnce(new URL(res.headers.location, target), depth + 1);
            return;
          }
          res.resume();
          req.destroy();
          done(true);
        });
        req.on('timeout', () => { req.destroy(); done(false); });
        req.on('error', () => done(false));
        req.end();
      } catch {
        done(false);
      }
    };
    tryOnce(url, 0);
  });
}

async function speedtestNics(nics, speedUrl) {
  const results = [];
  for (const nic of nics) {
    log(`测速 ${nic.name} (${nic.ip}) ...`);
    const r = await probeOnce(speedUrl, nic.ip, SPEED_MAX_BYTES, SPEED_TIMEOUT_MS, MAX_REDIRECTS);
    if (r.ok) {
      const mbps = mbpsOf(r.bytes, r.ms);
      log(`  ${nic.name}: ${r.bytes} bytes / ${r.ms} ms ≈ ${mbps.toFixed(2)} Mbps`);
      results.push({ name: nic.name, mbps });
    } else {
      log(`  ${nic.name}: 测速失败（${r.reason}），按 0 处理`);
      results.push({ name: nic.name, mbps: 0 });
    }
  }
  return results;
}

// ---------- 下载执行 ----------

function findCurl() {
  const candidates = [process.env.CURL || 'curl.exe'];
  return candidates[0];
}

function runCurl(args) {
  return new Promise((resolve) => {
    const child = spawn(findCurl(), args, { stdio: 'inherit' });
    child.on('error', (e) => { console.error(`[dl] curl 启动失败: ${e.message}`); resolve(false); });
    child.on('exit', (code) => resolve(code === 0));
  });
}

/** 调用 dsh-proxy.ps1（stdio inherit，避免沙箱管道限制），成功返回 true */
function runPwshProxy(args) {
  return new Promise((resolve) => {
    const child = spawn('pwsh', ['-NoProfile', '-File', PROXY_SCRIPT, ...args], { stdio: 'inherit' });
    child.on('error', (e) => { console.error(`[dl] pwsh 启动失败: ${e.message}`); resolve(false); });
    child.on('exit', (code) => resolve(code === 0));
  });
}

/**
 * 按需确保代理：直连可达 -> 'direct'（不走代理，国内源快）；
 * 直连不可达 -> 拉起 dsh-proxy.ps1 自检代理 -> 就绪 'proxy'，失败仍 'direct'（尽力而为）
 */
async function ensureProxyFor(url) {
  log(`代理自检（直连优先）: ${url}`);
  if (await probeReachable(url)) {
    log(`  直连可达，不需要代理`);
    return 'direct';
  }
  log(`  直连不可达，拉起代理...`);
  const ok = await runPwshProxy(['-Action', 'ensure', '-TestUrl', url]);
  if (ok) { log(`  代理就绪`); return 'proxy'; }
  log(`  代理自检失败（继续尝试直连下载）`);
  return 'direct';
}

// 慢速超时：平均速度低于 1KB/s 持续 30 秒则中止（防止链路卡死无限等待）
const CURL_SPEED_ARGS = ['--speed-limit', '1024', '--speed-time', '30'];

async function simpleDownload(url, out, localIp, proxy) {
  log(`  单链路下载（绑 ${localIp}${proxy ? '，走代理' : ''}）`);
  const args = ['--fail', '--location',
    '--connect-timeout', '20', '--retry', '2', ...CURL_SPEED_ARGS,
    '--output', out, url];
  if (proxy) {
    // 代理模式下不绑 --interface：绑物理网卡 IP 连本地代理会被拒（curl 实测 exit 7）
    args.unshift('-x', PROXY_URL);
  } else {
    args.unshift('--interface', localIp);
  }
  const ok = await runCurl(args);
  if (!ok) { err(`  下载失败: ${url}`); return false; }
  return true;
}

/** 探测是否支持 Range 及总大小 */
function probeRange(url, localIp) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, {
      method: 'GET',
      headers: { 'user-agent': 'dsh-dl-scheduler/1.0', 'range': 'bytes=0-0' },
      localAddress: localIp,
      timeout: 15000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        probeRange(next, localIp).then(done);
        return;
      }
      res.resume();
      const cr = res.headers['content-range'] || '';
      const m = cr.match(/bytes 0-0\/(\d+)/);
      const total = m ? Number(m[1]) : null;
      const accept = (res.headers['accept-ranges'] || '').toLowerCase();
      done({ supportsRange: (accept === 'bytes' || total !== null) && total !== null, totalBytes: total });
    });
    req.on('timeout', () => { req.destroy(); done({ supportsRange: false, totalBytes: null }); });
    req.on('error', () => done({ supportsRange: false, totalBytes: null }));
    req.end();
  });
}

/** 按速度比例切段，返回 [{ip, start, end, partPath}] */
function splitByWeight(totalBytes, nics, mbpsList) {
  const total = mbpsList.reduce((a, b) => a + b, 0);
  if (total <= 0 || nics.length === 1) {
    // 退化：全部给第一张卡
    return [{ ip: nics[0].ip, start: 0, end: totalBytes - 1 }];
  }
  const segs = [];
  let cursor = 0;
  for (let i = 0; i < nics.length; i++) {
    const bytes = i === nics.length - 1
      ? totalBytes - cursor
      : Math.floor(totalBytes * (mbpsList[i] / total));
    if (bytes >= MIN_SEGMENT_BYTES && bytes > 0) {
      segs.push({ ip: nics[i].ip, start: cursor, end: cursor + bytes - 1 });
      cursor += bytes;
    }
  }
  // 若尾部还有剩余（小数舍入/被过滤的段），并入最后一段
  if (cursor < totalBytes) {
    if (segs.length > 0) {
      segs[segs.length - 1].end = totalBytes - 1;
    } else {
      segs.push({ ip: nics[0].ip, start: 0, end: totalBytes - 1 });
    }
  }
  return segs;
}

async function segmentedDownload(url, out, nics, mbpsList, proxy) {
  // 用最快网卡的 IP 做 Range 探测（探测本身不占多少流量）
  const bestIdx = mbpsList.indexOf(Math.max(...mbpsList));
  const probe = await probeRange(url, nics[bestIdx].ip);
  if (!probe.supportsRange || !probe.totalBytes || probe.totalBytes < MIN_SEGMENT_BYTES * 2) {
    log(`  源站不支持 Range 或文件太小，退回单链路（最快网卡 ${nics[bestIdx].name}）`);
    return simpleDownload(url, out, nics[bestIdx].ip, proxy);
  }

  const segs = splitByWeight(probe.totalBytes, nics, mbpsList);
  log(`  目标 ${probe.totalBytes} bytes，按速度比例切 ${segs.length} 段并行下载`);
  // 清理上次残留的分片
  try {
    for (const f of fs.readdirSync(QUEUE_DIR)) {
      if (/^part\.\d+\.tmp$/.test(f)) { try { fs.unlinkSync(path.join(QUEUE_DIR, f)); } catch {} }
    }
  } catch {}
  const partFiles = [];
  const procs = segs.map((seg, i) => {
    const part = path.join(QUEUE_DIR, `part.${i}.tmp`);
    partFiles.push(part);
    return (async () => {
      // 每段最多尝试 2 次（慢速超时/瞬时失败都算一次）
      for (let attempt = 1; attempt <= 2; attempt++) {
        const segArgs = [
          '--fail', '--location',
          '--connect-timeout', '20', '--retry', '2', ...CURL_SPEED_ARGS,
          '--range', `${seg.start}-${seg.end}`,
          '--output', part, url,
        ];
        if (proxy) {
          segArgs.unshift('-x', PROXY_URL); // 代理模式不绑网卡（绑物理网卡连本地代理被拒）
        } else {
          segArgs.unshift('--interface', seg.ip);
        }
        const ok = await runCurl(segArgs);
        if (ok) return { ok: true, part, seg };
        if (attempt === 1) log(`  段 ${i} 第 1 次失败，重试一次（绑 ${seg.ip}）`);
      }
      return { ok: false, part, seg };
    })();
  });

  const results = await Promise.all(procs);
  const failed = results.filter(r => !r.ok);
  if (failed.length > 0) {
    for (const p of partFiles) { try { fs.unlinkSync(p); } catch {} }
    err(`  有 ${failed.length} 段下载失败，已清理分片`);
    return false;
  }

  // 校验分片大小之和
  const totalGot = partFiles.reduce((a, p) => a + fs.statSync(p).size, 0);
  if (totalGot !== probe.totalBytes) {
    for (const p of partFiles) { try { fs.unlinkSync(p); } catch {} }
    err(`  分片大小不符（期望 ${probe.totalBytes}，实得 ${totalGot}），已清理`);
    return false;
  }

  // 按段序合并
  log(`  合并 ${partFiles.length} 个分片 -> ${out}`);
  const ws = fs.createWriteStream(out);
  for (const p of partFiles) {
    await new Promise((res, rej) => {
      const rs = fs.createReadStream(p);
      rs.on('error', rej);
      rs.pipe(ws, { end: false });
      rs.on('end', res);
    });
  }
  ws.end();
  await new Promise((res, rej) => { ws.on('finish', res); ws.on('error', rej); });
  for (const p of partFiles) { try { fs.unlinkSync(p); } catch {} }
  log(`  完成: ${out}（${totalGot} bytes）`);
  return true;
}

// ---------- 命令实现 ----------

function cmdStatus() {
  const nics = listOnlineNics();
  log(`在线网卡（共 ${nics.length} 张）：`);
  for (const n of nics) {
    log(`  - ${n.name}  [${n.type}]  ${n.ip}`);
  }
  if (nics.length < 2) log('提示：只有一张在线网卡，无法分流（需要网线 + 热点/第二条链路）');
  const state = loadState();
  const cacheKeys = Object.keys(state.speedCache);
  if (cacheKeys.length > 0) {
    log('测速缓存：');
    for (const k of cacheKeys) {
      const c = state.speedCache[k];
      log(`  - ${k}: ${c.mbps.toFixed(2)} Mbps（${new Date(c.at).toLocaleString()}）`);
    }
  } else {
    log('尚无测速缓存，可先跑 speedtest');
  }
}

async function cmdSpeedtest(speedUrl) {
  const nics = listOnlineNics();
  if (nics.length === 0) { err('没有在线网卡'); return; }
  const results = await speedtestNics(nics, speedUrl);
  const state = loadState();
  for (const r of results) {
    state.speedCache[r.name] = { mbps: r.mbps, at: Date.now() };
  }
  saveState(state);
  log('测速结果已缓存（15 分钟有效，run 时 --force 可强制重测）');
}

function safeFilename(name) {
  return name.replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120) || 'download';
}

function cmdAdd(url, out, name) {
  if (!/^https?:\/\//i.test(url)) { err('URL 必须以 http(s):// 开头'); return; }
  const state = loadState();
  let finalOut = out;
  if (!finalOut) {
    fs.mkdirSync(DL_DIR, { recursive: true });
    const base = safeFilename(name || (() => {
      try { return decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || 'download'); } catch { return 'download'; }
    })());
    finalOut = path.join(DL_DIR, base);
  }
  finalOut = path.resolve(finalOut);
  state.tasks.push({ url, out: finalOut, name: name || path.basename(finalOut), addedAt: Date.now(), status: 'pending' });
  saveState(state);
  log(`已加入队列 #${state.tasks.length}: ${name || path.basename(finalOut)}`);
  log(`  URL: ${url}`);
  log(`  输出: ${finalOut}`);
}

function cmdList() {
  const state = loadState();
  if (state.tasks.length === 0) { log('队列为空'); return; }
  state.tasks.forEach((t, i) => {
    const done = t.status === 'done' ? `（完成 ${new Date(t.doneAt || t.addedAt).toLocaleString()}）` : '';
    const failed = t.status === 'failed' ? `（失败: ${t.error || '未知'}）` : '';
    log(`#${i + 1} [${t.status}] ${t.name}${done}${failed}`);
    log(`     ${t.url}`);
    log(`     -> ${t.out}`);
  });
}

function cmdRemove(index) {
  const state = loadState();
  if (index < 1 || index > state.tasks.length) { err(`没有 #${index}（共 ${state.tasks.length} 个任务）`); return; }
  const [removed] = state.tasks.splice(index - 1, 1);
  saveState(state);
  log(`已移除 #${index}: ${removed.name}`);
}

function cmdClear() {
  saveState({ tasks: [], speedCache: {} });
  log('队列与测速缓存已清空');
}

async function cmdRun(force, speedUrl, ensureProxy) {
  const state = loadState();
  const pending = state.tasks.filter(t => t.status === 'pending');
  if (pending.length === 0) { log('没有待执行的任务（add 加入后再 run）'); return; }
  const nics = listOnlineNics();
  if (nics.length === 0) { err('没有在线网卡'); return; }

  // 0) 按需代理：每个待执行任务先直连自检，不通则自动拉起代理（--ensure-proxy 时）
  const modes = [];
  if (ensureProxy) {
    log(`开始代理自检（${pending.length} 个任务）...`);
    for (const t of pending) {
      modes.push(await ensureProxyFor(t.url));
    }
  } else {
    for (const _ of pending) modes.push('direct');
  }

  // 1) 测速（缓存有效期内不重测，除非 --force；--url 可指定更接近下载源的测速地址）
  let needSpeed = force;
  for (const n of nics) {
    const c = state.speedCache[n.name];
    if (!c || !c.mbps || Date.now() - c.at > SPEED_CACHE_TTL_MS) needSpeed = true;
  }
  if (needSpeed) {
    log(`重新测速（${speedUrl}）...`);
    const results = await speedtestNics(nics, speedUrl);
    for (const r of results) state.speedCache[r.name] = { mbps: r.mbps, at: Date.now() };
    saveState(state);
  }
  const mbpsList = nics.map(n => state.speedCache[n.name]?.mbps || 0);
  const usable = nics.filter((_, i) => mbpsList[i] > 0);
  const usableMbps = usable.map((_, i) => mbpsList[nics.indexOf(usable[i])]);

  if (usable.length === 0) { err('所有网卡测速都是 0，无法分流（检查网络或换测速 URL）'); return; }
  log(`参与分流的链路：${usable.map((u, i) => `${u.name}(${usableMbps[i].toFixed(1)}Mbps)`).join(' + ')}`);

  // 2) 执行
  if (pending.length === 1) {
    const t = pending[0];
    log(`单任务 #${state.tasks.indexOf(t) + 1}: ${t.name}`);
    const ok = await segmentedDownload(t.url, t.out, usable, usableMbps, modes[0] === 'proxy');
    t.status = ok ? 'done' : 'failed';
    t.doneAt = Date.now();
    if (!ok) t.error = 'download failed';
  } else {
    // 多任务：按速度比例加权轮询分配网卡，每任务单链路下载
    const total = usableMbps.reduce((a, b) => a + b, 0);
    const quotas = usableMbps.map(m => Math.floor(pending.length * (m / total)));
    let rem = pending.length - quotas.reduce((a, b) => a + b, 0);
    let bestIdx = 0;
    for (let i = 1; i < usableMbps.length; i++) if (usableMbps[i] > usableMbps[bestIdx]) bestIdx = i;
    quotas[bestIdx] += rem; // 余数给最快的
    log(`任务分配（加权轮询）: ${quotas.map((q, i) => `${usable[i].name}x${q}`).join(', ')}`);
    let qi = 0;
    for (let i = 0; i < pending.length; i++) {
      const t = pending[i];
      while (qi < quotas.length && quotas[qi] <= 0) qi++;
      const nic = usable[Math.min(qi, usable.length - 1)];
      quotas[qi]--;
      log(`  #${state.tasks.indexOf(t) + 1} ${t.name} -> ${nic.name}${modes[i] === 'proxy' ? '（代理）' : ''}`);
      const ok = await simpleDownload(t.url, t.out, nic.ip, modes[i] === 'proxy');
      t.status = ok ? 'done' : 'failed';
      t.doneAt = Date.now();
      if (!ok) t.error = 'download failed';
    }
  }

  saveState(state);
  const doneCount = state.tasks.filter(t => t.status === 'done').length;
  const failCount = state.tasks.filter(t => t.status === 'failed').length;
  log(`本轮结束：完成 ${doneCount}，失败 ${failCount}，待执行 ${state.tasks.filter(t => t.status === 'pending').length}`);
}

// ---------- CLI ----------

function usage() {
  log(`用法:
  node dsh-dl-scheduler.mjs status                    列出在线网卡 + 测速缓存
  node dsh-dl-scheduler.mjs speedtest [--url <U>]     对每张网卡实测吞吐（默认 ${DEFAULT_SPEED_URL}）
  node dsh-dl-scheduler.mjs add <url> [--out <path>] [--name <n>]   加入队列
  node dsh-dl-scheduler.mjs list                      查看队列
  node dsh-dl-scheduler.mjs remove <index>            移除任务（1-based）
  node dsh-dl-scheduler.mjs clear                     清空队列
  node dsh-dl-scheduler.mjs run [--force] [--url <U>] [--ensure-proxy]   执行队列（自动测速/分流/分段合并；--ensure-proxy 下载前按需自检代理，直连不通自动拉起）`);
}

const args = process.argv.slice(2);
const cmd = args[0];
const rest = args.slice(1);
const flag = (name, def) => {
  const i = rest.indexOf(name);
  return i >= 0 && rest[i + 1] !== undefined ? rest[i + 1] : def;
};

switch (cmd) {
  case 'status': cmdStatus(); break;
  case 'speedtest': cmdSpeedtest(flag('--url', DEFAULT_SPEED_URL)); break;
  case 'add': {
    const url = rest.find(a => !a.startsWith('--'));
    if (!url) { usage(); break; }
    cmdAdd(url, flag('--out', ''), flag('--name', ''));
    break;
  }
  case 'list': cmdList(); break;
  case 'remove': cmdRemove(Number(rest[0])); break;
  case 'clear': cmdClear(); break;
  case 'run': cmdRun(rest.includes('--force'), flag('--url', DEFAULT_SPEED_URL), rest.includes('--ensure-proxy')); break;
  default: usage(); break;
}
