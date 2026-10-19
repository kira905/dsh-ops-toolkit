# ============================================================
#  DSH Snapshot - backup profile state before plugin changes
#  Saves package.json + pnpm-lock.yaml + a manifest of the
#  installed plugin list, so the guard can roll back to the
#  last-known-good version after a plugin-induced crash.
#  Called automatically by dsh-plugin.cmd before every run,
#  which passes the plugin operation being performed.
# ============================================================
param(
    [string]$ProfileDir = (Join-Path $env:USERPROFILE ".dsh\profiles\web"),
    [string]$SnapRoot = "$env:USERPROFILE\.dsh\snapshots",
    [string]$OpArgs = ""          # e.g. "--profile web add some-package"
)

$ErrorActionPreference = "Stop"

# --- what to snapshot ---------------------------------------------------
$packageJson  = Join-Path $ProfileDir "package.json"
$lockFile     = Join-Path $ProfileDir "pnpm-lock.yaml"

if (-not (Test-Path $packageJson)) {
    Write-Host " [snapshot] profile package.json missing at $packageJson; nothing to snapshot"
    exit 1
}

# --- build the snapshot directory ---------------------------------------
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$snapDir = Join-Path $SnapRoot $stamp
New-Item -ItemType Directory -Force -Path $snapDir | Out-Null

Copy-Item $packageJson (Join-Path $snapDir "package.json") -Force
if (Test-Path $lockFile) {
    Copy-Item $lockFile (Join-Path $snapDir "pnpm-lock.yaml") -Force
}

# --- record the plugin manifest (dependencies + bundles) ----------------
$manifest = @{}
try {
    $pkg = Get-Content $packageJson -Raw | ConvertFrom-Json
    $manifest = @{
        name         = $pkg.name
        dependencies = $pkg.dependencies
        bundles      = $pkg.dsh.profile.bundles
        snapshotTime = (Get-Date).ToString("o")
        op           = $OpArgs
    }
} catch {
    $manifest = @{
        snapshotTime = (Get-Date).ToString("o")
        op           = $OpArgs
        parseError   = $_.Exception.Message
    }
}
# 写 JSON 一律用无 BOM UTF-8（坑清单 #1：PS5.1 的 Set-Content -Encoding UTF8 会写 BOM，
# 让读 JSON 的程序（如 node/dsh）崩溃。用 .NET WriteAllText + UTF8Encoding($false) 无 BOM。）
$manifestJson = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText((Join-Path $snapDir "manifest.json"), $manifestJson, (New-Object System.Text.UTF8Encoding($false)))

# --- plugin-operation marker (guard only rolls back op-tagged snapshots) ---
if ($OpArgs.Trim() -ne "") {
    $opJson = @{
        op       = $OpArgs
        time     = (Get-Date).ToString("o")
        snapshot = $stamp
    } | ConvertTo-Json
    [System.IO.File]::WriteAllText((Join-Path $snapDir "plugin-op.json"), $opJson, (New-Object System.Text.UTF8Encoding($false)))
}

Write-Host " [snapshot] saved: $snapDir"
return $snapDir
