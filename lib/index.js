/**
 * dsh-sidebar-git-graph — 宿主半：把「当前会话工作区」的 git 提交图以只读路由交给浏览器。
 *
 * 这个插件只做三件事，全部只读：
 *   1. 定位工作目录（可信度顺序见 lib/workspace.js），非 git 仓库 / 没装 git 时回明确错误码
 *      而不是抛错（前端按码给文案）；
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
import { basename, join } from 'node:path'
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
  canonical,
  dshHomeDir,
  isBackedByWorkspace,
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
 * 组装一次图谱查询。
 * @param ctx - 宿主上下文。
 * @param payload - 请求 payload。
 * @returns `{ ok:true, value }` 或 `{ ok:false, error }`。
 */
async function handleGraph(ctx, payload) {
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

  const revParse = await runGit(revParseArgv(chosen.cwd), { cwd: chosen.cwd })
  if (!revParse.ok) {
    if (revParse.code === 'ENOENT') return fail('no-git', '在 PATH 里找不到 git 可执行文件')
    return fail('not-a-repo', `不是 git 工作区：${chosen.cwd}`, { detail: stderrTail(revParse) })
  }
  const root = firstLine(revParse.stdout)
  if (root === '') return fail('not-a-repo', `git 没能给出仓库根：${chosen.cwd}`)

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
  return { ok: true, value }
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
    try {
      const body = raw !== '' ? JSON.parse(raw) : {}
      if (body !== null && typeof body === 'object') {
        if (typeof body.rpcId === 'string') rpcId = body.rpcId
        if (body.payload !== null && typeof body.payload === 'object') payload = body.payload
      }
    } catch (error) { /* 解析失败也照常回包 */ }

    const outcome = await handleGraph(ctx, payload)
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
export const internals = { chooseCandidate, handleGraph, handleRoute, runGit, gitEnv }

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
