# dsh-backup-sessions.ps1
# 会话（sessions）跨机同步 + 异地备份 —— Gitee 私有仓 dsh-sessions3，全量 git-crypt 加密
# 仓沿革：dsh-sessions（初代）→ dsh-sessions2（2026-09-16 上午换仓）→ **dsh-sessions3（2026-09-17 凌晨换仓）**
#   每次换仓都是「新仓只装活跃会话快照 + 老仓原地留作冷备（含全部历史）」，工作副本路径始终不变
#   ⇒ 本脚本零改动（remote 由 git 配置持有）。旧仓别删：dsh-sessions-old-20260916 / -old-20260917。
#
# 背景：M2 实体化后 .dsh 不再走百度同步，会话跨机改由本仓承担（方案 §3 仓2）。
#
# 2026-09-09 改造（单向镜像 → 双向合并）：
#   旧版 -Sync 用 robocopy /MIR（镜像+purge）且从不拉取 → 只能单向备份，两台机器会互相
#   删掉对方的会话（实测：TUF 一次 -Sync 把仓里 ROG 的 68 个会话 purge 掉，ROG 会话在
#   TUF 永远看不到）。现改为：
#     1) 采集用 /E（增量复制，不 purge）
#     2) -Sync 流程 = 采集 → 提交 → git pull → 把仓里本机缺失的会话补进本机（只补缺、不覆盖）
#   语义变化：本机手工删掉的会话，下次 -Sync 会从仓里补回来（双向同步的固有行为，
#   要彻底删需同时在仓里删并提交推送）。
#
# 2026-09-14 守卫（空壳不得覆盖完整版）：
#   背景（事故 + 实测确证）：TUF 侧 19 个会话在 2026-08-27 被清空成 147~458 B 的创建头
#   （「空壳」），此后**每轮采集都把空壳盖到仓里，把 ROG 推的完整版覆盖掉**，来回拉锯；
#   完整内容只剩在更早的 git 提交里（需 git-crypt smudge + 逐帧 zstd 解才读得到）。
#   详见 docs\会话内容恢复-仓2历史提取-20260914.md。
#   现在采集前对**每个会话文件**做一次比对，命中「两侧判定表」里的保护情形就跳过：
#     本机空壳 + 仓里完整  => 跳过不覆盖（统计 + 日志一行；-HealShells 时改为拿仓里那份回灌本机）
#     本机完整（含小但两帧带事件）      => 照旧覆盖
#     两侧都空壳                        => 照旧覆盖（谁新谁上）
#     仓里没有                          => 新增
#   空壳判据（判据① 是前提，②③ 命中任一即判空壳；依据 = 761 个真实会话文件实测 2026-09-14）：
#     ① 文件 < 2 KB（实测空壳 147~458 B，完整版最小 13 KB，间隔三个数量级）
#     ② 逐帧 zstd 解后事件数 < 3（**只解第一帧会误判**：本文件是多帧拼接 append-only）
#     ③ 逐帧解后没有 turn/start（= 只有 session / permission / sandbox / approval / end-seed 这类启动头）
#   实测样本：150B/1 事件/无 turn-start、308B/4 事件/无 turn-start、458B/6 事件/无 turn-start 都判空壳；
#             801B/9 事件/**有** turn-start 的真实短会话不判空壳（照旧覆盖，不误伤有内容的小会话）。
#   ②③ 由零依赖探针 tools\dsh-session-probe.mjs 计算（Node 已在 PATH；探针缺失/失败时
#   保守按空壳处理 = 宁可少覆盖，不可丢内容）。判据只在 ① 成立的候选上才解压，全库
#   通常只有 0~2 个候选，开销可忽略。
#
# 2026-09-16 采集降级改造（卡 AT16，与仓1/仓3 的 AT15 改造对称）：
#   旧版采集末尾 `if ($LASTEXITCODE -ge 8) { throw ... }` 会把**单文件瞬时占用**（mmap / EDR 扫描窗口）
#   当成"整轮失败"——整次采集抛错退出，已复制成功的会话全部作废。本仓概率比仓3 更高：会话文件是
#   多帧 zstd 拼接、活跃会话正被 dsh 追加写。改造后：
#     ① 整轮最多 3 次尝试（轮间 2s / 4s 退避）   ② 仍失败则解析失败清单，逐个 Copy-Item 补试一次
#     ③ 仍失败 → **记账 + 显式告警 + 计数**（不 throw，其余会话照采 —— 采集是备份动作，fail-open）
#     ④ 会话文件单文件复制（含 -HealShells 回灌）同样降级记账，不再中断整轮
#   摘要落 `logs\backup-collect-failures-dsh-sessions.json`（每轮覆盖写；logs 不进任何仓）。
#   🔴 红线：降级绝不掩盖真实复制失败（含"解析不出失败清单"也要按未知失败记账）。
#   ⚠️ 本仓两条红线未动：**永不用 -Prune**（/E 不 purge）、**空壳不得覆盖完整版**守卫；退出码也未改
#      （dsh-sync-all.ps1 用退出码判「本仓失败 → 跳过 Push」，给采集加非零码会让一个被占用的文件
#       阻断整仓推送；可见性由「醒目告警段 + 台账 + 计数」承担，见 AT16 报告§待拍板）。
#   台账路径支持环境变量 DSH_COLLECT_FAILURE_LEDGER 覆盖（夹具/沙盒必须能隔离生产输出路径）。
#
# 用法：
#   .\dsh-backup-sessions.ps1 -Init                 首次初始化（git init + 复用 dsh-core key + 首次提交）
#   .\dsh-backup-sessions.ps1 -Sync                 采集 + 提交 + 拉取 + 合并（日常推荐）
#   .\dsh-backup-sessions.ps1 -Sync -BackupOnly     只采集 + 提交，不拉取不合并（纯备份模式）
#   .\dsh-backup-sessions.ps1 -Sync -DryRun         只跑判定与统计、一个字节都不写（体检）
#   .\dsh-backup-sessions.ps1 -Sync -HealShells     判定同 -DryRun，但把「本机空壳 / 仓里有完整版」的
#                                                   本机文件用仓里那份回灌（默认关）
#   .\dsh-backup-sessions.ps1 -Pull                 只拉取 + 合并（把另一台机的会话补到本机）
#   .\dsh-backup-sessions.ps1 -SetRemote <url>      设置 remote
#   .\dsh-backup-sessions.ps1 -Push                 推送到 Gitee
#   .\dsh-backup-sessions.ps1 -Status               查看状态（含本机/仓 会话数）
#
# 2026-09-10 修补（PullMerge 认「归档态」为本机已有）：
#   物理归档到 _archived-sessions 的会话在仓里仍然存在（采集用 /E 不 purge + 仓2 永不用 -Prune
#   两条纪律保证它们不会被删），而旧 -PullMerge 只看 sessions 目录判"本机缺不缺" →
#   每次 -Sync 都把归档会话整批回流进 sessions（实测 08:24 一次回流 94 个 8 月老会话 / 122.7MB，
#   文件 mtime 被刷成搬入当天 → 大管家面板误报"刚被打断的会话"，DSH 启动解码也变慢）。
#   现改为按归一 id 同时索引 sessions 与 _archived-sessions：归档态 = 本机已有 → 不回流。
#   注意：这只补了兜底防线，保住归档收益的日常纪律仍是 -Push 或 -Sync -BackupOnly。
#
# 注意：
#   1. 仓库本体在 DSH_ROOT-offsync\git-backup\dsh-sessions（盘外）
#   2. 全部文件加密（会话含隐私），未 unlock 的 clone 只见密文
#   3. 复用 dsh-core 的 git-crypt key（一套 key 管多仓；key 丢失 = 两仓全毁）
#   4. 活跃会话正在被 DSH 写入，复制可能取到中间态；下次 -Sync 会修正
#   5. -SessionsDir 仅供测试用（默认 %USERPROFILE%\.dsh\sessions）

param(
    [switch]$Init,
    [switch]$Sync,
    [switch]$Pull,
    [switch]$BackupOnly,
    [string]$SetRemote,
    [switch]$Push,
    [switch]$Status,
    [switch]$DryRun,
    [switch]$HealShells,
    [switch]$NoGit,
    [string]$SessionsDir,
    [string]$ArchiveDir,
    # 统一开关逃生舱（S1b 接线 · 2026-10-11）：带上即忽略 `repo2.push` 判据、恢复本脚本原有推送行为
    [switch]$IgnoreTopology,
    # 沙盒验证用（默认值 = 生产路径，行为不变）—— 见 tools\_test\test-collect-degrade-sessions.ps1
    [string]$Repo = (Join-Path $env:USERPROFILE 'dsh-offsync\git-backup\dsh-sessions')
)

$ErrorActionPreference = 'Stop'
# $Repo 见 param（默认 = 生产仓；夹具用 -Repo 注入沙盒仓，绝不碰生产）
$KeyFile  = Join-Path $env:USERPROFILE 'dsh-offsync\git-backup\keys\dsh-core.key'
$GitCrypt = if ($env:DSH_GIT_CRYPT) { $env:DSH_GIT_CRYPT } else { 'git-crypt' }
$DefaultRemote = ''   # 2026-09-17 换仓；仅在「本地无 remote」时用于初始化
$Src      = if ($SessionsDir) { $SessionsDir } else { Join-Path $env:USERPROFILE '.dsh\sessions' }
# 物理归档目录（2026-09-10）：PullMerge 把它一起当「本机已有」，防归档会话回流
$Arch     = if ($ArchiveDir) { $ArchiveDir } else { Join-Path $env:USERPROFILE '.dsh\_archived-sessions' }
# 纯 -DryRun（不传任何动作开关）时也允许跑判定体检：视作 -Sync -DryRun
if ($DryRun -and -not ($Init -or $Sync -or $Pull -or $SetRemote -or $Push -or $Status)) { $Sync = $true }
# 会话文件名（多世代 · 2026-09-24 卡「三机同步步A-V3代际适配」· 2026-10-16 世代推 v4）：
#   主包 0.1.5 起落盘名 `session.jsonl.zstd` → `session.v3.jsonl.zstd`（归档里另有 1040 个旧名文件）；
#   主包 0.2.x 起**再换代** → `session.v4.jsonl.zstd`（**现行世代**）。
#   **读取侧一律用 Test-SessionFileName / $SessionFileFilter（认全世代）**，绝不再拿单一名字比较
#   （原来精确比较 ⇒ Count-Sessions 恒 0、采集守卫一个会话都看不见 = 采集链"运空气"）。
#   写入侧（真要写名字时）用 $SessionFileNameCurrent（2026-10-16 起 = v4）。
#   ⚠️ 与 tools\lib\session-file-name.mjs **同口径**（PowerShell 无法 import，改一处必须同步另一处）。
$SessionFileName        = 'session.jsonl.zstd'          # 旧世代名（历史保留，勿用于比较）
$SessionFileNameCurrent = 'session.v4.jsonl.zstd'       # 当前世代名（写入侧用；0.2.x 起）
$SessionFileFilter      = 'session*.jsonl.zstd'         # 宽模式（robocopy /XF 等）
function Test-SessionFileName([string]$Name) { return ($Name -match '^session(\.v\d+)?\.jsonl\.zstd$') }
$ShellSizeLimit  = 2048     # 空壳候选阈值（判据①；实测空壳 147~458 B / 完整版 ≥13 KB）
$ShellEventLimit = 3        # 判据②：逐帧解后事件数 < 3
$SkipSuffixes    = @('.baiduyun.uploading.cfg')

function Write-Step($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Write-Ok($m)   { Write-Host "    OK  $m" -ForegroundColor Green }
function Write-Warn2($m){ Write-Host "    !!  $m" -ForegroundColor Yellow }
function Write-Skip($m) { Write-Host "    --  $m" -ForegroundColor DarkGray }

function Write-Utf8NoBom($path, $text) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $enc)
}

# ---------- 采集失败账本（2026-09-16 AT16 采集降级，对称抄自仓1/仓3 的 AT15 版）----------
# 语义：CopyFailures  = 本轮**确实没采到**的文件（必须显式告警 + 计数，红线）
#       CopyRecovered = 整轮失败后逐文件补试**救回来**的文件（不阻断，但仍记账，便于看频度）
$script:CopyFailures  = New-Object System.Collections.ArrayList
$script:CopyRecovered = New-Object System.Collections.ArrayList
$script:RobocopyTries = 3                                           # 整轮 robocopy 尝试次数（含首次）
# 台账路径可用环境变量 DSH_COLLECT_FAILURE_LEDGER 覆盖 —— 夹具/沙盒必须能隔离生产输出路径
#   （persona 铁律：测试/探针不得写生产输出位置；见 tools\_test\test-collect-degrade-sessions.ps1 E 段）
$script:CopyFailureLedger = if ($env:DSH_COLLECT_FAILURE_LEDGER) { $env:DSH_COLLECT_FAILURE_LEDGER } else { Join-Path $env:USERPROFILE '.dsh\collect-failures-dsh-sessions.json' }

function Add-CopyFailure {
    param([string]$Stage, [string]$Path, [string]$Code, [string]$Message)
    [void]$script:CopyFailures.Add([pscustomobject]@{ stage = $Stage; path = $Path; code = $Code; message = $Message })
}

function Add-CopyRecovered {
    param([string]$Stage, [string]$Path, [string]$Code, [string]$Message)
    [void]$script:CopyRecovered.Add([pscustomobject]@{ stage = $Stage; path = $Path; code = $Code; message = $Message })
}

# 解析 robocopy 输出里的文件级错误行
# 实测（2026-09-16 AT15 夹具）：即使 /NFL /NDL /NJH /NJS /NP 全开，失败行**仍会打印**，形如
#   `2026/09/16 12:09:30 ERROR 32 (0x00000020) Copying File <DRIVE>:\...\lock32.txt`
# 故无需额外"详细模式"重跑即可定位失败文件。
# ⚠️ 必须按 (码, 操作, 路径) 去重：robocopy 的 /R:n 对该文件**每次重试都打印一行 ERROR**
#   （实测 /R:2 → 同一文件 3 行）——不去重会让一个文件被记账 3 次、告警刷屏、计数虚高。
function Get-RobocopyFailureList {
    param([string[]]$Output)
    $fail = @()
    $seen = @{}
    foreach ($line in @($Output)) {
        $m = [regex]::Match([string]$line, 'ERROR\s+(\d+)\s+\(0x[0-9A-Fa-f]+\)\s+(Copying|Moving|Deleting|Creating)\s+(File|Directory)\s+(.+?)\s*$')
        if ($m.Success) {
            $code = [int]$m.Groups[1].Value
            $op   = ('{0} {1}' -f $m.Groups[2].Value, $m.Groups[3].Value)
            $path = $m.Groups[4].Value.Trim()
            $key  = '{0}|{1}|{2}' -f $code, $op, $path
            if ($seen.ContainsKey($key)) { continue }
            $seen[$key] = $true
            $fail += [pscustomobject]@{ code = $code; op = $op; path = $path }
        }
    }
    return ,$fail
}

# 单文件复制：失败**不 throw**（一个文件不该断整轮采集），但必须记账 + 显式告警
function Copy-OneFile {
    param([string]$Src, [string]$Dst, [string]$Stage)
    try {
        Copy-Item -LiteralPath $Src -Destination $Dst -Force -ErrorAction Stop
        return $true
    } catch {
        Add-CopyFailure -Stage $Stage -Path $Src -Code '' -Message $_.Exception.Message
        Write-Warn2 ("XX 复制失败（已记账，采集继续）：{0}  [{1}]" -f $Src, $_.Exception.Message)
        return $false
    }
}

# 整轮 robocopy：失败时按 2s/4s 退避重试（瞬时 mmap / EDR 扫描窗口通常秒级）
# 返回 @{ Code; Output; Tries }；**永不 throw** —— 由调用方决定降级记账
# -RetryArgs：robocopy 的自身重试参数（仓1/仓3 用 /R:2 /W:1；本仓沿用改造前的 /R:5 /W:3，不改既有语义）
function Invoke-RobocopyRetry {
    param([string]$Src, [string]$Dst, [string]$Mode, [string[]]$ExtraArgs = @(), [string[]]$RetryArgs = @('/R:2', '/W:1'))
    $last = $null
    for ($i = 1; $i -le $script:RobocopyTries; $i++) {
        $out = & robocopy $Src $Dst $Mode /XJ @ExtraArgs @RetryArgs /NFL /NDL /NJH /NJS /NP 2>&1
        $last = [pscustomobject]@{ Code = $LASTEXITCODE; Output = @($out); Tries = $i }
        if ($last.Code -lt 8) { break }
        if ($i -lt $script:RobocopyTries) {
            $wait = 2 * $i
            Write-Warn2 ("robocopy rc={0} 出错（{1} -> {2}）：第 {3}/{4} 次尝试失败，{5}s 后重试（疑似瞬时占用：mmap/EDR 扫描）" -f $last.Code, $Src, $Dst, $i, $script:RobocopyTries, $wait)
            Start-Sleep -Seconds $wait
        }
    }
    return $last
}

# 非会话文件的整轮采集（robocopy /E，**永不用 /MIR** —— 仓2 红线：不 purge 目标端多余文件）
# 2026-09-16（卡 AT16）：从 Invoke-Collect 抽出，与仓1/仓3 的 Copy-Tree 对称：
#   rc>=8 ⇒ ① 整轮退避重试已由 Invoke-RobocopyRetry 做过 ② 解析失败清单逐个 Copy-Item 补试
#            ③ 仍失败则**记账 + 告警**（不 throw，本轮其余文件照采）
# -ExtraArgs：/XF 排除项等附加参数；-RetryArgs：robocopy 自身重试参数（生产 = /R:5 /W:3 与改前一致，夹具可传 0 提速）
function Copy-Tree {
    param($src, $dst, [string[]]$ExtraArgs = @(), [string[]]$RetryArgs = @('/R:5', '/W:3'))
    if (-not (Test-Path $src)) { Write-Warn2 "missing source: $src"; return }
    $r = Invoke-RobocopyRetry -Src $src -Dst $dst -Mode '/E' -ExtraArgs $ExtraArgs -RetryArgs $RetryArgs
    if ($r.Code -lt 8) { return $r }

    $fails = Get-RobocopyFailureList $r.Output
    Write-Warn2 ("XX robocopy 在 {0} 次尝试后仍返回 rc={1}（{2} -> {3}）：本轮采集**继续**，失败文件逐个记账" -f $r.Tries, $r.Code, $src, $dst)
    if ($fails.Count -eq 0) {
        # 解析不出文件级错误 ⇒ 仍按「未知失败」记账（绝不静默放过）
        $head = ((@($r.Output) | Select-Object -First 6) -join ' / ')
        Add-CopyFailure -Stage "robocopy:$src" -Path $dst -Code ([string]$r.Code) -Message "rc=$($r.Code)，输出里没有 'ERROR n (0x..) Copying File' 行，未能解析出失败文件；原始输出前几行：$head"
        Write-Warn2 ("XX robocopy rc={0} 但未能解析出失败文件清单 —— 已按未知失败记账！原始输出：{1}" -f $r.Code, $head)
        return $r
    }
    foreach ($f in $fails) { Write-Warn2 ("XX 复制失败 rc={0}：{1}  [{2}]" -f $f.code, $f.path, $f.op) }

    # 逐文件最后一次补试（粒度更细：整轮失败常只卡在个别文件）
    foreach ($f in $fails) {
        if ($f.op -ne 'Copying File') {
            Add-CopyFailure -Stage "robocopy:$src" -Path $f.path -Code ([string]$f.code) -Message "$($f.op) 失败（非文件复制类，未做逐文件补试）"
            continue
        }
        $rel = $f.path
        if ($rel.StartsWith($src, [System.StringComparison]::OrdinalIgnoreCase)) { $rel = $rel.Substring($src.Length).TrimStart('\') }
        $tf = Join-Path $dst $rel
        $tfDir = Split-Path $tf -Parent
        if ($tfDir -and -not (Test-Path $tfDir)) { $null = New-Item -ItemType Directory -Path $tfDir -Force }
        # 补试仍失败时必须**保留 robocopy 的 ERROR 码**（台账/日报要显示 "ERROR 1224" 这类线索；
        # 若走 Copy-OneFile 只会剩 IOException 文本、丢掉码）—— 故与仓1/仓3 的 Copy-Tree 同形态手写
        $ok = $false; $err = ''
        try { Copy-Item -LiteralPath $f.path -Destination $tf -Force -ErrorAction Stop; $ok = $true }
        catch { $err = $_.Exception.Message }
        if ($ok) {
            Add-CopyRecovered -Stage "robocopy:$src" -Path $f.path -Code ([string]$f.code) -Message '整轮重试失败后逐文件补试成功'
            Write-Warn2 ("   -> 逐文件补试成功（本次已采到，仍记账以便观察频度）：{0}" -f $f.path)
        } else {
            Add-CopyFailure -Stage "robocopy:$src" -Path $f.path -Code ([string]$f.code) -Message $err
            Write-Warn2 ("XX 逐文件补试仍失败（已记账，保留 ERROR {0}）：{1}  [{2}]" -f $f.code, $f.path, $err)
        }
        Start-Sleep -Milliseconds 500
    }
    return $r
}

# 采集收尾：醒目告警 + 计数 + 台账落盘
# -NoWrite：-DryRun 时只喊不落盘（本脚本 -DryRun 的契约是"一个字节都不写"，别为了台账破约）
function Write-CopyFailureLedger {
    param([string]$RepoTag, [switch]$NoWrite)
    $total = $script:CopyFailures.Count
    $rec   = $script:CopyRecovered.Count
    if ($total -gt 0) {
        Write-Host ''
        Write-Host ("!!!! 采集不完整：本轮有 {0} 个文件复制失败（未中断整轮采集，已记账） !!!!" -f $total) -ForegroundColor Red
        foreach ($f in $script:CopyFailures) {
            $codeTxt = if ($f.code) { "ERROR $($f.code)" } else { 'copy-item' }
            Write-Host ("     - {0}  [{1}]  {2}" -f $codeTxt, $f.stage, $f.path) -ForegroundColor Red
            if ($f.message) { Write-Host ("       $($f.message)") -ForegroundColor DarkGray }
        }
        Write-Host ("     => 这些文件本轮**没有**采进仓（下次采集会自动再试；持续失败请查占用者）") -ForegroundColor Red
        if (-not $NoWrite) { Write-Host ("     => 台账：{0}" -f $script:CopyFailureLedger) -ForegroundColor Red }
        Write-Host ''
    }
    if ($rec -gt 0) {
        Write-Warn2 ("采集重试恢复：{0} 个文件在整轮重试/逐文件补试后被采到（非失败，但已记账，见台账）" -f $rec)
    }
    if ($NoWrite) {
        if ($total -eq 0) { Write-Ok 'dry-run: no copy failures' }
        return
    }
    # 台账：每轮覆盖写（logs 不进任何仓）
    try {
        $dir = Split-Path $script:CopyFailureLedger
        if (-not (Test-Path $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
        $obj = [ordered]@{
            schema         = 1
            host           = $env:COMPUTERNAME
            repo           = $RepoTag
            lastRunAt      = (Get-Date).ToString('o')
            failureCount   = $total
            recoveredCount = $rec
            failures       = @($script:CopyFailures)
            recovered      = @($script:CopyRecovered)
        }
        Write-Utf8NoBom $script:CopyFailureLedger (($obj | ConvertTo-Json -Depth 6) + "`n")
        if ($total -eq 0) { Write-Ok ("collect complete: no copy failures (ledger: {0})" -f $script:CopyFailureLedger) }
    } catch {
        # 台账写不进去也必须喊出来（否则"记账"这一环静默失效）
        Write-Warn2 "XX 写采集失败台账失败：$($_.Exception.Message)（屏幕告警仍有效）"
    }
}

function Invoke-Git {
    param([string[]]$Arguments)
    $out = & git -C $Repo @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed: $out" }
    return $out
}

# ---------------------------------------------------------------- 统一开关：仓2 停推判据（S1b 接线）
# 真源 `docs\方案-跨机骨架三柱与统一开关-20261010-v2.md` §5.2（fail 口径）/ §5.4-③b（落点与打印句）。
# 取值一律走**唯一读取器**的 CLI（`lib\sync-topology.mjs --get repo2.push`：值走 stdout、文案走 stderr、
#   rc 0 = 读到 / 3 = 未读到）—— 本文件**不写第二份 ConvertFrom-Json 判据**（S1 交付报告 §9.5 明示）。
# fail-open：读不到 ⇒ 按**本脚本现值**执行（= 会推）**并打印"本次会推仓2"**（v2 §5.2 末行：
#   否则「没打印」无法与「文件丢了」区分）。读到 false ⇒ 本轮不推（"停推"必须显式写文件才成立）。
# 逃生舱：`-IgnoreTopology`（带了就完全不算开关，恢复原行为）。
function Test-Repo2PushStopped {
    if ($IgnoreTopology) {
        Write-Host '[topology] 已按 -IgnoreTopology 忽略同步拓扑开关（逃生舱）⇒ 本轮按原行为执行' -ForegroundColor Cyan
        return $false
    }
    $reader = Join-Path $PSScriptRoot 'dsh-butler\lib\sync-topology.mjs'
    if (-not (Test-Path $reader)) {
        Write-Warn2 '[topology] 同步拓扑读取器未分发到本机 ⇒ 未找到同步拓扑开关文件，按现值执行（本次会推仓2）'
        return $false
    }
    $rc = -1
    $raw = $null
    # 与 Get-SessionEventCount 同款：pwsh 7.3+ 在 $ErrorActionPreference='Stop' 下会把原生命令的
    #   非零退出码变成异常（该变量在 PS5.1 不存在，赋值也安全）⇒ 显式关掉该行为。
    $prevNative = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
    try {
        $raw = & node.exe $reader --get repo2.push 2>&1
        $rc = $LASTEXITCODE
    } catch {
        $rc = -1
    } finally {
        $PSNativeCommandUseErrorActionPreference = $prevNative
    }
    $arr = @(($raw | Out-String) -split "`r?`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
    # ⚠️ ps1 侧 `2>&1` 的 stdout/stderr **合并顺序不保证**（实测缺文件时 stdout 那行值会排在最前）
    #   ⇒ 不许靠"最后一行就是值"取值。取值只在 rc=0 时做 —— 读取器 rc=0 时 stderr 必为空（已核源码）。
    #   其余行一律当文案原样打印（v2 §5.2「无论走哪边都打印」）；`true`/`false` 那行是值不是文案，跳过。
    $val = ''
    if ($rc -eq 0 -and $arr.Count -gt 0) { $val = $arr[$arr.Count - 1] }
    foreach ($l in $arr) {
        if ($l -eq 'true' -or $l -eq 'false') { continue }
        Write-Warn2 "[topology] $l"
    }
    if ($rc -eq 0 -and $val -eq 'false') {
        # v2 §5.4-③b 原文打印句（防"静默跳过被当故障"）
        Write-Warn2 '[topology] 已按总开关跳过仓2（butler-sync-topology.json#repo2.push=false）'
        return $true
    }
    if ($rc -eq 0 -and $val -eq 'true') {
        Write-Host '[topology] 同步拓扑开关 repo2.push=true ⇒ 本轮会推仓2（原行为）' -ForegroundColor Cyan
        return $false
    }
    Write-Warn2 "[topology] 未找到同步拓扑开关文件，按现值执行（本次会推仓2）（rc=$rc）"
    return $false
}

function Count-Sessions {
    param([string]$Dir)
    if (-not (Test-Path $Dir)) { return 0 }
    # 2026-09-24：认全世代（旧名 + v3 名）—— 原 -Filter 'session.jsonl.zstd' 精确名 ⇒ 0.1.5 起恒 0
    return (Get-ChildItem $Dir -Recurse -File -Force -ErrorAction SilentlyContinue |
            Where-Object { Test-SessionFileName $_.Name } | Measure-Object).Count
}

# 会话目录名 → 归一 id（仓里斯/本机侧前缀不统一：同 id 可能是 'session-<guid>' 或裸 '<guid>'）
function Get-SessionId {
    param([string]$Name)
    $n = $Name
    if ($n.StartsWith('session-')) { $n = $n.Substring('session-'.Length) }
    if ($n -match '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$') { return $n }
    return $null
}

# 一棵会话树下所有会话 id 的集合（sessions 与 _archived-sessions 通用）
function Get-SessionIdIndex {
    param([string]$Dir)
    $set = New-Object 'System.Collections.Generic.HashSet[string]'
    if (Test-Path $Dir) {
        foreach ($d in Get-ChildItem $Dir -Recurse -Directory -Force -ErrorAction SilentlyContinue) {
            $id = Get-SessionId $d.Name
            if ($id) { $null = $set.Add($id) }
        }
    }
    return ,$set
}

# ---------------------------------------------------------------- 空壳判据（2026-09-14）
# 逐帧统计事件数 / 是否有 turn/start：调零依赖探针（PowerShell 无内置 zstd 解压）
# 注：探针用退出码表达结果（0=至少一个文件探测成功 / 3=全部失败），而 pwsh 7.3+ 在
#     $ErrorActionPreference='Stop' 下会把原生命令的非零退出码变成异常 → 显式关掉该行为
#     （该变量在 PS5.1 不存在，赋值也安全）。
function Get-SessionEventCount {
    param([string]$Path)
    $probePath = Join-Path $PSScriptRoot 'dsh-session-probe.mjs'
    if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) { return $null }
    if (-not (Test-Path $probePath)) { return $null }
    $prevNative = $PSNativeCommandUseErrorActionPreference
    $PSNativeCommandUseErrorActionPreference = $false
    try {
        $raw = & node.exe $probePath --events $Path 2>$null
    } catch { return $null }
    finally { $PSNativeCommandUseErrorActionPreference = $prevNative }
    if (-not $raw) { return $null }
    try { $o = ($raw | Out-String).Trim() | ConvertFrom-Json } catch { return $null }
    if (-not $o -or -not $o.ok) { return $null }
    return [pscustomobject]@{
        Events       = [int]$o.events
        HasTurnStart = [bool]$o.hasTurnStart
        Frames       = [int]$o.frames
    }
}

# 空壳判定（判据 = 用户给定三条的「或」集合，三条都只在 <2KB 的前提下才评估）：
#   ① 文件 < 2 KB
#   ② 逐帧解后事件数 < 3
#   ③ 逐帧解后没有 turn/start（= 只有 session / permission / sandbox / approval / end-seed 这类启动头）
#   ②③ 命中任一即空壳。实测三类样本（2026-09-14）：
#     147~150B 1 帧 1 事件（被清空的历史空壳）→ ②③ 都命中；
#     308B 4 事件无 turn/start（只写了启动头）→ ③ 命中；
#     458B 6 事件无 turn/start（启动头 + 两个 end-seed）→ ③ 命中；
#     801B 9 事件**有** turn/start（真实短会话）→ 不判空壳，照旧走覆盖（不误伤有内容的小会话）。
#   探针不可用（node 缺失/解析失败）→ 保守按空壳（宁可少覆盖，不可丢内容）。
function Test-ShellSessionFile {
    param([string]$Path)
    $info = [ordered]@{
        Path = $Path; Bytes = 0; Events = 0; HasTurnStart = $false; Frames = 0; Shell = $false; Error = $null
    }
    if (-not (Test-Path -LiteralPath $Path)) { $info.Error = 'missing'; return [pscustomobject]$info }
    $info.Bytes = (Get-Item -LiteralPath $Path).Length
    if ($info.Bytes -ge $ShellSizeLimit) { return [pscustomobject]$info }   # 判据① 不成立 → 视为有内容
    $ev = Get-SessionEventCount -Path $Path
    if ($null -eq $ev) {
        $info.Error = 'probe-unavailable'
        $info.Shell = $true                        # 探针不可用 → 保守按空壳
        return [pscustomobject]$info
    }
    $info.Events = $ev.Events
    $info.HasTurnStart = $ev.HasTurnStart
    $info.Frames = $ev.Frames
    if ($info.Events -lt $ShellEventLimit) { $info.Shell = $true; return [pscustomobject]$info }   # 判据②
    if (-not $info.HasTurnStart) { $info.Shell = $true; return [pscustomobject]$info }             # 判据③
    return [pscustomobject]$info
}

# 跳过判据（纯函数，便于单测）：
#   本机文件 <2KB 且被判为空壳、且仓里那份**更大**（存在且有内容）→ 跳过覆盖，保住仓里的完整版
#   注：$LocalIsShell 由 Test-ShellSessionFile 判定；探针不可用时会判为 shell（保守）
function Test-SkippedShell {
    param([int]$LocalLen, [int]$RepoLen, [bool]$LocalIsShell)
    if ($LocalLen -ge $ShellSizeLimit) { return $false }   # 判据① 不成立
    if (-not $LocalIsShell) { return $false }               # 判据②③ 都不成立 = 本机有内容
    if ($RepoLen -le $LocalLen) { return $false }          # 仓里没有、或仓里那份不比本机大
    return $true
}

# ---------------------------------------------------------------- 采集（2026-09-14 加守卫）
function Invoke-CommitIfDirty {
    param([string]$Label = 'sessions sync')
    Invoke-Git @('add', '-A') | Out-Null
    $st = & git -C $Repo status --porcelain 2>&1
    if (-not $st) { Write-Ok 'no changes'; return }
    $msg = "{0}-{1} {2} {3}" -f (Get-Date -Format 'yyyyMMdd'), (Get-Date -Format 'HHmm'), $env:COMPUTERNAME, $Label
    Invoke-Git @('commit', '-m', $msg) | Out-Null
    Write-Ok "committed: $msg"
}

# 采集：默认行为与 2026-09-09 版一致（/E 增量覆盖），只多一道会话文件守卫
function Invoke-Collect {
    param(
        [string]$Target = $Src,
        [switch]$DryRun,
        [switch]$HealShells
    )
    Write-Step "collect sessions -> $Repo\sessions  (from $Target)"
    if (-not (Test-Path $Target)) { throw "sessions dir not found: $Target" }
    $dst = Join-Path $Repo 'sessions'
    if (-not $DryRun) { $null = New-Item -ItemType Directory -Path $dst -Force }

    # 1) 非会话文件照旧交给 robocopy（形态/参数与改前一致：/E /XJ 不 purge、排除百度盘残渣）
    #    /XF <会话文件名> 把会话文件排除在外，改由下面的守卫逐个处理；
    #    /L 是 robocopy 的「只列不复制」，-DryRun 时用它保证零写入。
    #    2026-09-16（卡 AT16）：rc>=8 **不再 throw 整轮** —— 走 Copy-Tree（整轮重试 + 逐文件补试 + 降级记账）
    # 2026-09-24：/XF 必须用**宽模式**，否则 v3 名会话文件会被 robocopy 无守卫地复制
    #（丢掉空壳保护 / 大小校验 / 失败记账），下面第 2 段守卫就成了摆设。
    $extra = @('/XF', $SessionFileFilter)
    foreach ($suf in $SkipSuffixes) { $extra += @('/XF', "*$suf") }
    if ($DryRun) { $extra += '/L' }
    [void](Copy-Tree $Target $dst -ExtraArgs $extra)


    # 2) 会话文件守卫
    #      （DryRun 也必须建索引：否则「仓里已有完整版」会被当成「仓里没有」→ 判定全错）
    $dstIndex = @{}
    if (Test-Path $dst) {
        foreach ($f in Get-ChildItem $dst -Recurse -File -Force -ErrorAction SilentlyContinue) {
            if (-not (Test-SessionFileName $f.Name)) { continue }
            $rel = $f.FullName.Substring($dst.Length).TrimStart('\')
            $dstIndex[$rel] = [pscustomobject]@{ Len = $f.Length; MTime = $f.LastWriteTimeUtc }
        }
    }

    $skipList = New-Object System.Collections.ArrayList
    $skipPaths = New-Object 'System.Collections.Generic.HashSet[string]'
    $copied = 0; $added = 0; $healed = 0; $bothShell = 0; $skipped = 0; $mtimeSkipped = 0; $copyFailed = 0

    $stack = New-Object System.Collections.Stack
    $stack.Push($Target)
    while ($stack.Count -gt 0) {
        $dir = $stack.Pop()
        $items = @()
        try { $items = Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue } catch { continue }
        foreach ($it in $items) {
            if ($it.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { continue }   # 不跟随 junction（同 /XJ）
            if ($it.PSIsContainer) { $stack.Push($it.FullName); continue }
            if ($SkipSuffixes | Where-Object { $it.Name.EndsWith($_) }) { continue }
            if (-not (Test-SessionFileName $it.Name)) { continue }                             # 非会话文件已由 robocopy 处理
            $rel = $it.FullName.Substring($Target.Length).TrimStart('\')
            $localLen = $it.Length
            $repoLen = -1
            $repoMTime = $null
            if ($dstIndex.ContainsKey($rel)) { $repoLen = [int]$dstIndex[$rel].Len; $repoMTime = $dstIndex[$rel].MTime }
            # 空壳判定只对 <2KB 的候选做（其余文件大小本身就证明有内容，不必解压）
            $localShell = $false
            $localEvents = 0
            if ($localLen -lt $ShellSizeLimit) {
                $localInfo = Test-ShellSessionFile -Path $it.FullName
                $localShell = [bool]$localInfo.Shell
                $localEvents = [int]$localInfo.Events
            }
            # 本机那份不比仓里更新、大小又一致 → 无需处理（robocopy 的 mtime 跳过语义，DryRun 走同一条路）
            if ($repoLen -eq $localLen -and $null -ne $repoMTime -and $it.LastWriteTimeUtc -le $repoMTime -and -not $localShell) { $mtimeSkipped++; continue }
            if (-not (Test-SkippedShell -LocalLen $localLen -RepoLen $repoLen -LocalIsShell $localShell)) {
                if ($DryRun) { $copied++ ; continue }
                $targetFile = Join-Path $dst $rel
                $targetDir = Split-Path $targetFile -Parent
                if (-not (Test-Path $targetDir)) { $null = New-Item -ItemType Directory -Path $targetDir -Force }
                # 2026-09-16（卡 AT16）：单文件复制失败不再 throw 整轮 —— 记账后继续采其它会话
                if (-not (Copy-OneFile -Src $it.FullName -Dst $targetFile -Stage 'sessions')) { $copyFailed++; continue }
                $n = (Get-Item -LiteralPath $targetFile).Length
                if ($n -ne $localLen) {
                    # 大小不符 = 这次**没采全**（活跃会话中间态也会命中）→ 记账告警，不中断整轮
                    Add-CopyFailure -Stage 'sessions' -Path $it.FullName -Code '' -Message "copy size mismatch: $rel（目标 $n B vs 源 $localLen B）"
                    Write-Warn2 ("XX 复制大小不符（已记账）：{0}  目标 {1}B vs 源 {2}B" -f $rel, $n, $localLen)
                    $copyFailed++
                    continue
                }
                if ($repoLen -lt 0) { $added++ } else { $copied++ }
                continue
            }
            # 命中保护情形：本机空壳 / 仓里那份更大
            $null = $skipPaths.Add($rel)
            $repoInfo = Test-ShellSessionFile -Path (Join-Path $dst $rel)
            if ($repoInfo.Shell) { $bothShell++ }
            $row = [pscustomobject]@{
                Rel = $rel; LocalLen = $localLen; LocalEvents = $localEvents; LocalShell = $localShell
                RepoLen = $repoLen; RepoEvents = [int]$repoInfo.Events; RepoShell = [bool]$repoInfo.Shell; Action = 'skipped'
            }
            if ($HealShells) {
                if ($DryRun) {
                    $row.Action = 'heal(dryrun)'; $healed++
                } else {
                    # 2026-09-16（卡 AT16）：回灌失败同样降级记账（写的是本机会话目录，更该可见）
                    try {
                        [System.IO.File]::Copy((Join-Path $dst $rel), $it.FullName, $true)
                        $row.Action = 'healed'; $healed++
                    } catch {
                        Add-CopyFailure -Stage 'heal-shells' -Path $it.FullName -Code '' -Message $_.Exception.Message
                        Write-Warn2 ("XX 空壳回灌失败（已记账）：{0}  [{1}]" -f $rel, $_.Exception.Message)
                        $row.Action = 'heal-failed'
                    }
                }
            } else {
                $skipped++
            }
            $null = $skipList.Add($row)
        }
    }

    foreach ($row in $skipList) {
        $tag = if ($row.Action -eq 'skipped') { 'SKIP' } elseif ($row.Action -eq 'healed') { 'HEAL' } elseif ($row.Action -eq 'heal-failed') { 'HEAL-FAIL' } else { 'HEAL(dry)' }
        if ($row.Action -eq 'skipped') {
            Write-Skip "$tag $($row.Rel)  local=$($row.LocalLen)B(shell,events=$($row.LocalEvents))  repo=$($row.RepoLen)B(events=$($row.RepoEvents))  -> keep repo copy"
        } else {
            Write-Skip "$tag $($row.Rel)  local=$($row.LocalLen)B(shell,events=$($row.LocalEvents)) <- repo=$($row.RepoLen)B(events=$($row.RepoEvents))"
        }
    }
    if ($DryRun) {
        Write-Ok "dry-run: would copy=$copied  skipped(shell-protected)=$skipped  mtime-skipped=$mtimeSkipped  healed=$healed  (nothing written)"
    } else {
        Write-Ok "sessions copied=$copied  added=$added  skipped(shell-protected)=$skipped  mtime-skipped=$mtimeSkipped  healed=$healed  copy-failed=$copyFailed  both-shell=$bothShell  protected-rows=$($skipList.Count)"
    }
    $f = Get-ChildItem $dst -Recurse -File -Force -ErrorAction SilentlyContinue
    Write-Ok "repo now holds $(Count-Sessions $dst) sessions / $([math]::Round(($f | Measure-Object Length -Sum).Sum/1MB,1))MB"
    # 采集收尾：失败可视化（红线 —— 降级不得掩盖失败）；-DryRun 只喊不落盘
    Write-CopyFailureLedger -RepoTag 'dsh-sessions' -NoWrite:$DryRun
    return [pscustomobject]@{
        Copied = $copied; Added = $added; Skipped = $skipped; ProtectedRows = $skipList.Count; Healed = $healed; BothShell = $bothShell; CopyFailed = $copyFailed; SkipRows = $skipList
    }
}


function Invoke-Pull {
    Write-Step 'pull from origin'
    $up = & git -C $Repo rev-parse --abbrev-ref 'master@{u}' 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "no upstream set ($up) - run -Push once first"; return }
    $out = & git -C $Repo pull --no-rebase --no-edit 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "git pull failed (rc=$LASTEXITCODE): $out"; return }
    Write-Ok 'pulled (or already up to date)'
}

function Invoke-PullMerge {
    param([string]$Target = $Src)
    Write-Step "merge repo sessions -> $Target  (missing only, never overwrite)"
    $repoSessions = Join-Path $Repo 'sessions'
    if (-not (Test-Path $repoSessions)) { Write-Warn2 'repo sessions dir not found, skip merge'; return }
    if (-not (Test-Path $Target)) { $null = New-Item -ItemType Directory -Path $Target -Force }
    # 2026-09-10：本机已有 = sessions 里有 OR 物理归档（_archived-sessions）里有。
    #   否则仓里留存的归档会话每次都被判"本机缺"→ 整批回流（实测一次 94 个）。
    #   判据按归一 id，兼容 'session-<guid>' / '<guid>' 两种目录名（直接比目录名会造假缺口）。
    $localIds = Get-SessionIdIndex -Dir $Target
    $archIds  = Get-SessionIdIndex -Dir $Arch
    $added = 0; $kept = 0; $skippedArchived = 0
    foreach ($grp in Get-ChildItem $repoSessions -Directory) {
        $localGrp = Join-Path $Target $grp.Name
        if (-not (Test-Path $localGrp)) { $null = New-Item -ItemType Directory -Path $localGrp -Force }
        foreach ($sess in Get-ChildItem $grp.FullName -Directory) {
            $id = Get-SessionId $sess.Name
            if ($id) {
                if ($localIds.Contains($id)) { $kept++; continue }
                if ($archIds.Contains($id)) { $skippedArchived++; continue }
            } elseif (Test-Path (Join-Path $localGrp $sess.Name)) { $kept++; continue }
            $dst = Join-Path $localGrp $sess.Name
            Copy-Item $sess.FullName $dst -Recurse -Force
            if ($id) { $null = $localIds.Add($id) }
            $added++
        }
    }
    Write-Ok "merged $added new session(s); kept $kept existing; skipped $skippedArchived archived-only"
}

function Write-GitAttributes {
    $attr = @'
# git-crypt: every session file is encrypted (conversations contain private data)
sessions/** filter=git-crypt diff=git-crypt
'@
    Set-Content -Path (Join-Path $Repo '.gitattributes') -Value $attr -Encoding ascii
    Write-Ok '.gitattributes written (sessions/** encrypted)'
}

function Invoke-Init {
    $null = New-Item -ItemType Directory -Path $Repo -Force
    if (-not (Test-Path (Join-Path $Repo '.git'))) {
        Write-Step 'git init'
        Invoke-Git @('init') | Out-Null
        Invoke-Git @('branch', '-M', 'master') | Out-Null
        if (-not (& git -C $Repo config user.name 2>$null)) {
            Invoke-Git @('config', 'user.name', 'kira905') | Out-Null
            Invoke-Git @('config', 'user.email', 'kira905@users.noreply.gitee.com') | Out-Null
        }
        Write-Ok 'git repo created'
    } else { Write-Warn2 'git repo already exists, skip init' }

    Write-GitAttributes

    # git-crypt：优先复用 dsh-core 的 key（一套 key 管多仓）
    $hasCrypt = Test-Path (Join-Path $Repo '.git\git-crypt')
    if ($hasCrypt) {
        Write-Warn2 'git-crypt already initialized in repo, skip'
    } elseif (Test-Path $KeyFile) {
        Write-Step "git-crypt unlock with existing key ($KeyFile)"
        Push-Location $Repo
        try {
            $out = & $GitCrypt unlock $KeyFile 2>&1
            if ($LASTEXITCODE -ne 0) { throw "git-crypt unlock failed: $out" }
            Write-Ok 'git-crypt unlocked (reused dsh-core key)'
        } finally { Pop-Location }
    } else {
        Write-Step 'git-crypt init (new key)'
        Push-Location $Repo
        try {
            & $GitCrypt init 2>&1 | Out-Null
            & $GitCrypt export-key $KeyFile 2>&1 | Out-Null
        } finally { Pop-Location }
        Write-Warn2 "new key exported -> $KeyFile (must be cold-backed up!)"
    }

    Invoke-Collect -Target $Src -DryRun:$DryRun -HealShells:$HealShells
    if ($DryRun) { Write-Warn2 'DryRun: skip add/commit/remote/status'; return }
    Invoke-Git @('add', '-A') | Out-Null
    $msg = "{0}-{1} {2} {3}" -f (Get-Date -Format 'yyyyMMdd'), (Get-Date -Format 'HHmm'), $env:COMPUTERNAME, 'init dsh-sessions backup'
    Invoke-Git @('commit', '-m', $msg) | Out-Null
    Write-Ok "committed: $msg"
    if (-not $DefaultRemote) { Write-Warn2 '未指定 remote（发布版不含私有仓地址）：用 -SetRemote <url> 指定后再跑' } elseif (-not (& git -C $Repo remote 2>&1)) { Invoke-Git @('remote', 'add', 'origin', $DefaultRemote) | Out-Null; Write-Ok "remote = $DefaultRemote" }
    Invoke-Status
}

function Invoke-Sync {
    Invoke-Collect -Target $Src -DryRun:$DryRun -HealShells:$HealShells
    if ($DryRun) { Write-Warn2 'DryRun: skip commit/pull/merge (nothing written)'; return }
    if ($NoGit) { Write-Warn2 'NoGit: skip commit/pull/merge (test mode)'; return }
    Invoke-CommitIfDirty -Label 'sessions sync'
    if ($BackupOnly) { Write-Ok 'BackupOnly: skip pull/merge'; return }
    Invoke-Pull
    Invoke-PullMerge -Target $Src
    Invoke-CommitIfDirty -Label 'sessions sync (post-merge)'
}

function Invoke-Status {
    Write-Step 'repo status'
    & git -C $Repo log --oneline -3 2>&1 | Write-Host
    $st = & git -C $Repo status --short 2>&1
    if ($st) { Write-Host $st } else { Write-Ok 'working tree clean' }
    $r = & git -C $Repo remote -v 2>&1
    if ($r) { Write-Host "remote: $r" } else { Write-Warn2 'no remote set' }
    $localN = Count-Sessions $Src
    $repoN  = Count-Sessions (Join-Path $Repo 'sessions')
    $archN  = Count-Sessions $Arch
    Write-Step "sessions count: local=$localN  repo=$repoN  archived=$archN"
    Push-Location $Repo
    try { Write-Step 'encrypted sample'; & $GitCrypt status -e 2>&1 | Select-Object -First 5 } finally { Pop-Location }
}

if (-not (Test-Path $GitCrypt)) { throw "git-crypt not found: $GitCrypt" }
if (-not (Test-Path $Repo)) { $null = New-Item -ItemType Directory -Path $Repo -Force }

if ($Init)      { Invoke-Init }
if ($Sync)      { Invoke-Sync }
if ($Pull) {
    if ($DryRun) { Write-Warn2 'DryRun: skip pull/merge' }
    else { Invoke-Pull; Invoke-PullMerge -Target $Src }
}
if ($SetRemote) {
    if ($DryRun) { Write-Warn2 'DryRun: skip remote change' }
    elseif (& git -C $Repo remote 2>&1 | Select-String '^origin$') { Invoke-Git @('remote', 'set-url', 'origin', $SetRemote) | Out-Null }
    else { Invoke-Git @('remote', 'add', 'origin', $SetRemote) | Out-Null }
    if (-not $DryRun) { Write-Ok "remote origin = $SetRemote" }
}
if ($Push) {
    # S1b 接线（v2 §5.4-③b）：先过统一开关判据；读到 false ⇒ 本轮不推仓2（逃生舱 -IgnoreTopology）。
    #   ⚠️ 停推分支里 node 的 rc 是 0 ⇒ `$LASTEXITCODE` 保持 0；显式再赋 0，防调用方
    #   （`dsh-sync-all.ps1` 的 `& $script -Push; if ($LASTEXITCODE -ne 0) ...`）把"停推"误判成失败。
    if (Test-Repo2PushStopped) { $LASTEXITCODE = 0; Write-Warn2 '    本轮按统一开关停推仓2（要强推请加 -IgnoreTopology）' }
    elseif ($DryRun) { Write-Warn2 'DryRun: skip push (nothing pushed to remote)' }
    else { Invoke-Git @('push', '-u', 'origin', 'master'); Write-Ok 'pushed' }
}
if ($Status) { Invoke-Status }

if (-not ($Init -or $Sync -or $Pull -or $SetRemote -or $Push -or $Status)) {
    Write-Host 'usage: -Init | -Sync [-BackupOnly] [-DryRun] [-HealShells] [-NoGit] | -Pull | -SetRemote <url> | -Push | -Status [-SessionsDir <dir>] [-ArchiveDir <dir>]'
}
