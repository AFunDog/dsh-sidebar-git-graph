/**
 * dsh-sidebar-git-graph 宿主半的「定位工作区」与「信任围栏」两件事。
 *
 * 定位优先级（越靠前越可信）：
 *   1. 宿主自己的会话记录 `ctx.get('sessions').get(id).header.cwd`（服务在就直接用）；
 *   2. 持久化工作区表 `~/.dsh/storages/workspace.json` 里该 sessionId 所属工作区；
 *   3. `ctx.get('workspaceRegistry').list()` 里的工作区路径（按 sessionId 命中优先）；
 *   4. 兜底：扫 `~/.dsh/sessions/` 找最近写入的会话所在目录。
 *
 * 客户端传来的 `cwd` 不可信，只有在它能被上面的结果背书（同一个路径，或落在某个
 * 已注册工作区之内）时才采用——见 index.js 的 chooseCandidate。
 *
 * 第 2、4 条读的是 DSH 自己的落盘布局（`storages/workspace.json` 的 `tables.workspaces`、
 * `sessions/<编码路径>/<会话id>/`），属于**未公开的实现细节**：它们只是服务缺失时的兜底，
 * 前两条（服务）才是正路。DSH 改了这套布局也不会让插件失效——最差是退回"没有候选"分支。
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'

/**
 * DSH 家目录：ctx 提供的 `dshHomePath` 优先，其次环境变量，最后用户目录。
 * @param ctx - 宿主 cordis 上下文。
 * @returns 绝对路径。
 */
export function dshHomeDir(ctx) {
  const provided = ctx.get('dshHomePath')
  if (typeof provided === 'function') {
    try {
      const value = provided()
      if (typeof value === 'string' && value !== '') return value
    } catch (error) { /* 走兜底 */ }
  }
  return process.env.DSH_HOME
    || join(process.env.USERPROFILE || process.env.HOME || 'C:/', '.dsh')
}

/**
 * 会话目录名 → 工作区绝对路径（与 DSH 的编码互逆：去 `--`、补盘符冒号、`-` 变 `\`）。
 * @param name - `~/.dsh/sessions/` 下的一级目录名。
 * @returns 绝对路径。
 */
export function decodeSessionDir(name) {
  let text = name
  if (text.startsWith('--')) text = text.slice(2)
  if (text.endsWith('--')) text = text.slice(0, -2)
  if (/^[A-Za-z]-/.test(text)) text = text[0] + ':' + text.slice(1)
  return text.replace(/-/g, '\\')
}

/**
 * 读持久化工作区表。
 * @param dshHome - DSH 家目录。
 * @returns `{ 路径, sessionIds }` 数组；缺失或损坏时为空数组。
 */
export function workspaceRecords(dshHome) {
  try {
    const store = JSON.parse(readFileSync(join(dshHome, 'storages', 'workspace.json'), 'utf8'))
    const workspaces = store !== null && store.tables !== undefined ? store.tables.workspaces : undefined
    if (workspaces === undefined || workspaces === null) return []
    const out = []
    for (const key of Object.keys(workspaces)) {
      const record = workspaces[key]
      if (record === null || typeof record !== 'object') continue
      if (typeof record.path !== 'string' || record.path === '') continue
      out.push({
        id: key,
        path: record.path,
        sessionIds: Array.isArray(record.sessionIds) ? record.sessionIds : [],
      })
    }
    return out
  } catch (error) { return [] }
}

/**
 * 扫 `sessions/` 找最近写入的会话所在工作区（最后兜底）。
 * @param dshHome - DSH 家目录。
 * @returns 仍存在的绝对路径，或 null。
 */
export function newestSessionWorkspace(dshHome) {
  const sessionsRoot = join(dshHome, 'sessions')
  let dirs = []
  try { dirs = readdirSync(sessionsRoot, { withFileTypes: true }) } catch (error) { return null }
  let best = null
  for (const entry of dirs) {
    if (!entry.isDirectory()) continue
    const workspaceDir = join(sessionsRoot, entry.name)
    let sessionDirs = []
    try { sessionDirs = readdirSync(workspaceDir, { withFileTypes: true }) } catch (error) { continue }
    for (const session of sessionDirs) {
      if (!session.isDirectory()) continue
      const sessionDir = join(workspaceDir, session.name)
      let files = []
      try { files = readdirSync(sessionDir) } catch (error) { continue }
      let newest = -1
      for (const file of files) {
        try {
          const stat = statSync(join(sessionDir, file))
          if (stat.mtimeMs > newest) newest = stat.mtimeMs
        } catch (error) { /* 跳过不可读文件 */ }
      }
      if (newest < 0) continue
      if (best === null || newest > best.mtime) {
        best = { path: decodeSessionDir(entry.name), mtime: newest }
      }
    }
  }
  if (best === null) return null
  try { return existsSync(best.path) ? best.path : null } catch (error) { return null }
}

/**
 * realpath（失败就退回 resolve），用于工作区包含判定。
 * @param path - 任意路径。
 * @returns 规范化后的绝对路径或 null。
 */
export function canonical(path) {
  if (typeof path !== 'string' || path === '') return null
  try { return realpathSync.native(path) } catch (error) { /* 可能不存在 */ }
  try { return resolve(path) } catch (error) { return null }
}

/**
 * 判断 child 是否落在 parent 之内（含相等）。
 * @param child - 候选路径（绝对）。
 * @param parent - 容器路径（绝对）。
 * @returns 是否包含。
 */
export function isInside(child, parent) {
  const a = canonical(child)
  const b = canonical(parent)
  if (a === null || b === null) return false
  if (a === b) return true
  const rel = relative(b, a)
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(`..${sep}`) && !rel.includes(`:${sep}`)
}

/**
 * 按可信度列出「这个会话可能的工作目录」。
 * @param ctx - 宿主 cordis 上下文。
 * @param dshHome - DSH 家目录。
 * @param sessionId - 会话 id，可为空。
 * @returns `{ path, source }` 数组，已去重。
 */
export function resolutionCandidates(ctx, dshHome, sessionId) {
  const out = []
  const seen = new Set()
  const push = (path, source) => {
    if (typeof path !== 'string' || path === '') return
    const key = canonical(path)
    if (key === null || seen.has(key)) return
    seen.add(key)
    out.push({ path, source })
  }

  if (typeof sessionId === 'string' && sessionId !== '') {
    const sessions = ctx.get('sessions')
    if (sessions !== undefined && sessions !== null && typeof sessions.get === 'function') {
      try { push(sessions.get(sessionId)?.header?.cwd, 'session') } catch (error) { /* 服务形态不同就跳过 */ }
    }
    for (const record of workspaceRecords(dshHome)) {
      if (record.sessionIds.includes(sessionId)) {
        push(record.path, 'storage')
        break
      }
    }
  }

  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
    try {
      for (const workspace of registry.list()) {
        const path = workspace !== null && typeof workspace === 'object' ? workspace.path : undefined
        push(path, 'registry')
      }
    } catch (error) { /* 忽略 */ }
  }

  if (out.length === 0) {
    for (const record of workspaceRecords(dshHome)) push(record.path, 'storage-any')
    push(newestSessionWorkspace(dshHome), 'newest')
  }
  return out
}

/**
 * 判断路径是否被「已注册的工作区」背书（用于给客户端传来的 cwd 放行）。
 * @param ctx - 宿主 cordis 上下文。
 * @param dshHome - DSH 家目录。
 * @param candidate - 客户端传来的路径。
 * @returns 是否被背书。
 */
export function isBackedByWorkspace(ctx, dshHome, candidate) {
  const registry = ctx.get('workspaceRegistry')
  if (registry !== undefined && registry !== null && typeof registry.list === 'function') {
    try {
      for (const workspace of registry.list()) {
        const path = workspace !== null && typeof workspace === 'object' ? workspace.path : undefined
        if (isInside(candidate, path)) return true
      }
    } catch (error) { /* 落到存储表白名单 */ }
  }
  for (const record of workspaceRecords(dshHome)) {
    if (isInside(candidate, record.path)) return true
  }
  return false
}

/**
 * 浏览器同源信任围栏。
 *
 * 带 `sec-fetch-site` 的现代浏览器是主判据；缺它时退回 `Origin` 与 `Host` 比对。
 * 两个头都没有的请求（curl / 脚本）放行——真正的边界是「只能查已注册工作区」，
 * 而不是「只有浏览器能问」（见 index.js 的 chooseCandidate）。
 * @param req - node http 请求。
 * @returns 是否可信。
 */
export function isTrustedRequest(req) {
  const headers = req !== null && req !== undefined && req.headers !== undefined ? req.headers : {}
  const site = headers['sec-fetch-site']
  if (typeof site === 'string' && site !== '') {
    return site === 'same-origin' || site === 'same-site' || site === 'none'
  }
  const origin = headers.origin
  if (typeof origin === 'string' && origin !== '') {
    try {
      return new URL(origin).host === headers.host
    } catch (error) { return false }
  }
  return true
}
