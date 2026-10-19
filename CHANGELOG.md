# dsh-ops-toolkit

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
