# dsh-ops-toolkit

[English](README.en.md) · 中文（默认）

DeepSeek Harness（DSH）的**运维与升级工具箱**：备份采集、宿主自举体检、环境自检、插件快照、
升级包审计、升级锁恢复、升级静默窗、插电保护（不睡眠/不休眠/不关屏），共 **16 件可直接运行的脚本**
（12 个 `.mjs` + 4 个 `.ps1`）+ 6 个共享依赖（`lib/`）。

> 这些脚本来自一套真实的单机 DSH 运维体系（Windows + Node + PowerShell），按「只读优先、默认 dry-run、
> 改动可回滚」的方式写：绝大多数件都带 `--check` / `--status` / `--dry-run` / `--list` 这类**零副作用入口**。

---

## ℹ️ 先读这一条：帮助与参数闸

`dsh-upgrade-audit` · `overnight-mode` · `snapshot-upgrade-pre` 这 3 件（2026-10-30 起）已支持
`--help`（打印用法、退出码 0）与**未知参数拒收**（退出码 2，绝不执行动作）；用法文本会写清「这个命令会写什么」。

其余脚本（`dsh-maintenance` · `dsh-bootstrap` · `dsh-boot-sync` · `dsh-dl-scheduler` · `dsh-upgrade-*` 等）
仍是旧行为：`--help` **不是被识别的开关**，未识别的参数会被**忽略，然后按默认动作直接执行**
（例如 `dsh-maintenance.mjs --help` 会走它的默认分支，不是打印帮助）。

⇒ 未接入的那批请**按下面「真实用法」表**调用；拿不准时**只跑只读项**（`--check` / `--plan` / `--status` /
`--dry-run` / `--list` / `--self-test`）。

---

## 环境前提

| 项 | 说明 |
|---|---|
| Node.js | ≥ 20（`dsh-maintenance.mjs` 的部分任务用 `node:sqlite`，需 22.5+） |
| PowerShell | **pwsh 7 优先**（`powershell.exe` 5.1 兜底）；`.ps1` 为 UTF-8 **带 BOM** + CRLF |
| `DSH_ROOT` | DSH 工作区根（缺省 = 本仓的上一级目录）；脚本里的「DSH 根」都取它 |
| `~/.dsh` | DSH 用户目录（home）；可用 `DSH_HOME` / `BUTLER_DSH_HOME` 覆盖 |
| `DSH_OFFSYNC_ROOT` | 盘外备份/快照根（缺省 `~/dsh-offsync`） |
| `DSH_TOOLS_DIR` | 工具树根（缺省 = 本仓目录）；指向本地 DSH 工具树时，部分脚本会额外调用本地组件 |

> ⚠️ 工具箱里若干件（备份、静默窗、恢复）会调用**同机的 DSH 组件**（例如 `dsh-butler` 工具树、
> `guard-ctl.mjs`、`butler-tickd.mjs`）。**这些组件不在本仓**：对应脚本在缺组件时会**明确降级或拒动**
> （不会静默改状态），见每行的「依赖」列。

---

## 逐件用途与用法（16 件）

### 备份与收仓

| 脚本 | 干什么 | 真实用法 | 注意 |
|---|---|---|---|
| `dsh-backup-sessions.ps1` | 把 `~/.dsh/sessions` 采集进**会话仓**（git + git-crypt），并做拉取/合并/推送 | `pwsh -File dsh-backup-sessions.ps1 -Status` · `-Sync` · `-Sync -DryRun` · `-Sync -BackupOnly` · `-Pull` · `-Push` · `-Init` · `-SetRemote <url>` · `-HealShells` | `-DryRun` = 一个字节都不写；`-Repo` / `-SessionsDir` 可指向沙盒 |
| `dsh-backup-workspace.ps1` | 把 DSH 工作区（根启动链 / `docs` / `tools` / `assets` 等白名单）采集进**工作区仓** | `pwsh -File dsh-backup-workspace.ps1 -Status` · `-Sync` · `-DryRun` · `-Push` · `-Push -ForcePush` · `-Pull` · `-Init` | `-ForcePush` 是逃生舱（跳过挡推体检并留审计）；`-SourceRoot` / `-Repo` 可指向沙盒 |
| `dsh-boot-sync.mjs` | 开机「收仓 + 回灌」：把盘外三仓同步回本机工作树 / `~/.dsh` | `node dsh-boot-sync.mjs` · `--dry-run` · `--no-pull` · `--root-only` · `--self-test` | **禁止 DSH 在跑时回灌**（脚本自己会判并拒跑）；永不镜像、永不 prune |
| `dsh-snapshot.ps1` | 给插件 profile 拍一份轻量快照（`package.json` + `pnpm-lock.yaml` + 清单） | `pwsh -File dsh-snapshot.ps1 [-ProfileDir <path>] [-SnapRoot <path>]` | 只写快照目录，不动生产 |

### 体检与自检

| 脚本 | 干什么 | 真实用法 | 注意 |
|---|---|---|---|
| `dsh-bootstrap.mjs` | 宿主自举体检：缺什么、怎么补（计划任务 / 桌面快捷方式 / 插件对齐等） | `node dsh-bootstrap.mjs --check` · `--plan` · `--apply`（`--safe` / `--only <步骤,步骤>`）· `--self-test` | `--check` / `--plan` 零副作用；`--apply` 幂等但会真写 |
| `dsh-selfcheck.ps1` | 环境自检（根目录白名单 / JSON 健康 / 链接与启动链一致性等），只读 | `pwsh -File dsh-selfcheck.ps1` | 无参数；不跟随 junction 进盘外实体树 |
| `dsh-upgrade-watch.mjs` | 版本体检：本地基线 vs 远端（npm / GitHub）有没有新版 | `node dsh-upgrade-watch.mjs` · `--no-remote` · `--json <path>` · `--quiet` | 只读；断网用 `--no-remote` |
| `dsh-upgrade-audit.mjs` | 升级包审计：对新版 tarball 做符号/词表比对，产出 `_tmp/l0-audit-report.md` | `node dsh-upgrade-audit.mjs [tarballsDir]` · `--self-test` | 只读样本目录；不联网；`--self-test` 不写报告 |
| `dsh-dl-scheduler.mjs` | 多网卡下载队列：测速 + 按吞吐分流 + 代理按需拉起 | `node dsh-dl-scheduler.mjs status` · `speedtest [--url <U>]` · `add <url> [--out <path>] [--name <n>]` · `list` · `remove <index>` · `clear` · `run [--force]` | 队列目录可用 `DSH_DL_DIR` 指定；代理脚本路径 `DSH_PROXY_SCRIPT` |

### 升级与恢复

| 脚本 | 干什么 | 真实用法 | 注意 |
|---|---|---|---|
| `dsh-upgrade-silence.mjs` | **升级静默窗**开关 v2：停/恢复生产自动化（tickd + 计划任务），持有者引用计数 | `node dsh-upgrade-silence.mjs --status` · `--disable --holder <id>` · `--enable --holder <id>` · `--check-stale` | `--status` / `--check-stale` 只读；`--disable` 会**真停**自动化（先写盘再停，防半完成态） |
| `snapshot-upgrade-pre.mjs` | 升级**前**快照（主包/插件/闭包/配置）+ 自校验 | `node snapshot-upgrade-pre.mjs`（dry-run）· `--apply` · `--apply --no-tree` · `--verify [--backup <dir>]` | 默认 dry-run；`--verify` 只读对账 |
| `dsh-upgrade-recover.mjs` | 升级**锁卡死**后的判定与恢复（本机 / 跨机 SSH），fail-closed | `node dsh-upgrade-recover.mjs [--target local\|peer-a\|peer-b]` · `--apply` · `--json` · `--ssh <别名>` | 默认只判定不动作；只放行「持有进程已退出 / 心跳超 TTL」的锁 |
| `dsh-maintenance.mjs` | **停机维护编排**：停 DSH → 跑维护任务 → 起回（含守护进程） | `node dsh-maintenance.mjs --list` · `--task <任务名>`（dry-run）· `--task <任务名> --go` | **`--go` 会真停 DSH**；不带开关 = dry-run；退出码 3 = 前置不满足（零副作用） |
| `upgrade-triage-cli.mjs` | 升级分级授权**定档**：把「包/版本/输入证据」判成档位（纯判定，不升级） | `node upgrade-triage-cli.mjs [--input <json>] [--pkg <名>] [--root <dir>] [--tools-dir <dir>] [--json]` | 只出结论；参数不认识会**拒跑**（fail-closed） |

### 插电保护（睡眠/休眠/关屏/合盖）

| 脚本 | 干什么 | 真实用法 | 注意 |
|---|---|---|---|
| `overnight-mode.mjs` | 插电保护开关：插电时禁睡眠/休眠/关屏/合盖睡眠 + 堵 Windows 更新自动重启；拔电恢复 | `node overnight-mode.mjs auto` · `on` · `off` · `status` · `on --dry-run` · `--self-test` | `status` 只读；`on/off` 真改电源设置（`off` 按备份写回）；`--json` / `--force` / `--no-events` 通用 |
| `overnight-guard-check.mjs` | 插电保护的**只读探针**：核对当前电源设置相对基线有没有被改 | `node overnight-guard-check.mjs` · `--json` · `--section` · `--fail-on-change` · `--self-test` | 绝不代劳改回（要改回请显式跑 `overnight-mode.mjs on`） |

---

## 共享依赖（`lib/`）

| 文件 | 作用 |
|---|---|
| `lib/dsh-home.mjs` | `~/.dsh` / 工作区根的唯一解析口径（`BUTLER_DSH_HOME` > `DSH_HOME` > `~/.dsh`） |
| `lib/powershell-exe.mjs` | PowerShell 解释器选择：**pwsh 7 优先**、5.1 兜底（含 WindowsApps 别名的真跑探测） |
| `lib/closure-links.mjs` | 依赖闭包（`profiles/node_modules`）链接指向扫描（只读） |
| `lib/guard-http.mjs` | HTTP 判活口径（`isHttpAlive` / `judgeHttp`） |
| `lib/upgrade-inputs.mjs` · `lib/upgrade-triage.mjs` | 升级定档的输入采集与纯判定函数 |

除 Node 内置模块外**无第三方依赖**（`yaml` 仅在个别件里按需 `import`，缺了就跳过对应段落）。

---

## 本批未包含的 4 件（如实登记）

以下 4 件依赖**未公开的内核模块**，按开源纪律**本批不发**（不是遗漏）：

| 件 | 卡在哪 |
|---|---|
| `dsh-upgrade-gate-cli.mjs` | 静态 import `dsh-butler/lib/audit.mjs`、`paths.mjs`（授权台账内核） |
| `dsh-upgrade-orchestrator.mjs` | 静态 import `dsh-butler/lib/{paths,autonomy-state,upgrade-lock,audit,host-line}.mjs`（升级锁与自治矩阵内核） |
| `dsh-upgrade-settings-check.mjs` | 静态 import `lib/dsh-host-rpc.mjs`（读本机凭据通道） |
| `imagegen-backup.mjs` | 静态 import `dsh-butler/lib/host-tag.mjs`（本机标识） |

要发这 4 件，需先把「审计 / 锁 / 主机标识」抽成**可注入接口**（依赖反转），再单独成批。

---

## 安全须知

- **默认只读优先**：能先跑 `--check` / `--status` / `--dry-run` / `--list` 的，先跑它。
- **会真动作的开关**（点名）：`--apply` / `--go` / `-Sync` / `-Push` / `--disable` / `on` / `off` / `--force`。
- 本仓脚本**不烧钱、不外发**：不代发消息、不推别人的仓；跨机动作只走你显式给的 `--target` / `--ssh`。
- 备份类脚本涉及 **git-crypt 密钥文件路径**：那是本地路径，**不要把密钥本身放进仓**。

## 许可

**AGPL-3.0-only + 商业授权（双许可）**，全文见 [`LICENSE`](LICENSE)。
简单说：要么按 AGPL-3.0 使用并让衍生作品同样开源，要么另行取得商业授权。

## 修订

见 [`CHANGELOG.md`](CHANGELOG.md)。
