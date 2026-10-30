# dsh-ops-toolkit

English (default here) · [中文](README.md)

Operations and upgrade tooling for **DeepSeek Harness (DSH)**: backup collection, host bootstrap checks,
environment self-check, plugin snapshots, upgrade-package audit, upgrade-lock recovery, upgrade silence
windows, and "plugged-in protection" (no sleep / no hibernate / no display-off).
**16 runnable scripts** (12 `.mjs` + 4 `.ps1`) plus 6 shared modules in `lib/`.

> These scripts come from a real single-machine DSH operations setup (Windows + Node + PowerShell) and are
> written read-only-first, dry-run by default, and reversible: most of them expose a zero-side-effect entry
> such as `--check`, `--status`, `--dry-run` or `--list`.

---

## ℹ️ Read first: help & argument gate

`dsh-upgrade-audit` · `overnight-mode` · `snapshot-upgrade-pre` (since 2026-10-30) implement `--help`
(prints usage, exit 0) and **reject unknown arguments** (exit 2, never executes anything); each usage text says what the command writes.

The remaining scripts (`dsh-maintenance` · `dsh-bootstrap` · `dsh-boot-sync` · `dsh-dl-scheduler` · `dsh-upgrade-*` …)
keep the old behaviour: `--help` is **not a recognized switch**, unrecognized arguments are **ignored and the default action runs**
(for example `dsh-maintenance.mjs --help` takes its default branch instead of printing help).

⇒ For those, use the "Real usage" column below. When unsure, run only read-only entries
(`--check` / `--plan` / `--status` / `--dry-run` / `--list` / `--self-test`).

---

## Shared-source notice

Some files in this repository **share a source with an internal production implementation**
(the same engineering effort, evolved over time, with two landing places).

- **How much**: measured by the **line-level shared-source ratio** (among same-named comparable files, how
  many non-empty lines of this repository's files are found in the reference files, multiset-deducted); this
  repository's "≥50% line-share" figure is **100%**.
- **What that means**: this repository is a **distilled export** of that implementation — **neither a verbatim
  copy nor a fully rewritten independent implementation**. Before reading any single file as an "independent
  reference implementation", run the check below.
- **How to re-run it**: the shared-source scanner ships with `dsh-quality-toolkit` as `dsh-sim-scan.mjs`
  (`--repo <this repo> --prod-root <reference root>`); the bucket thresholds and the measurement caliber live
  in its `config/sim-scan.json`, not buried in code.
- **License**: see `LICENSE` at the repository root (when a subdirectory carries its own exception, that
  subdirectory's `LICENSE` wins).

## Requirements

| Item | Notes |
|---|---|
| Node.js | ≥ 20 (`dsh-maintenance.mjs` uses `node:sqlite` for some tasks → 22.5+) |
| PowerShell | **pwsh 7 preferred**, `powershell.exe` 5.1 fallback; `.ps1` files are UTF-8 **with BOM** + CRLF |
| `DSH_ROOT` | DSH workspace root (default: the parent directory of this repo) |
| `~/.dsh` | DSH home; override with `DSH_HOME` / `BUTLER_DSH_HOME` |
| `DSH_OFFSYNC_ROOT` | Off-disk backup root (default `~/dsh-offsync`) |
| `DSH_TOOLS_DIR` | Tool-tree root (default: this repo). When it points at a local DSH tool tree, a few scripts can call local components |

> ⚠️ Several scripts (backup, silence window, recovery) call **DSH components that are not in this repo**
> (`dsh-butler` tool tree, `guard-ctl.mjs`, `butler-tickd.mjs`). When a component is missing those scripts
> **degrade explicitly or refuse to act** — they never silently change state.

---

## Scripts (16)

### Backup & repo sync

| Script | What it does | Real usage | Notes |
|---|---|---|---|
| `dsh-backup-sessions.ps1` | Collect `~/.dsh/sessions` into the sessions repo (git + git-crypt); pull/merge/push | `pwsh -File dsh-backup-sessions.ps1 -Status` · `-Sync` · `-Sync -DryRun` · `-Sync -BackupOnly` · `-Pull` · `-Push` · `-Init` · `-SetRemote <url>` · `-HealShells` | `-DryRun` writes nothing; `-Repo` / `-SessionsDir` allow sandbox runs |
| `dsh-backup-workspace.ps1` | Collect the DSH workspace (root launchers / `docs` / `tools` / `assets`, whitelisted) into the workspace repo | `pwsh -File dsh-backup-workspace.ps1 -Status` · `-Sync` · `-DryRun` · `-Push` · `-Push -ForcePush` · `-Pull` · `-Init` | `-ForcePush` is an escape hatch (skips the superset gate, writes an audit line) |
| `dsh-boot-sync.mjs` | Boot-time "collect + restore back": sync the off-disk repos into the local tree / `~/.dsh` | `node dsh-boot-sync.mjs` · `--dry-run` · `--no-pull` · `--root-only` · `--self-test` | Refuses to restore while DSH is running; never mirrors, never prunes |
| `dsh-snapshot.ps1` | Light snapshot of the plugin profile (`package.json`, `pnpm-lock.yaml`, manifest) | `pwsh -File dsh-snapshot.ps1 [-ProfileDir <path>] [-SnapRoot <path>]` | Writes the snapshot dir only |

### Checks & diagnostics

| Script | What it does | Real usage | Notes |
|---|---|---|---|
| `dsh-bootstrap.mjs` | Host bootstrap audit/fix (scheduled tasks, shortcuts, plugin alignment, …) | `node dsh-bootstrap.mjs --check` · `--plan` · `--apply` (`--safe`, `--only <a,b>`) · `--self-test` | `--check`/`--plan` are side-effect free; `--apply` is idempotent but writes |
| `dsh-selfcheck.ps1` | Read-only environment self-check (root whitelist, JSON health, launcher consistency) | `pwsh -File dsh-selfcheck.ps1` | No parameters; does not follow junctions into off-disk trees |
| `dsh-upgrade-watch.mjs` | Version check: local baseline vs npm / GitHub | `node dsh-upgrade-watch.mjs` · `--no-remote` · `--json <path>` · `--quiet` | Read-only |
| `dsh-upgrade-audit.mjs` | Audit a new tarball's symbols/vocabulary; writes `_tmp/l0-audit-report.md` | `node dsh-upgrade-audit.mjs [tarballsDir]` · `--self-test` | Reads sample dir only; no network |
| `dsh-dl-scheduler.mjs` | Multi-NIC download queue: speed test, split by throughput, on-demand proxy | `node dsh-dl-scheduler.mjs status` · `speedtest [--url <U>]` · `add <url> [--out <path>] [--name <n>]` · `list` · `remove <index>` · `clear` · `run [--force]` | Queue dir via `DSH_DL_DIR`; proxy script via `DSH_PROXY_SCRIPT` |

### Upgrade & recovery

| Script | What it does | Real usage | Notes |
|---|---|---|---|
| `dsh-upgrade-silence.mjs` | Upgrade **silence window** v2: stop/restore production automation (tickd + scheduled tasks), refcounted holders | `node dsh-upgrade-silence.mjs --status` · `--disable --holder <id>` · `--enable --holder <id>` · `--check-stale` | `--status`/`--check-stale` read-only; `--disable` **really stops** automation (writes state before stopping) |
| `snapshot-upgrade-pre.mjs` | Pre-upgrade snapshot (main package / plugins / closure / config) + self-verify | `node snapshot-upgrade-pre.mjs` (dry-run) · `--apply` · `--apply --no-tree` · `--verify [--backup <dir>]` | Dry-run by default |
| `dsh-upgrade-recover.mjs` | Diagnose/recover a stuck **upgrade lock** (local or cross-host over SSH), fail-closed | `node dsh-upgrade-recover.mjs [--target local\|peer-a\|peer-b]` · `--apply` · `--json` · `--ssh <alias>` | Judges only unless `--apply`; peer hosts come from `DSH_PEER_A_*` / `DSH_PEER_B_*` |
| `dsh-maintenance.mjs` | **Downtime maintenance orchestration**: stop DSH → run task → bring it back | `node dsh-maintenance.mjs --list` · `--task <name>` (dry-run) · `--task <name> --go` | **`--go` really stops DSH**; no switch = dry-run; exit 3 = precondition not met |
| `upgrade-triage-cli.mjs` | Upgrade triage: classify a package/version/evidence into an authorization tier (decision only) | `node upgrade-triage-cli.mjs [--input <json>] [--pkg <name>] [--root <dir>] [--tools-dir <dir>] [--json]` | Fail-closed on unknown arguments |

### Plugged-in protection (sleep / hibernate / display / lid)

| Script | What it does | Real usage | Notes |
|---|---|---|---|
| `overnight-mode.mjs` | Plugged-in protection: while plugged in, block sleep/hibernate/display-off/lid-sleep and Windows Update auto-reboot; restore on battery | `node overnight-mode.mjs auto` · `on` · `off` · `status` · `on --dry-run` · `--self-test` | `status` read-only; `on`/`off` really change power settings (`off` restores from backup); common switches `--json` / `--force` / `--no-events` |
| `overnight-guard-check.mjs` | Read-only probe: compare current power settings with the baseline | `node overnight-guard-check.mjs` · `--json` · `--section` · `--fail-on-change` · `--self-test` | Never restores by itself (run `overnight-mode.mjs on` explicitly) |

---

## Shared modules (`lib/`)

| File | Purpose |
|---|---|
| `lib/dsh-home.mjs` | Single resolution rule for `~/.dsh` / workspace root |
| `lib/powershell-exe.mjs` | PowerShell interpreter selection (pwsh 7 first, 5.1 fallback) |
| `lib/closure-links.mjs` | Read-only scan of `profiles/node_modules` junction targets |
| `lib/guard-http.mjs` | HTTP liveness rule (`isHttpAlive` / `judgeHttp`) |
| `lib/upgrade-inputs.mjs`, `lib/upgrade-triage.mjs` | Upgrade-triage input collection and pure decision function |

No third-party runtime dependency (Node built-ins only; `yaml` is imported on demand where needed).

---

## Not included in this batch (4 scripts, stated openly)

| Script | Why |
|---|---|
| `dsh-upgrade-gate-cli.mjs` | static import of `dsh-butler/lib/audit.mjs`, `paths.mjs` (authorization ledger kernel) |
| `dsh-upgrade-orchestrator.mjs` | static import of `dsh-butler/lib/*` (upgrade lock + autonomy matrix kernel) |
| `dsh-upgrade-settings-check.mjs` | static import of `lib/dsh-host-rpc.mjs` (host credential channel) |
| `imagegen-backup.mjs` | static import of `dsh-butler/lib/host-tag.mjs` (host identity) |

Shipping them requires extracting audit / lock / host-identity behind injectable interfaces first.

## Safety

- Read-only first: `--check`, `--status`, `--dry-run`, `--list`, `--self-test`.
- Switches that really act: `--apply`, `--go`, `-Sync`, `-Push`, `--disable`, `on`, `off`, `--force`.
- No messaging, no pushes to other people's repositories, no network calls except the version checks you run.

## License

**AGPL-3.0-only + commercial license (dual licensing)** — see [`LICENSE`](LICENSE).
