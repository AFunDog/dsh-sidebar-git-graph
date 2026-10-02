/**
 * dsh-sidebar-git-graph 宿主半的纯函数层：git argv 构造 + 输出解析。
 *
 * 这一层**零依赖**（不碰 fs / 网络 / ctx），所以 Node 测试可以直接 import 它，
 * 也不读任何部署状态，因此可以脱离 DSH 直接跑。真正的进程执行与路由在 lib/index.js。
 *
 * 为什么用 %x00 / %x1e 做分隔符：git 的用户内容（作者名、subject）里可以有空格、
 * 逗号、竖线，但不能有 NUL；用可打印字符当分隔符一定会踩到真实仓库。记录分隔用
 * 0x1e（RS），字段分隔用 0x00（NUL）。
 */

/** 字段分隔符（NUL）。 */
export const FIELD_SEP = '\u0000'
/** 记录分隔符（RS）。 */
export const RECORD_SEP = '\u001e'

/** `git log` 的 format：sha / parents / author / email / unix 时间 / 装饰 / subject。 */
const LOG_FORMAT = `--pretty=format:%H%x00%P%x00%an%x00%ae%x00%at%x00%D%x00%s%x1e`

/** 所有命令共用的、只影响输出的配置覆盖（不做任何写入）。 */
const SAFE_FLAGS = ['-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=UTF-8', '--no-optional-locks']

/**
 * 定位仓库根与 git 目录。
 *
 * 三个路径一次问出来（三条输出行，顺序与参数一致）：
 *   - `--show-toplevel`    工作树根；
 *   - `--absolute-git-dir` 本工作树的 git 目录（关联工作树下是 `.git/worktrees/<名>`）；
 *   - `--git-common-dir`   **共享**的那个 git 目录（关联工作树下仍是主仓库的 `.git`）。
 *
 * ⚠️ `--git-common-dir` 的相对/绝对**取决于在哪个工作树里问**（2026-10-02 实测）：
 * 主工作树回 `.git`（相对），关联工作树回绝对路径。所以调用方必须用 `parseRepoPaths`
 * 归一化，不能假定它一定是绝对的。
 * @param cwd - 会话工作目录（任意层级的子目录都可以）。
 * @returns git 参数数组。
 */
export function revParseArgv(cwd) {
  return ['-C', cwd, 'rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']
}

/**
 * 解析 `revParseArgv` 的三行输出。
 *
 * `commonDir` 为相对路径时按 `cwd` 解析（相对的是**这条命令的 -C 目录**，实测如此）。
 * 只做字符串拼接，不碰 fs（本文件保持零依赖）。
 * @param stdout - 命令输出（3 行）。
 * @param cwd - 传给 `-C` 的目录，用于解析相对路径。
 * @returns `{ root, gitDir, commonDir }`；缺行时为 null。
 */
export function parseRepoPaths(stdout, cwd) {
  const lines = String(stdout === undefined || stdout === null ? '' : stdout)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '')
  if (lines.length < 3) return { root: lines[0] ?? null, gitDir: lines[1] ?? null, commonDir: null }
  const [root, gitDir, commonRaw] = lines
  return { root, gitDir, commonDir: resolveAgainst(cwd, commonRaw) }
}

/** 把可能是相对路径的 `target` 按 `base` 拼成绝对路径（只处理正/反斜杠两种分隔符）。 */
function resolveAgainst(base, target) {
  const text = String(target === undefined || target === null ? '' : target)
  if (text === '') return null
  if (/^[A-Za-z]:[\\/]/.test(text) || text.startsWith('/') || text.startsWith('\\\\')) return text
  const separator = String(base === undefined || base === null ? '' : base).includes('\\') ? '\\' : '/'
  return `${String(base).replace(/[\\/]+$/, '')}${separator}${text.replace(/^[\\/]+/, '')}`
}

/**
 * 头部状态：当前分支 / upstream / ahead / behind / 脏文件数。
 *
 * `--untracked-files=all` 是必须的：这是**改动区那两段用的是同一个文件集**。
 * 曾经这里是 `-u` 的 `no`（只算已跟踪），于是同一个页面上头部说「6 个改动」、
 * 下面的「更改」段说「7」——同一件事两个数，看图的人只会以为其中一个坏了
 * （2026-09-30 真机截图里就是这么并排显示的）。
 * 代价可忽略：图谱与改动区本来就是并发请求的，这里不新增串行步骤。
 * @param root - 仓库根。
 * @returns git 参数数组。
 */
export function statusArgv(root) {
  return ['-C', root, ...SAFE_FLAGS, 'status', '--porcelain=v1', '-b', '--untracked-files=all']
}

/**
 * 全部 refs（本地分支 / 远程分支 / 标签）。
 *
 * `%(*objectname)` 是**解引用**后的 sha：附注标签的对象是 tag 对象而非提交，
 * 用前者才能把标签挂到正确的提交上；轻量标签该字段为空，回退到 `%(objectname)`。
 *
 * 注意转义语法：`for-each-ref --format` 只认 `%00` 形式的十六进制字节，
 * 写成 `%x00`（`--pretty=format` 的写法）会原样输出这四个字符——实测踩过。
 * @param root - 仓库根。
 * @returns git 参数数组。
 */
export function refsArgv(root) {
  return [
    '-C', root,
    'for-each-ref',
    `--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream:short)%00%(HEAD)%00%(upstream:track)%00%(upstream:remotename)`,
    'refs/heads',
    'refs/remotes',
    'refs/tags',
  ]
}

/**
 * 提交 DAG。顺序由 git 的 `--topo-order` 保证：子提交永远排在父提交之前，
 * 这是泳道算法单趟扫描的前提。
 * @param root - 仓库根。
 * @param options - max 条数、skip 偏移、scope（all = 所有 refs / current = 仅 HEAD 历史）。
 * @returns git 参数数组。
 */
export function logArgv(root, options) {
  const max = options.max
  const skip = options.skip
  const selectors = options.scope === 'current' ? ['HEAD'] : ['--branches', '--tags', '--remotes']
  return [
    '-C', root,
    ...SAFE_FLAGS,
    'log',
    ...selectors,
    '--topo-order',
    '--parents',
    `--max-count=${max}`,
    `--skip=${skip}`,
    LOG_FORMAT,
  ]
}

/**
 * 解析 `%D` 装饰串（`HEAD -> main, origin/main, tag: v1.0`）。
 * @param text - 装饰串，可为空。
 * @returns HEAD 标记、分离头标记与 ref 名列表（不含 `HEAD -> ` / `tag: ` 前缀）。
 */
export function parseDecoration(text) {
  const out = { head: false, detached: false, refs: [] }
  for (const part of String(text === undefined || text === null ? '' : text).split(',')) {
    const name = part.trim()
    if (name === '') continue
    if (name.startsWith('HEAD -> ')) {
      out.head = true
      out.refs.push(name.slice('HEAD -> '.length).trim())
      continue
    }
    if (name === 'HEAD') {
      out.head = true
      out.detached = true
      continue
    }
    if (name.startsWith('tag: ')) {
      out.refs.push(name.slice('tag: '.length).trim())
      continue
    }
    out.refs.push(name)
  }
  return out
}

/**
 * 解析 `git log` 输出。
 *
 * 容错优先：字段数不足、时间非数字、空记录一律跳过而不是抛错——图少一行好过整页报错。
 * @param stdout - 命令标准输出。
 * @returns 提交数组（保持 git 给的顺序）。
 */
export function parseLog(stdout) {
  const commits = []
  for (const raw of String(stdout === undefined || stdout === null ? '' : stdout).split(RECORD_SEP)) {
    const chunk = raw.replace(/^[\r\n]+/, '')
    if (chunk === '') continue
    const fields = chunk.split(FIELD_SEP)
    if (fields.length < 7) continue
    const sha = fields[0].trim()
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) continue
    const parentsText = fields[1].trim()
    const seconds = Number.parseInt(fields[4], 10)
    const decoration = parseDecoration(fields[5])
    commits.push({
      sha,
      parents: parentsText === '' ? [] : parentsText.split(/\s+/),
      author: fields[2],
      email: fields[3],
      time: Number.isFinite(seconds) ? seconds : 0,
      // subject 里理论上不会有 NUL；真出现了也不要丢字段。
      subject: fields.slice(6).join(FIELD_SEP),
      head: decoration.head,
      detached: decoration.detached,
      decorationRefs: decoration.refs,
    })
  }
  return commits
}

/**
 * 解析 `for-each-ref` 输出。
 * @param stdout - 命令标准输出。
 * @returns ref 数组，按 git 给的顺序。
 */
export function parseRefs(stdout) {
  const refs = []
  for (const line of String(stdout === undefined || stdout === null ? '' : stdout).split('\n')) {
    const text = line.replace(/\r$/, '')
    if (text === '') continue
    const fields = text.split(FIELD_SEP)
    if (fields.length < 5) continue
    const refname = fields[0]
    const sha = fields[2] !== '' ? fields[2] : fields[1]
    if (!/^[0-9a-f]{4,64}$/i.test(sha)) continue
    const upstream = fields[3] !== '' ? fields[3] : undefined
    const isCurrent = fields[4] === '*'
    const track = parseTrack(fields[5])
    const remoteName = fields.length > 6 && fields[6] !== '' ? fields[6] : undefined
    let kind
    let name
    if (refname.startsWith('refs/heads/')) {
      kind = 'branch'
      name = refname.slice('refs/heads/'.length)
    } else if (refname.startsWith('refs/remotes/')) {
      name = refname.slice('refs/remotes/'.length)
      // origin/HEAD 只是个符号引用，画在图上是噪音。
      if (name.endsWith('/HEAD')) continue
      kind = 'remote'
    } else if (refname.startsWith('refs/tags/')) {
      kind = 'tag'
      name = refname.slice('refs/tags/'.length)
    } else {
      continue
    }
    if (name === '') continue
    // 只有**本地分支**才有"上游"这回事；远端分支与标签不带这些字段（带了也是噪音）。
    refs.push({
      name,
      kind,
      sha,
      isCurrent,
      ...(kind === 'branch'
        ? {
          upstream,
          upstreamGone: track.gone,
          ahead: track.ahead,
          behind: track.behind,
          // 有 upstream 配置（哪怕 ref 已 gone）就算"配了上游"。
          hasUpstream: upstream !== undefined || remoteName !== undefined,
        }
        : {}),
    })
  }
  return refs
}

/**
 * 解析 `%(upstream:track)`。
 *
 * 容忍未知形状：认不出来就当作「没有落后/领先信息」，**绝不猜**成 0 或者当作 gone
 * （猜错的表现是页面上一句假话，比不显示更糟）。
 * @param text - 形如 `[behind 10]` / `[ahead 2, behind 60]` / `[gone]` / `''`。
 * @returns `{ gone, ahead, behind }`；`ahead`/`behind` 为 null 表示"不知道"。
 */
export function parseTrack(text) {
  const raw = String(text === undefined || text === null ? '' : text).trim()
  const out = { gone: false, ahead: null, behind: null }
  if (raw === '') return out
  const inner = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1).trim() : raw
  if (inner === 'gone') {
    out.gone = true
    return out
  }
  const ahead = /ahead (\d+)/.exec(inner)
  const behind = /behind (\d+)/.exec(inner)
  if (ahead !== null) out.ahead = Number.parseInt(ahead[1], 10)
  if (behind !== null) out.behind = Number.parseInt(behind[1], 10)
  return out
}

/**
 * 解析 `git status --porcelain=v1 -b --untracked-files=all` 的头部与计数。
 *
 * 头部形态（git 2.x 实际会出现的都覆盖）：
 *   `## main...origin/main [ahead 6, behind 0]`
 *   `## main`（无 upstream）
 *   `## HEAD (no branch)`（分离头）
 *   `## No commits yet on main`（空仓库）
 * @param stdout - 命令标准输出。
 * @returns 分支、upstream、ahead/behind、脏文件数、分离头与空仓库标记。
 */
export function parseStatus(stdout) {
  const out = { branch: null, upstream: null, ahead: 0, behind: 0, dirty: 0, detached: false, initial: false }
  const lines = String(stdout === undefined || stdout === null ? '' : stdout).split('\n')
  let first = true
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '')
    if (line === '') continue
    if (first && line.startsWith('## ')) {
      first = false
      const text = line.slice(3)
      if (text.startsWith('HEAD (no branch)')) {
        out.detached = true
      } else {
        const initial = /^No commits yet on (.+)$/.exec(text)
        if (initial !== null) {
          out.initial = true
          out.branch = initial[1].trim()
        } else {
          const [branchPart, ...rest] = text.split('...')
          out.branch = branchPart.trim()
          const tail = rest.join('...')
          if (tail !== '') {
            const upstreamName = tail.replace(/\s*\[.*$/, '').trim()
            if (upstreamName !== '') out.upstream = upstreamName
          }
        }
      }
      const tracking = /\[([^\]]*)\]/.exec(text)
      if (tracking !== null) {
        const ahead = /ahead (\d+)/.exec(tracking[1])
        const behind = /behind (\d+)/.exec(tracking[1])
        if (ahead !== null) out.ahead = Number.parseInt(ahead[1], 10)
        if (behind !== null) out.behind = Number.parseInt(behind[1], 10)
      }
      continue
    }
    first = false
    if (line.startsWith('## ')) continue
    out.dirty += 1
  }
  return out
}

/**
 * 把三层原始解析结果合成前端要的一份快照：refs 挂到提交上、HEAD 标记、截断判定。
 * @param input - root / name / status / refs / commits / max / skip / gitVersion / now。
 * @returns 路由 value 的 ready 形态。
 */
export function buildSnapshot(input) {
  const bySha = new Map()
  for (const ref of input.refs) {
    const bucket = bySha.get(ref.sha)
    if (bucket === undefined) bySha.set(ref.sha, [ref])
    else bucket.push(ref)
  }
  const commits = input.commits.map((commit) => {
    const refs = bySha.get(commit.sha)
    return {
      sha: commit.sha,
      parents: commit.parents,
      author: commit.author,
      email: commit.email,
      time: commit.time,
      subject: commit.subject,
      head: commit.head,
      refs: refs === undefined ? [] : refs.map((ref) => ({ name: ref.name, kind: ref.kind })),
    }
  })
  const window = new Set(commits.map((commit) => commit.sha))
  return {
    state: 'ready',
    repo: {
      root: input.root,
      name: input.name,
      branch: input.status.branch,
      detached: input.status.detached,
      initial: input.status.initial,
      upstream: input.status.upstream,
      ahead: input.status.ahead,
      behind: input.status.behind,
      dirty: input.status.dirty,
    },
    refs: input.refs,
    commits,
    // 截断 = 还有更老的提交没取（够了 max 条，或最后一行仍有父提交落在窗口外）。
    truncated: commits.length >= input.max
      || commits.some((commit) => commit.parents.some((parent) => !window.has(parent))),
    scanned: commits.length,
    skip: input.skip,
    gitVersion: input.gitVersion,
    generatedAt: input.now,
  }
}

/**
 * 「本地对远端的认知有多旧」的判据。
 *
 * ## 为什么需要它（2026-10-02 用户报的真问题）
 *
 * 用户看到智能体说「已把 feat/x 合并到 develop」，但图上 develop 没有那个合并提交，
 * 于是怀疑图是不是画错了。**图没画错**：那次合并是**在远端**发生的，而本地仓库对远端的
 * 认知只更新到上一次 fetch。实测那一刻本地 `origin/develop` 落后远端 10 个提交，且
 * 那个合并提交的对象**在本地根本不存在**——本插件按设计从不联网（README 承诺只读），
 * 所以它不可能画出来。
 *
 * ## 为什么"本地分支落后上游"这个判据不够
 *
 * 本例里本地 `develop` 与**过期的** `origin/develop` 指向**同一个**提交，于是
 * `%(upstream:track)` 是空的（`behind 0`）——按"落后才提示"的写法，这次一点提示都不会有。
 * 真正能发现它的是**取回时间本身**，所以判据必须是「上次 fetch 距今多久」。
 *
 * ## 为什么要往 `gitDir` 和 `commonDir` 两处看
 *
 * 实测（git 2.49）：`FETCH_HEAD` 在**每个工作树自己的 gitdir** 里——
 * 在主工作树是 `<repo>/.git/FETCH_HEAD`，在关联工作树是
 * `<repo>/.git/worktrees/<名>/FETCH_HEAD`，两处时间可以差很远（实测一个 11:10、一个 10:36）。
 * 用户完全可能在主工作树 fetch、却在关联工作树里看图。所以取**两处里较新的那个**：
 * 「这个仓库最近一次联网是什么时候」才是要回答的问题。
 *
 * ⚠️ 不要改用目录 mtime：覆盖一个**已存在**的 ref 文件不会改变父目录的 mtime
 * （实测 `refs/remotes` 目录停在 09-20，而 `origin/develop` 文件是 10-02）。必须 stat 文件。
 * @param input - `{ fetchHeadMs, refMs, now }`（毫秒时间戳；缺失用 null）。
 * @returns `{ lastFetchAt, ageSeconds, stale }`；`lastFetchAt` 为 null 表示"从没 fetch 过"。
 */
export function describeFreshness(input) {
  const settings = input === undefined || input === null ? {} : input
  const now = Number.isFinite(settings.now) ? settings.now : Date.now()
  const candidates = [settings.fetchHeadMs, settings.refMs]
    .filter((value) => Number.isFinite(value) && value > 0)
  // 从没 fetch 过（本地全新仓库 / 从没配远端）与"很久没 fetch"是不同的两件事，
  // 前者不该被说成"数据旧了"——它根本没有远端可言。
  if (candidates.length === 0) {
    return { lastFetchAt: null, ageSeconds: null, stale: false, never: true }
  }
  const newest = Math.max(...candidates)
  const lastFetchAt = Math.floor(newest / 1000)
  const ageSeconds = Math.max(0, Math.floor((now - newest) / 1000))
  return {
    lastFetchAt,
    ageSeconds,
    // 阈值 6 小时：比"每次开页面都提醒"克制，又能在隔夜/跨半天工作时说出实情。
    stale: ageSeconds >= FRESHNESS_STALE_SECONDS,
    never: false,
  }
}

/**
 * 「提醒数据可能旧了」的年龄阈值（秒）。
 *
 * 选 6 小时的依据：本插件不联网，"陈旧"是**常态而非异常**，动不动就提示会变成噪音；
 * 而用户报的那个案例（上午合并、下午看图）跨度就在小时级。超过半天仍未取回，
 * 足以让人在"图上没有"时先想到去看一眼远端。
 */
export const FRESHNESS_STALE_SECONDS = 6 * 60 * 60
