/**
 * dsh-sidebar-git-graph 宿主半的「工作树改动」纯函数层：argv 构造 + 输出解析。
 *
 * 与 lib/git-read.js 同层：零依赖（不碰 fs / 网络 / ctx），Node 测试可以直接 import，
 * 真正的进程执行与路由在 lib/index.js。
 *
 * **本文件只构造只读命令**：`status` / `diff` 两种，永不出现 add / commit / restore /
 * reset / checkout / clean。这条不变量由 test/changes.test.cjs 钉死。
 *
 * 分隔符沿用 git-read.js 的约定：`-z` 让 git 用 NUL 分隔记录，路径里就不可能有 NUL，
 * 因此含空格、含非 ASCII 的路径都不需要引号解码。（**不要在测试里用 shell 管道看这批
 * 输出**：PowerShell 会按换行切分并字符串化，无换行的 `-z` 输出整块变成一个元素，
 * 再看 NUL 边界极易误读——实测踩过。逐字节的事用 Node 的 `encoding:'buffer'`。）
 */

/** 字段分隔符（NUL），与 git-read.js 一致。 */
export const FIELD_SEP = '\u0000'

/**
 * 状态清单的行数上限。超过就截断并如实上报，绝不悄悄少画。
 * `-uall` 会展开未跟踪目录，在没配好 .gitignore 的仓库上可能非常大。
 */
export const MAX_ROWS = 3000
/** 单次 patch 的字节上限（`maxBuffer` 是防进程炸，这个是给侧栏用的尺寸）。 */
export const MAX_DIFF_BYTES = 512 * 1024

/**
 * 只读命令共用的顶层选项。
 *
 * `--literal-pathspecs` 是关键的一条：关掉 pathspec 的魔法语法，`:(glob)`、`:(exclude)`、
 * 前导 `:` 之类一律按字面路径处理。没有它，客户端传来的 `path` 就能变成一条 pathspec 表达式
 * （例如 `:(top)*`），把「只读一个文件」放大成「读整个仓库」。
 */
const SAFE_FLAGS = [
  '-c', 'core.quotepath=false',
  '-c', 'i18n.logOutputEncoding=UTF-8',
  '--no-optional-locks',
  '--literal-pathspecs',
]

/** patch 相关的稳定选项：不要颜色、不要外部 diff、不要 textconv（否则会执行仓库配置里的命令）。 */
const PATCH_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--unified=3']

/**
 * 工作树状态（porcelain v2）。
 *
 * 为什么是 v2 而不是 v1：v1 的两字母 XY 在**重命名时把两个路径挤在一条记录里**，
 * `-z` 下要靠「记录里有没有第二个 NUL 字段」区分，容易和「文件名里恰好有换行」纠缠；
 * v2 把 rename 明确拆成两条记录（`2` 记录 + 紧随其后一条 origPath）。
 *
 * `-uall` 是必须的：`-unormal` 会把未跟踪目录塌成一条 `? dir/`，我们要的是文件清单。
 * （内嵌的独立仓库即使 `-uall` 也仍是一条 `? vendor/inner/`——git 不会下钻，
 * 见 parseStatusV2 的 container 判定。）
 * @param root - 仓库根。
 * @returns git 参数数组。
 */
export function changesStatusArgv(root) {
  return ['-C', root, ...SAFE_FLAGS, 'status', '--porcelain=v2', '-b', '--untracked-files=all', '-z']
}

/**
 * +/− 计数。两段各一条命令即可覆盖**全部已跟踪**文件，不需要每文件一条进程。
 *
 * 段与比较基准的对应：
 *   staged   → `--cached`：HEAD → 索引
 *   unstaged → 无参数   ：索引 → 工作树
 * 两条都不需要 HEAD 存在，所以**空仓库（还没有提交）天然可用**，不需要空树兜底。
 *
 * 未跟踪文件**不在这里**：`--no-index` 只接受两个路径，要行数就得每文件起一个进程。
 * 段头计数因此只统计已跟踪部分，README 里如实写明。
 * @param root - 仓库根。
 * @param section - `'staged'` 或 `'unstaged'`。
 * @returns git 参数数组。
 */
export function numstatArgv(root, section) {
  const compare = section === 'staged' ? ['--cached'] : []
  return ['-C', root, ...SAFE_FLAGS, 'diff', '--numstat', '-z', ...compare]
}

/**
 * 单个文件的 patch。
 *
 * 四种情况各有各的命令，**不能合并**：
 *   - unmerged（冲突）：必须是 `diff HEAD`。对未合并路径，`git diff`（无 rev）会走
 *     **combined diff**（`--cc`）格式：hunk 头是 `@@@`（三个 @）、正文行是**两字符**前缀
 *     （`++` / ` +` / `+ `）。统一 diff 的解析器读不懂它，结果是**静默返回空 diff**——
 *     一个不报错的空答案。改用 `diff HEAD`（HEAD → 工作树）就是普通 unified 格式，
 *     而且正好把工作树里那份带冲突标记的内容如实展示出来。
 *   - staged：`--cached`，比较 HEAD→索引。重命名必须把**新旧两个路径都给**——实测只给新路径时
 *     `-M` 认不出重命名，输出退化成「new file mode + 整文件新增」。
 *   - unstaged（已跟踪）：无参数，比较索引→工作树。这里**只给新路径**：索引里已经是新名字了。
 *   - untracked：`--no-index` 对着 `/dev/null`。它的**退出码 1 表示「有差异」而不是失败**
 *     （有差异时 stderr 为空）——调用方必须特判，否则表现为「未跟踪文件永远打不开 diff」
 *     且没有任何错误信息。
 * @param root - 仓库根。
 * @param options - `{ section, path, origPath, untracked, unmerged }`。
 * @returns git 参数数组。
 */
export function diffArgv(root, options) {
  const settings = options === undefined || options === null ? {} : options
  const path = settings.path
  if (settings.untracked === true) {
    return [
      '-C', root, ...SAFE_FLAGS,
      'diff', '--no-index', ...PATCH_FLAGS,
      '--', '/dev/null', path,
    ]
  }
  // 冲突路径必须显式对 HEAD 比较，否则会拿到解析不了的 combined diff（见函数头注释）。
  if (settings.unmerged === true) {
    return ['-C', root, ...SAFE_FLAGS, 'diff', 'HEAD', ...PATCH_FLAGS, '--', path]
  }
  const compare = settings.section === 'staged' ? ['--cached'] : []
  // 重命名只在 staged 段需要带上原路径（见函数头注释）。
  const paths = settings.section === 'staged' && typeof settings.origPath === 'string' && settings.origPath !== ''
    ? [settings.origPath, path]
    : [path]
  return ['-C', root, ...SAFE_FLAGS, 'diff', ...compare, '-M', ...PATCH_FLAGS, '--', ...paths]
}

/**
 * 客户端传来的路径是否是一个合法的**仓库根相对**路径。
 *
 * 这是除了 `--literal-pathspecs` 之外的第二道闸（纵深防御）：即便 pathspec 魔法被关掉，
 * 也不该让 `..`、绝对路径、盘符或前导 `-`（会被当成选项）进到 argv 里。
 *
 * 严格到底：任何一段是空串、`.`、`..` 都拒绝。这一条同时干掉了前导 `/`、尾随 `/`、
 * 连续 `//`，也顺带拒绝反斜杠路径（git 的仓库相对路径一律用 `/`，反斜杠在 Windows 上是
 * 合法文件名字符，放进来会造成「同一个文件两种写法」的歧义）。
 * @param value - 待检字符串。
 * @returns 是否可用。
 */
export function isRepoRelativePath(value) {
  if (typeof value !== 'string' || value === '') return false
  if (value.length > 4096) return false
  if (value.includes(FIELD_SEP) || value.includes('\n') || value.includes('\r')) return false
  if (value.includes('\\')) return false
  if (value.startsWith('-')) return false
  if (value.startsWith(':')) return false
  const segments = value.split('/')
  for (const segment of segments) {
    if (segment === '' || segment === '.' || segment === '..') return false
    // 盘符绝对路径（`C:/x`）的第一个路径段是 `C:`。Windows 的文件名里不可能有 `:`，
    // 所以在这里拒掉它既安全又准确，不必再单独判盘符。
    if (segment.includes(':')) return false
  }
  return true
}

/**
 * 解析 porcelain v2 的头部行（`# branch.oid …` / `# branch.head …` / `# branch.upstream …` /
 * `# branch.ab +N -M`）。
 * @param text - `# ` 之后的内容。
 * @param out - 被就地填写的对象。
 */
function parseHeadLine(text, out) {
  if (text.startsWith('branch.oid ')) {
    out.oid = text.slice('branch.oid '.length).trim()
    if (out.oid === '(initial)') out.initial = true
    return
  }
  if (text.startsWith('branch.head ')) {
    const value = text.slice('branch.head '.length).trim()
    if (value === '(detached)') out.detached = true
    else out.branch = value
    return
  }
  if (text.startsWith('branch.upstream ')) {
    const value = text.slice('branch.upstream '.length).trim()
    if (value !== '') out.upstream = value
    return
  }
  if (text.startsWith('branch.ab ')) {
    const ahead = /\+(\d+)/.exec(text)
    const behind = /-(\d+)/.exec(text)
    if (ahead !== null) out.ahead = Number.parseInt(ahead[1], 10)
    if (behind !== null) out.behind = Number.parseInt(behind[1], 10)
  }
}

/**
 * 按空格切前 N 个固定字段，剩下的**全部**（含其中的空格）作为最后一个字段。
 *
 * 为什么不用 `line.split(' ', N+1)`：`String.prototype.split` 的 limit 是**丢弃**剩余部分，
 * 不是把剩余部分并进最后一项。路径里可以有空格，于是 `split(' ', 11)[10]` 会把
 * `a file with spaces.txt` 悄悄截成 `a`——一个只在大括号路径上出现的静默错误。
 * （这条是 test/changes.test.cjs 逼出来的：先写错，测试红了才改对。）
 * @param text - 一整条记录。
 * @param fixedFields - 路径**之前**的字段个数。
 * @returns 长度固定为 `fixedFields + 1` 的数组；字段不足时返回 null。
 */
function splitPathTail(text, fixedFields) {
  const parts = text.split(' ')
  if (parts.length <= fixedFields) return null
  const head = parts.slice(0, fixedFields)
  head.push(parts.slice(fixedFields).join(' '))
  return head
}

/**
 * 解析 `git status --porcelain=v2 -z`。
 *
 * 四种记录（**字段数各不相同，这是最容易写错的地方**）：
 *   `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`                                   9 字段
 *   `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` + 一条 origPath 记录   10 字段
 *   `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`                        11 字段
 *   `? <path>`                                                                       2 字段
 *
 * **路径是最后一个字段，且可以含空格**，所以一律走 splitPathTail（见那里关于 split limit 的坑）。
 *
 * `u`（未合并/冲突）的 11 字段形状是**实测**出来的，不是照文档抄的：
 *   `u UU N... 100644 100644 100644 100644 <h1> <h2> <h3> conflict.txt`
 * 丢掉冲突文件是这块最难受的错，所以它有独立的一段与测试。
 * @param stdout - 命令标准输出。
 * @returns `{ branch, upstream, ahead, behind, detached, initial, oid, records, truncated }`。
 */
export function parseStatusV2(stdout) {
  const out = {
    branch: null, upstream: null, ahead: 0, behind: 0,
    detached: false, initial: false, oid: null,
    records: [], truncated: false,
  }
  // 末尾那条记录后面跟着一个 NUL，split 会留一个空串，跳过即可。
  const parts = String(stdout === undefined || stdout === null ? '' : stdout).split(FIELD_SEP)
  for (let index = 0; index < parts.length; index += 1) {
    const line = parts[index]
    if (line === '') continue
    const kind = line[0]

    if (kind === '#') { parseHeadLine(line.slice(2), out); continue }
    // `!` 是被忽略的文件（ignored），只有显式请求时才会出现；出现也不该进改动清单。
    if (kind === '!') continue

    if (kind === '?') {
      const path = line.slice(2)
      if (path === '') continue
      out.records.push({
        path,
        xy: '??',
        // 尾随 `/` = git 没有下钻，通常是内嵌的独立仓库（也可能是不可读目录）。
        // 这种行不能取 diff（实测 `--no-index` 报 `Could not access '<dir>/null'`）。
        container: path.endsWith('/'),
        kind: 'untracked',
      })
      continue
    }

    if (kind === '1') {
      const fields = splitPathTail(line, 8)
      if (fields === null) continue
      out.records.push({ path: fields[8], xy: fields[1], container: false, kind: 'ordinary' })
      continue
    }

    if (kind === '2') {
      const fields = splitPathTail(line, 9)
      if (fields === null) continue
      // origPath 是紧随其后的一条独立记录（整个记录就是路径，没有前缀）。
      index += 1
      const origPath = parts[index] === undefined ? '' : parts[index]
      out.records.push({
        path: fields[9], xy: fields[1], container: false, kind: 'renamed',
        origPath: origPath === '' ? undefined : origPath,
      })
      continue
    }

    if (kind === 'u') {
      const fields = splitPathTail(line, 10)
      if (fields === null) continue
      out.records.push({ path: fields[10], xy: fields[1], container: false, kind: 'unmerged' })
      continue
    }
    // 未知记录类型：跳过而不是抛错。图少一行好过整页报错（与 git-read.js 同一取向）。
  }

  if (out.records.length > MAX_ROWS) {
    out.records = out.records.slice(0, MAX_ROWS)
    out.truncated = true
  }
  return out
}

/**
 * 解析 `git diff --numstat -z`。
 *
 * 两种记录：
 *   普通   `added<TAB>deleted<TAB>path`
 *   重命名 `added<TAB>deleted<TAB>` 然后**两条独立记录**：先 origPath、后 path（实测）
 * 二进制文件的 added/deleted 是 `-`（不是数字）。
 * @param stdout - 命令标准输出。
 * @returns `Map<path, { added, deleted, binary, origPath }>`；added/deleted 对二进制为 undefined。
 */
export function parseNumstat(stdout) {
  const map = new Map()
  const parts = String(stdout === undefined || stdout === null ? '' : stdout).split(FIELD_SEP)
  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index]
    if (record === '') continue
    const fields = record.split('\t')
    if (fields.length < 3) continue
    const rawAdded = fields[0]
    const rawDeleted = fields[1]
    // 路径里理论上可以有制表符：把第 3 段起全部拼回来。
    let path = fields.slice(2).join('\t')
    let origPath
    if (path === '') {
      // 重命名：下一条是原路径，再下一条才是新路径。
      index += 1
      origPath = parts[index] === undefined ? '' : parts[index]
      index += 1
      path = parts[index] === undefined ? '' : parts[index]
    }
    if (path === '') continue
    const binary = rawAdded === '-' || rawDeleted === '-'
    map.set(path, {
      added: binary ? undefined : Number.parseInt(rawAdded, 10),
      deleted: binary ? undefined : Number.parseInt(rawDeleted, 10),
      binary,
      origPath: origPath === undefined || origPath === '' ? undefined : origPath,
    })
  }
  return map
}

/** 单个字母 → 段。X 是索引侧（已暂存），Y 是工作树侧（未暂存），`.` 表示该侧无改动。 */
function sectionsOf(xy) {
  const x = typeof xy === 'string' && xy.length >= 2 ? xy[0] : '.'
  const y = typeof xy === 'string' && xy.length >= 2 ? xy[1] : '.'
  const letterX = x === '.' || x === '?' ? undefined : x
  const letterY = y === '.' || y === '?' ? undefined : y
  return { staged: letterX, unstaged: letterY }
}

/**
 * 把解析结果摊成三段清单（冲突 / 更改 / 暂存的更改）。
 *
 * 一个 `MM` 文件会**同时出现在两段**——这正是 VS Code 的行为，也是选两段式的意义。
 * @param parsed - parseStatusV2 的结果。
 * @param numstat - `{ staged, unstaged }` 两个 Map。
 * @returns `{ conflicts, unstaged, staged }`，每项为 row 数组。
 */
export function buildChangeSections(parsed, numstat) {
  const stagedCounts = numstat !== null && numstat !== undefined && numstat.staged instanceof Map ? numstat.staged : new Map()
  const unstagedCounts = numstat !== null && numstat !== undefined && numstat.unstaged instanceof Map ? numstat.unstaged : new Map()
  const conflicts = []
  const unstaged = []
  const staged = []

  for (const record of parsed.records) {
    const base = {
      path: record.path,
      origPath: record.origPath,
      xy: record.xy,
      container: record.container === true,
    }
    if (record.kind === 'unmerged') {
      // 冲突文件也标 `U`，但它**不是**未跟踪文件：它在索引里有条目（多个 stage），
      // 能取普通 diff。所以这里显式带 `untracked: false`，不让前端靠字母去猜
      // （猜错的表现是拿 `--no-index` 对着它跑，把整个文件当成新增——一个不会报错的错答案）。
      conflicts.push({ ...base, status: 'U', untracked: false })
      continue
    }
    if (record.kind === 'untracked') {
      // 未跟踪没有 +/− 计数（见 numstatArgv 的注释），取 patch 要走 `--no-index`。
      unstaged.push({ ...base, status: 'U', untracked: true })
      continue
    }
    const sides = sectionsOf(record.xy)
    if (sides.staged !== undefined) {
      const counts = stagedCounts.get(record.path)
      staged.push({
        ...base,
        status: sides.staged,
        untracked: false,
        added: counts === undefined ? undefined : counts.added,
        deleted: counts === undefined ? undefined : counts.deleted,
        binary: counts === undefined ? undefined : counts.binary,
      })
    }
    if (sides.unstaged !== undefined) {
      const counts = unstagedCounts.get(record.path)
      unstaged.push({
        ...base,
        // 未暂存侧的「原路径」没有意义：索引里已经是当前名字。
        origPath: undefined,
        status: sides.unstaged,
        untracked: false,
        added: counts === undefined ? undefined : counts.added,
        deleted: counts === undefined ? undefined : counts.deleted,
        binary: counts === undefined ? undefined : counts.binary,
      })
    }
  }
  return { conflicts, unstaged, staged }
}

/** 段头汇总：只统计拿得到计数的行。 */
export function summarizeRows(rows) {
  let added = 0
  let deleted = 0
  let counted = 0
  for (const row of rows) {
    if (typeof row.added !== 'number' && typeof row.deleted !== 'number') continue
    counted += 1
    if (typeof row.added === 'number') added += row.added
    if (typeof row.deleted === 'number') deleted += row.deleted
  }
  return { count: rows.length, added, deleted, counted }
}

/** hunk 头：`@@ -a,b +c,d @@`；`b`/`d` 省略时表示 1 行（这个格式最经典的坑）。 */
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

/**
 * 解析 unified patch，摊成**结构化行**，让浏览器半完全不需要懂 diff 语法。
 *
 * 只在宿主侧做这一层是刻意的：行号推进、hunk 头缺省计数、`\ No newline` 这些
 * 全是纯逻辑，放这里就能在 Node 里逐条断言；放到浏览器半就只能靠肉眼看截图。
 *
 * 文件元信息（`diff --git` / `index` / `---` / `+++` / `new file mode` / `rename from` …）
 * 一律丢掉——段头与列表行已经说过这些事了。
 * @param stdout - patch 文本。
 * @returns `{ binary, lines }`；lines 项为 `{ kind, text, oldNo?, newNo? }`，
 *   kind ∈ hunk/add/del/ctx/meta。
 */
export function parsePatch(stdout) {
  const text = String(stdout === undefined || stdout === null ? '' : stdout)
  const lines = []
  let binary = false
  let combined = false
  let sawHunk = false
  let seenHunk = false
  let oldNo = 0
  let newNo = 0

  /** 收一条 hunk 头并重置两侧行号。 */
  const pushHunk = (line, head) => {
    oldNo = Number.parseInt(head[1], 10)
    newNo = Number.parseInt(head[3], 10)
    lines.push({
      kind: 'hunk',
      text: line,
      // 缺省计数是 1 行，不是 0 行。
      oldStart: oldNo, oldLines: head[2] === undefined ? 1 : Number.parseInt(head[2], 10),
      newStart: newNo, newLines: head[4] === undefined ? 1 : Number.parseInt(head[4], 10),
    })
  }

  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    // combined diff（`--cc`，未合并路径的默认输出）用的是 `@@@` 与两字符前缀，
    // 统一 diff 的规则读不懂它。**认出来并如实上报**，而不是当成"没有改动"返回空数组——
    // 后者是一个不报错的空答案（真踩过：冲突文件的 diff 一片空白）。
    if (line.startsWith('@@@') || line.startsWith('diff --cc')) { combined = true; continue }
    if (!seenHunk) {
      // hunk 之前只有文件元信息与二进制声明。
      if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) { binary = true; continue }
      const head = HUNK_HEAD.exec(line)
      if (head === null) continue
      seenHunk = true
      sawHunk = true
      pushHunk(line, head)
      continue
    }
    const head = line.startsWith('@@') ? HUNK_HEAD.exec(line) : null
    if (head !== null) { pushHunk(line, head); continue }
    if (line.startsWith('\\')) { lines.push({ kind: 'meta', text: line }); continue }
    if (line.startsWith('+')) {
      lines.push({ kind: 'add', text: line.slice(1), newNo })
      newNo += 1
      continue
    }
    if (line.startsWith('-')) {
      lines.push({ kind: 'del', text: line.slice(1), oldNo })
      oldNo += 1
      continue
    }
    if (line.startsWith(' ')) {
      lines.push({ kind: 'ctx', text: line.slice(1), oldNo, newNo })
      oldNo += 1
      newNo += 1
      continue
    }
    // 空行只在 hunk 头之后有意义：真实的空上下文行是「单个空格」，裸空行是 patch 的分隔空行。
    if (line === '') continue
    // 其余一律是元信息。
    //
    // 已知的简化（改动前请先看这里）：hunk 正文里「整行内容为空**且**丢了尾随空格」的
    // 上下文行会被算成元信息。git 自己不会产出这种行（`unified=3` 一定带那个空格），
    // 只有别的工具重写过 patch 才会。真碰到了也只是**少一行上下文**，不影响 +/- 判定。
    lines.push({ kind: 'meta', text: line })
  }
  // 有 hunk 正文却一行都没收下 —— 说明上面那条简化被踩到了，调用方据此显示提示而不是空白。
  return { binary, lines, combined, empty: !binary && !combined && !sawHunk && text.trim() !== '' }
}
