<#
.SYNOPSIS
  dsh-selfcheck.ps1 — DSH 环境自检脚本（本鱼技能树产物）

.DESCRIPTION
  把"DSH 折腾坑清单"变成可一键运行的只读自检：
    1. 根目录整洁度（防乱公约白名单检查）
    2. JSON 可解析性 + BOM 检测（坑1：Set-Content -Encoding UTF8 会写 BOM）
    3. _tmp 积压提醒（临时文件该归档了）
    4. 脚本语法检查（ps1 用 Parser，js/mjs 用 node --check）
    5. 进程状态（只读：dsh 相关进程是否在跑）
    6. 备份新鲜度
    7. HTML 注入脚本闭合检查（坑3：漏 </script> 全脚本失效）— 扫描面收窄到自研注入页
    8. launcherMain 两份同源（guard.mjs ↔ guard-launcher.mjs）

  纯只读，不修改任何文件、不杀任何进程。

  L-17（2026-09-23）两项修复：
    a) 枚举一律走 Get-SafeFiles（跳过 junction / 符号链接）。此前 §2/§3/§6/§7 用
       Get-ChildItem -Recurse 会跟随 DSH_ROOT 下 10 个 junction 走进 DSH_ROOT-offsync 实体树，
       实测 152.5s / 116208 文件 ⇒ 修后 4.6s / 9055 文件（node 探针同口径基准）。
    b) §7 扫描面收窄到"我们自己维护的注入页"白名单（assets / dsh-emoji-plugin / tools +
       根一层）。范围外的 HTML（docs\舆情监测 外抓站快照、docs\企微…官方留档、
       _tmp 抓站件等）不计入、也不报 FAIL —— 否则只跳 junction 会让 §7 恒报 14 条假红。
       判据不变：`<script` 与 `</script>` 计数比对，只对白名单内文件判 FAIL。

  回滚点：_archive\selfcheck-l17-20260923-1556\（restore-selfcheck.mjs + 桌面 restore-selfcheck.cmd）

  L-18（2026-09-25）[2] 段 JSON 健康两项修复：
    a) 解析器换 node（tools\json-health-scan.mjs）：PS ConvertFrom-Json 有两处结构性假红 —— ① 属性名大小写
       不敏感 ⇒ 合法 package-lock.json 报「名称为空字符串的属性 / 键大小写不同」；② 按代码页解码 ⇒ 合法
       UTF-8 中文 JSON 报「Unexpected character: 清」。实测 14 条 FAIL 无一条是真故障。
    b) 扫描面分档：strict 面（tools / docs 非证据件 / 根一层 …）计入 FAIL；_tmp（临时·测试·抓站）、
       docs\舆情监测（抓站证据留档）、任意层 chrome-profile 目录、以及「非 JSON 结构文本件（.json 误命名
       的报告文本，如 docs-discipline/_out/g29-*.json）」转 SKIP —— 显式列出、不计 FAIL。
       ⚠️ 代价：strict 面里「纯文本误命名 .json」不再报 FAIL（只登记）；换来「真损坏 JSON（首字符合法
       但内容坏，如截断/空文件）仍报 FAIL」不被掩盖。
    判据真源 = tools\json-health-scan.mjs（SKIP_RULES + 非 JSON 文本件判据；改判据后跑 --self-test）。
    回滚点：_archive\selfcheck-jsonhealth-20260925-1229\（restore-selfcheck.mjs + 桌面 restore-selfcheck-jsonhealth.cmd）

.EXAMPLE
  pwsh -NoProfile -File tools\dsh-selfcheck.ps1
#>

$ErrorActionPreference = 'SilentlyContinue'
$root = if ($env:DSH_ROOT) { $env:DSH_ROOT } else { Split-Path $PSScriptRoot -Parent }
$ok = 0; $warn = 0; $fail = 0

function Say([string]$level, [string]$msg) {
  switch ($level) {
    'OK'   { Write-Host "  [OK]   $msg" -ForegroundColor Green; $script:ok++ }
    'WARN' { Write-Host "  [WARN] $msg" -ForegroundColor Yellow; $script:warn++ }
    'FAIL' { Write-Host "  [FAIL] $msg" -ForegroundColor Red;    $script:fail++ }
  }
}
function T([System.Diagnostics.Stopwatch]$sw) {
  $sw.Stop()
  Write-Host "       [t] $([math]::Round($sw.Elapsed.TotalSeconds,2))s" -ForegroundColor DarkGray
}

# ---------- 安全枚举 helper（L-17）----------
# 逐层只读枚举，跳过 junction / 符号链接（ReparsePoint）—— 不再跟随进 DSH_ROOT-offsync 实体树。
# 起点 $Path 自身不判链接（调用方显式指定；§6 的 backups 本身就是 junction 起点，必须能进）。
# PS5.1 / PS7 双兼容：只用 Get-ChildItem -Force + FileAttributes 位运算，不依赖 PS7 专有参数。
# 不用 Write-Progress / Read-Host（无控制台环境下会退化）。
function Get-SafeFiles {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [string[]]$SkipDirNames = @('node_modules'),
    [switch]$NonRecurse,
    [System.Collections.Generic.List[string]]$JunctionList
  )
  $files = New-Object 'System.Collections.Generic.List[System.IO.FileSystemInfo]'
  if (-not (Test-Path -LiteralPath $Path)) { return , $files }
  $queue = New-Object 'System.Collections.Generic.Queue[string]'
  $queue.Enqueue($Path)
  while ($queue.Count -gt 0) {
    $dir = $queue.Dequeue()
    $children = @(Get-ChildItem -LiteralPath $dir -Force -ErrorAction SilentlyContinue)
    foreach ($c in $children) {
      $isLink = $false
      try { $isLink = (($c.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) } catch { $isLink = $false }
      if ($isLink) {
        if ($null -ne $JunctionList) { [void]$JunctionList.Add($c.FullName) }   # 注意：空 List 在 PS 里是 $false，必须判 $null
        continue
      }
      if ($c.PSIsContainer) {
        if ((-not $NonRecurse) -and ($SkipDirNames -notcontains $c.Name)) { $queue.Enqueue($c.FullName) }
      } else {
        [void]$files.Add($c)
      }
    }
  }
  return , $files
}

Write-Host "===== DSH 环境自检 ($(Get-Date -Format 'yyyy-MM-dd HH:mm')) =====" -ForegroundColor Cyan
$swAll = [System.Diagnostics.Stopwatch]::StartNew()

# ---------- 1. 根目录整洁度 ----------
Write-Host "`n[1] 根目录整洁度（防乱公约）" -ForegroundColor Cyan
# 白名单权威源 = tools\dsh-butler\butler-tidy-policy.json（P8 §5.3 单一数据源）。
# 读取顺序：策略文件（tools → ~/.dsh）→ 读不到才回落下方内联副本（P8 §15.2 P-2 契约）。
# ↓ 内联副本（回落用，与策略文件 rootWhitelist 同口径；旧版只认 2 个 *.mjs 正则，缺 guard2 件套等 → 假阳性）
#   2026-10-16 卡 生态-A系列卡4：目录补 .dsh-uploads（DSH 宿主上传落点，只能纳白名单、不可删不可搬）
$allowedDirs = @('_archive','_tmp','assets','docs','tools','dsh-emoji-plugin','backups','generated','logs','snapshots','node_modules','card-sessions','.dsh-uploads')
$allowedFiles = @(
    'fix-workspace-local.mjs','migrate-session-cwd.mjs',
    'guard.mjs','guard-core.mjs','guard-ctl.mjs','guard-switch.mjs','guard-http.mjs','guard-confirm.mjs',
    # ↑ guard-window.mjs（2026-10-11「守护鱼开窗治理」卡的开窗资格 / 进程 / 页面占用判据单一真源，
    #   guard.mjs 静态 import、dsh-start.ps1 经它的 CLI 调用）同批补登记（13 → 15 条，与权威源一致）。
    'guard-window.mjs',
    # ↑ guard-confirm.mjs 由 P1「判死前二次确认」件于 2026-10-10 落根（guard-core 的确认纯判据兄弟件）；
    #   当时只登记了权威源 butler-tidy-policy.json，**漏登本内联副本** ⇒ [1b] 白名单副本一致性报
    #   「+文件 guard-confirm.mjs」（策略文件读不到而回落内联时会把它当白名单外文件 = 假阳性）。
    #   2026-10-11 卡「冲刺600·开发批八」按处置路径补齐（13 → 14 条，与权威源一致）。
    'repair.mjs','repair-ctl.mjs',
    'knowledge.mjs','l2-actions.mjs','llm-client.mjs',
    'guard-launcher.mjs',
    # 2026-10-16 卡 生态-A系列卡4：与权威源同批补齐（15 → 18 条）。其中同族三件 dsh-desktop.cmd /
    #   dsh-plugin.cmd / dsh-guard.cmd 系 2026-10-14 卡 R8「只同步了 wrapup 内联、漏登本副本」的欠账
    #   ⇒ [1b] 长期报「+文件 三件」分叉；本卡按该脚本自身处置路径一并补齐。
    'dsh-desktop.cmd','dsh-plugin.cmd','dsh-guard.cmd'
)
$allowedFilePatterns = @('^(dsh-.*\.(cmd|ps1|mjs|js)|.*\.(ico|png|svg))$')
# ↓ 内联快照（卡 补C4 · 2026-10-09）：策略读取前先留底，供下方 [1b]「白名单副本一致性」逐条比对
$inlineAllowedDirs  = @($allowedDirs)
$inlineAllowedFiles = @($allowedFiles)
# ↓ 策略读取（覆盖上方内联副本）：任一候选存在且含 rootWhitelist 即生效
$wlSource = 'inline'
foreach ($cand in @("$root\tools\dsh-butler\butler-tidy-policy.json", "$env:USERPROFILE\.dsh\butler-tidy-policy.json")) {
  if (-not (Test-Path $cand)) { continue }
  try {
    $policy = Get-Content $cand -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($policy.rootWhitelist -and $policy.rootWhitelist.dirs -and $policy.rootWhitelist.files) {
      $allowedDirs = @($policy.rootWhitelist.dirs)
      $allowedFiles = @($policy.rootWhitelist.files)
      if ($policy.rootWhitelist.filePattern) { $allowedFilePatterns = @([string]$policy.rootWhitelist.filePattern) }
      $wlSource = "policy: $cand"
      break
    }
  } catch { }
}
if ($wlSource -eq 'inline') { Say 'WARN' '策略文件读不到或缺 rootWhitelist，已回落内联白名单（P8 §15.2 P-2）' }
$rootItems = Get-ChildItem $root -Force
$stray = @()
foreach ($item in $rootItems) {
  if ($item.PSIsContainer) {
    if ($allowedDirs -notcontains $item.Name) { $stray += "[目录] $($item.Name)" }
  } else {
    $matched = $allowedFiles -contains $item.Name
    if (-not $matched) { foreach ($pat in $allowedFilePatterns) { if ($item.Name -match $pat) { $matched = $true; break } } }
    if (-not $matched) { $stray += "[文件] $($item.Name)" }
  }
}
if ($stray.Count -eq 0) { Say 'OK' '根目录干净，无白名单外文件' }
else { foreach ($s in $stray) { Say 'WARN' "根目录混入非白名单项: $s" } }
Write-Host "       白名单来源 = $wlSource（$($allowedDirs.Count) 目录 / $($allowedFiles.Count) 文件 / $($allowedFilePatterns.Count) 形态正则）" -ForegroundColor DarkGray

# ---------- 1b. 白名单副本一致性（防分叉 · 卡 补C4 2026-10-09）----------
# 判据：本文件上方内联副本（$inlineAllowedFiles/$inlineAllowedDirs）与权威源策略文件必须逐条一致。
# 为什么要有它：内联副本是「策略文件读不到」时的回落态，平时不生效 ⇒ 分叉了也没人发现，
# 直到某天策略文件缺失才爆发成假阳性（先例：CW-2 内联 11 条 vs 权威 12 条；补C4 内联 12 条 vs 权威 13 条 = guard-http.mjs）。
# 本段只报不改（自检纯只读）；发现分叉的处置 = 同批同步内联段，然后重跑本脚本确认转 OK。
if ($wlSource -eq 'inline') {
  Say 'WARN' '白名单回落态（策略文件读不到）—— 无法核对内联副本与权威源一致性'
} else {
  $wlDiff = @()
  foreach ($f in $inlineAllowedFiles) { if ($allowedFiles -notcontains $f) { $wlDiff += "-文件 $f" } }
  foreach ($f in $allowedFiles)       { if ($inlineAllowedFiles -notcontains $f) { $wlDiff += "+文件 $f" } }
  foreach ($d in $inlineAllowedDirs)  { if ($allowedDirs -notcontains $d) { $wlDiff += "-目录 $d" } }
  foreach ($d in $allowedDirs)        { if ($inlineAllowedDirs -notcontains $d) { $wlDiff += "+目录 $d" } }
  if ($wlDiff.Count -eq 0) {
    Say 'OK' "白名单内联副本与权威源一致（$($allowedFiles.Count) 文件 / $($allowedDirs.Count) 目录）"
  } else {
    Say 'WARN' "白名单内联副本与权威源已分叉 $($wlDiff.Count) 处：$($wlDiff -join '；')"
    Say 'WARN' "处置：同步本脚本内联 `$allowedDirs/`$allowedFiles 后重跑（权威源 = $wlSource）"
  }
}

# ---------- 全树安全枚举（§2/§3/§7 共用，只遍历一次）----------
$swTree = [System.Diagnostics.Stopwatch]::StartNew()
$junctions = New-Object 'System.Collections.Generic.List[string]'
$allFiles = Get-SafeFiles -Path $root -SkipDirNames @('node_modules') -JunctionList $junctions
T $swTree
Write-Host "       安全枚举（跳 junction）：$($allFiles.Count) 个文件 / 跳过 $($junctions.Count) 个链接节点" -ForegroundColor DarkGray
if ($junctions.Count -gt 0) {
  Write-Host "       已跳过（不跟随进 DSH_ROOT-offsync）：$((($junctions | ForEach-Object { $_.Substring($root.Length + 1) }) -join ' · '))" -ForegroundColor DarkGray
}

# ---------- 2. JSON 可解析性 + BOM（node 解析 · 扫描面分档） ----------
Write-Host "`n[2] JSON 文件健康（node 解析 + BOM · 扫描面分档）" -ForegroundColor Cyan
$sw = [System.Diagnostics.Stopwatch]::StartNew()
# 历史归档目录（snapshots\_archive）里的旧 BOM 是过去式，不折腾（坑11：能用的别瞎改）
$jsonFiles = $allFiles | Where-Object {
  $_.Extension -eq '.json' -and
  $_.FullName -notmatch 'node_modules' -and $_.FullName -notmatch '[\\/](snapshots|_archive)[\\/]'
}
# 解析后端 = tools\json-health-scan.mjs（判据真源：路径分档 + 非 JSON 文本件判据）。
# 为什么换 node（L-18）：PS ConvertFrom-Json 有两处结构性假红（大小写不敏感键 / 代码页解码），
# 实测 14 条 FAIL 全是假红；本段一律不回落 PS 解析，防假红回归。
$scanTool = "$root\tools\json-health-scan.mjs"
if (-not (Test-Path -LiteralPath $scanTool)) {
  Say 'FAIL' 'JSON 解析后端缺失：tools\json-health-scan.mjs（本段不回落 PS ConvertFrom-Json，防假红回归）'
} else {
  $scanList = Join-Path $env:TEMP ("json-health-list-" + $PID + ".txt")
  try {
    [System.IO.File]::WriteAllLines($scanList, [string[]]@($jsonFiles | ForEach-Object { $_.FullName }), (New-Object System.Text.UTF8Encoding($false)))
    $prevEnc = [Console]::OutputEncoding
    try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
    $scanOut = & node $scanTool --list $scanList --root $root 2>&1 | Out-String
    $scanCode = $LASTEXITCODE
    try { [Console]::OutputEncoding = $prevEnc } catch { }
    try { $scan = $scanOut.Trim() | ConvertFrom-Json } catch { $scan = $null }
    if ($null -eq $scan -or -not $scan.files) {
      # 兜底：node 的 stderr 混进 stdout 时，取第一行以 { 开头的行再解析一次
      $jsonLine = @($scanOut -split "`n" | Where-Object { $_.TrimStart().StartsWith('{') })
      if ($jsonLine.Count -gt 0) { try { $scan = $jsonLine[0] | ConvertFrom-Json } catch { $scan = $null } }
    }
    if ($null -eq $scan -or -not $scan.files) {
      Say 'FAIL' "JSON 解析后端输出不可解析（node exit=$scanCode）：$(($scanOut.Trim() -split "`n" | Select-Object -First 1))"
    } else {
      foreach ($f in @($scan.files)) {
        if ($f.tier -ne 'strict') { continue }
        if ($f.status -eq 'ok') { Say 'OK' "$($f.rel)" }
        elseif ($f.status -eq 'bom') { Say 'WARN' "$($f.rel) 可解析但带 BOM（PS5.1 Set-Content 写的？建议重存）" }
        elseif ($f.status -eq 'missing') { Say 'WARN' "$($f.rel) 枚举后消失了（并发删除？）" }
        else { Say 'FAIL' "$($f.rel) JSON 解析失败: $($f.error)" }
      }
      $skipBad = @($scan.files | Where-Object { $_.tier -eq 'skip' -and $_.status -ne 'ok' })
      Write-Host "       扫描面分档：严格(strict) $($scan.counts.strict) 个计入 FAIL · SKIP $($scan.counts.skip) 个仅登记（_tmp $($scan.rules.tmp) · 舆情证据 $($scan.rules.opinion) · chrome-profile $($scan.rules.'browser-profile') · 非JSON文本件 $($scan.rules.'not-json-text')）" -ForegroundColor DarkGray
      if ($skipBad.Count -gt 0) {
        Write-Host "       SKIP 面异常 $($skipBad.Count) 条（不计 FAIL，仅登记可见）：" -ForegroundColor DarkGray
        foreach ($f in $skipBad) {
          $why = $f.error
          if ($f.rule -eq 'not-json-text') { $why = "非 JSON 文本件（首行：$($f.head)）" }
          Write-Host "         [SKIP·$($f.rule)] $($f.rel) — $why" -ForegroundColor DarkGray
        }
      }
    }
  } finally {
    if (Test-Path -LiteralPath $scanList) { Remove-Item -LiteralPath $scanList -Force -ErrorAction SilentlyContinue }
  }
}
Write-Host "       检查面：$($jsonFiles.Count) 个 json（跳 junction + 排除 node_modules/snapshots/_archive）" -ForegroundColor DarkGray
T $sw

# ---------- 3. _tmp 积压 ----------
Write-Host "`n[3] _tmp 临时文件积压" -ForegroundColor Cyan
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$tmp = "$root\_tmp"
if (Test-Path $tmp) {
  $prefix = "$tmp\"
  $files = @($allFiles | Where-Object { $_.FullName.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase) })
  $total = ($files | Measure-Object -Property Length -Sum).Sum
  if ($files.Count -eq 0) { Say 'OK' '_tmp 是空的' }
  elseif ($files.Count -le 50 -and $total -lt 20971520) { Say 'OK' "_tmp 有 $($files.Count) 个文件（约 $([math]::Round($total/1MB,2)) MB），保留项常态（队列/图标工具/当天迁移备份）" }
  else { Say 'WARN' "_tmp 积压 $($files.Count) 个文件（约 $([math]::Round($total/1MB,2)) MB），该归档到 _archive 了" }
} else { Say 'WARN' '_tmp 目录不存在（公约要求存在）' }
T $sw

# ---------- 4. 脚本语法 ----------
Write-Host "`n[4] 脚本语法检查" -ForegroundColor Cyan
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$psFiles = Get-ChildItem $root -File -Filter *.ps1 -Force
foreach ($f in $psFiles) {
  $tokens = $null; $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors) | Out-Null
  if ($errors.Count -eq 0) { Say 'OK' "$($f.Name) (ps1)" }
  else { Say 'FAIL' "$($f.Name) PS 语法错误: $($errors[0].Message)" }
}
$jsFiles = Get-ChildItem $root -File -Force | Where-Object { $_.Name -match '\.(mjs|js)$' }
foreach ($f in $jsFiles) {
  $out = & node --check $f.FullName 2>&1
  if ($LASTEXITCODE -eq 0) { Say 'OK' "$($f.Name) (node)" }
  else { Say 'FAIL' "$($f.Name) node 语法错误: $($out | Select-Object -First 1)" }
}
T $sw

# ---------- 5. 进程状态 ----------
Write-Host "`n[5] 进程状态（只读）" -ForegroundColor Cyan
$dshProcs = Get-Process | Where-Object { $_.ProcessName -match 'node|dsh' }
if ($dshProcs) {
  foreach ($p in $dshProcs | Select-Object -First 10) {
    Say 'OK' "进程 $($p.ProcessName) (PID $($p.Id)) 在跑"
  }
  if ($dshProcs.Count -gt 10) { Say 'WARN' "还有 $($dshProcs.Count - 10) 个 node/dsh 进程未列出" }
} else { Say 'WARN' '没看到 node/dsh 进程？（dsh 没在跑？）' }

# ---------- 6. 备份新鲜度 ----------
Write-Host "`n[6] 备份新鲜度" -ForegroundColor Cyan
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$bk = "$root\backups"
if (Test-Path $bk) {
  # backups 本身是 junction（指向 DSH_ROOT-offsync\backups）：起点允许进入，内部再遇链接才跳
  $bkFiles = Get-SafeFiles -Path $bk
  $latest = $bkFiles | Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if ($latest) {
    $age = (New-TimeSpan -Start $latest.LastWriteTime -End (Get-Date)).Days
    if ($age -le 7) { Say 'OK' "最近备份 $($latest.Name)（$age 天前）" }
    else { Say 'WARN' "最近备份是 $age 天前：$($latest.Name)，该备份了" }
  } else { Say 'WARN' 'backups 目录是空的' }
} else { Say 'WARN' 'backups 目录不存在' }
T $sw

# ---------- 7. HTML 注入脚本闭合 ----------
# 扫描面 = 我们自己维护的注入页白名单（L-17 收窄）。范围外（外抓站快照/官方留档/临时抓站件）
# 不计入也不判 FAIL —— 那些不是我们写的脚本，闭合不匹配是上游页面的客观事实。
Write-Host "`n[7] HTML 注入脚本闭合检查（扫描面=自研注入页）" -ForegroundColor Cyan
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$injectRoots = @(
  @{ Path = "$root\assets";           Label = 'assets' },
  @{ Path = "$root\dsh-emoji-plugin"; Label = 'dsh-emoji-plugin' },
  @{ Path = "$root\tools";            Label = 'tools' }
)
$injectFiles = New-Object 'System.Collections.Generic.List[System.IO.FileSystemInfo]'
$scanned = @()
foreach ($r in $injectRoots) {
  if (-not (Test-Path -LiteralPath $r.Path)) { continue }
  $got = Get-SafeFiles -Path $r.Path
  $hit = @($got | Where-Object { $_.Extension -match '^\.(html|htm)$' })
  foreach ($h in $hit) { [void]$injectFiles.Add($h) }
  $scanned += "$($r.Label)($($hit.Count))"
}
# 根一层（非递归）的自研注入页
$rootHtml = @(Get-ChildItem -LiteralPath $root -File -Force | Where-Object { $_.Extension -match '^\.(html|htm)$' })
foreach ($h in $rootHtml) { [void]$injectFiles.Add($h) }
if ($rootHtml.Count -gt 0) { $scanned += "根一层($($rootHtml.Count))" }

$allHtmlCount = @($allFiles | Where-Object { $_.Extension -match '^\.(html|htm)$' }).Count
$outsideCount = $allHtmlCount - $injectFiles.Count

if ($injectFiles.Count -eq 0) { Say 'OK' '白名单内没有 HTML 注入页需要检查' }
else {
  foreach ($f in $injectFiles) {
    $c = Get-Content $f.FullName -Raw -Encoding UTF8
    $open = ([regex]::Matches($c, '<script')).Count
    $close = ([regex]::Matches($c, '</script>')).Count
    $rel = $f.FullName.Substring($root.Length + 1)
    if ($open -eq $close -and $open -gt 0) { Say 'OK' "$rel script 闭合 $open/$close" }
    elseif ($open -eq 0) { Say 'OK' "$rel 无 script" }
    else { Say 'FAIL' "$rel script 开 $open 闭 $close，漏闭合会整片失效！" }
  }
}
Write-Host "       扫描面 = assets/dsh-emoji-plugin/tools（递归，跳 junction）+ 根一层；命中 $(($scanned -join ' · '))" -ForegroundColor DarkGray
Write-Host "       范围外 $outsideCount 个 HTML 不计入（外抓站快照/官方留档/临时抓站件：docs\舆情监测、docs\企微…、_tmp 等）" -ForegroundColor DarkGray
T $sw

# ---------- 8. launcherMain 两份同源（guard.mjs ↔ guard-launcher.mjs） ----------
# 判据真源 = tools\_test\test-guard-launcher-consistency.mjs（提取两份函数体逐字比对）。
# 漂移后果 = 悄悄退回「守护鱼起的 dsh 弹黑窗」（L-5/L-5b 卡根治的毛病），且**没有任何报错**。
# 卡 L-15（N-1）：挂到这里 ⇒ 单测从"要有人主动跑"变成"常驻可见"。
# 档位：本卡口径 = 只用 WARN（不改变本脚本既有退出码语义）；若要"漂移即让自检 red（exit 1）"，
# 把下面的 Say 'WARN' 换成 Say 'FAIL' 即可（一句话可切）。L-17 不动这个档位。
Write-Host "`n[8] launcherMain 两份同源（guard.mjs ↔ guard-launcher.mjs）" -ForegroundColor Cyan
$parityTest = "$root\tools\_test\test-guard-launcher-consistency.mjs"
if (Test-Path $parityTest) {
  # 捕获 node 输出前切 UTF-8（否则本机代码页会把中文解码错位，PS5.1/PS7 都可能）
  $prevEnc = [Console]::OutputEncoding
  try { [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false) } catch { }
  $parityOut = & node $parityTest 2>&1 | Out-String
  $parityCode = $LASTEXITCODE
  try { [Console]::OutputEncoding = $prevEnc } catch { }
  if ($parityCode -eq 0) {
    Say 'OK' '两份 launcherMain 逐字同源（改一处必须同批改另一处，漂移 = 弹黑窗复发）'
  } else {
    Say 'WARN' '两份 launcherMain 已漂移（严重：黑窗会复发且无报错）—— 改一处必须同批改另一处'
    $parityOut.Trim() -split "`n" | Where-Object { $_ -notmatch '^\s*ok\s' -and $_.Trim() } | ForEach-Object { Write-Host "       $($_.TrimEnd())" -ForegroundColor DarkGray }
    Write-Host "       处理：node $parityTest 看首个不同的行号与两侧原文" -ForegroundColor Yellow
  }
} else {
  Say 'WARN' "一致性测试缺失：$parityTest"
}

# ---------- 汇总 ----------
$swAll.Stop()
Write-Host "`n===== 汇总: OK=$ok  WARN=$warn  FAIL=$fail  （总耗时 $([math]::Round($swAll.Elapsed.TotalSeconds,2))s）=====" -ForegroundColor Cyan
if ($fail -gt 0) { Write-Host "发现 FAIL，先处理！" -ForegroundColor Red; exit 1 }
if ($warn -gt 0) { Write-Host "有 WARN 项，有空处理一下。" -ForegroundColor Yellow }
else { Write-Host "一切正常，主人可以放心折腾。" -ForegroundColor Green }
