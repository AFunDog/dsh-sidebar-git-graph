/**
 * 「工作树改动」宿主层的测试：解析（喂真字节）+ 端到端（在临时目录里造真仓库）。
 *
 * 两条刻意的取向：
 *   1. **解析样本是实测 dump 出来的真字节**，不是照 git 文档手写的。文档与实现在这块
 *      出入不小（`u` 记录 11 字段、路径在最后且可含空格、numstat 的重命名是三段记录），
 *      手写的样本只能证明"我的解析器同意我的想象"。
 *   2. **只读不变量单独一条测试**：对每个 argv 构造函数断言第一条真参数只能是 status/diff。
 *      以后有人给插件加"暂存"功能，这条会红——而不是悄悄违背 README 已公开的承诺。
 *
 * DSH_HOME 指向临时目录，避免读到真实的工作区表。跑法：node test/changes.test.cjs
 */
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zgg-changes-test-'))
process.env.DSH_HOME = path.join(sandbox, 'home')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })

const NUL = '\u0000'

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 造仓库并预置身份/换行设置（CI 的 Windows runner 上 autocrlf 会自己造出改动）。 */
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init'])
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(dir, ['config', 'user.name', 'Test User'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  git(dir, ['config', 'core.autocrlf', 'false'])
  return dir
}

function write(dir, name, text) {
  const full = path.join(dir, name)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text, 'utf8')
}

async function main() {
  const changes = await import('../lib/changes.js')
  const {
    MAX_ROWS,
    buildChangeSections,
    changesStatusArgv,
    diffArgv,
    isRepoRelativePath,
    numstatArgv,
    parseNumstat,
    parsePatch,
    parseStatusV2,
    summarizeRows,
  } = changes

  // ═══════════════════════════════════════════════════════════════════════
  // 1) 只读不变量：这条最要紧，放最前面
  // ═══════════════════════════════════════════════════════════════════════
  {
    // 任何写操作只要进了 argv，就必须让这条测试红。
    const WRITE_COMMANDS = new Set([
      'add', 'commit', 'restore', 'reset', 'checkout', 'clean', 'rm', 'mv',
      'stash', 'merge', 'rebase', 'cherry-pick', 'revert', 'apply', 'am',
      'push', 'fetch', 'pull', 'switch', 'update-index', 'write-tree',
    ])
    const READ_COMMANDS = new Set(['status', 'diff', 'rev-parse', 'for-each-ref', 'log'])

    const samples = [
      ['changesStatusArgv', changesStatusArgv('/repo')],
      ['numstatArgv(staged)', numstatArgv('/repo', 'staged')],
      ['numstatArgv(unstaged)', numstatArgv('/repo', 'unstaged')],
      ['diffArgv(staged)', diffArgv('/repo', { section: 'staged', path: 'a.txt', origPath: 'b.txt' })],
      ['diffArgv(unstaged)', diffArgv('/repo', { section: 'unstaged', path: 'a.txt' })],
      ['diffArgv(untracked)', diffArgv('/repo', { section: 'unstaged', path: 'a.txt', untracked: true })],
    ]

    for (const [label, argv] of samples) {
      // `-C <root>` 与 `-c k=v` / `--flag` 都是选项；第一条非选项才是子命令。
      const positional = []
      for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index]
        if (token === '-C' || token === '-c') { index += 1; continue }
        if (token.startsWith('-')) continue
        positional.push(token)
      }
      // `--no-index` 的 diff 之后会出现 `/dev/null` 这个位置参数，它不是子命令。
      const command = positional.find((token) => token !== '/dev/null')
      assert.ok(command !== undefined, `${label}: 找不到子命令`)
      assert.ok(
        READ_COMMANDS.has(command),
        `${label}: 子命令 ${command} 不在只读白名单里 —— 本插件承诺只读，写操作必须另开插件`,
      )
      for (const token of positional) {
        assert.ok(
          !WRITE_COMMANDS.has(token),
          `${label}: argv 里出现了写命令 ${token}`,
        )
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 2) 解析：实测真字节
  // ═══════════════════════════════════════════════════════════════════════
  {
    // 由探针 dump 出来的真输出（sha 截断成可读长度不影响解析，但这里用完整值以免掩盖字段数错误）。
    const statusOut = [
      '# branch.oid 41d6a8ef58ac5387267243e6f051b8a27a4dde71',
      '# branch.head main',
      '1 .D N... 100644 100644 000000 812b062e03f9bae2efeeea13a97761c24a62d1f7 812b062e03f9bae2efeeea13a97761c24a62d1f7 del.txt',
      '1 .M N... 100644 100644 100644 812b062e03f9bae2efeeea13a97761c24a62d1f7 812b062e03f9bae2efeeea13a97761c24a62d1f7 mod.txt',
      '1 A. N... 000000 100644 100644 0000000000000000000000000000000000000000 deec1dce2f03e05cd2298ea3910960a1dc42f459 new-staged.txt',
      '2 R. N... 100644 100644 100644 812b062e03f9bae2efeeea13a97761c24a62d1f7 812b062e03f9bae2efeeea13a97761c24a62d1f7 R100 renamed-now.txt',
      'renamed.txt',
      '1 D. N... 100644 000000 000000 812b062e03f9bae2efeeea13a97761c24a62d1f7 0000000000000000000000000000000000000000 staged-del.txt',
      '? newdir/a.txt',
      '? untracked.txt',
      '',
    ].join(NUL)

    const parsed = parseStatusV2(statusOut)
    assert.strictEqual(parsed.branch, 'main')
    assert.strictEqual(parsed.detached, false)
    assert.strictEqual(parsed.records.length, 7, `应解析出 7 条记录：${JSON.stringify(parsed.records)}`)

    const byPath = new Map(parsed.records.map((record) => [record.path, record]))
    assert.strictEqual(byPath.get('mod.txt').xy, '.M')
    assert.strictEqual(byPath.get('del.txt').xy, '.D')
    assert.strictEqual(byPath.get('new-staged.txt').xy, 'A.')
    assert.strictEqual(byPath.get('staged-del.txt').xy, 'D.')
    // 重命名：原路径必须被消费掉，且**不能**变成一条独立记录。
    assert.strictEqual(byPath.get('renamed-now.txt').origPath, 'renamed.txt')
    assert.strictEqual(byPath.get('renamed.txt'), undefined, '原路径不该成为独立记录')
    // 未跟踪目录行：尾随 `/` → container，不能取 diff。
    assert.strictEqual(byPath.get('newdir/a.txt').container, false)
    assert.strictEqual(byPath.get('untracked.txt').container, false)

    // 内嵌仓库那条（实测 `-uall` 下仍是目录行）。
    const withContainer = parseStatusV2([
      '# branch.head main',
      '? vendor/inner/',
      '? plaindir/a.txt',
      '',
    ].join(NUL))
    assert.strictEqual(withContainer.records[0].container, true, '内嵌仓库行必须标成 container')
    assert.strictEqual(withContainer.records[1].container, false)
  }

  {
    // `u`（未合并/冲突）记录：11 字段，**实测**形状，不是照文档抄的。
    const conflictOut = [
      '# branch.oid b0068848811b2c54e5d0469a837625a0fef092a6',
      '# branch.head main',
      'u UU N... 100644 100644 100644 100644 ae721301a641e97b1c92b705843e6cbb7eb4ddf8 6662396c8184b8dfd231ace4682aa2d505c76d59 bfe36f262172c4ea00250d91c1c2a9d275228264 conflict.txt',
      // 冲突文件路径**含空格**：证明不能按固定下标取路径。
      'u UU N... 100644 100644 100644 100644 587be6b4c3f93f93c489c0111bba5596147a26cb abd82dff563c33bd93afe51ee53d60e7aa20123d 846f0439115b2e71a3f64a46cbfbbb37e5e61f7f a file with spaces.txt',
      '',
    ].join(NUL)
    const parsed = parseStatusV2(conflictOut)
    assert.strictEqual(parsed.records.length, 2, '冲突记录不能被丢掉')
    assert.strictEqual(parsed.records[0].path, 'conflict.txt')
    assert.strictEqual(parsed.records[0].kind, 'unmerged')
    assert.strictEqual(parsed.records[1].path, 'a file with spaces.txt', '含空格的路径要完整取到')

    const sections = buildChangeSections(parsed, { staged: new Map(), unstaged: new Map() })
    assert.strictEqual(sections.conflicts.length, 2, '冲突必须进 conflicts 段')
    assert.strictEqual(sections.conflicts[0].status, 'U')
    // 冲突文件也是字母 `U`，但它**不是**未跟踪文件。这个标记必须由宿主明确给出，
    // 不能让前端靠字母猜——猜错就是拿 --no-index 把整个文件当成新增（不报错的错答案）。
    assert.strictEqual(sections.conflicts[0].untracked, false, '冲突文件不是未跟踪文件')
  }

  {
    // 非 ASCII 与含空格的路径（`core.quotepath=false` + `-z` 下原样输出）。
    const parsed = parseStatusV2([
      '# branch.head main',
      '? with space.txt',
      '? 中文 文件.txt',
      '',
    ].join(NUL))
    assert.deepStrictEqual(parsed.records.map((record) => record.path), ['with space.txt', '中文 文件.txt'])
  }

  {
    // numstat：普通 + 重命名（三段记录）+ 二进制。
    const numstatOut = [
      '2\t1\tboth.txt',
      '1\t0\tnew-staged.txt',
      '0\t0\t',
      'del.txt',
      'renamed-now.txt',
      '-\t-\tblob.bin',
      '',
    ].join(NUL)
    const map = parseNumstat(numstatOut)
    assert.deepStrictEqual(map.get('both.txt'), { added: 2, deleted: 1, binary: false, origPath: undefined })
    // 重命名：先 origPath 再 path，两条独立记录。
    assert.strictEqual(map.has('del.txt'), false, '重命名的原路径不该成为独立条目')
    assert.deepStrictEqual(
      map.get('renamed-now.txt'),
      { added: 0, deleted: 0, binary: false, origPath: 'del.txt' },
    )
    assert.strictEqual(map.get('blob.bin').binary, true)
    assert.strictEqual(map.get('blob.bin').added, undefined, '二进制没有行数')
  }

  {
    // 分段：MM 必须同时出现在两段（这正是 VS Code 的行为）。
    const parsed = parseStatusV2([
      '# branch.head main',
      '1 MM N... 100644 100644 100644 aaa bbb both.txt',
      '? fresh.txt',
      '',
    ].join(NUL))
    const sections = buildChangeSections(parsed, {
      staged: parseNumstat(['1\t1\tboth.txt', ''].join(NUL)),
      unstaged: parseNumstat(['1\t0\tboth.txt', ''].join(NUL)),
    })
    assert.strictEqual(sections.staged.length, 1)
    assert.strictEqual(sections.unstaged.length, 2, 'MM 文件两段都要有，未跟踪也在未暂存段')
    assert.strictEqual(sections.staged[0].status, 'M')
    assert.strictEqual(sections.staged[0].added, 1)
    assert.strictEqual(sections.unstaged.find((row) => row.path === 'both.txt').status, 'M')
    const untrackedRow = sections.unstaged.find((row) => row.path === 'fresh.txt')
    assert.strictEqual(untrackedRow.status, 'U')
    assert.strictEqual(untrackedRow.untracked, true, '未跟踪文件才是 untracked')
    assert.strictEqual(untrackedRow.added, undefined, '未跟踪没有行数')
  }

  {
    // 段头汇总：只算拿得到计数的行，未跟踪不计入 —— 但不能因此把 count 也算错。
    const totals = summarizeRows([
      { added: 3, deleted: 1 },
      { added: undefined, deleted: undefined },
      { added: 0, deleted: 0 },
    ])
    assert.deepStrictEqual(totals, { count: 3, added: 3, deleted: 1, counted: 2 })
  }

  {
    // hunk 头缺省计数 = 1 行（这个格式最经典的坑），以及行号推进。
    const patch = parsePatch([
      'diff --git a/x.txt b/x.txt',
      'index 111..222 100644',
      '--- a/x.txt',
      '+++ b/x.txt',
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '\\ No newline at end of file',
      '',
    ].join('\n'))
    assert.strictEqual(patch.binary, false)
    const hunk = patch.lines.find((line) => line.kind === 'hunk')
    assert.strictEqual(hunk.oldLines, 1, '省略计数时是 1 行而不是 0 行')
    assert.strictEqual(hunk.newLines, 1)
    const del = patch.lines.find((line) => line.kind === 'del')
    const add = patch.lines.find((line) => line.kind === 'add')
    assert.strictEqual(del.oldNo, 1)
    assert.strictEqual(add.newNo, 1)
    // 文件元信息不该混进正文。
    assert.ok(!patch.lines.some((line) => line.text.startsWith('index ')), '元信息必须丢掉')
  }

  {
    // 多 hunk + 上下文行号两侧各自推进。
    const patch = parsePatch([
      '@@ -10,3 +10,4 @@ heading',
      ' ctx',
      '-gone',
      '+added',
      '+added2',
      ' tail',
      '@@ -40,2 +41,1 @@',
      ' solo',
      '',
    ].join('\n'))
    const ctx = patch.lines.filter((line) => line.kind === 'ctx')
    assert.strictEqual(ctx[0].oldNo, 10)
    assert.strictEqual(ctx[0].newNo, 10)
    // 第一个 hunk 是 `-10,3 +10,4`：旧侧覆盖 10..12（ctx / del / ctx），
    // 新侧覆盖 10..13（ctx / add / add / ctx）。所以尾部那条上下文是 旧12 / 新13。
    assert.strictEqual(ctx[1].oldNo, 12, '旧侧 3 行：10(ctx) 11(del) 12(ctx)')
    assert.strictEqual(ctx[1].newNo, 13, '新侧 4 行：10(ctx) 11(add) 12(add) 13(ctx)')
  }

  {
    const binaryPatch = parsePatch([
      'diff --git a/b.bin b/b.bin',
      'index 111..222 100644',
      'Binary files a/b.bin and b/b.bin differ',
      '',
    ].join('\n'))
    assert.strictEqual(binaryPatch.binary, true)
  }

  {
    // 空 patch：不是错误，只是没有改动。
    const empty = parsePatch('')
    assert.deepStrictEqual(empty, { binary: false, lines: [], combined: false, empty: false })
  }

  {
    // combined diff（`--cc`，未合并路径的默认输出）：`@@@` 头 + 两字符前缀。
    // 解析器**认不出来但要认出来**——以前它会静默返回空数组，表现是冲突文件的 diff
    // 一片空白且不报错。现在必须显式标成 combined，让上层换个命令或如实说明。
    const combined = parsePatch([
      'diff --cc shared.txt',
      'index fcb3092,1268d40..0000000',
      '--- a/shared.txt',
      '+++ b/shared.txt',
      '@@@ -1,3 -1,3 +1,9 @@@',
      '++<<<<<<< HEAD',
      ' +main1',
      '+ side1',
      '++>>>>>>> side',
      '',
    ].join('\n'))
    assert.strictEqual(combined.combined, true, 'combined diff 必须被识别出来')
    assert.strictEqual(combined.lines.length, 0, '不该硬把它当统一 diff 解析出行')
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 3) 路径围栏
  // ═══════════════════════════════════════════════════════════════════════
  {
    for (const good of ['a.txt', 'src/lib/index.js', '中文 文件.txt', 'a/b/c/d.txt', '.github/workflows/ci.yml']) {
      assert.strictEqual(isRepoRelativePath(good), true, `${good} 应当被接受`)
    }
    for (const bad of [
      '', '/etc/passwd', 'C:/Windows/System32', 'c:/x', '../../etc/passwd', 'a/../../b',
      './a.txt', 'a/./b', 'a//b', 'a/', '\\a\\b', 'a\\b', '-flag.txt', '--upload-pack=x',
      ':(top)*', ':(exclude)a.txt', 'a\u0000b', 'a\nb', 'trailing/',
    ]) {
      assert.strictEqual(isRepoRelativePath(bad), false, `${JSON.stringify(bad)} 应当被拒绝`)
    }
    // 超长路径不该进 argv。
    assert.strictEqual(isRepoRelativePath('a'.repeat(5000)), false)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 4) argv 形状：两个"必须"的断言
  // ═══════════════════════════════════════════════════════════════════════
  {
    // 重命名在 staged 段必须**同时**给出新旧两个路径，否则 `-M` 认不出重命名（实测）。
    const staged = diffArgv('/repo', { section: 'staged', path: 'new.txt', origPath: 'old.txt' })
    assert.ok(staged.includes('old.txt') && staged.includes('new.txt'), 'staged 重命名必须带两个路径')
    // 未暂存段只给新路径：索引里已经是新名字了。
    const unstaged = diffArgv('/repo', { section: 'unstaged', path: 'new.txt', origPath: 'old.txt' })
    assert.ok(!unstaged.includes('old.txt'), '未暂存段不该带原路径')
    // pathspec 魔法必须关掉。
    assert.ok(staged.includes('--literal-pathspecs'), '必须关掉 pathspec 魔法')
    // 不要颜色、不要外部 diff、不要 textconv（后者会执行仓库配置里的命令）。
    for (const flag of ['--no-color', '--no-ext-diff', '--no-textconv']) {
      assert.ok(staged.includes(flag), `patch 必须带 ${flag}`)
    }
    // 未跟踪走 --no-index 对着 /dev/null。
    const untracked = diffArgv('/repo', { section: 'unstaged', path: 'u.txt', untracked: true })
    assert.ok(untracked.includes('--no-index'), '未跟踪必须走 --no-index')
    assert.ok(untracked.includes('/dev/null'))
    // 段与比较基准的对应。
    assert.ok(numstatArgv('/repo', 'staged').includes('--cached'))
    assert.ok(!numstatArgv('/repo', 'unstaged').includes('--cached'))
    assert.ok(changesStatusArgv('/repo').includes('--untracked-files=all'), '必须展开未跟踪目录')
    assert.ok(changesStatusArgv('/repo').includes('--porcelain=v2'), '必须用 v2（v1 把 rename 挤在一条记录里）')
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 5) 端到端：真仓库、真 git
  // ═══════════════════════════════════════════════════════════════════════
  const host = await import('../lib/index.js')
  const { handleChanges, handleDiff, handleRoute } = host.internals
  const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }

  const repo = initRepo(path.join(sandbox, 'repo'))
  write(repo, 'mod.txt', 'alpha\nbravo\ncharlie\ndelta\n')
  write(repo, 'gone.txt', 'bye\n')
  write(repo, 'renamed.txt', 'x\n'.repeat(30))
  write(repo, 'staged-del.txt', 'sd\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'init'])

  fs.appendFileSync(path.join(repo, 'mod.txt'), 'extra\n', 'utf8')
  fs.rmSync(path.join(repo, 'gone.txt'))
  git(repo, ['mv', 'renamed.txt', 'renamed-now.txt'])
  fs.rmSync(path.join(repo, 'staged-del.txt'))
  git(repo, ['add', '-A', '--', 'staged-del.txt'])
  write(repo, 'new-staged.txt', 'brand new\nsecond\n')
  git(repo, ['add', '--', 'new-staged.txt'])
  write(repo, 'untracked.txt', 'u1\nu2\n')
  write(repo, 'dir/nested.txt', 'n\n')
  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255, 254, 0, 7]))
  git(repo, ['add', '--', 'blob.bin'])

  const changesOutcome = await handleChanges(ctx, { cwd: repo })
  assert.strictEqual(changesOutcome.ok, true, `handleChanges 失败：${JSON.stringify(changesOutcome.error)}`)
  const value = changesOutcome.value
  assert.strictEqual(value.repo.branch, 'main')
  assert.strictEqual(value.countsAvailable, true)
  assert.strictEqual(value.truncated, false)

  const stagedPaths = value.sections.staged.map((row) => row.path)
  const unstagedPaths = value.sections.unstaged.map((row) => row.path)
  assert.ok(stagedPaths.includes('new-staged.txt'), '新暂存的文件要在暂存段')
  assert.ok(stagedPaths.includes('renamed-now.txt'), '重命名要在暂存段')
  assert.ok(stagedPaths.includes('staged-del.txt'), '暂存删除要在暂存段')
  assert.ok(unstagedPaths.includes('mod.txt'), '改过的文件要在更改段')
  assert.ok(unstagedPaths.includes('gone.txt'), '删掉的文件要在更改段')
  assert.ok(unstagedPaths.includes('untracked.txt'), '未跟踪要在更改段')
  assert.ok(unstagedPaths.includes('dir/nested.txt'), '-uall 必须展开未跟踪目录')
  assert.ok(!unstagedPaths.includes('dir/'), '目录本身不该作为一行')

  const modRow = value.sections.unstaged.find((row) => row.path === 'mod.txt')
  assert.strictEqual(modRow.status, 'M')
  assert.ok(modRow.added >= 1, `已跟踪文件应当有 + 计数，实到 ${JSON.stringify(modRow)}`)
  const renamedRow = value.sections.staged.find((row) => row.path === 'renamed-now.txt')
  assert.strictEqual(renamedRow.origPath, 'renamed.txt')
  assert.strictEqual(renamedRow.status, 'R')

  // 段头汇总只算拿得到计数的行。
  assert.strictEqual(value.totals.unstaged.count, value.sections.unstaged.length)
  assert.ok(value.totals.unstaged.counted < value.totals.unstaged.count, '未跟踪不计入 counted')

  // ── diff：已跟踪（未暂存）─────────────────────────────────────────────
  {
    const outcome = await handleDiff(ctx, { cwd: repo, path: 'mod.txt', section: 'unstaged' })
    assert.strictEqual(outcome.ok, true, JSON.stringify(outcome.error))
    assert.strictEqual(outcome.value.kind, 'text')
    assert.ok(outcome.value.lines.some((line) => line.kind === 'add' && line.text === 'extra'))
    assert.ok(outcome.value.lines.some((line) => line.kind === 'ctx'))
  }

  // ── diff：未跟踪（--no-index，退出码 1 是成功）────────────────────────
  {
    const outcome = await handleDiff(ctx, { cwd: repo, path: 'untracked.txt', section: 'unstaged', untracked: true })
    assert.strictEqual(outcome.ok, true, '--no-index 的退出码 1 必须被当作成功')
    assert.strictEqual(outcome.value.kind, 'text')
    const adds = outcome.value.lines.filter((line) => line.kind === 'add').map((line) => line.text)
    assert.deepStrictEqual(adds, ['u1', 'u2'], `未跟踪文件的内容应当整篇算新增：${JSON.stringify(adds)}`)
  }

  // ── diff：重命名必须认得出来（这就是要带 origPath 的理由）─────────────
  {
    const withOrig = await handleDiff(ctx, {
      cwd: repo, path: 'renamed-now.txt', origPath: 'renamed.txt', section: 'staged',
    })
    assert.strictEqual(withOrig.ok, true)
    const withoutOrig = await handleDiff(ctx, { cwd: repo, path: 'renamed-now.txt', section: 'staged' })
    // 不带原路径时 git 会退化成"整文件新增"：新增行数明显更多。
    const countAdds = (outcome) => outcome.value.lines.filter((line) => line.kind === 'add').length
    const countDels = (outcome) => outcome.value.lines.filter((line) => line.kind === 'del').length
    assert.ok(
      countAdds(withOrig) < countAdds(withoutOrig),
      `带 origPath 时应当识别成重命名（新增行更少）：带=${countAdds(withOrig)} 不带=${countAdds(withoutOrig)}`,
    )
    assert.strictEqual(countDels(withoutOrig), 0, '不带 origPath 时退化成纯新增')
  }

  // ── diff：二进制 ──────────────────────────────────────────────────────
  {
    const outcome = await handleDiff(ctx, { cwd: repo, path: 'blob.bin', section: 'staged' })
    assert.strictEqual(outcome.ok, true)
    assert.strictEqual(outcome.value.kind, 'binary', '二进制要单独成一种 kind，别硬渲染成文本')
  }

  // ── diff：路径围栏在跑 git 之前生效 ───────────────────────────────────
  {
    for (const bad of ['../../etc/passwd', '/etc/passwd', 'C:/Windows/win.ini', '-x']) {
      const outcome = await handleDiff(ctx, { cwd: repo, path: bad, section: 'unstaged' })
      assert.strictEqual(outcome.ok, false, `${bad} 必须被拒`)
      assert.strictEqual(outcome.error.code, 'bad-path')
    }
    // 未跟踪不可能出现在暂存段。
    const contradictory = await handleDiff(ctx, { cwd: repo, path: 'untracked.txt', section: 'staged', untracked: true })
    assert.strictEqual(contradictory.ok, false)
    assert.strictEqual(contradictory.error.code, 'bad-request')
  }

  // ── 空仓库（还没有提交）：两条 numstat 都不需要 HEAD，天然可用 ────────
  {
    const emptyRepo = initRepo(path.join(sandbox, 'empty-repo'))
    write(emptyRepo, 'first.txt', 'hello\n')
    const outcome = await handleChanges(ctx, { cwd: emptyRepo })
    assert.strictEqual(outcome.ok, true, `空仓库必须可用：${JSON.stringify(outcome.error)}`)
    assert.strictEqual(outcome.value.repo.initial, true)
    assert.deepStrictEqual(outcome.value.sections.unstaged.map((row) => row.path), ['first.txt'])
    // 空仓库里的未跟踪文件同样能取 diff。
    const diff = await handleDiff(ctx, { cwd: emptyRepo, path: 'first.txt', section: 'unstaged', untracked: true })
    assert.strictEqual(diff.ok, true)
    assert.strictEqual(diff.value.kind, 'text')
  }

  // ── 真冲突端到端：造一次真 merge 冲突 ──────────────────────────────────
  //
  // 这条是冲着一个具体的错答案去的：冲突文件的状态字母也是 `U`，若前端靠字母判断
  // 「是不是未跟踪」，就会拿 `--no-index /dev/null` 去跑它，把**整个文件**当成新增。
  // 那不会报错，只会给出一个错的 diff。所以要在这里跑真冲突，确认取到的是真 patch。
  {
    const conflictRepo = initRepo(path.join(sandbox, 'conflict-repo'))
    write(conflictRepo, 'shared.txt', 'base line 1\nbase line 2\nbase line 3\n')
    write(conflictRepo, 'untouched.txt', 'keep\n')
    git(conflictRepo, ['add', '-A'])
    git(conflictRepo, ['commit', '-qm', 'base'])

    git(conflictRepo, ['checkout', '-q', '-b', 'side'])
    write(conflictRepo, 'shared.txt', 'side line 1\nside line 2\nside line 3\n')
    git(conflictRepo, ['commit', '-qam', 'side'])
    git(conflictRepo, ['checkout', '-q', 'main'])
    write(conflictRepo, 'shared.txt', 'main line 1\nmain line 2\nmain line 3\n')
    git(conflictRepo, ['commit', '-qam', 'main'])
    // merge 有冲突时退出码是 1，execFileSync 会抛——这里预期它抛。
    let merged = true
    try { git(conflictRepo, ['merge', '--no-commit', 'side']) } catch (error) { merged = false }
    assert.strictEqual(merged, false, '这个 fixture 必须真的产生冲突，否则测试没有意义')

    const outcome = await handleChanges(ctx, { cwd: conflictRepo })
    assert.strictEqual(outcome.ok, true, JSON.stringify(outcome.error))
    const conflictRows = outcome.value.sections.conflicts
    assert.strictEqual(conflictRows.length, 1, `冲突文件必须被列出来：${JSON.stringify(outcome.value.sections)}`)
    const row = conflictRows[0]
    assert.strictEqual(row.path, 'shared.txt')
    assert.strictEqual(row.status, 'U')
    assert.strictEqual(row.untracked, false, '冲突文件不是未跟踪文件')
    // 冲突文件不应同时出现在「更改」段里被当成未跟踪。
    assert.strictEqual(
      outcome.value.sections.unstaged.some((candidate) => candidate.path === 'shared.txt'),
      false,
      '冲突文件不该再落进普通「更改」段',
    )

    // 取它的 diff：走 untracked 就会退化成"整个文件新增"（**每一行都是 add、一行 context 都没有**）。
    // 走 `diff HEAD` 则 HEAD 那三行是 **context**，只有冲突标记与对方的内容是 add。
    // 所以判据要用「有没有 context 行」，而不是「有没有删除行」——这个 fixture 下
    // 工作树 = HEAD 内容 + 冲突标记 + 对方内容，本来就不该有删除行。
    const diff = await handleDiff(ctx, {
      cwd: conflictRepo, path: 'shared.txt', section: 'unstaged', unmerged: true,
    })
    assert.strictEqual(diff.ok, true, JSON.stringify(diff.error))
    assert.strictEqual(diff.value.kind, 'text', `冲突文件要能逐行显示：${JSON.stringify(diff.value).slice(0, 200)}`)
    const ctxLines = diff.value.lines.filter((line) => line.kind === 'ctx')
    assert.ok(
      ctxLines.length >= 3,
      `必须对 HEAD 比较（有 context 行）；走 --no-index 的话全是 add：${JSON.stringify(diff.value.lines.slice(0, 6))}`,
    )
    assert.ok(
      diff.value.lines.some((line) => line.kind === 'add' && line.text.includes('<<<<<<<')),
      '工作树里的冲突标记要如实显示出来',
    )
    assert.ok(
      !diff.value.lines.some((line) => line.kind === 'add' && line.text === 'main line 1'),
      'HEAD 已有的内容不该被当成新增（那正是走错命令的症状）',
    )

    // 纵深防御：不带 unmerged 时拿到的会是 git 的 combined diff（`@@@`），
    // 解析器读不懂它 → 必须**如实说 combined**，而不是当成"没有改动"回一个空数组。
    // 这个不报错的空答案真出现过（冲突文件 diff 一片空白）。
    const withoutFlag = await handleDiff(ctx, { cwd: conflictRepo, path: 'shared.txt', section: 'unstaged' })
    assert.strictEqual(withoutFlag.ok, true)
    assert.strictEqual(withoutFlag.value.kind, 'combined', '认不出来的格式要自报家门，不能假装没有改动')
  }

  // ── 上限：MAX_ROWS 之上要如实上报截断 ─────────────────────────────────
  {
    const many = parseStatusV2([
      '# branch.head main',
      ...Array.from({ length: MAX_ROWS + 5 }, (_, index) => `? f${index}.txt`),
      '',
    ].join(NUL))
    assert.strictEqual(many.records.length, MAX_ROWS)
    assert.strictEqual(many.truncated, true)
  }

  // ── 路由分发 ──────────────────────────────────────────────────────────
  {
    const fakeRes = () => {
      const state = { status: 0, body: '' }
      return {
        state,
        writeHead(status) { state.status = status },
        end(text) { state.body = text === undefined || text === null ? '' : String(text) },
      }
    }
    const fakeReq = (body) => ({
      method: 'POST',
      headers: { 'sec-fetch-site': 'same-origin', host: '127.0.0.1:3080' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(body, 'utf8') },
    })
    const envelope = (method, payload) => JSON.stringify({ type: 'client-request', rpcId: 'r1', method, payload })

    const graphRes = fakeRes()
    await handleRoute(ctx, fakeReq(envelope('graph', { cwd: repo, max: 50 })), graphRes)
    const graphBody = JSON.parse(graphRes.state.body)
    assert.strictEqual(graphBody.result.ok, true, 'graph 分支未受影响')
    assert.ok(Array.isArray(graphBody.result.value.commits), 'graph 仍回提交数组')
    assert.strictEqual(graphBody.result.value.commits.length, 1, '本 fixture 只造了一个提交')

    const changesRes = fakeRes()
    await handleRoute(ctx, fakeReq(envelope('changes', { cwd: repo })), changesRes)
    const changesBody = JSON.parse(changesRes.state.body)
    assert.strictEqual(changesBody.result.ok, true)
    assert.deepStrictEqual(
      Object.keys(changesBody.result.value.sections).sort(),
      ['conflicts', 'staged', 'unstaged'],
      '新 method 必须回三段清单',
    )

    const diffRes = fakeRes()
    await handleRoute(ctx, fakeReq(envelope('diff', { cwd: repo, path: 'mod.txt', section: 'unstaged' })), diffRes)
    assert.strictEqual(JSON.parse(diffRes.state.body).result.value.kind, 'text')

    // 未知 method：明确报错，而不是当成 graph 静默跑一遍。
    const bogusRes = fakeRes()
    await handleRoute(ctx, fakeReq(envelope('nope', { cwd: repo })), bogusRes)
    const bogus = JSON.parse(bogusRes.state.body)
    assert.strictEqual(bogus.result.ok, false)
    assert.strictEqual(bogus.result.error.code, 'bad-method')

    // 老客户端不发 method：必须仍然按 graph 走（向后兼容）。
    const legacyRes = fakeRes()
    await handleRoute(ctx, fakeReq(JSON.stringify({
      type: 'client-request', rpcId: 'r2', payload: { cwd: repo, max: 2 },
    })), legacyRes)
    assert.strictEqual(JSON.parse(legacyRes.state.body).result.ok, true)
    assert.ok(Array.isArray(JSON.parse(legacyRes.state.body).result.value.commits), '缺 method 时默认 graph')
  }

  console.log(`changes.test.cjs: OK (sandbox=${sandbox})`)
}

async function cleanup() {
  try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch (error) { /* Windows 上偶发句柄占用 */ }
}

main()
  .then(cleanup)
  .catch(async (error) => {
    console.error(error)
    await cleanup()
    process.exit(1)
  })
