/**
 * dsh-sidebar-git-graph 宿主半的「一个提交改了哪些文件」纯函数层：argv 构造 + 输出解析。
 *
 * 与 lib/changes.js 同层：零依赖（不碰 fs / 网络 / ctx），Node 测试可以直接 import，
 * 真正的进程执行与路由在 lib/index.js。
 *
 * **本文件只构造只读命令**（`show`），永不出现 add / commit / checkout / restore /
 * worktree / fetch 之类。分隔符沿用 changes.js 的约定：`-z` 让 git 用 NUL 分隔，路径里就
 * 不可能有 NUL，因此含空格、含非 ASCII 的路径都不需要引号解码。
 *
 * ## 为什么必须带 `--first-parent`（2026-10-17 实测，两处都要）
 *
 * 合并提交上 `git show --name-status` 的**默认输出是空的**：git 对合并默认给 combined diff
 * （`--cc`），而「相对**所有**父提交都改了」的文件通常一个都没有。实测：
 *   - 干净合并（两侧各改不同文件）→ **空输出**；
 *   - 冲突后手工解决的合并 → `MM␀shared.txt␀`，**两字母状态**，与踩坑 #11 的 combined diff
 *     是同一类，统一格式的解析器读不懂。
 * 加上 `--first-parent` 之后两者都回到正常形态（`A␀side.txt␀` / `M␀shared.txt␀`），也正是
 * VS Code 的口径：合并提交与**第一父提交**比较。不加这一条的表现是把「这个合并改了 side.txt」
 * 说成「没改任何文件」——一个不报错的错答案。**单文件 patch 同理**（实测不带就空输出）。
 *
 * ## 为什么 sha 必须写在 `--` 之前（实测）
 *
 * `git show --format= -M -- renamed.txt <sha>` 输出**空**：`--` 之后的一切都是 pathspec，
 * 那条 sha 被当成路径去匹配了，于是"什么都没有"。把 sha 提到 `--` 之前就正常。这条同样不报错。
 */

import { FIELD_SEP, MAX_DIFF_BYTES, PATCH_FLAGS, SAFE_FLAGS, parseNumstat } from './changes.js'

export { FIELD_SEP, MAX_DIFF_BYTES }

/**
 * 一个提交最多列多少个文件。
 *
 * 初始提交在一棵大树上可以有上万个文件（实测本机某仓库首提交 3000+），侧栏不需要那么多；
 * 超过就截断并**如实上报**（`truncated` + 总数），绝不悄悄少列。
 */
export const MAX_FILES = 2000

/** 状态头：`A` / `M` / `D` / `T`，重命名与复制带相似度（`R073` / `C100`），合并的 combined 给两字母。 */
const STATUS_HEAD = /^([A-Z]{1,2})(\d{1,3})?$/

/**
 * 客户端传来的是不是一个**像 sha 的串**。
 *
 * 这是跑 git 之前的第一道闸，同时也是**注入闸**：只允许十六进制，`--upload-pack=…` 这类
 * 以 `-` 开头的"选项"根本进不来（实测 `git show --name-status --format= --weird` 会被 git
 * 当成未知选项报 128；我们不靠 git 报错，直接不让它进 argv）。
 * @param value - 待检字符串。
 * @returns 是否可用。
 */
export function isShaLike(value) {
  return typeof value === 'string' && /^[0-9a-f]{4,40}$/i.test(value)
}

/**
 * 列出某个提交改了哪些文件（状态 + 路径）。
 * @param root - 仓库根。
 * @param sha - 提交 sha（调用方已过 isShaLike）。
 * @returns git 参数数组。
 */
export function commitFilesArgv(root, sha) {
  return [
    '-C', root, ...SAFE_FLAGS,
    'show', sha, '--name-status', '-z', '-M', '--first-parent', '--format=',
  ]
}

/**
 * 某个提交的每文件 +/− 计数（`-` 表示二进制）。
 *
 * 与文件清单**分成两条命令**而不是合成一条：一条命令同时要 `--name-status` 与 `--numstat` 时，
 * 两段输出的先后与交织方式属于实现细节，靠它就是把解析器建在沙子上。两条只读命令并发跑，
 * 代价与 handleGraph 里的三连发同级。
 * @param root - 仓库根。
 * @param sha - 提交 sha。
 * @returns git 参数数组。
 */
export function commitNumstatArgv(root, sha) {
  return [
    '-C', root, ...SAFE_FLAGS,
    'show', sha, '--numstat', '-z', '-M', '--first-parent', '--format=',
  ]
}

/**
 * 提交内单个文件的 patch。
 *
 * 重命名必须把**新旧两个路径都给**（实测：只给新路径时输出退化成「new file mode + 整文件
 * 新增」——`a.txt→renamed.txt` 那条实测从 3 行改动变成整个文件算新增，与踩坑 #8 同一个坑）。
 * @param root - 仓库根。
 * @param options - `{ sha, path, origPath }`。
 * @returns git 参数数组。
 */
export function commitPatchArgv(root, options) {
  const settings = options === undefined || options === null ? {} : options
  const paths = typeof settings.origPath === 'string' && settings.origPath !== ''
    ? [settings.origPath, settings.path]
    : [settings.path]
  return [
    '-C', root, ...SAFE_FLAGS,
    // sha 在 `--` 之前：`--` 之后的一切都是 pathspec，sha 落到那边就什么都匹配不到（见文件头）。
    'show', settings.sha, '--first-parent', '--format=', '-M', ...PATCH_FLAGS,
    '--', ...paths,
  ]
}

/**
 * 解析 `show --name-status -z -M` 的输出。
 *
 * 实测的两条记录形状（NUL 写成 ␀）：
 *   `M␀a.txt␀`                —— 状态与路径各是一个 NUL 分隔字段；
 *   `R073␀a.txt␀renamed.txt␀` —— 重命名/复制**多一个字段**：原路径在前、新路径在后，
 *                                相似度直接粘在状态字母后面（不是单独字段）。
 * 认不出的记录**跳过**，绝不把状态字母当成文件名收下（那会凭空造出一个不存在的路径）。
 * @param stdout - git 的原始输出。
 * @returns `[{ status, score, path, origPath? }]`。
 */
export function parseNameStatus(stdout) {
  const parts = String(stdout === undefined || stdout === null ? '' : stdout).split(FIELD_SEP)
  const out = []
  for (let index = 0; index < parts.length; index += 1) {
    const raw = parts[index]
    if (raw === '') continue
    const head = STATUS_HEAD.exec(raw)
    if (head === null) continue
    const status = head[1]
    const score = head[2] === undefined ? null : Number.parseInt(head[2], 10)
    let origPath
    let path
    if (status.startsWith('R') || status.startsWith('C')) {
      index += 1
      origPath = parts[index] === undefined ? '' : parts[index]
      index += 1
      path = parts[index] === undefined ? '' : parts[index]
    } else {
      index += 1
      path = parts[index] === undefined ? '' : parts[index]
    }
    if (path === '') continue
    out.push({
      status,
      score,
      path,
      origPath: origPath === undefined || origPath === '' ? undefined : origPath,
    })
  }
  return out
}

/**
 * 把「状态清单」与「计数清单」并成页面要的行。
 *
 * 状态清单是**主表**（它才是"改了哪些文件"的权威），计数按**新路径**匹配（重命名后文件叫新名字）。
 * 计数缺失不算错误：`--numstat` 与 `--name-status` 之间理论上不该有差集，真有了也只是少几个
 * 数字，不该因此少列一行文件。
 * @param input - `{ nameStatus, numstat, limit }`。
 * @returns `{ files, truncated, totals }`；`totals.total` 是**未截断前**的条数。
 */
export function buildCommitFiles(input) {
  const settings = input === undefined || input === null ? {} : input
  const list = Array.isArray(settings.nameStatus) ? settings.nameStatus : []
  const counts = settings.numstat instanceof Map ? settings.numstat : new Map()
  const limit = Number.isInteger(settings.limit) && settings.limit > 0 ? settings.limit : MAX_FILES

  const files = []
  let truncated = false
  let added = 0
  let deleted = 0
  let counted = 0
  for (const entry of list) {
    if (files.length >= limit) {
      truncated = true
      break
    }
    const stat = counts.get(entry.path)
    const binary = stat !== undefined && stat.binary === true
    const rowsAdded = stat === undefined || binary || !Number.isFinite(stat.added) ? undefined : stat.added
    const rowsDeleted = stat === undefined || binary || !Number.isFinite(stat.deleted) ? undefined : stat.deleted
    if (Number.isFinite(rowsAdded) && Number.isFinite(rowsDeleted)) {
      added += rowsAdded
      deleted += rowsDeleted
      counted += 1
    }
    files.push({
      path: entry.path,
      origPath: entry.origPath,
      status: entry.status,
      score: entry.score,
      binary,
      added: rowsAdded,
      deleted: rowsDeleted,
    })
  }
  return {
    files,
    truncated,
    totals: { count: files.length, total: list.length, added, deleted, counted },
  }
}

/**
 * 计数清单的解析：**直接复用 changes.js 的 parseNumstat**。
 *
 * 不另写一份的理由：`--numstat -z` 的记录形状（`adds⇥dels⇥path␀`，重命名则是
 * `adds⇥dels⇥␀old␀new␀`）与工作树那两条命令**完全一样**，而那边已经处理过「路径里可能有
 * 制表符」「`-` 表示二进制」「重命名多两个字段」三件事。两份实现 = 两份迟早漂移的边界处理。
 * @param stdout - git 的原始输出。
 * @returns Map：新路径 → `{ added, deleted, binary, origPath }`。
 */
export function parseCommitNumstat(stdout) {
  return parseNumstat(stdout)
}

/**
 * 「按第一父提交比较」这句话要不要说给用户听。
 *
 * 合并提交（父数 ≥ 2）的文件清单与单亲提交**口径不同**：前者是"相对第一父提交的改动"，
 * 后者是"相对唯一父提交的改动"。不说清楚的话，用户在合并提交上看到 `side.txt` 会以为
 * 这个合并本身写了它。根提交（父数 0）不用解释——它本来就该列出全部文件。
 * @param parents - 该提交的父提交 sha 数组。
 * @returns 是否需要在界面上说明。
 */
export function needsFirstParentNotice(parents) {
  return Array.isArray(parents) && parents.length > 1
}
