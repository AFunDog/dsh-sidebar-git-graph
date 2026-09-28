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
 * @param cwd - 会话工作目录（任意层级的子目录都可以）。
 * @returns git 参数数组。
 */
export function revParseArgv(cwd) {
  return ['-C', cwd, 'rev-parse', '--show-toplevel', '--absolute-git-dir']
}

/**
 * 头部状态：当前分支 / upstream / ahead / behind / 脏文件数。
 * @param root - 仓库根。
 * @returns git 参数数组。
 */
export function statusArgv(root) {
  return ['-C', root, ...SAFE_FLAGS, 'status', '--porcelain=v1', '-b', '--untracked-files=no']
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
    `--format=%(refname)%00%(objectname)%00%(*objectname)%00%(upstream:short)%00%(HEAD)`,
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
    refs.push(upstream === undefined
      ? { name, kind, sha, isCurrent }
      : { name, kind, sha, isCurrent, upstream })
  }
  return refs
}

/**
 * 解析 `git status --porcelain=v1 -b --untracked-files=no` 的头部与计数。
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
