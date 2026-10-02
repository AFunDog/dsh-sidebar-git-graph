/**
 * 「跟随会话 worktree」联动的端到端测试（`@zeng/dsh-session-worktree` → 本插件）。
 *
 * 在系统临时目录里造**两个真仓库**，用假 ctx 模拟对方插件提供的
 * `sessionWorktree` 服务，逐档断言仓库优先级：
 *
 *     1. `payload.repo`          —— 用户本次手点
 *     2. **会话 worktree 标签**  —— 本次新增的联动
 *     3. `payload.repoHint`      —— 客户端上次记住的
 *     4. cwd 所在仓库            —— 原来的默认行为
 *     5. 扫盘第一个仓库          —— 原来的兜底
 *
 * 重点覆盖三件容易静默做错的事：
 *   ① **档 3 必须真的低于档 2** —— 否则 localStorage 的旧记忆会永远压过标签，
 *      联动等于没做（这正是客户端把 `repo` 降级成 `repoHint` 的原因）；
 *   ② **服务缺席时行为必须逐字不变** —— 没装 / 停用的用户不该有任何感知；
 *   ③ **标签也要过围栏** —— 跨插件的数据一样不可信，过不了要如实说原因，
 *      绝不能静默换一个仓库还不吭声。
 *
 * DSH_HOME 指向临时目录，避免读到真实的工作区表。
 * 跑法：node test/session-worktree-link.test.cjs
 */
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zgg-link-test-'))
process.env.DSH_HOME = path.join(sandbox, 'home')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 造一个最小仓库（能画就行）。 */
function initRepo(dir, name) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init'])
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(dir, ['config', 'user.name', 'Test User'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  git(dir, ['config', 'core.autocrlf', 'false'])
  fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n', 'utf8')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', `init ${name}`])
  return dir
}

/**
 * 假 ctx：`get(name)` 按表返回。
 * `service === undefined` 表示「对方插件没装 / 被停用」。
 */
function fakeCtx(services) {
  const table = services === undefined ? {} : services
  return {
    get(name) { return table[name] },
    logger: { info() {}, warn() {} },
  }
}

/** 造一个「session-worktree 插件」的服务对象。 */
function swService(pick) {
  return {
    version: 1,
    selection(sessionId) {
      if (typeof pick === 'function') return pick(sessionId)
      return pick
    },
  }
}

async function main() {
  const host = await import('../lib/index.js')
  const { handleGraph } = host.internals

  const ws = path.join(sandbox, 'ws')
  // 锚点仓库（工作区根自己）+ 工作区里的一个嵌套独立仓库。
  const anchorRepo = initRepo(ws, 'ws')
  const innerRepo = initRepo(path.join(ws, 'vendor', 'plugin'), 'plugin')

  // 工作区**之外**的仓库：标签指向它时必须被围栏拒绝。
  const outsideRepo = initRepo(path.join(sandbox, 'outside'), 'outside')

  // 锚点仓库的**关联工作树**，在**工作区之外**（兄弟目录）。
  //
  // ⚠️ 必须在**任何** handleGraph 调用之前建好：宿主对 `git worktree list` 有 8 秒缓存
  // （SCAN_TTL_MS），中途新建工作树会让缓存里的清单过期，测试就测的是缓存而不是围栏了
  // —— 这正是第一次写这个测试时踩到的。
  const linked = path.join(sandbox, 'ws-linked')
  git(ws, ['worktree', 'add', '-q', '-b', 'wt/linked', linked])

  const canon = (value) => {
    try { return fs.realpathSync.native(value) } catch { return path.resolve(value) }
  }

  // ── 档 4：没有标签、没有点名、没有提示 ⇒ 原来的行为（cwd 所在仓库）──────────
  {
    const out = await handleGraph(fakeCtx(), { cwd: ws })
    assert.strictEqual(out.ok, true)
    assert.strictEqual(out.value.repo.root, canon(anchorRepo), '无标签时画 cwd 所在仓库')
    assert.strictEqual(out.value.selection.source, 'cwd')
    assert.strictEqual(out.value.selection.tagApplied, false)
    assert.strictEqual(out.value.selection.tagged, null, '没有标签时 tagged 必须是 null')
    assert.ok(out.value.schema >= 2, '载荷要带形状版本（>= 2）')
  }

  // ── 档 2：标签生效（用户没手点）─────────────────────────────────────────────
  {
    const ctx = fakeCtx({ sessionWorktree: swService({ path: innerRepo, branch: 'main', repoRoot: innerRepo, anchor: false }) })
    const out = await handleGraph(ctx, { cwd: ws, sessionId: 'session-1' })
    assert.strictEqual(out.ok, true)
    assert.strictEqual(out.value.repo.root, canon(innerRepo), '应当跟随会话标签')
    assert.strictEqual(out.value.selection.source, 'session-worktree')
    assert.strictEqual(out.value.selection.tagApplied, true)
    assert.strictEqual(out.value.selection.tagged, innerRepo)
    assert.strictEqual(out.value.repos.find((entry) => entry.current === true).root, canon(innerRepo))
  }

  // ── 档 3 必须真的低于档 2（本次联动的关键）─────────────────────────────────
  {
    // 客户端 localStorage 里记着**锚点仓库**（旧行为下它会以 `repo` 点名发出来，
    // 从而永远赢过标签）。现在它是 `repoHint`，必须输给标签。
    const ctx = fakeCtx({ sessionWorktree: swService({ path: innerRepo, branch: 'main', repoRoot: innerRepo, anchor: false }) })
    const out = await handleGraph(ctx, { cwd: ws, sessionId: 'session-1', repoHint: anchorRepo })
    assert.strictEqual(out.value.repo.root, canon(innerRepo), '标签必须赢过 repoHint（否则联动等于没做）')
    assert.strictEqual(out.value.selection.source, 'session-worktree')
  }

  // ── 档 1 最高：用户手点必须赢过标签 ────────────────────────────────────────
  {
    const ctx = fakeCtx({ sessionWorktree: swService({ path: innerRepo, branch: 'main', repoRoot: innerRepo, anchor: false }) })
    const out = await handleGraph(ctx, { cwd: ws, sessionId: 'session-1', repo: anchorRepo })
    assert.strictEqual(out.value.repo.root, canon(anchorRepo), '手点的仓库必须赢过标签')
    assert.strictEqual(out.value.selection.source, 'requested')
    assert.strictEqual(out.value.selection.tagApplied, false, '没跟标签走就不要说跟了')
  }

  // ── 档 3 在没有标签时仍然生效（旧记忆不能因为加了联动就失效）───────────────
  {
    const out = await handleGraph(fakeCtx(), { cwd: ws, repoHint: innerRepo })
    assert.strictEqual(out.value.repo.root, canon(innerRepo), '没有标签时 repoHint 仍然顶用')
    assert.strictEqual(out.value.selection.source, 'hint')
  }

  // ── 服务缺席 / 形状不符 ⇒ 行为必须与「没有这个功能」逐字一致 ────────────────
  {
    const baseline = await handleGraph(fakeCtx(), { cwd: ws, sessionId: 'session-1' })

    const cases = [
      ['服务缺席（没装 / 已停用）', {}],
      ['服务是 null', { sessionWorktree: null }],
      ['服务不是对象', { sessionWorktree: 42 }],
      ['缺 version', { sessionWorktree: { selection: () => ({ path: innerRepo }) } }],
      ['version 不认识', { sessionWorktree: { version: 99, selection: () => ({ path: innerRepo }) } }],
      ['缺 selection 方法', { sessionWorktree: { version: 1 } }],
      ['selection 不是函数', { sessionWorktree: { version: 1, selection: 'nope' } }],
      ['selection 返回 undefined（存储还没读到）', { sessionWorktree: swService(undefined) }],
      ['selection 返回 null（明确没选）', { sessionWorktree: swService(null) }],
      ['selection 返回空路径', { sessionWorktree: swService({ path: '' }) }],
      ['selection 抛错', { sessionWorktree: { version: 1, selection() { throw new Error('boom') } } }],
    ]
    for (const [label, services] of cases) {
      const out = await handleGraph(fakeCtx(services), { cwd: ws, sessionId: 'session-1' })
      assert.strictEqual(out.ok, true, `${label}：不该让请求失败`)
      assert.strictEqual(out.value.repo.root, baseline.value.repo.root, `${label}：画错仓库了`)
      assert.strictEqual(out.value.selection.source, 'cwd', `${label}：应回退到原行为`)
    }
  }

  // ── 标签也要过围栏（跨插件数据一样不可信）──────────────────────────────────
  {
    // 工作区**之外**的仓库：与 `repo` 点名同一套闸，必须拒。
    const ctx = fakeCtx({ sessionWorktree: swService({ path: outsideRepo, branch: 'main', repoRoot: outsideRepo, anchor: false }) })
    const out = await handleGraph(ctx, { cwd: ws, sessionId: 'session-1' })
    assert.strictEqual(out.ok, true)
    assert.strictEqual(out.value.repo.root, canon(anchorRepo), '标签指向工作区之外的仓库必须被拒')
    assert.strictEqual(out.value.selection.tagApplied, false)
    assert.strictEqual(out.value.selection.tagReason, 'fenced', '要如实说被围栏拒了')
    assert.strictEqual(out.value.selection.tagged, outsideRepo, '要说清标签指的是哪里')
  }

  {
    // 目录已不存在。
    const ctx = fakeCtx({ sessionWorktree: swService({ path: path.join(ws, 'gone'), branch: null, repoRoot: null, anchor: true }) })
    const out = await handleGraph(ctx, { cwd: ws, sessionId: 'session-1' })
    assert.strictEqual(out.value.selection.tagReason, 'missing')
  }

  {
    // 路径存在但不是仓库根（普通子目录）。
    const subdir = path.join(ws, 'vendor')
    const ctx = fakeCtx({ sessionWorktree: swService({ path: subdir, branch: null, repoRoot: null, anchor: true }) })
    const out = await handleGraph(ctx, { cwd: ws, sessionId: 'session-1' })
    assert.strictEqual(out.value.selection.tagReason, 'not-root')
  }

  // ── 关联工作树：标签指向**工作区之外**的本仓库工作树，必须放行 ──────────────
  {
    // 这是本次扩展要支持的一类：`git worktree add` 出来的工作树可以是兄弟目录。
    // （工作树在 main() 开头就建好了，见那里的注释——不能在建好缓存之后才建。）
    const ctx = fakeCtx({ sessionWorktree: swService({ path: linked, branch: 'wt/linked', repoRoot: ws, anchor: false }) })
    const out = await handleGraph(ctx, { cwd: ws, sessionId: 'session-1' })
    assert.strictEqual(out.ok, true)
    assert.strictEqual(out.value.repo.root, canon(linked), '本仓库的关联工作树必须能跟')
    assert.strictEqual(out.value.selection.source, 'session-worktree')
    assert.strictEqual(out.value.selection.tagApplied, true)
  }

  // ── changes 载荷也带形状版本 ───────────────────────────────────────────────
  {
    const { handleChanges } = host.internals
    const out = await handleChanges(fakeCtx(), { cwd: ws })
    assert.strictEqual(out.ok, true)
    assert.ok(out.value.schema >= 2)
  }

  console.log(`session-worktree-link.test.cjs: OK (ws=${ws})`)
}

async function cleanup() {
  // 关联工作树要先删掉，否则 rmSync 可能因句柄占用失败。
  try { git(path.join(sandbox, 'ws'), ['worktree', 'prune']) } catch { /* 尽力而为 */ }
  try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch { /* Windows 上偶发句柄占用 */ }
}

main()
  .then(cleanup)
  .catch(async (error) => {
    console.error(error)
    await cleanup()
    process.exit(1)
  })
