/**
 * dsh-sidebar-git-graph 宿主半的「关联工作树」纯函数层：argv 构造 + 输出解析。
 *
 * 与 lib/git-read.js / lib/changes.js 同层：零依赖（不碰 fs / 网络 / ctx），
 * Node 测试可以直接 import，真正的进程执行与路由在 lib/index.js。
 *
 * **本文件只构造只读命令**：`worktree list` 一种。永不出现 `worktree add` / `remove` /
 * `prune` / `lock` / `move`——本插件承诺只读，这条不变量由 test/worktrees.test.cjs 钉死。
 *
 * ## 为什么需要它
 *
 * 一个仓库可以有**多个工作树**（`git worktree add`）：主工作树之外，每一个关联工作树都是
 * 一个独立的目录、独立的分支、独立的未提交改动。它们在**目录上可以毫无关系**——
 * 实测 `D:\GitRepository\Live2DUnityUpdate` 与 `D:\GitRepository\Live2DUnityUpdate-type-slimming`
 * 是兄弟目录，后者只是 `.git` **文件**里写着 `gitdir: …/.git/worktrees/…`。
 *
 * 所以只按文件系统扫盘永远发现不了它们（`lib/repos.js` 的「`.git` 在不在」判据覆盖不到
 * 目录之外的兄弟），而 git 自己有一份权威清单——本模块就是那份清单的读法。
 *
 * ## 字节契约（2026-09-30 在本机 git 2.49.0.windows.1 上逐字节实测）
 *
 * `git worktree list --porcelain -z`：
 *
 *   - **记录之间是 NUL NUL**（两个 NUL），记录内部的字段用**单个 NUL** 分隔；
 *   - **不引号转义**：含空格的路径原样输出（实测 `with space` 正常）；
 *   - 路径是**绝对路径、正斜杠**形态（Windows 上也是 `C:/…`）→ 调用方必须过 `canonical()`；
 *   - 从**任意一个**工作树发起都返回**全集**（实测主工作树与外挂工作树发起结果一致）。
 *
 * 逐字节样本：
 *
 *   "worktree <路径>\0HEAD <sha>\0branch refs/heads/main\0\0
 *    worktree <路径>\0HEAD <sha>\0detached\0\0
 *    worktree <路径>\0HEAD <sha>\0branch refs/heads/b/gone\0prunable gitdir file points to non-existent location\0\0
 *    worktree <路径>\0HEAD <sha>\0branch refs/heads/b/z\0locked\0\0"
 *
 * 四种可选字段都实测过：`detached`（分离头，此时**没有** `branch` 行）、`locked`
 * （内容仍可正常读取，只是禁止 `worktree remove`）、`prunable <原因>`（目录已不在）、
 * `bare`（裸仓库，没有工作树可画）。
 */

/** 字段分隔符（NUL），与 git-read.js / changes.js 一致。 */
export const FIELD_SEP = '\u0000'

/**
 * 只读命令共用的顶层选项（与 git-read.js 的 SAFE_FLAGS 一致：只影响输出，不做写入）。
 */
const SAFE_FLAGS = [
  '-c', 'core.quotepath=false',
  '-c', 'i18n.logOutputEncoding=UTF-8',
  '--no-optional-locks',
]

/**
 * 列出这个仓库的全部工作树。
 *
 * `--porcelain -z` 是刻意的：porcelain 形态稳定、给机器读；`-z` 去掉引号转义，
 * 含空格/非 ASCII 的路径不需要解码（路径里不可能有 NUL）。
 *
 * **只读**：`worktree` 的写子命令（add / remove / prune / lock / move）一个都不出现在这里。
 * @param root - 仓库根（任意一个工作树的根都行，git 会给出全集）。
 * @returns git 参数数组。
 */
export function worktreeListArgv(root) {
  return ['-C', root, ...SAFE_FLAGS, 'worktree', 'list', '--porcelain', '-z']
}

/**
 * 把一个记录块摊成字段数组。
 *
 * `-z` 形态按 NUL 切；人类可读形态按行切（只在兜底路径用到——那种形态下 git 会给
 * 含特殊字符的路径加引号，所以按行切是安全的）。
 * @param record - 一条记录的原文。
 * @param zMode - 是否 `-z` 形态。
 * @returns 字段数组。
 */
function fieldsOf(record, zMode) {
  return zMode ? record.split(FIELD_SEP) : record.split(/\r?\n/)
}

/**
 * 解析一条记录。
 *
 * 容错优先：字段缺失一律跳过而不是抛错（与 parseLog 同一取向——少一个工作树好过整页报错），
 * 但**必须**有 `worktree <路径>` 那一行，否则这条记录不是工作树，直接丢掉。
 * @param fields - 字段数组。
 * @returns 归一化的工作树对象，或 null（这条记录不可用）。
 */
function parseRecord(fields) {
  let path
  let head
  let branch
  let detached = false
  let locked = false
  let prunable = false
  let prunableReason
  let bare = false

  for (const field of fields) {
    if (field === '' || field === undefined) continue
    if (field.startsWith('worktree ')) { path = field.slice('worktree '.length); continue }
    if (field.startsWith('HEAD ')) { head = field.slice('HEAD '.length).trim(); continue }
    if (field.startsWith('branch ')) { branch = field.slice('branch '.length).trim(); continue }
    if (field === 'detached') { detached = true; continue }
    if (field === 'bare') { bare = true; continue }
    if (field === 'locked') { locked = true; continue }
    // 两种可选字段都可能**带原因**：`locked <原因>` / `prunable <原因>`。
    // 只认等值形态会把带原因的条目漏掉——那正好是需要如实说出来的那一类。
    if (field.startsWith('locked ')) { locked = true; continue }
    if (field === 'prunable') { prunable = true; continue }
    if (field.startsWith('prunable ')) { prunable = true; prunableReason = field.slice('prunable '.length); continue }
    // 未知字段跳过（git 以后加字段不该让这里崩）。
  }

  if (typeof path !== 'string' || path === '') return null

  // `branch` 行给的是全名（`refs/heads/feat/x`），剥掉前缀才是给人看的名字。
  let name = null
  if (typeof branch === 'string' && branch !== '') {
    name = branch.startsWith('refs/heads/') ? branch.slice('refs/heads/'.length) : branch
    if (name === '') name = null
  }
  const oid = typeof head === 'string' && /^[0-9a-f]{4,64}$/i.test(head) ? head : null

  return {
    path,
    head: oid,
    branch: name,
    // 分离头时 git 不给 `branch` 行；显式标出来，别让人以为"分支字段丢了"。
    detached: detached || name === null,
    locked,
    prunable,
    prunableReason,
    bare,
  }
}

/**
 * 解析 `git worktree list --porcelain [-z]` 的输出。
 *
 * 同时接受 `-z` 与人类可读两种形态（后者仅供单测与兜底）：`-z` 形态按 **NUL NUL** 切记录，
 * 否则按空行切。
 * @param stdout - 命令标准输出。
 * @returns 工作树数组，保持 git 给的顺序（**主工作树永远排在第一个**，见 git 文档：
 *   "The main working tree is listed first, followed by each of the linked working trees"）。
 */
export function parseWorktrees(stdout) {
  const text = String(stdout === undefined || stdout === null ? '' : stdout)
  if (text === '') return []
  const zMode = text.includes(FIELD_SEP)

  const records = []
  if (zMode) {
    let start = 0
    for (let index = 0; index + 1 < text.length; index += 1) {
      if (text[index] === FIELD_SEP && text[index + 1] === FIELD_SEP) {
        records.push(text.slice(start, index))
        index += 1
        start = index + 1
      }
    }
    if (start < text.length) records.push(text.slice(start))
  } else {
    for (const block of text.split(/\r?\n\r?\n/)) records.push(block)
  }

  const out = []
  for (const record of records) {
    if (record === '') continue
    const entry = parseRecord(fieldsOf(record, zMode))
    if (entry !== null) out.push(entry)
  }
  return out
}

/**
 * 从解析结果里挑出「可以画、可以放行」的那些。
 *
 * 剔除两类：
 *   - `prunable`：目录已经不在（`git worktree prune` 之前它会一直留在清单里），画不了；
 *   - `bare`：裸仓库没有工作树。
 * `locked` **不剔除**：锁只禁止 `worktree remove`，内容读取完全正常（实测）。
 * @param entries - parseWorktrees 的结果。
 * @returns 可用的工作树数组。
 */
export function listableWorktrees(entries) {
  const list = Array.isArray(entries) ? entries : []
  return list.filter((entry) => entry !== null && entry !== undefined && entry.prunable !== true && entry.bare !== true)
}

/**
 * 规范化后的路径集合，给围栏做集合判据用。
 *
 * 路径必须过 `canonical()`：git 给的是正斜杠绝对路径，Windows 上还要统一大小写/短名，
 * 不规范化就会出现「同一个目录两种写法」→ 去重失效、围栏误拒（与 index.js 的
 * buildRepoList 同一取向）。
 * @param entries - 工作树数组（建议先过 listableWorktrees）。
 * @param canonicalFn - 规范化函数（由调用方注入，避免这一层依赖 fs）。
 * @returns Set<string>。
 */
export function worktreePathSet(entries, canonicalFn) {
  const set = new Set()
  const list = Array.isArray(entries) ? entries : []
  const normalize = typeof canonicalFn === 'function' ? canonicalFn : (value) => value
  for (const entry of list) {
    if (entry === null || entry === undefined) continue
    if (entry.prunable === true || entry.bare === true) continue
    const key = normalize(entry.path)
    if (typeof key === 'string' && key !== '') set.add(key)
  }
  return set
}
