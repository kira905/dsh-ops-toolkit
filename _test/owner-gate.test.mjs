#!/usr/bin/env node
// dsh-maintenance.mjs「⑤-4 撤回链」复核段的**静态契约测试**。
//
// 为什么是静态判据：这段逻辑跑在「停机维护」编排里（--go 会停 DSH、跑迁移、再起回），
// 单测里真跑＝真停机，不允许。行为层的证据来自停机窗口那次的 report.md
// （会打印 `memory-retract --dry-run exit=N` 或跳过原因）。
//
// 本测试守的是**约定本身**（正因为约定曾被人肉绕过一次）：
//   ① 撤回命令必须带 --user，且值只能来自部署环境（$DSH_OWNER_USER）；
//   ② 未配置时**跳过并把原因写进报告**，不许静默空跑（空跑会伪造一个"已验过"的假象）；
//   ③ 源码里不许再出现任何写死的 userid 字面量（这条由词表扫描器在发布前守，这里守结构）。
//
// 跑法：node _test/owner-gate.test.mjs
// 退出码：0 = 全绿 / 1 = 有失败
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const file = path.join(here, '..', 'dsh-maintenance.mjs');
const src = fs.readFileSync(file, 'utf8');

let pass = 0;
const fails = [];
const ok = (name, cond, detail = '') => {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fails.push(name);
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
};

// 只看「撤回链」那一小段（memory-retract 前后各一段窗口），避免别处的同名字符串误命中
const anchor = src.indexOf('memory-retract.mjs');
ok('能定位撤回链调用点', anchor > 0);
const window = anchor > 0 ? src.slice(Math.max(0, anchor - 1400), anchor + 900) : '';

ok('调用点带 --dry-run（仍是只演练不真撤）', window.includes('"--dry-run"'));
ok('owner 的值来自 $DSH_OWNER_USER', /process\.env\.DSH_OWNER_USER/.test(window));
ok('未配置时走跳过分支（有 retractSkipped 记录）', /retractSkipped/.test(window));
ok('跳过分支会打出原因（不是静默 return）', /跳过/.test(window) && /DSH_OWNER_USER/.test(window));
ok(
  '--user 后面跟的是变量，不是字符串字面量',
  /"--user"\s*,\s*ownerUser/.test(window),
  '期望形如 [..., "--user", ownerUser]',
);
ok('不再出现 --user 紧跟字符串字面量的形态', !/"--user"\s*,\s*["']/.test(src));

// 报告段：跳过时不能只写"未跑"，要带原因（否则读报告的人分不清"没验"和"不需要验"）
ok('report 段把跳过原因写出来', /retractSkipped/.test(src) && /未跑（/.test(src));

console.log(`\n==== [owner-gate] ${pass} 通过 / ${fails.length} 失败 ====`);
if (fails.length) {
  for (const f of fails) console.log(`  ✗ ${f}`);
  process.exitCode = 1;
} else {
  process.exitCode = 0;
}
