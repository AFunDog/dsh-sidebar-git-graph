/**
 * 关联工作树（`git worktree add`）测试：解析 + 只读不变量 + 在真仓库上的端到端。
 *
 * 为什么必须有独立的一条：这是**只按文件系统扫盘永远测不出来**的一类仓库。
 * 关联工作树在目录上可以与主工作区毫无关系（实测是两个兄弟目录），
 * 而它的 `.git` 只是一个**文件**。`lib/repos.js` 的「`.git` 在不在」判据覆盖不到，
 * 所以必须有这条测试盯着「git 的权威清单被真的读了、真的用上了」。
 *
 * 三块：
 *   1. **只读不变量**——`worktree` 的写子命令（add/remove/prune/lock/move）一旦进 argv 就红；
 *   2. **解析**——喂实测出来的真字节（含空格路径 / 分离头 / locked / prunable / bare）；
 *   3. **端到端**——在 %TEMP% 里造 6 种形态的真工作树，跑真的宿主半，
 *      断言围栏放行/拒绝的**方向**（这是本次唯一放松安全边界的地方，两个方向都要钉）。
 *
 * 跑法：node test/worktrees.test.cjs
 */
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

/** 造临时沙箱；绝不碰用户的真实仓库（项目记忆 PIT-010 的教训）。 */
function makeSandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zgg-worktree-test-'))
}

/** 跑一条 git 命令（同步、失败抛错）。 */
function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 初始化一个带着首个提交的仓库。 */
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  execFileSync('git', ['init', '-q', dir])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'test'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n', 'utf8')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-qm', 'init'])
  return dir
}

async function main() {
  const worktrees = await import('../lib/worktrees.js')
  const { parseWorktrees, listableWorktrees, worktreeListArgv, worktreePathSet } = worktrees
  /** 逐字节样本里用的 NUL（`-z` 形态的记录内字段分隔符）。 */
  const Z = '\u0000'

  // ═══════════════════════════════════════════════════════════════════════
  // 1) 只读不变量：本模块只准构造 `worktree list`
  // ═══════════════════════════════════════════════════════════════════════
  {
    const WRITE = new Set(['add', 'remove', 'prune', 'lock', 'unlock', 'move', 'repair'])
    const argv = worktreeListArgv('/repo')
    const positional = []
    for (let index = 0; index < argv.length; index += 1) {
      const token = argv[index]
      if (token === '-C' || token === '-c') { index += 1; continue }
      if (token.startsWith('-')) continue
      positional.push(token)
    }
    assert.deepStrictEqual(
      positional,
      ['worktree', 'list'],
      '这一层只准构造 worktree list；写子命令（add/remove/prune/lock/move）一旦进来就是违背只读承诺',
    )
    for (const token of positional) {
      assert.ok(!WRITE.has(token), `argv 里出现了写子命令 ${token}`)
    }
    // `-z` 必须在：没有它 git 会给含特殊字符的路径加引号，解析层就得自己解码。
    assert.ok(argv.includes('-z'), '必须带 -z：路径不去引号转义，含空格/非 ASCII 的路径才不用解码')
    assert.ok(argv.includes('--porcelain'), '必须用 porcelain 形态：给机器读，形状稳定')
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 2) 解析：实测真字节（-z 形态）
  // ═══════════════════════════════════════════════════════════════════════
  {
    // 逐字节照抄 2026-09-30 在本机 git 2.49.0.windows.1 上 dump 出来的形状。
    const raw = [
      `worktree C:/ws/repo${Z}HEAD ${'a'.repeat(40)}${Z}branch refs/heads/main${Z}${Z}`,
      `worktree C:/ws/detached${Z}HEAD ${'b'.repeat(40)}${Z}detached${Z}${Z}`,
      `worktree C:/ws/gone${Z}HEAD ${'c'.repeat(40)}${Z}branch refs/heads/b/gone${Z}prunable gitdir file points to non-existent location${Z}${Z}`,
      `worktree C:/ws/locked${Z}HEAD ${'d'.repeat(40)}${Z}branch refs/heads/b/z${Z}locked${Z}${Z}`,
      `worktree C:/ws/with space${Z}HEAD ${'e'.repeat(40)}${Z}branch refs/heads/feat/x${Z}${Z}`,
      `worktree /home/me/项目${Z}HEAD ${'f'.repeat(40)}${Z}branch refs/heads/中文分支${Z}${Z}`,
    ].join('')

    const parsed = parseWorktrees(raw)
    assert.strictEqual(parsed.length, 6, `六条记录都该解析出来，实到 ${parsed.length}`)

    // 主工作树必须排在第一个（git 文档保证），调用方靠这个认「哪个是主工作树」。
    assert.strictEqual(parsed[0].path, 'C:/ws/repo')
    assert.strictEqual(parsed[0].branch, 'main', 'branch 行给的是全名，必须剥掉 refs/heads/')
    assert.strictEqual(parsed[0].detached, false)
    assert.strictEqual(parsed[0].prunable, false)

    // 含空格的路径：`-z` 的意义就在这里，绝不能被切开。
    assert.strictEqual(parsed[4].path, 'C:/ws/with space', '含空格的路径必须原样保留')
    assert.strictEqual(parsed[4].branch, 'feat/x')

    // 非 ASCII 路径与分支名。
    assert.strictEqual(parsed[5].path, '/home/me/项目')
    assert.strictEqual(parsed[5].branch, '中文分支')

    // 分离头：git 不给 branch 行，要显式标出来而不是"字段丢了"。
    assert.strictEqual(parsed[1].detached, true)
    assert.strictEqual(parsed[1].branch, null)

    // prunable 与 locked 是**两回事**：前者目录已不在，后者内容完全可读。
    assert.strictEqual(parsed[2].prunable, true)
    assert.match(parsed[2].prunableReason, /non-existent/)
    assert.strictEqual(parsed[2].locked, false)
    assert.strictEqual(parsed[3].locked, true)
    assert.strictEqual(parsed[3].prunable, false)

    // 过滤：prunable 出局，locked 留下（锁只禁止 worktree remove）。
    const listable = listableWorktrees(parsed)
    assert.strictEqual(listable.length, 5, 'prunable 的那条必须被剔除')
    assert.ok(!listable.some((entry) => entry.path === 'C:/ws/gone'))
    assert.ok(listable.some((entry) => entry.path === 'C:/ws/locked'), 'locked 的工作树内容可读，必须留下')

    // 带原因的 locked / prunable 也要认出来（`locked because…`）。
    const withReasons = parseWorktrees(
      `worktree /x${Z}HEAD ${'a'.repeat(40)}${Z}branch refs/heads/m${Z}locked because reasons${Z}${Z}`
      + `worktree /y${Z}HEAD ${'b'.repeat(40)}${Z}branch refs/heads/n${Z}bare${Z}${Z}`,
    )
    assert.strictEqual(withReasons[0].locked, true, '`locked <原因>` 这种带原因的形态也要认')
    assert.strictEqual(withReasons[1].bare, true, 'bare 条目要标出来')
    assert.strictEqual(listableWorktrees(withReasons).length, 1, 'bare 没有工作树可画，必须剔除')
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 3) 解析：容错（畸形输入一律不抛错）
  // ═══════════════════════════════════════════════════════════════════════
  {
    assert.deepStrictEqual(parseWorktrees(''), [])
    assert.deepStrictEqual(parseWorktrees(undefined), [])
    assert.deepStrictEqual(parseWorktrees(null), [])
    // 没有 worktree 行 → 不是一条工作树记录，丢掉而不是造一个 path 为空的条目。
    assert.deepStrictEqual(parseWorktrees(`HEAD ${'a'.repeat(40)}${Z}branch refs/heads/main${Z}${Z}`), [])
    // 未知字段（git 以后加字段）不该让解析崩。
    const unknown = parseWorktrees(`worktree /z${Z}HEAD ${'a'.repeat(40)}${Z}branch refs/heads/m${Z}something-new${Z}${Z}`)
    assert.strictEqual(unknown.length, 1)
    assert.strictEqual(unknown[0].path, '/z')
    // HEAD 不是 sha（异常）时置 null，而不是把垃圾当 sha 发出去。
    assert.strictEqual(parseWorktrees(`worktree /z${Z}HEAD not-a-sha${Z}branch refs/heads/m${Z}${Z}`)[0].head, null)

    // 人类可读形态（非 -z）也要能读：兜底路径与单测都靠它。
    const pretty = parseWorktrees(
      'worktree /ws/a\nHEAD ' + 'a'.repeat(40) + '\nbranch refs/heads/main\n\n'
      + 'worktree /ws/b\nHEAD ' + 'b'.repeat(40) + '\ndetached\n\n',
    )
    assert.strictEqual(pretty.length, 2)
    assert.strictEqual(pretty[0].branch, 'main')
    assert.strictEqual(pretty[1].detached, true)
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 4) 路径集合（围栏用的判据）
  // ═══════════════════════════════════════════════════════════════════════
  {
    const entries = [
      { path: 'C:\\ws\\a', prunable: false, bare: false },
      { path: 'C:\\ws\\GONE', prunable: true, bare: false },
      { path: 'C:\\ws\\bare', prunable: false, bare: true },
    ]
    // 大小写归一是 Windows 上的现实需要：git 给正斜杠、浏览器可能给反斜杠，
    // 不规范化就会出现「同一个目录两种写法」→ 去重失效、围栏误拒。
    const normalize = (value) => String(value).replace(/\//g, '\\').toLowerCase()
    const set = worktreePathSet(entries, normalize)
    assert.ok(set.has('c:\\ws\\a'))
    assert.ok(!set.has('c:\\ws\\gone'), 'prunable 的不能进围栏白名单')
    assert.ok(!set.has('c:\\ws\\bare'), 'bare 的不能进围栏白名单')
    assert.strictEqual(worktreePathSet(null, normalize).size, 0, '空输入不该崩')
  }

  // ═══════════════════════════════════════════════════════════════════════
  // 5) 端到端：在真仓库上跑真的宿主半
  // ═══════════════════════════════════════════════════════════════════════
  const sandbox = makeSandbox()
  try {
    const host = await import('../lib/index.js')
    const { handleGraph, handleChanges } = host.internals

    const mainRepo = initRepo(path.join(sandbox, 'main'))
    const sibling = path.join(sandbox, 'sibling-wt')            // 目录外的关联工作树（用户报的那一类）
    const inside = path.join(mainRepo, '.worktrees', 'inside')  // 工作区**内部**的关联工作树
    const lockedWt = path.join(sandbox, 'locked-wt')
    const goneWt = path.join(sandbox, 'gone-wt')
    const unrelated = initRepo(path.join(sandbox, 'elsewhere', 'unrelated'))

    git(mainRepo, ['branch', 'feat/x'])
    git(mainRepo, ['worktree', 'add', '-q', sibling, 'feat/x'])
    git(mainRepo, ['worktree', 'add', '-q', inside, '-b', 'inside/wt'])
    git(mainRepo, ['worktree', 'add', '-q', lockedWt, '-b', 'locked/wt'])
    git(mainRepo, ['worktree', 'lock', lockedWt])
    git(mainRepo, ['worktree', 'add', '-q', goneWt, '-b', 'gone/wt'])
    fs.rmSync(goneWt, { recursive: true, force: true })   // 目录删掉 → git 标 prunable

    // 本机没有工作区表，所以走「claimed-unfenced」兜底：cwd 直接被信。
    const ctx = { get: () => undefined, logger: { info() {}, warn() {}, error() {} } }
    // 比对路径先归一：Windows 上大小写与分隔符都可能不同（git 给正斜杠、返回值可能是反斜杠）。
    const norm = (value) => path.resolve(value).toLowerCase()
    const samePath = (left, right) => norm(left) === norm(right)
    /** 清单里所有仓库根的归一化集合，用来断言"某个目录在不在清单里"。 */
    const rootsOf = (value) => value.repos.map((entry) => norm(entry.root))
    /** 清单里属于 `dir` 的那一项。 */
    const entryOf = (value, dir) => value.repos.find((entry) => samePath(entry.root, dir))

    // ── ① 从主工作区：目录外的关联工作树必须**点和没点都对** ──────────────
    {
      const auto = await handleGraph(ctx, { cwd: mainRepo, max: 5 })
      assert.strictEqual(auto.ok, true, JSON.stringify(auto.error))
      const roots = rootsOf(auto.value)
      assert.ok(
        roots.includes(norm(sibling)),
        `目录外的关联工作树必须出现在仓库清单里：${JSON.stringify(auto.value.repos.map((r) => r.root))}`,
      )
      assert.ok(roots.includes(norm(inside)), '工作区内部的关联工作树也要列出')
      assert.ok(roots.includes(norm(lockedWt)), 'locked 的工作树内容可读，必须列出')
      assert.ok(!roots.includes(norm(goneWt)), 'prunable（目录已不在）的不该列出')

      // 每个工作树条目都要标出**自己的**分支——这正是"分不清两个工作树"的解药。
      const siblingEntry = entryOf(auto.value, sibling)
      assert.strictEqual(siblingEntry.kind, 'worktree', '关联工作树必须标成 worktree 而不是普通 repo')
      assert.strictEqual(siblingEntry.branch, 'feat/x', '工作树条目要带它自己的分支')
      assert.strictEqual(siblingEntry.main, false)
      assert.strictEqual(entryOf(auto.value, inside).branch, 'inside/wt')
      assert.strictEqual(entryOf(auto.value, mainRepo).main, true, '主工作树要被标出来（git 保证它排在第一个）')
      assert.strictEqual(entryOf(auto.value, lockedWt).locked, true, '被 lock 的工作树要标出来')

      // 摘要：总数与列出数都要如实给（"我有 6 个、页面 5 个"不能说漏）。
      assert.strictEqual(auto.value.worktrees.total, 5, `git 报 5 个工作树，实到 ${auto.value.worktrees.total}`)
      assert.strictEqual(auto.value.worktrees.listed, 4, 'prunable 的那个不进列表')
      assert.strictEqual(auto.value.worktrees.prunable.length, 1)

      // 点名目录外的那个 → 必须被接受，且**不是** fallback（修好之前这里全是 fallback）。
      const picked = await handleGraph(ctx, { cwd: mainRepo, repo: sibling, max: 5 })
      assert.strictEqual(picked.ok, true, JSON.stringify(picked.error))
      assert.ok(
        samePath(picked.value.repo.root, sibling),
        '点名一个**同一个仓库的关联工作树**必须被接受——这是本次要修的核心',
      )
      assert.strictEqual(picked.value.selection.source, 'requested')
      assert.strictEqual(picked.value.selection.fallback, false)
      assert.strictEqual(picked.value.selection.reason, null)

      // 画出来的必须是**那个工作树自己的**状态，不能串味。
      assert.strictEqual(picked.value.repo.branch, 'feat/x', '要画被点名工作树自己的分支')
      const mainGraph = await handleGraph(ctx, { cwd: mainRepo, repo: mainRepo, max: 5 })
      assert.strictEqual(mainGraph.value.repo.branch, 'main')
      assert.notStrictEqual(picked.value.commits.length, 0)
    }

    // ── ② 围栏的**拒绝方向**：不能因为支持工作树就把别的仓库也放进来 ────────
    {
      const faraway = await handleGraph(ctx, { cwd: mainRepo, repo: unrelated, max: 5 })
      assert.strictEqual(faraway.ok, true)
      assert.ok(
        !samePath(faraway.value.repo.root, unrelated),
        '无关仓库必须仍然被拒——围栏放松的只有"同一个仓库的另一个工作树"这一条',
      )
      assert.strictEqual(faraway.value.selection.fallback, true)
      assert.strictEqual(faraway.value.selection.reason, 'fenced', '被围栏拒的理由要说准，不能一律说"仓库不在了"')

      // prunable 的目录已不在 → reason 必须是 prunable（而不是"被围栏拒"）。
      const pruned = await handleGraph(ctx, { cwd: mainRepo, repo: goneWt, max: 5 })
      assert.strictEqual(pruned.value.selection.fallback, true)
      assert.strictEqual(pruned.value.selection.reason, 'prunable', '被删掉的工作树要说成 prunable，而不是"出围栏"')

      // 压根不存在的路径 → missing。
      const ghost = await handleGraph(ctx, { cwd: mainRepo, repo: path.join(sandbox, 'nope'), max: 5 })
      assert.strictEqual(ghost.value.selection.reason, 'missing')

      // 仓库里的普通子目录 → not-root。
      fs.mkdirSync(path.join(mainRepo, 'sub'), { recursive: true })
      const sub = await handleGraph(ctx, { cwd: mainRepo, repo: path.join(mainRepo, 'sub'), max: 5 })
      assert.strictEqual(sub.value.selection.reason, 'not-root')
    }

    // ── ③ 反向：工作区**就是**那个关联工作树时，主工作区也必须可选 ──────────
    {
      const fromWt = await handleGraph(ctx, { cwd: sibling, max: 5 })
      assert.strictEqual(fromWt.ok, true, JSON.stringify(fromWt.error))
      assert.strictEqual(fromWt.value.repo.branch, 'feat/x', '要画这个工作树自己的分支')
      const roots = rootsOf(fromWt.value)
      assert.ok(
        roots.includes(norm(mainRepo)),
        `从关联工作树出发时，主工作树也必须在清单里（不能只有它自己）：${JSON.stringify(fromWt.value.repos.map((r) => r.root))}`,
      )
      // 且真的能切过去。
      const back = await handleGraph(ctx, { cwd: sibling, repo: mainRepo, max: 5 })
      assert.strictEqual(back.value.selection.source, 'requested', '从工作树切回主工作区也必须被放行')
      assert.strictEqual(back.value.repo.branch, 'main')
    }

    // ── ④ 每个工作树的状态各自独立（实测主 3 个改动 / 工作树 17 个，不能共用一份）──
    {
      fs.appendFileSync(path.join(mainRepo, 'a.txt'), 'main change\n', 'utf8')
      fs.writeFileSync(path.join(sibling, 'b.txt'), 'sibling only\n', 'utf8')

      const mainChanges = await handleChanges(ctx, { cwd: mainRepo })
      const wtChanges = await handleChanges(ctx, { cwd: sibling })
      assert.strictEqual(mainChanges.ok, true, JSON.stringify(mainChanges.error))
      assert.strictEqual(wtChanges.ok, true, JSON.stringify(wtChanges.error))

      const mainPaths = mainChanges.value.sections.unstaged.map((row) => row.path)
      const wtPaths = wtChanges.value.sections.unstaged.map((row) => row.path)
      assert.ok(mainPaths.includes('a.txt'), `主工作区该看到 a.txt 的改动：${JSON.stringify(mainPaths)}`)
      assert.ok(!mainPaths.includes('b.txt'), '主工作区**不该**看到关联工作树里新建的文件')
      assert.ok(wtPaths.includes('b.txt'), `关联工作树该看到自己新建的 b.txt：${JSON.stringify(wtPaths)}`)
      assert.ok(!wtPaths.includes('a.txt'), '关联工作树**不该**看到主工作区改的 a.txt')

      // changes 也要带仓库清单：下拉框以前只挂在 graph 载荷上，graph 一失败就整个消失。
      assert.ok(Array.isArray(mainChanges.value.repos) && mainChanges.value.repos.length > 1,
        'changes 载荷必须也带 repos，否则 graph 失败时仓库下拉会一起消失')
      assert.ok(mainChanges.value.repos.some((entry) => entry.kind === 'worktree'))
      assert.strictEqual(typeof mainChanges.value.reposTruncated, 'boolean')
    }

    // ── ⑤ 单工作树的普通仓库：行为一字不变（不能为了新功能伤到老路径）────────
    {
      const solo = initRepo(path.join(sandbox, 'solo'))
      const out = await handleGraph(ctx, { cwd: solo, max: 5 })
      assert.strictEqual(out.ok, true)
      assert.strictEqual(out.value.repos.length, 1, '只有一个工作树时清单里就该只有它')
      assert.strictEqual(out.value.repos[0].kind, 'worktree')
      assert.strictEqual(out.value.repos[0].main, true)
      assert.strictEqual(out.value.selection.fallback, false)
      assert.strictEqual(out.value.worktrees.total, 1)
      assert.strictEqual(out.value.worktrees.listed, 1)
    }
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch (error) { /* Windows 上偶发占用，忽略 */ }
  }

  console.log('worktrees.test.cjs: OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
