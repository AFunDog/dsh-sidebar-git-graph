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
  listableWorktrees,
  parseWorktrees,
  worktreeListArgv,
  worktreePathSet,
} from './worktrees.js'
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
 *
 * **系统配置：两个变量都不能设。**（2026-09-30 在真机上实测出来的缺陷）
 *
 * 系统级 gitconfig 里有 `core.autocrlf=true`（Git for Windows 的默认安装配置）。
 * 工作区是 CRLF、索引是 LF 的仓库，一旦这项失效就**每一行都被算成改动**——
 * 实测 `docs/README.md` 从 `1 增 0 删` 变成 `88 增 87 删`，一个只加了一行的文件
 * 在页面上显示成整个文件重写。同一个仓库里另外四个文件因为索引里本来就是 CRLF
 * 恰好正常，所以「大部分行都对」极易让人放过它。
 *
 * 三条实测：
 *   - `GIT_CONFIG_NOSYSTEM=1` → 症状出现（`88 87`）；
 *   - `GIT_CONFIG_SYSTEM=''`（空串）→ **同样的症状**（`88 87`）；
 *   - 两个都不设 → 与用户自己的 git 一致（`1 0`）。
 * 所以正确的做法不是「重定向到系统配置」，而是**什么都不设**：让 git 按它自己的
 * 默认位置去找系统配置，那正是用户的 git 走的路。曾经想用 `git --exec-path` 推出
 * `etc/gitconfig` 再显式指定，结果 Git for Windows 的布局是
 * `<安装>/etc/gitconfig` 而 `--exec-path` 指向 `<安装>/mingw64/libexec/git-core`，
 * 推导落空返回空串 → 正好命中第二条，缺陷原样复现。**少做一件事就是对的。**
 *
 * 安全性不受影响：这里本身就把环境白名单化了（一切 API key 都进不去），
 * 而 `credential.helper` / `sshCommand` 这类外部命令在只读命令里根本用不到。
 * `stripExternalCommands` 另外移除 `filter.*` 与 `diff.*.textconv`，防止仓库配置执行外部程序。
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
  // 这里**故意不设** GIT_CONFIG_NOSYSTEM / GIT_CONFIG_SYSTEM，见函数头注释。
  env.LC_ALL = 'C'
  return env
}

/**
 * 按前缀移除配置项。
 *
 * 存在的意义只有一个：**只读插件不该因为仓库自己的配置就去执行外部程序**。
 * `filter.*.clean/smudge/process` 与 `diff.*.textconv` 都是 git 会拿文件内容去跑的命令，
 * 读取一个不受信任的仓库时它们是真实的攻击面。其余配置一律保留——多屏蔽一项就多一分
 * 与用户自己的 git 给出不同答案的风险（本轮已经因为屏蔽系统配置栽过一次，见 gitEnv）。
 *
 * 实现上按 `-c <key>=<value>` **成对**处理：只删键、把值留在原地会让它变成一个
 * 位置参数（例如 `git … status --porcelain` 变成 `git … --porcelain status`），
 * 那比不删还糟。同一对里的值可能**不含 `=`**（`-c foo` 在 git 里等于设 `foo` 为真），
 * 所以成对取值时不能要求值里有 `=`。
 * @param argv - 原始参数数组（形如 `['-C', root, ...SAFE_FLAGS, 'status', …]`）。
 * @returns 移除了外部命令配置的新数组。
 */
function stripExternalCommands(argv) {
  const list = Array.isArray(argv) ? argv : []
  const out = []
  let index = 0
  while (index < list.length) {
    const token = list[index]
    if (token !== '-c' || index + 1 >= list.length) {
      out.push(token)
      index += 1
      continue
    }
    const pair = list[index + 1]
    if (typeof pair === 'string' && /^(filter\.|diff\..*\.textconv)/i.test(pair.split('=')[0])) {
      // 整对丢掉。
      index += 2
      continue
    }
    out.push(token, pair)
    index += 2
  }
  return out
}

/**
 * 跑一条 git 命令。**永不 reject**：失败也返回事实，由调用方决定错误码。
 * @param argv - 完整参数数组（必须已含 -C）。
 * @param options - cwd（子进程工作目录，可为空）。
 * @returns `{ ok, stdout, stderr, code }`；code 为 'ENOENT' 表示找不到 git。
 */
function runGit(argv, options) {
  const settings = options === undefined || options === null ? {} : options
  const safeArgv = stripExternalCommands(argv)
  return new Promise((resolvePromise) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    try {
      execFile('git', safeArgv, {
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
 * 一个仓库的工作树清单（带缓存 + 并发去重）。
 *
 * 为什么要有它：**关联工作树在目录上可以与主工作区毫无关系**（实测是两个兄弟目录），
 * 所以按文件系统扫盘永远发现不了它们；而 `git worktree list` 是 git 自己给的权威清单。
 * 详见 lib/worktrees.js 的文件头。
 *
 * 缓存与去重都是必要的：页面一次刷新会并发发 `graph` 与 `changes` 两个请求，
 * 没有 in-flight 去重就会同时起两条一模一样的 git 进程。
 * @param root - 仓库根（任意一个工作树的根都行，git 会给出全集）。
 * @returns 工作树数组（**未**过滤 prunable，调用方按需过 listableWorktrees）。
 */
const worktreeCache = new Map()
async function listWorktrees(root) {
  const key = canonical(root) ?? root
  const now = Date.now()
  const cached = worktreeCache.get(key)
  if (cached !== undefined) {
    if (cached.pending !== undefined) return cached.pending
    if (now - cached.at < SCAN_TTL_MS) return cached.value
  }
  const pending = (async () => {
    const result = await runGit(worktreeListArgv(root), { cwd: root })
    // 命令失败一律当作「没有工作树」——那正是旧行为，不该让工作树这一个加分项
    // 把整个页面变成错误页（老 git 没有 --porcelain 时就是这个样子）。
    if (!result.ok) return []
    return parseWorktrees(result.stdout)
  })()
  if (worktreeCache.size > 64) worktreeCache.clear()
  worktreeCache.set(key, { at: now, pending })
  const value = await pending
  worktreeCache.set(key, { at: Date.now(), value })
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
 * 客户端点名仓库时的第一道闸：目录关系 或 **同一个仓库的另一个工作树**。
 *
 * 目录关系是三条（工作区自身 / 工作区里的子目录 / 工作区的祖先）——允许祖先是因为工作区
 * 常常只是某个仓库的一个子目录（工作区 = `repo/profiles/web`）。
 *
 * 第四条是本次新增的**关联工作树**：`git worktree add` 出来的工作树在目录上可以与主工作区
 * **毫无关系**（实测是两个兄弟目录），所以「包含关系」这条判据够不到它。判据改为
 * 「它出现在 git 自己给出的、本仓库的工作树清单里」——浏览器无法凭空造一个路径进去。
 *
 * 注意这只是第一道闸；第二道是下面用 `rev-parse` 确认它**真的是个仓库根**，
 * 第三道是它与清单里的路径**规范化后逐字相等**。
 * @param workspaceCwd - 工作区绝对路径（已规范化）。
 * @param candidate - 客户端传来的仓库路径。
 * @param worktreePaths - 本仓库的工作树路径集合（已规范化，已剔除 prunable/bare）。
 * @returns 是否允许。
 */
function repoRelationAllowed(workspaceCwd, candidate, worktreePaths) {
  const a = canonical(candidate)
  const b = canonical(workspaceCwd)
  if (a === null || b === null) return false
  if (a === b) return true
  if (isInside(a, b) || isInside(b, a)) return true
  return worktreePaths instanceof Set && worktreePaths.has(a)
}

/**
 * 合成给前端的仓库清单：**同一个仓库的各个工作树**（来自 git 的权威清单）+
 * 扫盘发现的独立仓库（工作区里的、以及工作区所属的那个可能在工作区**之外**的仓库）+
 * 当前选中的那个（保证它在列表里，下拉框才对得上）。
 *
 * 两级来源的语义不同，所以逐项标 `kind`：`worktree` = 同一个仓库的另一个工作树
 * （带各自的分支），`repo` = 目录里躺着的另一个仓库。它们此前长得一模一样，
 * 于是「工作区内部的关联工作树」被显示成一个无关仓库。
 * @param input - `{ workspaceCwd, cwdRoot, scanned, selected, worktrees }`。
 * @returns `{ root, name, rel, depth, outside, current, kind, … }` 数组。
 */
function buildRepoList(input) {
  const out = []
  const seen = new Set()
  const keyOf = (root) => canonical(root) ?? root
  const push = (root, depth, outside, extra) => {
    const key = keyOf(root)
    if (seen.has(key)) return
    seen.add(key)
    out.push({
      root: key,
      name: basename(key),
      rel: relative(input.workspaceCwd, key),
      depth,
      outside,
      current: input.selected !== null && key === keyOf(input.selected),
      ...(extra === undefined ? {} : extra),
    })
  }

  // ① 工作树清单优先：它信息更全（带分支/HEAD），去重时应当赢过扫盘那一份。
  //    git 保证主工作树排在第一个，所以 index 0 就是 main。
  const worktrees = Array.isArray(input.worktrees) ? input.worktrees : []
  for (let index = 0; index < worktrees.length; index += 1) {
    const entry = worktrees[index]
    const key = keyOf(entry.path)
    push(key, 0, !isInside(key, input.workspaceCwd), {
      kind: 'worktree',
      main: index === 0,
      branch: entry.branch ?? null,
      head: entry.head ?? null,
      detached: entry.detached === true,
      locked: entry.locked === true,
    })
  }

  // ② 工作区所属的仓库（可能在工作区**之外**，即工作区只是仓库的一个子目录）。
  if (input.cwdRoot !== null) push(input.cwdRoot, 0, !isInside(input.cwdRoot, input.workspaceCwd), { kind: 'repo' })
  // ③ 扫盘发现的独立仓库。
  for (const repo of input.scanned.repos) push(repo.root, repo.depth, false, { kind: 'repo' })
  // ④ 点名要的那个：保证它一定在列表里，否则下拉框的选中项对不上画的那个仓库。
  if (input.selected !== null) push(input.selected, 0, !isInside(input.selected, input.workspaceCwd), { kind: 'repo' })
  return out
}


/**
 * 解析出「这次请求要画哪个仓库」，以及沿途的事实。
 *
 * 抽出来是因为 graph / changes / diff 三个 method 的挑选与围栏**必须完全一致**——
 * 三者各写一遍迟早会漂移，而漂移的那一份就是围栏上的洞。
 * @param ctx - 宿主上下文。
 * @param payload - 请求 payload（含可选的 `repo` 点名与 `scanDepth`）。
 * @returns `{ ok:true, root, source, reason, requested, workspaceCwd, chosen, cwdRepo, scanned, worktrees }`
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

  // 工作区所属的那个仓库的工作树清单——围栏与仓库清单都要用，所以在这里取一次。
  //
  // **锚点只能用「宿主自己认定」的仓库，绝不能用客户端点名的那个路径**：`worktree list`
  // 对任何仓库都会至少列出它自己，拿被点名的路径去问，等于让申请者给自己签通行证——
  // 围栏会当场失效（route.test.cjs 的「工作区之外的仓库必须被拒」正是这么红的）。
  // 所以锚点只有两个合法来源：工作区**所在**的仓库（rev-parse 得到，工作区是它的子目录也算）。
  const requestedRaw = typeof payload.repo === 'string' && payload.repo !== '' ? payload.repo : null
  const anchorRoot = cwdRepo.ok === true ? cwdRepo.root : null
  const worktreesRaw = anchorRoot === null ? [] : await listWorktrees(anchorRoot)
  const worktrees = listableWorktrees(worktreesRaw)
  const worktreePaths = worktreePathSet(worktrees, canonical)
  // 锚点本身就是一次「这是本仓库」的证明：它必须出现在自己那份清单里（git 保证）。
  if (anchorRoot !== null) worktreePaths.add(canonical(anchorRoot) ?? anchorRoot)

  const scanned = await scanWorkspace(workspaceCwd, clampInt(payload.scanDepth, 0, MAX_SCAN_DEPTH, DEFAULT_SCAN_DEPTH))

  const requested = requestedRaw
  let root = null
  let source = null
  // 点名了但没认时给前端一个**准确的**理由：以前无论什么原因都说「仓库不在了」，
  // 而"路径出了围栏"与"目录真的没了"是两件完全不同的事。
  let reason = null
  if (requested !== null) {
    // 三道闸都过了才认：路径关系合法（或它是本仓库的另一个工作树）、目录存在、
    // 且 git 确认它自己就是仓库根（不是仓库里的子目录）。
    if (repoRelationAllowed(workspaceCwd, requested, worktreePaths) && existsSync(requested)) {
      const check = await repoRootOf(requested)
      const claimed = canonical(requested) ?? requested
      if (check.ok === true && check.root === claimed) {
        root = claimed
        source = 'requested'
      } else reason = 'not-root'
    } else if (!existsSync(requested)) {
      // 目录不在有两种：被删了，或它是个 prunable 的工作树（git 还记着它）。
      reason = worktreesRaw.some((entry) => entry.prunable === true && (canonical(entry.path) ?? entry.path) === (canonical(requested) ?? requested))
        ? 'prunable'
        : 'missing'
    } else reason = 'fenced'
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
  if (reason === null && requested !== null && source !== 'requested') reason = 'fenced'
  return { ok: true, root, source, reason, requested, workspaceCwd, chosen, cwdRepo, scanned, worktrees, worktreesRaw }
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
  const { root, source, reason, requested, workspaceCwd, chosen, cwdRepo, scanned, worktrees, worktreesRaw } = resolved

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
    worktrees,
  })
  value.selection = {
    requested,
    source,
    // 点名了但没认（仓库被删了 / 换机器了 / 路径出围栏了 / 它是个 prunable 工作树）→
    // 前端按 `reason` 说准确的话，别一律讲成"仓库不在了"。
    fallback: requested !== null && source !== 'requested',
    reason: requested !== null && source !== 'requested' ? reason : null,
  }
  value.worktrees = summarizeWorktrees(worktreesRaw, worktrees)
  value.reposTruncated = scanned.truncated
  value.reposTruncatedBy = scanned.truncatedBy
  return { ok: true, value }
}

/**
 * 工作树清单的对外摘要（如实说明，不藏）。
 *
 * `prunable` 与 `bare` 的条目**不列出**（一个目录已不在，一个是裸仓库），
 * 但它们的存在要能看见——否则「我有 3 个工作树，页面上只有 2 个」又是一句没说出口的话。
 * @param raw - parseWorktrees 的完整结果。
 * @param listed - listableWorktrees 过滤后、真正进了下拉的那些。
 * @returns `{ total, listed, prunable, bare }`。
 */
function summarizeWorktrees(raw, listed) {
  const all = Array.isArray(raw) ? raw : []
  return {
    total: all.length,
    listed: Array.isArray(listed) ? listed.length : 0,
    prunable: all.filter((entry) => entry.prunable === true).map((entry) => entry.path),
    bare: all.filter((entry) => entry.bare === true).map((entry) => entry.path),
  }
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
  const { root, workspaceCwd, chosen, cwdRepo, scanned, worktrees } = resolved

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
      // 仓库清单也带在这里：下拉框此前只挂在 graph 载荷上，graph 一失败（或它还没回来）
      // 下拉就整个消失——而改动区自己的请求明明也能给出同一份清单。
      repos: buildRepoList({
        workspaceCwd,
        cwdRoot: cwdRepo.ok === true ? cwdRepo.root : null,
        scanned,
        selected: root,
        worktrees,
      }),
      reposTruncated: scanned.truncated,
      reposTruncatedBy: scanned.truncatedBy,
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
  listWorktrees,
  repoRelationAllowed,
  repoRootOf,
  resolveRepo,
  runGit,
  scanWorkspace,
  summarizeWorktrees,
  gitEnv,
  stripExternalCommands,
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
