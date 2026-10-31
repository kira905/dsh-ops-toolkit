# dsh-backup-workspace.ps1
# 仓3 dsh-workspace —— DSH_ROOT 工具链（根启动链 / docs / tools / assets / dsh-emoji-plugin）-> Gitee 私有仓
#
# 用法：
#   .\dsh-backup-workspace.ps1 -Init                      首次初始化（git init + 导入共用 key + 白名单采集 + 首提交）
#   .\dsh-backup-workspace.ps1 -Sync                      采集 + 提交 + git pull（日常/换机前跑）
#   .\dsh-backup-workspace.ps1 -Sync -BackupOnly          只采集 + 提交，不拉取
#   .\dsh-backup-workspace.ps1 -Pull                      只 git pull（把另一台机推送的内容拉到工作副本）
#   .\dsh-backup-workspace.ps1 -SetRemote <仓库URL>       设置 Gitee 仓库地址（origin）
#   .\dsh-backup-workspace.ps1 -Push                      推送到 Gitee（推前超集体检，不合格即拒绝）
#   .\dsh-backup-workspace.ps1 -Push -ForcePush           逃生舱：跳过挡推阻断（必写审计流水，见 P9 §17.2 T9）
#   ⚠️ 挡推门口径（2026-09-16 起）：只挡**判不出可回退**的仓侧独有行（CLI --blocking-only），
#      与 handoff.mjs --depart 前置体检同源；「本机已提交且已推送的旧版本」放行但列出。
#   .\dsh-backup-workspace.ps1 -Status                    查看仓库状态
#   .\dsh-backup-workspace.ps1 -DryRun                    只统计将采集的清单与体积，不写任何文件
#   .\dsh-backup-workspace.ps1 -Init -Repo <沙盒仓> -SourceRoot <假源>   沙盒验证（同一脚本跑假数据）
#
# 2026-09-09 改造（防跨机互相 purge，与仓2 dsh-backup-sessions.ps1 同一修法）：
#   采集由 /MIR（镜像+purge）改为 /E（增量，不删目标端多余文件）——旧版两台机器各自 -Sync
#   会把对方 push 的独有文件从工作副本删掉并推回远端（实测仓2 因此丢掉 ROG 68 个会话）。
#   -Sync 追加 git pull，让工作副本拿到另一台机的最新提交；确需清理「本机已删、仓里还在」
#   的文件时用 -Prune（显式回到 /MIR 语义，跑之前先确认对方机器已同步）。
#
# 2026-09-16 采集降级改造（卡 AT15）：robocopy 单文件失败不再 throw 整轮采集
#   事故：连续两次 `-Sync` 在 `robocopy docs -> 仓3\docs` 抛
#     `ERROR 1224 (0x000004C8) user-mapped section open`（卡在当日刚被 tick 刷新的
#     docs\管家报告\2026-09-16-<HOST_A>.md），**整次采集抛错退出**（不是只跳过该文件）——
#     该日报每 30 分钟重刷 ⇒ 周期性复发，自动同步/收工采集都不稳。
#   做法（与 dsh-backup-sync.ps1 对称）：① 整轮 robocopy 最多 3 次尝试（轮间 2s/4s 退避）+
#     ② 失败文件逐个补试一次 + ③ 仍失败则**记账 + 显式告警 + 计数**（不 throw，其余文件照采）；
#     ④ 摘要落 `logs\backup-collect-failures-dsh-workspace.json`（logs 在排除清单里，不进仓）。
#   🔴 红线：降级**绝不掩盖**真实复制失败 —— 失败必须显眼打印并进台账（含 ERROR 码与路径），
#     解析不出失败清单时按「未知失败」记账，绝不静默放过（判据见 tools\_test\test-collect-degrade.ps1）。
#   为什么不该 throw：采集是备份动作（本脚本多处已明确 fail-open，如体检失败不阻断采集），
#     一个文件被瞬时占用不该让另外几千个文件白采；但**不 throw ≠ 不报**。
#   为什么不改退出码：`dsh-sync-all.ps1` 用 `$LASTEXITCODE` 判「本仓采集失败 → 跳过 Push」，
#     给采集加非零码会让一个被占用的文件阻断整仓推送；可见性改由「醒目告警段 + 台账文件 + 计数」承担。
#
# 设计（docs\git交接迁移方案-20260907.md §3 仓3）：
#   1. 仓库本体在盘外 DSH_ROOT-offsync\git-backup\dsh-workspace，绝不进百度同步目录
#   2. 白名单采集；绝不带 _archive/_tmp/generated/logs/snapshots/backups/node_modules/*.zip
#   3. 敏感文件单独 git-crypt 加密（tools/setup-tuf-api.mjs、docs/API资产与定价.md）
#   4. 与仓1/仓2 共用同一把 git-crypt key（一套 key 管三仓，key 丢失=密文永久不可读）

param(
    [switch]$Init,
    [switch]$Sync,
    [switch]$Pull,
    [switch]$BackupOnly,
    [switch]$Prune,
    [switch]$Push,
    [switch]$ForcePush,
    [switch]$Status,
    [switch]$DryRun,
    [string]$SetRemote,
    [string]$Repo       = (Join-Path $env:USERPROFILE 'dsh-offsync\git-backup\dsh-workspace'),
    [string]$SourceRoot = $(if ($env:DSH_ROOT) { $env:DSH_ROOT } else { Split-Path $PSScriptRoot -Parent }),
    [string]$KeyFile    = (Join-Path $env:USERPROFILE 'dsh-offsync\git-backup\keys\dsh-core.key')
)

$ErrorActionPreference = 'Stop'
$GitCrypt = if ($env:DSH_GIT_CRYPT) { $env:DSH_GIT_CRYPT } else { 'git-crypt' }

# ---------- 白名单 ----------
# 根启动链：只收这 4 类扩展名（guard.mjs.before-restore 之类不入仓）
$RootGlobs = @('*.cmd', '*.ps1', '*.ico', '*.mjs')
# 白名单目录
$DirList = @('docs', 'tools', 'assets', 'dsh-emoji-plugin')
# 采集时排除（robocopy /XD /XF）：盘外大目录 + 依赖闭包 + 大文件
$ExcludeDirs  = @('node_modules', '_archive', '_tmp', 'generated', 'logs', 'snapshots', 'backups', '.git', 'chrome-profile', 'card-sessions')
$ExcludeFiles = @('*.zip', '*.tmp', '*.bak*', '*.old', '*.orig', '*.before-restore')

# ---------- 敏感文件（git-crypt 加密）----------
# ⚠️ 只允许 ASCII 路径！实测（2026-09-09 沙盒）：git-crypt 0.7.0 在 Windows 对非 ASCII 路径
#    走 CreateFileA，换机 `git-crypt unlock` 会报 "System error: CreateFileA: <中文路径>" 而失败；
#    clean/smudge 走管道不受影响（日常提交正常，解锁可删文件后 `git checkout -- .` 兜底）。
#    => docs/ 下中文文档若有敏感内容：先脱敏（明文 key 改为指向 .credentials.yaml），不要列入本清单。
$EncryptedPaths = @(
    'tools/setup-tuf-api.mjs'
    'tools/phone-proxy-config.json'
)
# ---------- 目录级加密模式（通配）----------
# 回滚点异地化的「仓3 独立段」（方案《自愈与回滚》§3.3 / D5=A）：只收 restore-*.mjs + offsite-manifest.json
#   + index.json（**不含备份数据**，数据在冷盘），由 tools\rollback-points-index-export.mjs 采集。
#   ⚠️ 采集出来的路径全 ASCII（中文点名被转成 uXXXX slug）——git-crypt 0.7.0 在 Windows 对非 ASCII
#      路径走 CreateFileA，unlock 会失败（2026-09-09 实测）。
#   ⚠️ 改这里之后**必须手工把同一行同步进工作副本的 .gitattributes**（Write-Meta 只在 -Init 跑；
#      2026-09-10 教训：只改脚本、仓里没生效 = 规则等于没加）。
$EncryptedGlobs = @(
    'rollback-points/**'
)

# ---------- 工具函数 ----------
function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK  $msg" -ForegroundColor Green }
function Write-Warn2($msg){ Write-Host "    !!  $msg" -ForegroundColor Yellow }

function Write-Utf8NoBom($path, $text) {
    $enc = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($path, $text, $enc)
}

# ---------- 采集失败账本（2026-09-16 AT15 采集降级）----------
# 语义：CopyFailures  = 本轮**确实没采到**的文件（必须显式告警 + 计数，红线）
#       CopyRecovered = 整轮失败后逐文件补试**救回来**的文件（不阻断，但仍记账，便于看频度）
$script:CopyFailures  = New-Object System.Collections.ArrayList
$script:CopyRecovered = New-Object System.Collections.ArrayList
$script:RobocopyTries = 3                                          # 整轮 robocopy 尝试次数（含首次）
# 台账路径可用环境变量 DSH_COLLECT_FAILURE_LEDGER 覆盖 —— 夹具/沙盒必须能隔离生产输出路径
#   （persona 铁律：测试/探针不得写生产输出位置；见 tools\_test\test-collect-degrade.ps1 E 段）
$script:CopyFailureLedger = if ($env:DSH_COLLECT_FAILURE_LEDGER) { $env:DSH_COLLECT_FAILURE_LEDGER } else { Join-Path $env:USERPROFILE '.dsh\collect-failures-dsh-workspace.json' }

function Add-CopyFailure {
    param([string]$Stage, [string]$Path, [string]$Code, [string]$Message)
    [void]$script:CopyFailures.Add([pscustomobject]@{ stage = $Stage; path = $Path; code = $Code; message = $Message })
}

function Add-CopyRecovered {
    param([string]$Stage, [string]$Path, [string]$Code, [string]$Message)
    [void]$script:CopyRecovered.Add([pscustomobject]@{ stage = $Stage; path = $Path; code = $Code; message = $Message })
}

# 解析 robocopy 输出里的文件级错误行
# 实测（2026-09-16 夹具 `_tmp\collect-degrade-probe\probe.ps1`/`probe2.ps1`）：即使
#   /NFL /NDL /NJH /NJS /NP 全开，失败行**仍会打印**，形如
#     `2026/09/16 12:09:30 ERROR 32 (0x00000020) Copying File <DRIVE>:\...\lock32.txt`
#   末尾还有一行人类可读说明。故无需额外"详细模式"重跑即可定位失败文件。
# ⚠️ 必须按 (码, 操作, 路径) 去重：robocopy 的 /R:n 对该文件**每次重试都打印一行 ERROR**
#   （夹具实测 /R:2 → 同一文件 3 行）——不去重会让一个文件被记账 3 次、告警刷屏、计数虚高。
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
# 返回 @{ Code; Output; Tries }；**永不 throw** —— 由 Copy-Tree 决定降级记账
function Invoke-RobocopyRetry {
    param([string]$Src, [string]$Dst, [string]$Mode, [string[]]$ExtraArgs = @())
    $last = $null
    for ($i = 1; $i -le $script:RobocopyTries; $i++) {
        $out = & robocopy $Src $Dst $Mode /XJ @ExtraArgs /R:2 /W:1 /NFL /NDL /NJH /NJS /NP 2>&1
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

# 采集收尾：醒目告警 + 计数 + 台账落盘
function Write-CopyFailureLedger {
    param([string]$RepoTag)
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
        Write-Host ("     => 台账：{0}" -f $script:CopyFailureLedger) -ForegroundColor Red
        Write-Host ''
    }
    if ($rec -gt 0) {
        Write-Warn2 ("采集重试恢复：{0} 个文件在整轮重试/逐文件补试后被采到（非失败，但已记账，见台账）" -f $rec)
    }
    # 台账：每轮覆盖写（logs 是盘外大目录、在采集排除清单里 ⇒ 不进仓）
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

# 采集分步计时（R5 报告 §8-R5 · 2026-10-14 · 主人拍板「R5-Q2」）：把 collect / add / status / commit
#   各段耗时并进采集台账。为什么：2026-10-14 那次 600s 超时，事后只能靠外围物证（台账 mtime / index
#   状态 / reflog / fsck）反推「卡在哪一步」，成本极高（见内部归因记录）；
#   有了这几个数，下次一眼就能分辨「搬运慢」还是「git 收尾慢」。
# 纯新增字段：不改控制流、不改退出码；写失败只告警，绝不影响采集/提交结果（fail-open）。
# 台账路径经 $env:DSH_COLLECT_FAILURE_LEDGER 可注入 ⇒ 夹具演练不会碰生产台账。
function Add-SyncTimings {
    param([object]$Timings)
    if (-not $Timings) { return }
    try {
        $obj = $null
        if (Test-Path $script:CopyFailureLedger) {
            try { $obj = Get-Content $script:CopyFailureLedger -Raw | ConvertFrom-Json } catch { $obj = $null }
        }
        $h = [ordered]@{}
        if ($obj) {
            foreach ($p in $obj.PSObject.Properties) { $h[$p.Name] = $p.Value }
        } else {
            $h['schema'] = 1
            $h['host'] = $env:COMPUTERNAME
            $h['repo'] = 'dsh-workspace'
            $h['lastRunAt'] = (Get-Date).ToString('o')
        }
        $h['timings'] = $Timings
        $dir = Split-Path $script:CopyFailureLedger
        if (-not (Test-Path $dir)) { $null = New-Item -ItemType Directory -Path $dir -Force }
        Write-Utf8NoBom $script:CopyFailureLedger (($h | ConvertTo-Json -Depth 6) + "`n")
    } catch {
        Write-Warn2 "XX 写采集分步计时失败：$($_.Exception.Message)（不影响采集结果）"
    }
}

# 必须以数组传参，避免 PowerShell 把 -A / -m 当函数参数名缩写
function Invoke-Git {
    param([string[]]$Arguments)
    $out = & git -C $Repo @Arguments 2>&1
    if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed: $out" }
    return $out
}

# robocopy 复制（0-7 均为成功，>=8 才是错误）；/XJ 排除 junction 防钻依赖闭包
# 默认 /E 增量（不删目标端多余文件）；-Prune 时 /MIR（镜像+purge，会删源端没有的文件）
# 2026-09-16：>=8 不再 throw 整轮 —— 见文件头「采集降级改造」。降级路径**必须**留痕（红线）。
function Copy-Tree($src, $dst) {
    if (-not (Test-Path $src)) { Write-Warn2 "missing source: $src"; return }
    $null = New-Item -ItemType Directory -Path $dst -Force
    $mode = if ($Prune) { '/MIR' } else { '/E' }
    $extra = @('/XD') + $ExcludeDirs + @('/XF') + $ExcludeFiles
    $r = Invoke-RobocopyRetry -Src $src -Dst $dst -Mode $mode -ExtraArgs $extra
    if ($r.Code -lt 8) { return }

    $fails = Get-RobocopyFailureList $r.Output
    Write-Warn2 ("XX robocopy 在 {0} 次尝试后仍返回 rc={1}（{2} -> {3}）：本轮采集**继续**，失败文件逐个记账" -f $r.Tries, $r.Code, $src, $dst)
    if ($fails.Count -eq 0) {
        # 解析不出文件级错误 ⇒ 仍按「未知失败」记账（绝不静默放过）
        $head = ((@($r.Output) | Select-Object -First 6) -join ' / ')
        Add-CopyFailure -Stage "robocopy:$src" -Path $dst -Code ([string]$r.Code) -Message "rc=$($r.Code)，输出里没有 'ERROR n (0x..) Copying File' 行，无法定位失败文件；原始输出前几行：$head"
        Write-Warn2 ("XX robocopy rc={0} 但未能解析出失败文件清单 —— 已按未知失败记账！原始输出：{1}" -f $r.Code, $head)
        return
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
        $target = Join-Path $dst $rel
        $ok = $false; $err = ''
        try { Copy-Item -LiteralPath $f.path -Destination $target -Force -ErrorAction Stop; $ok = $true }
        catch { $err = $_.Exception.Message }
        if ($ok) {
            Add-CopyRecovered -Stage "robocopy:$src" -Path $f.path -Code ([string]$f.code) -Message '整轮重试失败后逐文件补试成功'
            Write-Warn2 ("   -> 逐文件补试成功（本次已采到，仍记账以便观察频度）：{0}" -f $f.path)
        } else {
            Add-CopyFailure -Stage "robocopy:$src" -Path $f.path -Code ([string]$f.code) -Message $err
        }
        Start-Sleep -Milliseconds 500
    }
}

function Copy-RootFiles($srcDir, $dstDir, $globs) {
    $null = New-Item -ItemType Directory -Path $dstDir -Force
    $n = 0
    foreach ($g in $globs) {
        $files = Get-ChildItem -Path $srcDir -File -Filter $g -Force -ErrorAction SilentlyContinue
        foreach ($f in $files) {
            if (Copy-OneFile -Src $f.FullName -Dst (Join-Path $dstDir $f.Name) -Stage 'root-files') { $n++ }
        }
    }
    Write-Ok "root startup files: $n"
}

function Get-WhitelistFiles {
    $list = @()
    foreach ($g in $RootGlobs) {
        $list += Get-ChildItem -Path $SourceRoot -File -Filter $g -Force -ErrorAction SilentlyContinue
    }
    foreach ($d in $DirList) {
        $p = Join-Path $SourceRoot $d
        if (-not (Test-Path $p)) { continue }
        $files = Get-ChildItem -Path $p -Recurse -File -Force -ErrorAction SilentlyContinue
        $list += $files | Where-Object {
            $rel = $_.FullName.Substring($p.Length + 1)
            $parts = $rel -split '\\'
            $skip = $false
            foreach ($part in $parts) { if ($ExcludeDirs -contains $part) { $skip = $true; break } }
            if (-not $skip) {
                foreach ($pat in $ExcludeFiles) { if ($_.Name -like $pat) { $skip = $true; break } }
            }
            -not $skip
        }
    }
    return $list
}

# 清理「已在仓库里但如今被排除」的文件
# 注意：robocopy /XF 是双向排除（既不复制也不删除），源里被排除的旧文件会残留在仓库工作区
function Remove-StaleTracked {
    $tracked = & git -C $Repo -c core.quotepath=false ls-files 2>$null
    if (-not $tracked) { return }
    $stale = @()
    foreach ($f in $tracked) {
        $parts = $f -split '/'
        $name = $parts[-1]
        $hit = $false
        foreach ($d in $ExcludeDirs) { if ($parts -contains $d) { $hit = $true; break } }
        if (-not $hit) { foreach ($pat in $ExcludeFiles) { if ($name -like $pat) { $hit = $true; break } } }
        if ($hit) { $stale += $f }
    }
    if ($stale.Count -eq 0) { return }
    Write-Step "prune excluded tracked files: $($stale.Count)"
    foreach ($s in $stale) { Write-Host "    - $s" }
    Invoke-Git (@('rm', '--quiet', '--') + $stale) | Out-Null
}

# ---------- 推前超集体检（挡推保护 · P9 H0 2026-09-10 补）----------
# 为什么：采集是 robocopy /E 覆盖式 —— 工作副本里若存在生产没有的内容（别的机器推上来、
#   还没分发回本机的），下一次 -Sync 就会抹掉它，再 -Push 就永久丢失。
#   实测先例（2026-09-10 09:07）：本机 -Sync 覆盖掉仓3 里 TUF 版 8 份文档（插件魔改维护清单等）。
# 判据：复用 tools\lib\repo-superset.mjs（与 tools\check-repo-superset.mjs 同一份逻辑）的
#   **blockingLines**（CLI `--blocking-only`）= 仓里有、生产没有**且判不出可回退**的行（exit 1 = 命中）。
#   2026-09-16 卡「push-gate 对齐」：本门与 handoff.mjs --depart 前置体检、仓1 同款门**同一套口径**
#   （此前是「同一个门两套判据」：旧口径只要 uniqueLines 非空就挡）。
# 失败处置（§17.2 T9：不许"一失败就永久卡死"）：
#   ① 打印差异清单（文件 + 行数 + 仓内末次提交，便于判断谁更全）
#   ② 人工裁决入口：docs\P9-H0-立规矩与清尾巴-20260910.md §3（逐文件比对口径）
#   ③ 逃生舱 -ForcePush：确认「仓里内容可弃 / 本机确为超集」后强推，并**记审计**（哈希链）
function Get-NodeExe {
    $c = Get-Command node -ErrorAction SilentlyContinue
    if ($c) { return $c.Source }
    foreach ($p in @("$env:ProgramFiles\nodejs\node.exe", "${env:ProgramFiles(x86)}\nodejs\node.exe", "$env:APPDATA\npm\node.exe")) {
        if (Test-Path $p) { return $p }
    }
    return $null
}

# 返回 @{ ExitCode; Risky; Recoverable; Gate; VersionMismatch }
#   Risky       = **不可回退**的真内容独有行清单（供拒绝时列给人看）
#   Recoverable = 「♻ 可回退旧版」清单（已提交且已推送 ⇒ 覆盖后 git 可找回；本门放行，仅列出）
#   VersionMismatch = 工具没给出 blocking 口径（gate 栏缺失 / JSON 解析失败）⇒ 调用方 fail-closed
function Invoke-SupersetCheck {
    $tool = Join-Path $PSScriptRoot 'check-repo-superset.mjs'
    if (-not (Test-Path $tool)) { throw "推前超集体检工具缺失：$tool（fail-closed：拒绝继续）" }
    $node = Get-NodeExe
    if (-not $node) { throw '找不到 node.exe（fail-closed：拒绝继续）' }
    # ⚠️ 编码铁律（2026-09-16 根因 · TUF 实测）：CLI 的 --json 是 **UTF-8** 输出；若本进程
    #   [Console]::OutputEncoding 是系统代码页（中文机 936/GBK），PowerShell 捕获原生命令输出时
    #   会按 GBK 解码 → 多字节中文错位 → JSON 里的引号/反斜杠被吃 → ConvertFrom-Json 失败 →
    #   gate 读不到 → 下方 fail-closed 误挡推送（TUF depart 被 PUSH BLOCKED 的真因，被挡内容其实零风险）。
    #   修法：捕获期间临时切 UTF-8，捕获完**立刻还原**（不影响脚本自身中文输出的编码）。
    $savedOe = [Console]::OutputEncoding
    try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
    try {
        $json = (& $node $tool 'dsh-workspace' --json --blocking-only 2>$null) -join "`n"
        $code = $LASTEXITCODE
    } finally {
        try { [Console]::OutputEncoding = $savedOe } catch { }
    }
    $risky = @(); $recoverable = @(); $gate = ''; $mismatch = $false
    try {
        $obj = $json | ConvertFrom-Json
        $gate = [string]$obj.gate
        foreach ($r in @($obj.reports)) {
            foreach ($u in @($r.blockingLines)) { $risky += "$($u.rel)  ($($u.n) 行)" }
            foreach ($u in @($r.recoverableLines)) { $recoverable += "$($u.rel)  ($($u.n) 行)" }
        }
        # 口径校验：只有新 CLI 才带 gate 栏；查不到 = 工具被回滚/换成旧版 ⇒ 交给调用方 fail-closed，绝不静默放行
        if ($gate -ne 'blocking') { $mismatch = $true }
    } catch { $risky = @('(报告解析失败，按有风险处理)'); $mismatch = $true }
    return [pscustomobject]@{ ExitCode = $code; Risky = $risky; Recoverable = $recoverable; Gate = $gate; VersionMismatch = $mismatch }
}

# 仓内该文件的末次内容变更提交（人判"谁更全"的辅助信息）
function Get-RepoFileNote {
    param([string]$Rel)
    $s = & git -C $Repo log -1 --format='%ci %s' -- $Rel 2>$null
    if (-not $s) { return '(仓内无提交记录)' }
    return ([string]::Join(' ', @($s)))
}

function Assert-PushSafe {
    if ($ForcePush) {
        Write-Warn2 'ForcePush：跳过推前超集体检的**阻断**（危险，仅在你已逐项确认过差异时使用）'
        # 逃生舱是"绕过护栏"的动作 → 必须留痕（P5 审计流水，append-only + 哈希链）
        $res = $null
        try { $res = Invoke-SupersetCheck } catch { Write-Warn2 "体检本身失败：$($_.Exception.Message)" }
        $riskyList = if ($res -and $res.Risky.Count) { [string]::Join('; ', @($res.Risky)) } else { '(none/check-failed)' }
        if ($res -and $res.Recoverable.Count) {
            $riskyList = $riskyList + " | 可回退旧版 $($res.Recoverable.Count) 项: " + [string]::Join('; ', @($res.Recoverable))
        }
        $logger = Join-Path $PSScriptRoot 'dsh-butler\forcepush-log.mjs'
        $node = Get-NodeExe
        if ($node -and (Test-Path $logger)) {
            $reason = 'user confirmed: repo-only content is disposable / local is superset'
            $out = & $node $logger --repo dsh-workspace --reason $reason --risky $riskyList 2>&1
            Write-Warn2 "force-push audit: $([string]::Join(' ', @($out)))"
        } else {
            Write-Warn2 '[!] escape-hatch audit NOT recorded (missing node or forcepush-log.mjs) - record it manually'
        }
        return
    }
    Write-Step 'push guard: superset check (repo3 dsh-workspace, gate=blocking)'
    $res = Invoke-SupersetCheck
    if ($res.VersionMismatch) {
        # 2026-09-16（卡 AT12 · C 项）：fail-closed 不等于「内容冲突」——把**真因**分流打在屏幕上，
        # 不再只喊一句 PUSH BLOCKED（今天在 TUF 上因此耗掉一整轮排查：真因是控制台编码，不是内容风险）。
        Write-Warn2 'XX 真因诊断（gate 栏缺失 ⇒ 无法确认工具支持 --blocking-only；**不是**内容冲突）：'
        Write-Warn2 '   ① 编码：本进程 [Console]::OutputEncoding 非 UTF-8 时，node 的 UTF-8 JSON 会被按系统代码页解码 → 引号被吃 → gate 读不到。'
        Write-Warn2 '      本脚本已内置「捕获期间切 UTF-8 + 捕获后还原」；手工在别的 shell 跑同样会踩，先切再跑：'
        Write-Warn2 '      [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)'
        Write-Warn2 '   ② 工具版本：手工确认工具确实支持该口径（应打印 gate=blocking / exit=0）：'
        Write-Warn2 '      node tools\check-repo-superset.mjs dsh-workspace --json --blocking-only'
        Write-Warn2 '   ③ 工具或文件缺失（对端生产没有新版）：先让它过河——跑 Arrive 的分发段（A6b 会补 tools/**、docs/**、skills/**）：'
        Write-Warn2 '      node tools\dsh-butler\handoff.mjs --arrive                # 默认 report-only，先看清单'
        Write-Warn2 '      node tools\dsh-butler\handoff.mjs --arrive --adopt-apply  # 确认干净后本轮真写'
        Write-Warn2 '      兜底（只覆盖不删除、逐个备份）：node tools\tuf-adopt-repo-newer-files.mjs --apply'
        throw "PUSH BLOCKED（真因：工具未返回 blocking 口径，gate='$($res.Gate)'）—— fail-closed 拒绝推送。按上面 ①②③ 逐条定位（多数是编码或对端缺新版文件），**不要**用 -ForcePush 掩盖。"
    }
    if ($res.ExitCode -eq 0) {
        Write-Ok 'push guard passed (no un-recoverable repo-only content)'
        if ($res.Recoverable.Count -gt 0) {
            Write-Warn2 "   （另有 $($res.Recoverable.Count) 项「♻ 可回退旧版」：本机已提交且已推送 ⇒ 覆盖后 git 可找回，本门放行，仅列出供人眼扫一眼）"
            foreach ($f in $res.Recoverable) { Write-Warn2 "   ♻ $f" }
        }
        return
    }
    Write-Warn2 "XX 推前超集体检未通过（exit=$($res.ExitCode)）—— 拒绝推送，未执行任何 git 写操作"
    foreach ($f in $res.Risky) { Write-Warn2 "   $f" }
    if ($res.Recoverable.Count -gt 0) {
        Write-Warn2 "   --- 另有 $($res.Recoverable.Count) 项「♻ 可回退旧版」不在阻断范围（已提交且已推送 ⇒ git 可找回）---"
        foreach ($f in $res.Recoverable) { Write-Warn2 "   ♻ $f" }
    }
    Write-Warn2 '   --- 仓内末次提交（辅助判断谁更全：仓内提交晚于本机文件 mtime = 可能真是对方成果）---'
    foreach ($f in $res.Risky) {
        $rel = ($f -split '  \(')[0]
        Write-Warn2 ("   " + $rel + "  <-  " + (Get-RepoFileNote $rel))
    }
    Write-Warn2 '   --- 真因分流（先试 ①，再考虑 ②；两者处置完全不同）---'
    Write-Warn2 '   ① 本次交接刚拉进来的对端新版（只是还没分发回本机生产）→ 跑 Arrive 自动分发：'
    Write-Warn2 '      node tools\dsh-butler\handoff.mjs --arrive                # A6b 段，默认 report-only 先看清单'
    Write-Warn2 '      node tools\dsh-butler\handoff.mjs --arrive --adopt-apply  # 确认干净后本轮真写（逐个备份、只覆盖不删除）'
    Write-Warn2 '   ② 本机自己产的内容（对端没有）→ 人工裁决：确认可弃再 -ForcePush（会记审计流水），否则先合并/分发'
    throw "PUSH BLOCKED：仓3 工作副本里还有**不可回退**的、生产没有的内容（见上）。先分发回生产或确认可弃，再按 docs\\P9-H0-立规矩与清尾巴-20260910.md §3 走完人工裁决重试；确认无风险可加 -ForcePush（会记审计）。"
}

# ---------- 回滚点「仓3 独立段」采集（方案《自愈与回滚》§3.3 / D5=A · 2026-09-14）----------
# 分工：冷盘 = 数据（<DRIVE>:/F:，按主机名解析，禁写死盘符）；仓3 本段 = restore-*.mjs + offsite-manifest.json
#   + index.json（**不含备份数据**，避免仓库膨胀与 git-crypt 大 blob 无 delta）。
#   F1 实证：白名单的 $ExcludeDirs 明确排除 `_archive` → 回滚点脚本/清单此前从未进过任何仓。
# 冷盘不在线：采集器**回落本机副本**（_archive/<点>/offsite-manifest.json）并打 warning（不静默）。
# keep 段（2026-09-20 卡 ③-3.3）：同一次调用顺带采 `_archive\handoff-keep`（GC 凭据保留区）的凭据脚本
#   + 冷盘打包清单，落 `<仓>/rollback-points/handoff-keep/<host>/`（同一段、同一加密 glob，不新开段）。
# 失败**不阻断**其它段（采集是备份动作，fail-open；升级告警由日报「🧊」段负责）。
function Copy-RollbackPointsIndex {
    Write-Step 'collect rollback-points segment (restore scripts + manifest only; data stays on the cold drive)'
    $exporter = Join-Path $PSScriptRoot 'rollback-points-index-export.mjs'
    $node = Get-NodeExe
    if (-not (Test-Path $exporter)) { Write-Warn2 "exporter missing, skip segment: $exporter"; return }
    if (-not $node) { Write-Warn2 'node.exe not found -> skip rollback-points segment'; return }
    # ⚠️ 编码：node 的 --json 是 UTF-8；本进程 OutputEncoding 为 GBK 时捕获错位 → 解析失败 →
    #   本段会被误报成 unparsable（2026-09-16 与挡推门同源的根因修法）。
    $savedOe = [Console]::OutputEncoding
    try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
    try {
        $json = (& $node $exporter --repo $Repo --json 2>$null) -join "`n"
        $code = $LASTEXITCODE
    } finally {
        try { [Console]::OutputEncoding = $savedOe } catch { }
    }
    $o = $null
    try { $o = $json | ConvertFrom-Json } catch { $o = $null }
    if ($o) {
        $note = 'points={0} files={1} bytes={2} source={3}' -f $o.points, $o.files, $o.bytes, $o.source
        if ($o.keep) { $note += (' keep={0} buckets/{1} files source={2}' -f $o.keep.buckets, $o.keep.files, $o.keep.source) }
        if ($code -eq 0) { Write-Ok "rollback-points: $note" } else { Write-Warn2 "rollback-points rc=$code : $note" }
        if ($o.warning) { Write-Warn2 "rollback-points warning: $($o.warning)" }
        if ($o.keep -and $o.keep.warning) { Write-Warn2 "handoff-keep warning: $($o.keep.warning)" }
        if ($o.keep -and $o.keep.errors -and $o.keep.errors.Count -gt 0) { Write-Warn2 'handoff-keep segment has errors -- see daily report section [rollback offsite]' }
    } else {
        $head = if ($json) { $json.Substring(0, [Math]::Min(200, $json.Length)) } else { '(no output)' }
        Write-Warn2 "rollback-points output unparsable (rc=$code): $head"
    }
    if ($code -ne 0) { Write-Warn2 'rollback-points segment incomplete -- see daily report section [rollback offsite]' }
}

# _archive 索引导出（卡 D5 巡检报告 §6.3-B）：只收目录级元数据，落 docs/archive-index-<host>.json
#   docs 在采集白名单内 ⇒ 索引随之进仓3；对端 pull 后即可判「卡里声称的产物在对端是否存在」。
#   动机：_archive 不进任何仓（跨机不同步）⇒ 产物在对端时本机无从核对、下游卡只好重做（实例 1fcaf8a7）。
#   失败不阻断采集（对齐 rollback-points 段：采集是备份动作，fail-open，告警走日报）。
function Copy-ArchiveIndex {
    Write-Step 'collect archive index segment (directory-level metadata only; no content)'
    $exporter = Join-Path $PSScriptRoot 'archive-index-export.mjs'
    $node = Get-NodeExe
    if (-not (Test-Path $exporter)) { Write-Warn2 "exporter missing, skip segment: $exporter"; return }
    if (-not $node) { Write-Warn2 'node.exe not found -> skip archive-index segment'; return }
    $savedOe = [Console]::OutputEncoding
    try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
    try {
        $json = (& $node $exporter --json 2>$null) -join "`n"
        $code = $LASTEXITCODE
    } finally {
        try { [Console]::OutputEncoding = $savedOe } catch { }
    }
    $o = $null
    try { $o = $json | ConvertFrom-Json } catch { $o = $null }
    if ($o) {
        $note = 'dirs={0} files={1} bytes={2}' -f $o.dirs, $o.files, $o.bytes
        if ($code -eq 0) { Write-Ok "archive-index: $note" } else { Write-Warn2 "archive-index rc=$code : $note" }
    } else {
        $head = if ($json) { $json.Substring(0, [Math]::Min(200, $json.Length)) } else { '(no output)' }
        Write-Warn2 "archive-index output unparsable (rc=$code): $head"
    }
}
function Invoke-Collect {
    Write-Step "collecting whitelist -> $Repo"
    Copy-RootFiles $SourceRoot $Repo $RootGlobs
    foreach ($d in $DirList) { Copy-Tree (Join-Path $SourceRoot $d) (Join-Path $Repo $d) }
    Copy-RollbackPointsIndex
    Copy-ArchiveIndex
    Remove-StaleTracked
    Write-Ok 'collected'
    # 采集收尾：失败可视化（红线 —— 降级不得掩盖失败）
    Write-CopyFailureLedger 'dsh-workspace'
}

function Write-Meta {
    # git-crypt 加密规则（.gitattributes 必须 UTF-8 无 BOM，否则中文路径匹配失败）
    $attr = @()
    $attr += '# git-crypt: 敏感文件在仓库中为密文（未 unlock 的 clone 只见密文）'
    foreach ($p in $EncryptedPaths) {
        $attr += ('"{0}"    filter=git-crypt diff=git-crypt' -f $p)
    }
    foreach ($g in $EncryptedGlobs) {
        $attr += ('"{0}"    filter=git-crypt diff=git-crypt' -f $g)
    }
    Write-Utf8NoBom (Join-Path $Repo '.gitattributes') (($attr -join "`n") + "`n")
    Write-Ok '.gitattributes written (git-crypt rules)'

    # 大文件/依赖/临时文件不入仓（43MB LoRA 数据集 zip、node_modules 依赖闭包）
    $ignore = @'
# 大文件与依赖闭包（绝不入仓）
tools/*.zip
**/node_modules/
*.tmp

# 盘外大目录（白名单本就不采集，双保险）
_archive/
_tmp/
generated/
logs/
snapshots/
backups/
'@
    Write-Utf8NoBom (Join-Path $Repo '.gitignore') ($ignore -replace "`r`n", "`n")
    Write-Ok '.gitignore written'
}

function Initialize-GitCrypt {
    Push-Location $Repo
    try {
        $keyInRepo = Join-Path $Repo '.git\git-crypt\keys\default'
        if (Test-Path $keyInRepo) { Write-Warn2 'git-crypt already configured in repo, skip'; return }
        if (Test-Path $KeyFile) {
            Write-Step "import shared git-crypt key: $KeyFile"
            $out = & $GitCrypt unlock $KeyFile 2>&1
            if ($LASTEXITCODE -ne 0) { throw "git-crypt unlock failed: $out" }
            Write-Ok 'shared key imported (一套 key 管三仓)'
        } else {
            Write-Step 'git-crypt init (no shared key found -> new key)'
            $out = & $GitCrypt init 2>&1
            if ($LASTEXITCODE -ne 0) { throw "git-crypt init failed: $out" }
            $null = New-Item -ItemType Directory -Path (Split-Path $KeyFile) -Force
            & $GitCrypt export-key $KeyFile 2>&1 | Out-Null
            Write-Warn2 "new key exported -> $KeyFile （务必冷备；否则密文永久不可读）"
        }
    } finally { Pop-Location }
}

# 读取暂存区 blob 文本（latin1 保留字节，GITCRYPT 头为 ASCII 可识别）
# 注：git-crypt status 的路径输出是 C 转义形式，中文路径无法直接正则匹配，故用 blob 头判定
function Get-StagedBlobText($relPath) {
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = 'git'
    $psi.WorkingDirectory = $Repo
    $psi.RedirectStandardOutput = $true
    $psi.UseShellExecute = $false
    $psi.StandardOutputEncoding = [System.Text.Encoding]::GetEncoding(28591)
    $psi.Arguments = 'cat-file blob ":' + $relPath + '"'
    $p = [System.Diagnostics.Process]::Start($psi)
    $s = $p.StandardOutput.ReadToEnd()
    $p.WaitForExit()
    return $s
}

function Test-Encryption {
    Write-Step 'verify git-crypt encryption'
    $clean = & git -C $Repo config --get filter.git-crypt.clean 2>$null
    if ($clean) { Write-Ok "git filter configured: $clean" }
    else { Write-Warn2 'filter.git-crypt.clean missing -> repo not unlocked?' }
    foreach ($p in $EncryptedPaths) {
        $native = $p -replace '/', '\'
        if (-not (Test-Path (Join-Path $Repo $native))) { Write-Warn2 "missing in repo: $p"; continue }
        $blob = Get-StagedBlobText $p
        if ($blob -and $blob.Contains('GITCRYPT')) { Write-Ok "encrypted (ciphertext staged): $p" }
        else { Write-Warn2 "NOT ENCRYPTED: $p  (check .gitattributes / git-crypt filter)" }
    }
    # 目录级模式（$EncryptedGlobs）：拿仓里第一个匹配文件抽验 git 属性（不抽 blob 头——
    #   -Sync 之后内容已提交、staged 为空，blob 头判定会误报）。
    foreach ($g in $EncryptedGlobs) {
        $prefix = $g -replace '/\*\*$', ''
        $sample = Get-ChildItem -Path (Join-Path $Repo $prefix) -Recurse -File -Force -ErrorAction SilentlyContinue | Select-Object -First 1
        if (-not $sample) { Write-Warn2 "no file yet under $g (skip attr check)"; continue }
        $rel = $sample.FullName.Substring($Repo.Length + 1) -replace '\\', '/'
        $attrOut = & git -C $Repo check-attr filter diff -- $rel 2>$null
        if (([string]::Join(' ', @($attrOut))) -match 'filter:\s*git-crypt') { Write-Ok "dir pattern encrypted: $g -> $rel" }
        else { Write-Warn2 "NOT ENCRYPTED by pattern ${g}: $rel  (check .gitattributes; 手工同步过吗？)" }
    }
}

function Invoke-Init {
    $null = New-Item -ItemType Directory -Path $Repo -Force
    if (-not (Test-Path (Join-Path $Repo '.git'))) {
        Write-Step 'git init'
        Invoke-Git @('init') | Out-Null
        Invoke-Git @('branch', '-M', 'master') | Out-Null
        Write-Ok 'git repo created'
    } else { Write-Warn2 'git repo already exists, skip init' }

    if (-not (& git -C $Repo config user.name 2>$null)) {
        Invoke-Git @('config', 'user.name', 'kira905') | Out-Null
        Invoke-Git @('config', 'user.email', 'kira905@users.noreply.gitee.com') | Out-Null
        Write-Ok 'local git identity set (kira905)'
    }

    Write-Meta
    # 先提交元文件让仓库有 HEAD（git-crypt unlock 更稳）
    Invoke-Git @('add', '-A') | Out-Null
    if (& git -C $Repo status --porcelain 2>$null) {
        Invoke-Git @('commit', '-m', (New-CommitMsg 'init meta (.gitattributes/.gitignore)')) | Out-Null
        Write-Ok 'meta committed'
    }

    Initialize-GitCrypt
    Invoke-Collect
    Invoke-Git @('add', '-A') | Out-Null
    Test-Encryption
    $st = & git -C $Repo status --porcelain 2>&1
    if (-not $st) { Write-Ok 'no changes'; return }
    Invoke-Git @('commit', '-m', (New-CommitMsg 'init dsh-workspace backup')) | Out-Null
    Write-Ok 'committed'
    Invoke-Status
}

function New-CommitMsg($summary) {
    return "{0}-{1} {2} {3}" -f (Get-Date -Format 'yyyyMMdd'), (Get-Date -Format 'HHmm'), $env:COMPUTERNAME, $summary
}

function Invoke-Pull {
    Write-Step 'pull from origin'
    $up = & git -C $Repo rev-parse --abbrev-ref 'master@{u}' 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "no upstream set ($up) - run -Push once first"; return }
    $out = & git -C $Repo pull --no-rebase --no-edit 2>&1
    if ($LASTEXITCODE -ne 0) { Write-Warn2 "git pull failed (rc=$LASTEXITCODE): $out"; return }
    Write-Ok 'pulled (or already up to date)'
}

function Invoke-Sync {
    # 采集是覆盖式的：先体检提醒 —— 「仓里有、生产没有」的内容会被本机版覆盖
    # （工作副本内容可从 git 恢复，但先提醒；-Push 仍会被挡推保护拦住）
    # 口径（2026-09-16）：与 -Push 门一致 = blocking。提醒只针对**不可回退**那批（覆盖后 git 找不回）。
    # 注意：体检本身失败**不阻断采集**（采集是备份动作，不做 fail-closed）
    try {
        $pre = Invoke-SupersetCheck
        if ($pre.VersionMismatch) {
            Write-Warn2 '!! 采集前体检：体检工具未返回 blocking 口径（gate 栏缺失）—— 采集照常，但 -Push 会被 fail-closed 拦住，先核对体检工具版本'
        }
        if ($pre.ExitCode -ne 0) {
            Write-Warn2 "!! 采集前体检：仓3 有 $($pre.Risky.Count) 个文件存在**不可回退**的「仓里有、生产没有」内容，本次 -Sync 会用本机版覆盖它们（覆盖后 git 找不回）"
            foreach ($f in $pre.Risky) { Write-Warn2 "     $f" }
            Write-Warn2 '   若那是对方机器尚未分发回来的成果 → 停手先处理（docs\P9-H0-立规矩与清尾巴-20260910.md §3）；确认可弃可继续'
        }
        if ($pre.Recoverable.Count -gt 0) {
            Write-Warn2 "   -Sync 前体检：另有 $($pre.Recoverable.Count) 项「♻ 可回退旧版」（本机已提交且已推送 ⇒ 覆盖后可用 git 找回，不阻断）"
        }
    } catch { Write-Warn2 "采集前体检跳过：$($_.Exception.Message)" }
    # 分步计时（R5 §8-R5）：collect / add / status / commit 四段各自耗时 → 见 Add-SyncTimings。
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    Invoke-Collect
    $tCollect = $sw.ElapsedMilliseconds
    Invoke-Git @('add', '-A') | Out-Null
    $tAdd = $sw.ElapsedMilliseconds
    $st = & git -C $Repo status --porcelain 2>&1
    $tStatus = $sw.ElapsedMilliseconds
    if ($st) {
        Invoke-Git @('commit', '-m', (New-CommitMsg 'workspace sync')) | Out-Null
        Write-Ok 'committed'
    } else { Write-Ok 'no changes' }
    $sw.Stop()
    Add-SyncTimings -Timings ([ordered]@{
        collectMs  = [int]$tCollect
        addMs      = [int]($tAdd - $tCollect)
        statusMs   = [int]($tStatus - $tAdd)
        commitMs   = [int]($sw.ElapsedMilliseconds - $tStatus)
        totalMs    = [int]$sw.ElapsedMilliseconds
        addScope   = 'all (git add -A)'
        measuredAt = (Get-Date).ToString('o')
    })
    if ($BackupOnly) { Write-Ok 'BackupOnly: skip pull'; return }
    Invoke-Pull
}

function Invoke-Status {
    Write-Step 'repo status'
    Write-Host (& git -C $Repo log --oneline -5 2>&1)
    $st = & git -C $Repo status --short 2>&1
    if ($st) { Write-Host $st } else { Write-Ok 'working tree clean' }
    $remote = & git -C $Repo remote -v 2>&1
    if ($remote) { Write-Host "remote: $remote" } else { Write-Warn2 'no remote set (-SetRemote <url>)' }
    $files = & git -C $Repo ls-files 2>&1
    Write-Host ("tracked files: {0}" -f $files.Count)
    Push-Location $Repo
    try { Write-Host (& $GitCrypt status -e 2>&1 | Select-Object -First 10) } finally { Pop-Location }
}

function Invoke-DryRun {
    Write-Step "DRY RUN  source=$SourceRoot  repo=$Repo"
    $files = Get-WhitelistFiles
    $sum = ($files | Measure-Object Length -Sum).Sum
    if (-not $sum) { $sum = 0 }
    Write-Host ("    files = {0}" -f $files.Count)
    Write-Host ("    size  = {0} MB" -f [math]::Round($sum / 1MB, 2))
    Write-Host '    --- top 10 by size ---'
    $files | Sort-Object Length -Descending | Select-Object -First 10 |
        ForEach-Object { Write-Host ("    {0,8:N2} MB  {1}" -f ($_.Length / 1MB), $_.FullName.Substring($SourceRoot.Length + 1)) }
    Write-Host '    --- encrypted paths ---'
    foreach ($p in $EncryptedPaths) { Write-Host "    $p" }
}

# ---------- 主流程 ----------
if (-not (Test-Path $GitCrypt)) { throw "git-crypt not found: $GitCrypt" }

if ($DryRun) { Invoke-DryRun; return }
if (-not (Test-Path $Repo)) { $null = New-Item -ItemType Directory -Path $Repo -Force }

if ($Init) { Invoke-Init }
if ($Sync) { Invoke-Sync }
if ($Pull) { Invoke-Pull }
if ($SetRemote) {
    if (& git -C $Repo remote 2>&1 | Select-String '^origin$') { Invoke-Git @('remote', 'set-url', 'origin', $SetRemote) | Out-Null }
    else { Invoke-Git @('remote', 'add', 'origin', $SetRemote) | Out-Null }
    Write-Ok "remote origin = $SetRemote"
}
if ($Push) {
    Assert-PushSafe
    Invoke-Git @('push', '-u', 'origin', 'master')
    Write-Ok 'pushed'
}
if ($Status) { Invoke-Status }

if (-not ($Init -or $Sync -or $Pull -or $SetRemote -or $Push -or $Status -or $DryRun)) {
    Write-Host 'usage: -Init | -Sync [-BackupOnly] | -Pull | -SetRemote <url> | -Push [-ForcePush] | -Status | -DryRun [-Prune]'
    Write-Host '       [-Repo <path>] [-SourceRoot <path>] [-KeyFile <path>]  (沙盒验证用)'
}
