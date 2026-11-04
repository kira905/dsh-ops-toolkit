# dsh-ops-toolkit

## v0.1.2 — 2026-11-04

**把真实账号从代码里移除**（安全修复）。⚠️ 如实说明：**v0.1.1 及更早的包仍带着它**（已发布在 npm），
本版清除。

- `dsh-maintenance.mjs` 的「⑤-4 撤回链可用性」复核段原先把 `--user <真实账号>` 写死在参数里；
  改为读环境变量 **`$DSH_OWNER_USER`**。**未配置时这一步跳过，并把跳过原因写进报告**
  （`未跑（未配置 $DSH_OWNER_USER）`）—— 不静默跑空参数，那样会伪造一个"已验过"的假象。
- 新增 `_test/owner-gate.test.mjs`（8 条断言）与 `npm test`，守三条约定：撤回调用必须带 `--user`、
  值只能来自环境变量、未配置必须留痕。
  **为什么是静态判据**：这段代码跑在停机维护编排里（`--go` 会停 DSH、跑迁移、再起回），
  单测里真跑＝真停机；行为层的证据来自停机窗口那次的 `report.md`。

*English*: the hard-coded account in the retract-chain recheck is gone. It now reads `$DSH_OWNER_USER`
and skips with a recorded reason when unset. A static-contract test (8 assertions) plus `npm test` was
added, because that code path can only run inside the stop-the-world maintenance flow.

**已知未清理（如实登记，非本次引入）**：本仓扫描另有设备别名、内部目录名与 Windows 电源方案 GUID
的命中。前两类是既有的内部标识残留（**此处不复写原文**，免得又写进公开仓）；第三类是微软公开常量
（电源子组 / 设置 GUID）与测试用假 GUID，属误报。清理前两类要动功能常量（仓库路径 / 仓库名），
影响面另评估。

## v0.1.1 — 2026-10-30

（补记）本版只改 README 的引导段与注释面中性化，脚本行为与 v0.1.0 一致。

## v0.1.0 — 2026-10-19

首批公开（Gitee + GitHub）。

- **16 件脚本首发**：备份采集 2 · 开机收仓 1 · 插件快照 1 · 宿主自举 1 · 环境自检 1 · 版本体检 1 ·
  升级包审计 1 · 下载调度 1 · 升级静默窗 1 · 升级前快照 1 · 升级锁恢复 1 · 停机维护 1 · 升级定档 1 ·
  插电保护 2（1 开关 + 1 只读探针）。
- **共享依赖 6 件**（`lib/`）：`dsh-home` · `powershell-exe` · `closure-links` · `guard-http` ·
  `upgrade-inputs` · `upgrade-triage`。
- **脱敏**：盘符绝对路径 / 用户名 / 机器名 / 凭据形态 ⇒ 全部改为 `env` / 参数 / 相对路径；
  机器身份改为环境变量（`DSH_ROOT` / `DSH_HOME` / `DSH_OFFSYNC_ROOT` / `DSH_TOOLS_DIR` /
  `DSH_PEER_A_*` / `DSH_PEER_B_*`）。
- **未包含 4 件**（如实登记，非遗漏）：静态依赖未公开内核的 `dsh-upgrade-gate-cli` /
  `dsh-upgrade-orchestrator` / `dsh-upgrade-settings-check` / `imagegen-backup`。
- **文档**：README（中/英）逐件用途 + 真实用法；**明确写明本批脚本没有 `--help` 实现**，
  未识别参数会被忽略后直接执行。
- 许可：AGPL-3.0-only + 商业授权（双许可）。
