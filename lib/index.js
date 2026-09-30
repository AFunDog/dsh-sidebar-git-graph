/**
 * dsh-sidebar-git-graph — 宿主半：把「当前会话工作区」的 git 提交图以只读路由交给浏览器。
 *
 * 这个插件只做三件事，全部只读：
 *   1. 定位工作目录（可信度顺序见 lib/workspace.js），并挑出要画的那个仓库——工作区里
 *      可能有多个（见 lib/repos.js），客户端可以点名，非 git 仓库 / 没装 git 时回明确
 *      错误码而不是抛错（前端按码给文案）；
 *   2. 跑 4 条**只读** git 命令（rev-parse / status / for-each-ref / log --topo-order），
 *      一律：净化环境、无 shell 插值、超时 10s、输出上限 48 MiB、不写仓库；
 *   3. 挂 `POST /dsh-sidebar-git-graph/api`：请求 `{ type:'client-request', rpcId, method, payload }`，
 *      响应 `{ type:'server-response', rpcId, result:{ ok, value } }` 或 `result:{ ok:false, error }`。
 *
 * 明确不做任何写操作：不 checkout、不 commit、不 fetch/push、不 reset——要写就用别的工具。
 *
 * 为什么用 node:child_process 而不是 ctx.subprocess：后者要求部署侧挂了 subprocess 提供方，
 * 缺了本插件的 fiber 就会一直挂起（服务缺席比功能缺席更难排查）。execFile 的 timeout /
 * maxBuffer 语义直接可用，环境净化自己来做（只透传 PATH 一类），因此本插件对部署零额外要求。
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { basename, join, relative } from 'node:path'
import {
  buildSnapshot,
  logArgv,
  parseLog,
  parseRefs,
  parseStatus,
  refsArgv,
  revParseArgv,
  statusArgv,
} from './git-read.js'
import {
  MAX_DIFF_BYTES,
  buildChangeSections,
  changesStatusArgv,
  diffArgv,
  isRepoRelativePath,
  numstatArgv,
  parseNumstat,
  parsePatch,
  parseStatusV2,
  summarizeRows,
} from './changes.js'
import {
  DEFAULT_DEPTH as DEFAULT_SCAN_DEPTH,
  MAX_DEPTH as MAX_SCAN_DEPTH,
  discoverRepos,
} from './repos.js'
import {
  canonical,
  dshHomeDir,
  isBackedByWorkspace,
  isInside,
  isTrustedRequest,
  resolutionCandidates,
} from './workspace.js'

export const name = 'dsh-sidebar-git-graph'
export const inject = ['webServer']

/** 路由前缀（method 走 payload，不用子路径）。 */
const ROUTE = '/dsh-sidebar-git-graph/api'
/** 单次请求默认/最大提交条数。 */
const DEFAULT_MAX = 400
const HARD_MAX = 2000
/** 单条 git 命令的预算。 */
const TIMEOUT_MS = 10000
const MAX_BUFFER = 48 * 1024 * 1024
/** 请求体上限（只含 sessionId/cwd/几个数字）。 */
const MAX_BODY = 64 * 1024

/** `git --version` 只问一次。 */
let gitVersionPromise = null

/**
 * 给 git 的环境：只透传运行必需的变量，其余（含一切 API key）一律不进去。
 * @returns 子进程环境。
 */
function gitEnv() {
  const passthrough = ['PATH', 'Path', 'SystemRoot', 'windir', 'PATHEXT', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'ComSpec']
  const env = {}
  for (const key of passthrough) {
    const value = process.env[key]
    if (typeof value === 'string' && value !== '') env[key] = value
  }
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_OPTIONAL_LOCKS = '0'
  env.GIT_PAGER = 'cat'
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.LC_ALL = 'C'
  return env
}

/**
 * 跑一条 git 命令。**永不 reject**：失败也返回事实，由调用方决定错误码。
 * @param argv - 完整参数数组（必须已含 -C）。
 * @param options - cwd（子进程工作目录，可为空）。
 * @returns `{ ok, stdout, stderr, code }`；code 为 'ENOENT' 表示找不到 git。
 */
function runGit(argv, options) {
  const settings = options === undefined || options === null ? {} : options
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    try {
      execFile('git', argv, {
        cwd: typeof settings.cwd === 'string' && settings.cwd !== '' ? settings.cwd : undefined,
        timeout: TIMEOUT_MS,
        maxBuffer: MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
        env: gitEnv(),
      }, (error, stdout, stderr) => {
        if (error === null || error === undefined) {
          finish({ ok: true, stdout: stdout === undefined ? '' : stdout, stderr: stderr === undefined ? '' : stderr })
          return
        }
        const code = typeof error.code === 'string' ? error.code : (typeof error.code === 'number' ? String(error.code) : undefined)
        finish({
          ok: false,
          stdout: typeof stdout === 'string' ? stdout : '',
          stderr: typeof stderr === 'string' ? stderr : '',
          code,
          message: typeof error.message === 'string' ? error.message : 'git failed',
        })
      })
    } catch (error) {
      finish({ ok: false, stdout: '', stderr: '', code: 'SPAWN', message: String(error) })
    }
  })
}

/**
 * git 版本（失败返回 undefined；结果进程内缓存）。
 * @returns 版本字符串。
 */
async function gitVersion() {
  if (gitVersionPromise === null) {
    gitVersionPromise = runGit(['--version'], {}).then((result) => {
      const match = /(\d+\.\d+(?:\.\d+)?)/.exec(result.stdout)
      return result.ok && match !== null ? match[1] : undefined
    })
  }
  return gitVersionPromise
}

/** 取文本首行（用于 rev-parse 的输出）。 */
function firstLine(text) {
  return String(text === undefined || text === null ? '' : text).split(/\r?\n/)[0].trim()
}

/** 错误事实里的 stderr 尾巴（给前端一行提示用，不泄漏整段输出）。 */
function stderrTail(result) {
  const text = String(result.stderr === undefined || result.stderr === null ? '' : result.stderr).trim()
  if (text === '') return undefined
  const line = text.split(/\r?\n/).filter((entry) => entry.trim() !== '').slice(-1)[0]
  return line === undefined ? undefined : line.slice(0, 300)
}

/** 构造失败结果。 */
function fail(code, message, extra) {
  return { ok: false, error: { code, message, ...(extra === undefined ? {} : extra) } }
}

/** 把外部输入钳到安全范围。 */
function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10)
  if (!Number.isFinite(parsed)) return fallback
  const rounded = Math.trunc(parsed)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/**
 * 选一个工作目录：宿主解析出的候选优先，客户端传来的 cwd 只有在被背书时才采用。
 * @param ctx - 宿主上下文。
 * @param dshHome - DSH 家目录。
 * @param payload - 请求 payload。
 * @returns `{ cwd, source }` 或 null。
 */
function chooseCandidate(ctx, dshHome, payload) {
  const sessionId = typeof payload.sessionId === 'string' && payload.sessionId !== '' ? payload.sessionId : undefined
  const candidates = resolutionCandidates(ctx, dshHome, sessionId)
  const allowed = new Set()
  for (const candidate of candidates) {
    const key = canonical(candidate.path)
    if (key !== null) allowed.add(key)
  }
  const claimed = typeof payload.cwd === 'string' && payload.cwd !== '' ? payload.cwd : undefined
  if (claimed !== undefined) {
    const key = canonical(claimed)
    if (key !== null && (allowed.has(key) || isBackedByWorkspace(ctx, dshHome, claimed))) {
      return { cwd: claimed, source: 'claimed' }
    }
    // 没有任何宿主候选时（本机没登记工作区）给客户端路径一个机会：能 rev-parse 出来就用。
    if (candidates.length === 0) return { cwd: claimed, source: 'claimed-unfenced' }
  }
  if (candidates.length === 0) return null
  return { cwd: candidates[0].path, source: candidates[0].source }
}

/**
 * 仓库清单缓存：一次刷新要扫一遍目录树，而「刷新」按钮、切作用域、切分支都会触发
 * 请求。同一工作区 8 秒内复用同一份清单，用户感知不到，磁盘也少挨几遍。
 */
const SCAN_TTL_MS = 8000
const scanCache = new Map()

/**
 * 带缓存的仓库扫描。
 * @param workspaceCwd - 工作区绝对路径（已规范化）。
 * @param maxDepth - 扫描层数。
 * @returns `{ repos, truncated, truncatedBy, scanned }`。
 */
async function scanWorkspace(workspaceCwd, maxDepth) {
  const key = `${workspaceCwd}\u0000${maxDepth}`
  const now = Date.now()
  const cached = scanCache.get(key)
  if (cached !== undefined && now - cached.at < SCAN_TTL_MS) return cached.value
  const value = await discoverRepos(workspaceCwd, { maxDepth })
  if (scanCache.size > 64) scanCache.clear()
  scanCache.set(key, { at: now, value })
  return value
}

/**
 * 问 git：这个目录落在哪个仓库里。
 * @param dir - 目录绝对路径（必须已存在，否则 execFile 的 ENOENT 会与「没装 git」混淆）。
 * @returns `{ ok:true, root }` 或 `{ ok:false, code, detail }`（code 为 'ENOENT' 表示 git 缺席）。
 */
async function repoRootOf(dir) {
  const result = await runGit(revParseArgv(dir), { cwd: dir })
  if (!result.ok) {
    return {
      ok: false,
      code: result.code === 'ENOENT' ? 'ENOENT' : 'not-a-repo',
      detail: stderrTail(result),
    }
  }
  const root = firstLine(result.stdout)
  if (root === '') return { ok: false, code: 'not-a-repo', detail: undefined }
  return { ok: true, root: canonical(root) ?? root }
}

/**
 * 客户端点名仓库时的围栏：只允许「工作区自身 / 工作区里的子目录 / 工作区的祖先」。
 *
 * 允许祖先是因为工作区常常只是某个仓库的一个子目录（工作区 = `repo/profiles/web`）。
 * 除此之外一律不放行——否则这个路由就成了「读盘上任意仓库」的接口。注意这只是
 * 第一道闸；第二道是下面用 `rev-parse` 确认它**真的是个仓库根**。
 * @param workspaceCwd - 工作区绝对路径（已规范化）。
 * @param candidate - 客户端传来的仓库路径。
 * @returns 是否允许。
 */
function repoRelationAllowed(workspaceCwd, candidate) {
  const a = canonical(candidate)
  const b = canonical(workspaceCwd)
  if (a === null || b === null) return false
  if (a === b) return true
  return isInside(a, b) || isInside(b, a)
}

/**
 * 合成给前端的仓库清单：工作区所属仓库（可能在工作区**之外**，即工作区只是仓库的一个
 * 子目录）+ 扫描到的仓库 + 当前选中的那个（保证它在列表里，下拉框才对得上）。
 * @param input - `{ workspaceCwd, cwdRoot, scanned, selected }`。
 * @returns `{ root, name, rel, depth, outside, current }` 数组。
 */
function buildRepoList(input) {
  const out = []
  const seen = new Set()
  const push = (root, depth, outside) => {
    const key = canonical(root) ?? root
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      root: key,
      name: basename(key),
      rel: relative(input.workspaceCwd, key),
      depth,
      outside,
      current: input.selected !== null && key === (canonical(input.selected) ?? input.selected),
    })
  }

  if (input.cwdRoot !== null) push(input.cwdRoot, 0, !isInside(input.cwdRoot, input.workspaceCwd))
  for (const repo of input.scanned.repos) push(repo.root, repo.depth, false)
  if (input.selected !== null) push(input.selected, 0, !isInside(input.selected, input.workspaceCwd))
  return out
}

/**
 * 解析出「这次请求要画哪个仓库」，以及沿途的事实。
 *
 * 抽出来是因为 graph / changes / diff 三个 method 的挑选与围栏**必须完全一致**——
 * 三者各写一遍迟早会漂移，而漂移的那一份就是围栏上的洞。
 * @param ctx - 宿主上下文。
 * @param payload - 请求 payload（含可选的 `repo` 点名与 `scanDepth`）。
 * @returns `{ ok:true, root, source, requested, workspaceCwd, chosen, cwdRepo, scanned }`
 *   或 `{ ok:false, error }`。
 */
async function resolveRepo(ctx, payload) {
  const dshHome = dshHomeDir(ctx)
  const chosen = chooseCandidate(ctx, dshHome, payload)
  if (chosen === null) {
    return fail('no-workspace', '拿不到工作目录：会话没有记录 cwd，也没有已注册的工作区')
  }
  // 先确认目录真的存在：execFile 在 cwd 不存在时也报 ENOENT，那会被下面的分支误判成
  // "PATH 里没有 git"——一个把用户引向错误方向的诊断（实测踩过）。
  if (!existsSync(chosen.cwd)) {
    return fail('no-workspace', `工作目录不存在：${chosen.cwd}`)
  }
  const workspaceCwd = canonical(chosen.cwd) ?? chosen.cwd

  // ── 挑仓库 ───────────────────────────────────────────────────────────────
  const cwdRepo = await repoRootOf(workspaceCwd)
  if (cwdRepo.ok === false && cwdRepo.code === 'ENOENT') {
    return fail('no-git', '在 PATH 里找不到 git 可执行文件')
  }
  const scanned = await scanWorkspace(workspaceCwd, clampInt(payload.scanDepth, 0, MAX_SCAN_DEPTH, DEFAULT_SCAN_DEPTH))

  const requested = typeof payload.repo === 'string' && payload.repo !== '' ? payload.repo : null
  let root = null
  let source = null
  if (requested !== null) {
    // 两道闸都过了才认：路径关系合法，且 git 确认它自己就是仓库根（不是仓库里的子目录）。
    if (repoRelationAllowed(workspaceCwd, requested) && existsSync(requested)) {
      const check = await repoRootOf(requested)
      const claimed = canonical(requested) ?? requested
      if (check.ok === true && check.root === claimed) {
        root = claimed
        source = 'requested'
      }
    }
  }
  if (root === null && cwdRepo.ok === true) { root = cwdRepo.root; source = 'cwd' }
  if (root === null && scanned.repos.length > 0) {
    root = canonical(scanned.repos[0].root) ?? scanned.repos[0].root
    source = 'scan'
  }
  if (root === null) {
    return fail(
      'not-a-repo',
      `工作区里没有 git 仓库：${workspaceCwd}`,
      cwdRepo.detail === undefined ? {} : { detail: cwdRepo.detail },
    )
  }
  return { ok: true, root, source, requested, workspaceCwd, chosen, cwdRepo, scanned }
}

/**
 * 组装一次图谱查询。
 * @param ctx - 宿主上下文。
 * @param payload - 请求 payload（含可选的 `repo` 点名与 `scanDepth`）。
 * @returns `{ ok:true, value }` 或 `{ ok:false, error }`。
 */
async function handleGraph(ctx, payload) {
  const resolved = await resolveRepo(ctx, payload)
  if (resolved.ok === false) return { ok: false, error: resolved.error }
  const { root, source, requested, workspaceCwd, chosen, cwdRepo, scanned } = resolved

  const max = clampInt(payload.max, 1, HARD_MAX, DEFAULT_MAX)
  const skip = clampInt(payload.skip, 0, 1000000, 0)
  const scope = payload.scope === 'current' ? 'current' : 'all'

  const [statusResult, refsResult, logResult] = await Promise.all([
    runGit(statusArgv(root), { cwd: root }),
    runGit(refsArgv(root), { cwd: root }),
    runGit(logArgv(root, { max, skip, scope }), { cwd: root }),
  ])
  if (!logResult.ok) {
    return fail('git-failed', 'git log 失败', { detail: stderrTail(logResult) })
  }

  const commits = parseLog(logResult.stdout)
  const refs = refsResult.ok ? parseRefs(refsResult.stdout) : []
  const status = statusResult.ok
    ? parseStatus(statusResult.stdout)
    : { branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0, detached: false, initial: false }

  const value = buildSnapshot({
    root,
    name: basename(root),
    status,
    refs,
    commits,
    max,
    skip,
    gitVersion: await gitVersion(),
    now: Math.floor(Date.now() / 1000),
  })
  value.workspace = { cwd: chosen.cwd, source: chosen.source }
  value.repos = buildRepoList({
    workspaceCwd,
    cwdRoot: cwdRepo.ok === true ? cwdRepo.root : null,
    scanned,
    selected: root,
  })
  value.selection = {
    requested,
    source,
    // 点名了但没认（仓库被删了 / 换机器了 / 路径出围栏了）→ 前端提示一句，别让人以为选错了没反应。
    fallback: requested !== null && source !== 'requested',
  }
  value.reposTruncated = scanned.truncated
  value.reposTruncatedBy = scanned.truncatedBy
  return { ok: true, value }
}

/**
 * 组装一次「工作树改动」查询：三段清单（冲突 / 更改 / 暂存的更改）+ 每段汇总。
 *
 * 三条只读命令，**不做每文件一条**：两条 numstat 覆盖全部已跟踪文件的 +/− 计数。
 * 未跟踪文件没有计数（见 changes.js 的 numstatArgv 注释）。
 * @param ctx - 宿主上下文。
 * @param payload - 请求 payload。
 * @returns `{ ok:true, value }` 或 `{ ok:false, error }`。
 */
async function handleChanges(ctx, payload) {
  const resolved = await resolveRepo(ctx, payload)
  if (resolved.ok === false) return { ok: false, error: resolved.error }
  const { root, workspaceCwd, chosen, cwdRepo, scanned } = resolved

  const [statusResult, stagedCounts, unstagedCounts] = await Promise.all([
    runGit(changesStatusArgv(root), { cwd: root }),
    runGit(numstatArgv(root, 'staged'), { cwd: root }),
    runGit(numstatArgv(root, 'unstaged'), { cwd: root }),
  ])
  if (!statusResult.ok) {
    return fail('git-failed', 'git status 失败', { detail: stderrTail(statusResult) })
  }

  const parsed = parseStatusV2(statusResult.stdout)
  const sections = buildChangeSections(parsed, {
    staged: stagedCounts.ok ? parseNumstat(stagedCounts.stdout) : new Map(),
    unstaged: unstagedCounts.ok ? parseNumstat(unstagedCounts.stdout) : new Map(),
  })

  return {
    ok: true,
    value: {
      state: 'ready',
      repo: {
        root,
        name: basename(root),
        branch: parsed.branch,
        detached: parsed.detached,
        initial: parsed.initial,
        upstream: parsed.upstream,
        ahead: parsed.ahead,
        behind: parsed.behind,
      },
      sections,
      totals: {
        conflicts: summarizeRows(sections.conflicts),
        unstaged: summarizeRows(sections.unstaged),
        staged: summarizeRows(sections.staged),
      },
      truncated: parsed.truncated,
      // 计数命令失败时不是「没有改动」，而是「不知道」——如实带出去，页面才好说话。
      countsAvailable: stagedCounts.ok && unstagedCounts.ok,
      workspace: { cwd: chosen.cwd, source: chosen.source },
      repos: buildRepoList({
        workspaceCwd,
        cwdRoot: cwdRepo.ok === true ? cwdRepo.root : null,
        scanned,
        selected: root,
      }),
      gitVersion: await gitVersion(),
      generatedAt: Math.floor(Date.now() / 1000),
    },
  }
}

/**
 * 取一个文件的 patch 并解析成结构化行。
 * @param ctx - 宿主上下文。
 * @param payload - `{ section, path, origPath, untracked, repo, cwd, sessionId, scanDepth }`。
 * @returns `{ ok:true, value }` 或 `{ ok:false, error }`。
 */
async function handleDiff(ctx, payload) {
  const rawPath = typeof payload.path === 'string' ? payload.path : ''
  // 路径围栏在**跑 git 之前**：非法路径连仓库都不用解析，直接回。
  if (!isRepoRelativePath(rawPath)) {
    return fail('bad-path', '路径不合法（只接受仓库根相对路径）')
  }
  const rawOrig = typeof payload.origPath === 'string' && payload.origPath !== '' ? payload.origPath : ''
  if (rawOrig !== '' && !isRepoRelativePath(rawOrig)) {
    return fail('bad-path', '原路径不合法（只接受仓库根相对路径）')
  }

  const resolved = await resolveRepo(ctx, payload)
  if (resolved.ok === false) return { ok: false, error: resolved.error }
  const { root } = resolved

  const section = payload.section === 'staged' ? 'staged' : 'unstaged'
  const untracked = payload.untracked === true
  const unmerged = payload.unmerged === true
  // 未跟踪文件只可能出现在「更改」段；反过来说「暂存的未跟踪文件」是自相矛盾的请求。
  if (untracked && section === 'staged') {
    return fail('bad-request', '未跟踪的文件不会有暂存改动')
  }
  if (untracked && unmerged) {
    return fail('bad-request', '未跟踪与未合并不可能同时成立')
  }
  const base = { path: rawPath, section, origPath: rawOrig === '' ? undefined : rawOrig }

  const result = await runGit(diffArgv(root, {
    section,
    path: rawPath,
    origPath: rawOrig,
    untracked,
    unmerged,
  }), { cwd: root })

  // `--no-index` 在「有差异」时返回 1 且 stdout 是完整 patch、stderr 为空。
  // 不特判的表现是「未跟踪文件永远打不开 diff」，而且没有任何错误信息可查（实测）。
  const noIndexDiff = untracked && result.ok === false && result.code === '1'
  if (!result.ok && !noIndexDiff) {
    return fail('git-failed', 'git diff 失败', { detail: stderrTail(result) })
  }

  const patch = parsePatch(result.stdout)
  if (patch.binary) return { ok: true, value: { ...base, kind: 'binary' } }
  // combined diff 正常不该走到这里（unmerged 会改走 `diff HEAD`）。真走到了就如实说，
  // 而不是把空数组当成"没有改动"发出去。
  if (patch.combined) return { ok: true, value: { ...base, kind: 'combined' } }

  // 超长 patch 在**字节**上截断，并且只按整行切，免得把一行劈成两半。
  const bytes = Buffer.byteLength(result.stdout, 'utf8')
  let lines = patch.lines
  let truncated = false
  if (bytes > MAX_DIFF_BYTES) {
    truncated = true
    let budget = MAX_DIFF_BYTES
    const kept = []
    for (const line of lines) {
      budget -= Buffer.byteLength(line.text, 'utf8') + 1
      if (budget < 0) break
      kept.push(line)
    }
    lines = kept
  }

  return {
    ok: true,
    value: {
      ...base,
      kind: 'text',
      lines,
      truncated,
      bytes,
      // 有 patch 文本却一条都没解析出来（工具重写过 patch 才会）→ 让页面说实话。
      unparsed: patch.empty,
    },
  }
}

/** 发一个 JSON 响应。 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(text)
}

/** 读请求体（有上限）。 */
async function readBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY) throw new Error('request body too large')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/**
 * 路由处理器。
 * @param ctx - 宿主上下文。
 * @param req - node http 请求。
 * @param res - node http 响应。
 */
async function handleRoute(ctx, req, res) {
  let rpcId = 'unknown'
  try {
    if (req.method !== 'POST') {
      sendJson(res, 405, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'method', message: 'POST only' } } })
      return
    }
    if (!isTrustedRequest(req)) {
      sendJson(res, 403, { type: 'server-response', rpcId, result: { ok: false, error: { code: 'forbidden', message: 'cross-origin request refused' } } })
      return
    }
    const raw = await readBody(req)
    let payload = {}
    // 客户端一直在信封里发 `method`，宿主侧此前忽略它（只服务 graph）。现在接上：
    // 未知 method 明确回错，而不是当成 graph 静默跑一遍 log（那会让人以为"改了没生效"）。
    let method = 'graph'
    try {
      const body = raw !== '' ? JSON.parse(raw) : {}
      if (body !== null && typeof body === 'object') {
        if (typeof body.rpcId === 'string') rpcId = body.rpcId
        if (typeof body.method === 'string' && body.method !== '') method = body.method
        if (body.payload !== null && typeof body.payload === 'object') payload = body.payload
      }
    } catch (error) { /* 解析失败也照常回包 */ }

    let outcome
    if (method === 'graph') outcome = await handleGraph(ctx, payload)
    else if (method === 'changes') outcome = await handleChanges(ctx, payload)
    else if (method === 'diff') outcome = await handleDiff(ctx, payload)
    else outcome = fail('bad-method', `未知的 method：${method}`)

    if (outcome.ok) {
      sendJson(res, 200, { type: 'server-response', rpcId, result: { ok: true, value: outcome.value } })
      return
    }
    sendJson(res, 200, { type: 'server-response', rpcId, result: { ok: false, error: outcome.error } })
  } catch (error) {
    try {
      sendJson(res, 200, {
        type: 'server-response',
        rpcId,
        result: { ok: false, error: { code: 'internal', message: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) } },
      })
    } catch (nested) { /* 响应已经发出去或断开了 */ }
  }
}

/** 供测试直接调用的入口：测试用假 ctx + %TEMP% 里的真仓库跑，不启动 DSH。 */
export const internals = {
  buildRepoList,
  chooseCandidate,
  handleChanges,
  handleDiff,
  handleGraph,
  handleRoute,
  repoRelationAllowed,
  repoRootOf,
  resolveRepo,
  runGit,
  scanWorkspace,
  gitEnv,
}

export function apply(ctx) {
  const webServer = ctx.get('webServer')
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') {
    ctx.logger.warn('dsh-sidebar-git-graph: webServer unavailable, /dsh-sidebar-git-graph/api not served')
    return
  }
  const route = {
    kind: 'prefix',
    path: ROUTE,
    handler: (req, res) => {
      // handler 里任何抛出都会变成宿主侧未处理错误：在这里兜住，绝不让它冒出去。
      handleRoute(ctx, req, res).catch((error) => {
        ctx.logger.warn(`dsh-sidebar-git-graph: request failed: ${String(error)}`)
      })
    },
  }
  ctx.effect(() => webServer.register(route), 'dsh-sidebar-git-graph: /dsh-sidebar-git-graph/api route')
  ctx.logger.info(`dsh-sidebar-git-graph: serving the read-only git graph at ${ROUTE} (home=${join(dshHomeDir(ctx), '')})`)
}
