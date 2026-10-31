#!/usr/bin/env node
/**
 * dsh-upgrade-watch.mjs — DSH 生态只读体检脚本（长期任务执行内核）
 *
 * 双线监控：
 *  A 线（Adapter/标准研发进度）：deepseek-ai/deepseek-harness（官方）、T-Auto/dsh-std（原 Yan-Zero/dsh-std，
 *      2026-10-19 现查：GitHub 301 重定向到 T-Auto）、T-Auto/dsh-ecosystem-spec、
 *      oh-my-dsh/dsh-community-standard、oh-my-dsh/dsh-plugin-upgrade-skill
 *  B 线（本地插件 x 主包版本）：web profile dependencies vs npm registry latest
 *
 * 设计原则：幂等、只读（默认不写任何文件）、零依赖（node>=18 fetch）、
 *   远端失败不中断（标 UNREACH 继续），适合无人值守看板任务调用。
 *
 * 用法：
 *   node <DSH_ROOT>\tools\dsh-upgrade-watch.mjs            # 全量（本地基线 + 远端对比）
 *   node <DSH_ROOT>\tools\dsh-upgrade-watch.mjs --no-remote   # 只看本地基线（断网/纯盘点）
 *   node <DSH_ROOT>\tools\dsh-upgrade-watch.mjs --json <path> # 额外把 JSON 结果写到 <path>
 *   node <DSH_ROOT>\tools\dsh-upgrade-watch.mjs --quiet       # 安静模式（仅摘要行）
 *
 * 退出码：0 正常（无论是否有新版本）；2 参数错误；3 本地基线缺失。
 */

import { readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

// ---- 入口守卫：junction 下 import.meta.url（物理）与 argv[1]（逻辑）必须 realpath 后比较 ----
function isMainEntry() {
  try {
    const fromMeta = realpathSync(fileURLToPath(import.meta.url))
    const fromArgv = realpathSync(path.resolve(process.argv[1] ?? ''))
    return fromMeta === fromArgv
  } catch {
    return false
  }
}

const FETCH_TIMEOUT_MS = 8000
const UA = 'dsh-upgrade-watch/1.0 (dsh long-term task; contact: local)'
const GITHUB_REPOS = [
  // ⚠️ D-1 覆盖源核对（看板卡 A2 · 2026-09-17）：本数组第 1 项与 dsh-upstream-watch.mjs 的
  //   OWNER/REPO 是**同一个仓的两处常量**（deepseek-ai/deepseek-harness）——改一处必须改两处。
  //   两线口径不同、互补不替代：本脚本 = **版本面**（npm latest / 本地实体 vs 声明值）+ 其余 4 个
  //   社区规范类源（下面几项只有本线盯）；dsh-upstream-watch.mjs = **内容面**（提交/符号/断裂面）。
  //   结论行目前在各自主报告里并列，未做合并核对（见 docs\跨机同步-A2-接线收口-交付报告-20260917.md §D-1）。
  { key: 'official-deepseek-harness', owner: 'deepseek-ai', repo: 'deepseek-harness', label: '官方 deepseek-ai/deepseek-harness' },
  // 2026-10-19 现查（在一次生态核查里）：`Yan-Zero/dsh-std` 已 GitHub **301 重定向**
  //   到 `T-Auto/dsh-std`（★158 · 最近 push 2026-10-10 · 未归档）⇒ 跟上真实 owner。
  //   别指望重定向永久有效：源仓一旦被删/再改名，旧路径就真断（改前实测旧路径仍可取数，故非"当场坏了"）。
  { key: 'dsh-std', owner: 'T-Auto', repo: 'dsh-std', label: '元协议 T-Auto/dsh-std' },
  { key: 'dsh-ecosystem-spec', owner: 'T-Auto', repo: 'dsh-ecosystem-spec', label: '准入 T-Auto/dsh-ecosystem-spec' },
  { key: 'community-standard', owner: 'oh-my-dsh', repo: 'dsh-community-standard', label: '标准 oh-my-dsh/dsh-community-standard' },
  { key: 'plugin-upgrade-skill', owner: 'oh-my-dsh', repo: 'dsh-plugin-upgrade-skill', label: '升级技能 oh-my-dsh/dsh-plugin-upgrade-skill' },
]
// 在 bundles 但不在 dependencies 的包（实体副本读版本）
const EXTRA_BUNDLES = ['@wxg-prc-cpg/browser-skill-dsh-plugin']

function parseArgs(argv) {
  const args = { remote: true, json: undefined, quiet: false }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--no-remote') args.remote = false
    else if (a === '--quiet') args.quiet = true
    else if (a === '--json' && argv[i + 1]) args.json = argv[i + 1]
    else if (a === '--help' || a === '-h') {
      console.log('DSH 生态体检脚本。用法：node dsh-upgrade-watch.mjs [--no-remote] [--json <path>] [--quiet]')
      process.exit(0)
    }
  }
  return args
}

async function fetchJson(url, { github = false } = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const headers = { 'user-agent': UA }
    if (github) headers.accept = 'application/vnd.github+json'
    const res = await fetch(url, { signal: ctrl.signal, headers })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/** npm registry latest version for a package name (scoped names URL-encoded).
 *  Returns the version string, or '404' when the package is not published to npm. */
async function npmLatest(name) {
  const encoded = name.startsWith('@') ? name.replace('/', '%2F') : name
  try {
    const doc = await fetchJson(`https://registry.npmjs.org/${encoded}/latest`)
    return doc.version
  } catch (e) {
    if (String(e.message).includes('HTTP 404')) return '404'
    throw e
  }
}

/** 解析 semver → { nums:[a,b,c], pre:[…标识符] }。 */
function parseSemver(v) {
  const s = String(v ?? '').replace(/^v/, '')
  const plus = s.indexOf('+')
  const noBuild = plus >= 0 ? s.slice(0, plus) : s
  const dash = noBuild.indexOf('-')
  const core = dash >= 0 ? noBuild.slice(0, dash) : noBuild
  const pre = dash >= 0 ? noBuild.slice(dash + 1).split('.').filter(Boolean) : []
  return { nums: core.split('.').map((x) => Number.parseInt(x, 10) || 0), pre }
}

/**
 * prerelease 感知的版本比较（v1.1 修正，见升级方案 §9 V6）。
 * 旧版只比前 3 段数字 → `0.1.5-alpha.2` 与 `0.1.5-rc.1` 被判相等，全 prerelease 生态下失真。
 * 现按 semver 规则：数字段逐位比 → 有预发布段者更小 → 预发布段逐标识符比
 * （数字段按数值且小于字母段；字母段按字典序，恰好使 alpha < beta < rc）。
 */
export function semverCompare(a, b) {
  const A = parseSemver(a)
  const B = parseSemver(b)
  for (let i = 0; i < 3; i++) {
    const x = A.nums[i] ?? 0
    const y = B.nums[i] ?? 0
    if (x > y) return 1
    if (x < y) return -1
  }
  if (!A.pre.length && !B.pre.length) return 0
  if (!A.pre.length) return 1   // 正式版 > 预发布版
  if (!B.pre.length) return -1
  const n = Math.max(A.pre.length, B.pre.length)
  for (let i = 0; i < n; i++) {
    const x = A.pre[i]
    const y = B.pre[i]
    if (x === undefined) return -1
    if (y === undefined) return 1
    const xn = /^\d+$/.test(x)
    const yn = /^\d+$/.test(y)
    if (xn && yn) {
      const xi = Number(x)
      const yi = Number(y)
      if (xi !== yi) return xi > yi ? 1 : -1
    } else if (xn) return -1
    else if (yn) return 1
    else if (x !== y) return x > y ? 1 : -1
  }
  return 0
}

function flagOf(local, latest) {
  if (latest === undefined) return 'UNREACH'
  if (latest === null) return '未知'
  if (latest === '404') return 'npm未发布'
  const cmp = semverCompare(local, latest)
  if (cmp < 0) return '可升级'
  if (cmp > 0) return '超前(本地>远端)'
  return '最新'
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function main() {
  const args = parseArgs(process.argv)
  const home = process.env.USERPROFILE || process.env.HOME || ''
  const profilePkgPath = path.join(home, '.dsh', 'profiles', 'web', 'package.json')
  const mainPkgGlob = path.join(process.env.APPDATA || home, 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'package.json')

  let profilePkg
  try {
    profilePkg = JSON.parse(readFileSync(profilePkgPath, 'utf8'))
  } catch (e) {
    console.error(`[基线缺失] 读不到 web profile: ${profilePkgPath} (${e.message})`)
    process.exit(3)
  }
  let mainVersion = 'unknown'
  try {
    mainVersion = JSON.parse(readFileSync(mainPkgGlob, 'utf8')).version
  } catch {
    /* 主包路径找不到时保持 unknown */
  }

  const deps = profilePkg.dependencies ?? {}
  const lines = []
  const jsonResult = {
    generatedAt: new Date().toISOString(),
    mainPackage: { name: '@deepseek-ai/dsh', local: mainVersion },
    lineA: {},
    lineB: [],
  }

  lines.push('='.repeat(72))
  lines.push(`DSH 生态体检报告  ${new Date().toLocaleString('zh-CN', { hour12: false })}`)
  lines.push('='.repeat(72))
  lines.push(`主包 @deepseek-ai/dsh  本地: ${mainVersion}`)
  lines.push(`web profile: ${profilePkgPath}`)
  lines.push('')

  // ---------- A 线：Adapter / 标准研发进度 ----------
  lines.push('【A 线 · Adapter/标准研发进度】')
  if (!args.remote) {
    lines.push('（--no-remote：跳过远端检查）')
  } else {
    for (const repo of GITHUB_REPOS) {
      try {
        const releases = await fetchJson(
          `https://api.github.com/repos/${repo.owner}/${repo.repo}/releases?per_page=3`,
          { github: true },
        )
        const commits = await fetchJson(
          `https://api.github.com/repos/${repo.owner}/${repo.repo}/commits?per_page=1`,
          { github: true },
        )
        const rel = Array.isArray(releases) && releases.length > 0 ? releases[0] : undefined
        const tag = rel?.tag_name ?? '（无 release）'
        const relAt = rel?.published_at ?? ''
        const commitAt =
          Array.isArray(commits) && commits[0]?.commit?.committer?.date
            ? commits[0].commit.committer.date
            : '?'
        const latestStable =
          Array.isArray(releases) && releases.some((x) => !x.prerelease)
            ? releases.filter((x) => !x.prerelease).map((x) => x.tag_name).join(', ')
            : '（全 prerelease）'
        lines.push(`- ${repo.label}`)
        lines.push(`    最新 release : ${tag}${relAt ? `  (${relAt.slice(0, 10)})` : ''}`)
        lines.push(`    最新稳定    : ${latestStable}`)
        lines.push(`    最近提交    : ${commitAt.slice(0, 10)}`)
        jsonResult.lineA[repo.key] = {
          url: `https://github.com/${repo.owner}/${repo.repo}`,
          latestTag: tag,
          latestStable: latestStable === '（全 prerelease）' ? null : latestStable,
          lastCommitAt: commitAt,
        }
      } catch (e) {
        lines.push(`- ${repo.label}  → UNREACH (${e.message})`)
        jsonResult.lineA[repo.key] = {
          url: `https://github.com/${repo.owner}/${repo.repo}`,
          unreachable: String(e.message),
        }
      }
      await sleep(250)
    }
  }
  lines.push('')

  // ---------- B 线：本地插件 x npm 最新 ----------
  lines.push('【B 线 · 本地插件版本体检】')
  const npmTargets = []
  /**
   * 本地实体版本（v1.1 新增，见升级方案 §1.4）：
   * profile 的 **声明值**会与实体漂移（实测 imagegen 声明 1.2.2 / 实体 1.4.0），
   * 只读声明会把"已升过的"报成可升级 → 一律优先读实体，读不到才回落声明。
   */
  const entityVersion = (name) => {
    try {
      return JSON.parse(
        readFileSync(
          path.join(home, '.dsh', 'profiles', 'web', 'node_modules', ...name.split('/'), 'package.json'),
          'utf8',
        ),
      ).version
    } catch {
      return null
    }
  }
  for (const [name, ver] of Object.entries(deps)) {
    if (typeof ver === 'string' && ver.startsWith('link:')) {
      lines.push(`- ${name}: 本地 link → ${path.basename(ver.slice(5).replace(/\\/g, '/'))}（本地魔改/内部包，不查远端）`)
      continue
    }
    const declared = String(ver).replace(/^[\^~]/, '')
    const entity = entityVersion(name)
    npmTargets.push({
      name,
      local: entity ?? declared,
      declared,
      source: entity ? 'entity' : 'declared',
    })
  }
  for (const name of EXTRA_BUNDLES) {
    if (!(name in deps)) {
      const entity = entityVersion(name)
      npmTargets.push({ name, local: entity ?? 'unknown', declared: null, source: entity ? 'entity' : 'missing' })
    }
  }

  if (!args.remote) {
    for (const t of npmTargets) lines.push(`- ${t.name}: 本地 ${t.local}（--no-remote，跳过比对）`)
  } else {
    for (const t of npmTargets) {
      let latest
      try {
        latest = await npmLatest(t.name)
      } catch {
        latest = undefined
      }
      const flag = flagOf(t.local, latest)
      const noteParts = []
      if (t.local === 'unknown') noteParts.push('实体版本未知')
      if (t.source === 'declared') noteParts.push('实体缺失，取声明值')
      if (t.source === 'entity' && t.declared && t.declared !== t.local) noteParts.push(`漂移：声明 ${t.declared} ≠ 实体`)
      // ⚠️ flag 实际值是 '超前(本地>远端)'（见 flagOf）—— 与字面量 '超前' 比较永不命中，
      //    曾导致该备注静默丢失（2026-09-10 B0 验收实测：ui-jobs 行缺此备注）→ 改前缀匹配。
      if (flag.startsWith('超前') && t.name.startsWith('@deepseek-ai/')) noteParts.push('官方配套包，以主包线为准')
      if (flag === 'npm未发布') noteParts.push('npm 未发布（可能 GitHub 直装/私有分发）')
      const note = noteParts.length > 0 ? `（${noteParts.join('；')}）` : ''
      lines.push(`- ${t.name}: 本地 ${t.local} → npm ${latest === '404' ? 'N/A' : (latest ?? 'UNREACH')}  [${flag}]${note}`)
      jsonResult.lineB.push({
        name: t.name,
        local: t.local,
        declared: t.declared,
        source: t.source,
        latest: latest === '404' ? null : (latest ?? null),
        flag,
      })
      await sleep(120)
    }
  }
  lines.push('')

  // ---------- 汇总 ----------
  if (args.remote) {
    const upgradable = jsonResult.lineB.filter((x) => x.flag === '可升级')
    lines.push(`小结：B 线可升级 ${upgradable.length} 个：${upgradable.map((x) => x.name).join('、') || '（无）'}`)
    const unreach = [
      ...Object.values(jsonResult.lineA).filter((x) => x.unreachable),
      ...jsonResult.lineB.filter((x) => x.flag === 'UNREACH'),
    ]
    if (unreach.length > 0) {
      lines.push(`⚠️ ${unreach.length} 个远端源未取到（可能需代理或限流）。`)
      lines.push('   处理：先跑 tools\\dsh-proxy.ps1 ensure 保证代理端口出网，再重跑本脚本。')
    }
  }
  lines.push('='.repeat(72))

  const out = args.quiet
    ? lines.filter((l) => l.startsWith('小结') || l.startsWith('⚠️')).join('\n')
    : lines.join('\n')
  console.log(out)
  if (args.json) {
    writeFileSync(args.json, JSON.stringify(jsonResult, null, 2), 'utf8')
    console.log(`[json] 已写 ${args.json}`)
  }
  process.exit(0)
}

if (isMainEntry()) {
  await main()
}
