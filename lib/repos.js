/**
 * dsh-sidebar-git-graph 宿主半的「一个工作区里有几个仓库」发现器。
 *
 * 为什么需要它：一个工作区经常同时躺着好几个 git 仓库——本仓库就是，
 * `profiles/web/vendor/@zeng/dsh-sidebar-git-graph/` 下挂着一个独立的自研插件仓库。
 * 图谱页必须能选「画哪一个」，所以得先把它们列出来。
 *
 * 为什么只能扫盘：嵌套的独立仓库在父仓库眼里就只是几个被忽略的目录，git 自己**没有**
 * 列它们的命令（`git submodule` 看不到非 submodule 的嵌套仓库，`git status` 也看不见）。
 * VS Code 的做法同样是扫工作区目录，所以这里也扫。
 *
 * 四条自我约束（少一条就可能把磁盘扫穿）：
 *   1. **四道闸门**——层数、目录数、仓库数、耗时；任何一条踩到就停下并把 `truncated`
 *      标成 true。宁可给一份不完整的清单，也不能让一次 HTTP 请求变成一次全盘遍历。
 *   2. **跳过显然不含仓库的目录**（`node_modules` / `target` / `.venv` …）。注意
 *      **不跳 `vendor`**：那恰恰是本仓库嵌套仓库所在的位置。
 *   3. **跳过的目录仍做一次廉价探测**：只 `stat` 它的 `.git`，命中就照样列出来。这样
 *      「恰好有个叫 build 的仓库」不会因为黑名单而凭空消失，而代价只有一次 stat。
 *   4. **不跟随符号链接**：`readdir` 的 Dirent 用 lstat 语义，指向目录的链接
 *      `isDirectory()` 为 false，因此既不会绕圈，也不会顺着 pnpm 的链接跑进 store。
 *
 * 这一层只依赖 `node:fs/promises` 与 `node:path`（不碰 ctx / 网络），因此测试可以直接
 * 在临时目录上跑真正的扫描。
 */
import { promises as fsp } from 'node:fs'
import { basename, join, relative } from 'node:path'

/** 默认向下扫几层（够到本仓库的嵌套仓库需要 5 层）。 */
export const DEFAULT_DEPTH = 5
/** 层数硬上限。 */
export const MAX_DEPTH = 8
/** 最多列出的仓库数。 */
export const MAX_REPOS = 100
/** 最多访问的目录数。 */
export const MAX_DIRS = 20000
/** 扫描耗时预算（毫秒）。 */
export const TIME_BUDGET_MS = 4000
/** 一批并发处理的目录数。 */
const CONCURRENCY = 32

/**
 * 不向下递归的目录名。判据是「里面几乎不可能有值得单独画的仓库」，
 * 不是为了省事——每一条都要能说出理由，否则会悄悄漏掉真实仓库。
 */
const SKIP_DIRS = new Set([
  // 包管理的产物：里面是别人仓库的副本，列出来只会淹没用户自己的仓库。
  'node_modules', 'bower_components', '.pnpm-store', '.yarn', '.pnp',
  // 版本控制元数据。
  '.git', '.hg', '.svn', '.bzr',
  // 构建/覆盖产物。
  'dist', 'build', 'out', 'target', 'coverage', 'obj', 'bin', '.next', '.nuxt',
  '.turbo', '.parcel-cache', '.svelte-kit', '.output', '.vercel', '.netlify',
  // 语言级虚拟环境与缓存。
  '.venv', 'venv', '__pycache__', '.tox', '.mypy_cache', '.pytest_cache',
  '.gradle', '.dart_tool', 'Pods', 'DerivedData', '.terraform',
  // 编辑器/工具缓存。
  '.cache', '.idea', '.vs', '.vscode-test',
])

/**
 * 读一个目录；失败（权限、竞态删除）不算错，当作空目录。
 * @param dir - 目录绝对路径。
 * @returns `{ entries }`，读不到时 entries 为 null。
 */
async function readEntries(dir) {
  try {
    return await fsp.readdir(dir, { withFileTypes: true })
  } catch (error) {
    return null
  }
}

/**
 * 廉价探测：这个目录自己是不是仓库根（只看 `.git` 在不在，不递归）。
 * @param dir - 目录绝对路径。
 * @returns 是否存在 `.git`（目录或文件——worktree/submodule 用的是文件）。
 */
async function hasGitEntry(dir) {
  try {
    await fsp.stat(join(dir, '.git'))
    return true
  } catch (error) {
    return false
  }
}

/**
 * 扫一个工作区，列出里面的 git 仓库根。
 *
 * 返回顺序稳定（工作区根在前，其余按相对路径字典序），这样前端下拉框的次序不会
 * 因为文件系统的枚举顺序而抖动。
 * @param rootDir - 工作区绝对路径。
 * @param options - `{ maxDepth }`（0 表示不扫，直接返回空表）。
 * @returns `{ repos, truncated, scanned }`；`repos` 项为 `{ root, name, rel, depth }`。
 */
export async function discoverRepos(rootDir, options) {
  const settings = options === undefined || options === null ? {} : options
  const requested = Number.isFinite(settings.maxDepth) ? Math.trunc(settings.maxDepth) : DEFAULT_DEPTH
  const maxDepth = Math.min(MAX_DEPTH, Math.max(0, requested))
  const started = Date.now()
  const found = []
  const truncated = { repos: false, dirs: false, time: false }
  let dirsVisited = 0

  if (maxDepth === 0) {
    // 关掉扫描：只认工作区根自己（父级仓库由 index.js 用 rev-parse 单独补）。
    if (await hasGitEntry(rootDir)) found.push({ dir: rootDir, depth: 0 })
    return finish(found, rootDir, truncated, { dirs: 0, ms: Date.now() - started })
  }

  let queue = [{ dir: rootDir, depth: 0 }]
  // 所有 push 都走它：批次是按目录并发处理的，一个批次里可能一次冒出好几个仓库，
  // 只在循环顶端查上限会冲过头（实测：130 个仓库的目录一趟冲到 128 条）。
  const add = (dir, depth) => {
    if (found.length >= MAX_REPOS) { truncated.repos = true; return false }
    found.push({ dir, depth })
    return true
  }

  while (queue.length > 0) {
    if (found.length >= MAX_REPOS) { truncated.repos = true; break }
    if (dirsVisited >= MAX_DIRS) { truncated.dirs = true; break }
    if (Date.now() - started > TIME_BUDGET_MS) { truncated.time = true; break }

    const batch = queue.splice(0, CONCURRENCY)
    const read = await Promise.all(batch.map((item) => readEntries(item.dir)))
    const probes = []

    for (let index = 0; index < batch.length; index += 1) {
      const item = batch[index]
      const entries = read[index]
      dirsVisited += 1
      if (entries === null) continue
      let isRepo = false
      for (const entry of entries) {
        if (entry.name === '.git') { isRepo = true; continue }
        // 链接的 isDirectory() 为 false，天然被挡在外面（见文件头第 4 条）。
        if (!entry.isDirectory()) continue
        const child = join(item.dir, entry.name)
        if (SKIP_DIRS.has(entry.name)) { probes.push(child); continue }
        if (item.depth < maxDepth) queue.push({ dir: child, depth: item.depth + 1 })
      }
      if (isRepo && !add(item.dir, item.depth)) break
    }

    // 被跳过的目录只做一次 stat：命中就说明它自己是个仓库，照样列出来。
    if (probes.length > 0) {
      const hits = await Promise.all(probes.map((dir) => hasGitEntry(dir)))
      for (let index = 0; index < probes.length; index += 1) {
        if (hits[index] && !add(probes[index], -1)) break
      }
    }
  }

  return finish(found, rootDir, truncated, { dirs: dirsVisited, ms: Date.now() - started })
}

/**
 * 排序 + 归一化成对外的形状。
 * @param found - `{ dir, depth }` 数组。
 * @param rootDir - 工作区绝对路径。
 * @param truncated - 截断标记。
 * @param scanned - `{ dirs, ms }`。
 * @returns 对外结果。
 */
function finish(found, rootDir, truncated, scanned) {
  const seen = new Set()
  const repos = []
  for (const item of found) {
    const rel = relative(rootDir, item.dir)
    // 用相对路径当去重键：同一个仓库不可能被两条路径发现两次。
    if (seen.has(rel)) continue
    seen.add(rel)
    repos.push({
      root: item.dir,
      name: basename(item.dir),
      rel,
      depth: item.depth,
      outside: false,
    })
  }
  repos.sort((left, right) => {
    if (left.rel === right.rel) return 0
    if (left.rel === '') return -1
    if (right.rel === '') return 1
    return left.rel < right.rel ? -1 : 1
  })
  const wasTruncated = truncated.repos || truncated.dirs || truncated.time
  return {
    repos,
    truncated: wasTruncated,
    truncatedBy: wasTruncated ? Object.keys(truncated).filter((key) => truncated[key]) : [],
    scanned,
  }
}
