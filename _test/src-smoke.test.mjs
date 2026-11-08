// 批6 冒烟夹具：11 个入口能 import、关键导出在、告警注入点行为对（零网络、零生产读写）
// 跑法：node _test/src-smoke.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..');
const SRC = path.join(ROOT, 'src', 'dsh-butler');

// 隔离 home：任何状态文件都落在临时目录里
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ops-smoke-'));
process.env.DSH_HOME = HOME;
process.env.BUTLER_DSH_HOME = HOME;
process.env.DSH_ALERT_TARGET = 'smoke-target';

const ENTRIES = [
  ['anchor-watch.mjs', 5], ['schtask-overview.mjs', 5], ['said-ledger.mjs', 5], ['plan-gate.mjs', 5],
  ['self-review-check.mjs', 1], ['manual-action-rollback.mjs', 5], ['butler-external.mjs', 5],
  ['butler-watch-fs.mjs', 1], ['butler-watch-channels.mjs', 1], ['config-snapshot.mjs', 5],
  ['butler-audit-archive.mjs', 5], ['dsh-snapshot-tick.mjs', 5], ['ledger-read.mjs', 1],
];

let pass = 0;
const fails = [];

async function check(label, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${label}`);
  } catch (e) {
    fails.push(`${label}: ${e?.message ?? e}`);
    console.log(`  ✗ ${label} — ${e?.message ?? e}`);
  }
}

console.log(`# src-smoke（home=${HOME}）`);

// ① 11 个入口 + 2 个随行件都能 import，且导出数不为 0
for (const [file, minExports] of ENTRIES) {
  const p = path.join(SRC, file);
  await check(`import ${file}`, async () => {
    assert.ok(fs.existsSync(p), `文件不存在：${p}`);
    const m = await import(pathToFileURL(p).href);
    assert.ok(Object.keys(m).length >= minExports, `导出偏少：${Object.keys(m).length} < ${minExports}`);
  });
}

// ② 告警注入点：默认不接传输 ⇒ 明确返回 no-transport（一个字节都不外发）
const hub = await import(pathToFileURL(path.join(SRC, 'lib', 'alert-hub.mjs')).href);

await check('alert-hub 默认无传输', async () => {
  hub.installAlertTransport(null);
  assert.equal(hub.alertTransportInfo().installed, false);
  const r = await hub.sayAlert('smoke', { alertChannel: true });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'no-transport');
});

await check('alert-hub 未开通道 ⇒ 直接跳过（连队列都不进）', async () => {
  const r = await hub.sayAlert('smoke', { alertChannel: false });
  assert.equal(r.skipped, true);
  assert.equal(r.reason, 'explicit-override');
  assert.equal(r.channelEnabled, false);
});

await check('alert-hub 注入传输后真回调，且参数只有单目标', async () => {
  const seen = [];
  hub.installAlertTransport(async (spec) => { seen.push(spec); return { ok: true, msgid: 'm-1' }; }, { name: 'smoke' });
  const r = await hub.sayAlert('hello', { alertChannel: true });
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].target, 'smoke-target');
  assert.equal(seen[0].text, 'hello');
  hub.installAlertTransport(null);
});

// ③ 开关读写：只动 watchChannels.alert 一个键 + 回读校验
await check('开关写盘只改一个键且回读一致', async () => {
  const file = path.join(HOME, 'butler-autonomy-limits.json');
  fs.mkdirSync(HOME, { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, watchChannels: { whale: false } }, null, 2), 'utf8');
  const w = await hub.applyAlertChannelWrite({ home: HOME, enabled: true, why: 'smoke' });
  assert.equal(w.changed, true);
  const after = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(after.watchChannels.alert.enabled, true);
  assert.equal(after.watchChannels.whale, false, '其它通道键必须原样保留');
  const rt = hub.resolveAlertChannel({ home: HOME });
  assert.equal(rt.enabled, true);
});

// ④ 镜像布局：入口的相对 import 全部落在 src/ 内（不越界到宿主树）
await check('相对 import 不越出包根', async () => {
  const esc = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.mjs')) continue;
      const txt = fs.readFileSync(p, 'utf8');
      const re = /from\s+['"](\.\.?\/[^'"]+)['"]/g;
      let m;
      while ((m = re.exec(txt)) !== null) {
        const abs = path.resolve(path.dirname(p), m[1]);
        if (!abs.toLowerCase().startsWith(path.join(ROOT, 'src').toLowerCase())) esc.push(`${path.relative(ROOT, p)} → ${m[1]}`);
      }
    }
  };
  walk(path.join(ROOT, 'src'));
  assert.deepEqual(esc, []);
});

// ⑤ 收尾：清临时 home
try { fs.rmSync(HOME, { recursive: true, force: true }); } catch { /* 残留不致命 */ }

console.log(`\n结果：${pass} 通过 / ${fails.length} 失败`);
if (fails.length) { for (const f of fails) console.log(`  - ${f}`); process.exitCode = 1; }
