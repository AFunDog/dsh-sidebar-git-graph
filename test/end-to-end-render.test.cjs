/**
 * 跨两半的端到端渲染测试：**真实的宿主输出** → 喂进**真实的渲染路径**。
 *
 * 为什么需要这一条：已有的测试分两类，各自都绿，但**没有一条跨过中间那道缝**——
 *   - changes.test.cjs 测宿主半：真仓库、真 git，断言返回的 JSON 形状；
 *   - render-smoke.test.cjs 测浏览器半：喂**手写**的载荷，断言不崩。
 * 两边用的载荷形状都是我**想象**出来的。真实宿主多一个字段、少一个字段、
 * 或者某个字段是 null，两边都发现不了——而 2026-09-30 那个「旧宿主被显示成
 * 没有改动」的假话，正好就藏在这道缝里。
 *
 * 这一条把缝焊上：在临时仓库上造出各种改动，调**真** handleChanges / handleDiff，
 * 把**真**返回值喂给 GraphView，断言页面上出现的文字与仓库里的事实一致。
 *
 * 跑法：node test/end-to-end-render.test.cjs
 */
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { loadInternals } = require('./helpers/load-client.cjs')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zgg-e2e-'))
process.env.DSH_HOME = path.join(sandbox, 'home')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })

/** 收集整棵树的文本。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

/**
 * useState 依次弹出预定值；其余 hook 直通。
 * 顺序与 GraphView 里的调用顺序一致（见 render-smoke.test.cjs 的说明）。
 */
function makeReact(values) {
  let index = 0
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: props === null || props === undefined ? {} : props,
      children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
    }),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (initial) => {
      const provided = index < values.length ? values[index] : undefined
      index += 1
      const value = provided === undefined ? initial : provided
      return [typeof value === 'function' ? value() : value, () => {}]
    },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init'])
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  for (const [k, v] of [['user.name', 'T'], ['user.email', 't@e.com'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) git(dir, ['config', k, v])
  return dir
}

function write(dir, name, text) {
  const full = path.join(dir, name)
  fs.mkdirSync(path.dirname(full), { recursive: true })
  fs.writeFileSync(full, text, 'utf8')
}

/** 用真实的宿主载荷渲染一次，返回页面上的文字。 */
function renderWith(internals, changesValue, diffTarget) {
  const graphState = {
    status: 'ready',
    value: {
      state: 'ready',
      repo: { root: 'D:/r', name: 'r', branch: 'main', detached: false, initial: false, upstream: null, ahead: 0, behind: 0, dirty: 1 },
      refs: [], commits: [], truncated: false, scanned: 0, skip: 0, gitVersion: '2.49.0', generatedAt: 1,
      workspace: { cwd: 'D:/r', source: 'requested' },
      repos: [{ root: 'D:/r', name: 'r', rel: '', depth: 0, outside: false, current: true }],
      selection: { requested: null, source: 'cwd', fallback: false },
      reposTruncated: false, reposTruncatedBy: [],
    },
    refreshing: false,
  }
  const values = [graphState, { status: 'ready', value: changesValue, refreshing: false }]
  // 索引 2..10 占位（scope/query/matchAt/selected/scrollTop/viewHeight/repoChoice/
  // repoHint/folded），索引 11 是 diffTarget。
  // ⚠️ 加/删 GraphView 里的 useState 就要同步改这里的长度（见 render-smoke.test.cjs 的说明）。
  for (let i = 0; i < 9; i += 1) values.push(undefined)
  values.push(diffTarget === undefined ? undefined : diffTarget)
  const loaded = loadInternals({ react: makeReact(values) })
  return textOf(loaded.GraphView({
    ctx: { get: () => undefined, logger: { info() {}, warn() {} } },
    sessionId: 's1', cwd: 'D:/r', visible: true,
  }))
}

async function main() {
  const host = await import('../lib/index.js')
  const { handleChanges, handleDiff } = host.internals
  const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }

  // ── 造一个各种改动都有的仓库 ────────────────────────────────────────────
  const repo = initRepo(path.join(sandbox, 'repo'))
  write(repo, 'src/lib/index.js', 'a\nb\nc\n')
  write(repo, 'src/gone.js', 'bye\n')
  write(repo, 'docs/readme.md', 'x\n')
  write(repo, 'old-name.js', 'y\n'.repeat(20))
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'init'])

  fs.appendFileSync(path.join(repo, 'src/lib/index.js'), 'd\ne\n', 'utf8')  // 未暂存修改
  fs.rmSync(path.join(repo, 'src/gone.js'))                                  // 未暂存删除
  git(repo, ['mv', 'old-name.js', 'new-name.js'])                            // 暂存重命名
  write(repo, 'staged-new.txt', 'brand new\nsecond\n')
  git(repo, ['add', '--', 'staged-new.txt'])                                 // 暂存新增
  write(repo, 'untracked.md', 'u1\nu2\n')                                    // 未跟踪
  fs.writeFileSync(path.join(repo, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]))

  // ── 真宿主输出 ──────────────────────────────────────────────────────────
  const outcome = await handleChanges(ctx, { cwd: repo })
  assert.strictEqual(outcome.ok, true, `handleChanges 失败：${JSON.stringify(outcome.error)}`)
  const value = outcome.value

  // ── 拿真输出渲染，断言页面上的文字与仓库事实一致 ────────────────────────
  const text = renderWith(host.internals, value)
  const { looksLikeChanges } = loadInternals()

  assert.strictEqual(looksLikeChanges(value), true, '真宿主的输出必须被认成改动载荷（否则页面会走错误态）')

  // 段头（顺序照 VS Code：更改在上、暂存的更改在下）
  assert.ok(text.includes('更改'), '缺「更改」段头')
  assert.ok(text.includes('暂存的更改'), '缺「暂存的更改」段头')
  assert.ok(!text.includes('没有未提交的改动'), '有明显改动时不该说"没有改动"')

  // 真实文件名要出现在页面上（用 basename，侧栏才放得下）
  assert.ok(text.includes('index.js'), `未暂存修改的文件应当出现：${text.slice(0, 200)}`)
  assert.ok(text.includes('gone.js'), '删除的文件应当出现')
  assert.ok(text.includes('untracked.md'), '未跟踪文件应当出现')
  assert.ok(text.includes('staged-new.txt'), '暂存新增应当出现')
  assert.ok(text.includes('new-name.js'), '重命名后的新名字应当出现')
  assert.ok(text.includes('old-name.js'), '重命名的原名字应当一并显示（← 前缀）')

  // 计数取自真 numstat：未暂存修改的 src/lib/index.js 是 +2
  assert.ok(text.includes('+2'), `应当显示真实的 + 计数：${text.slice(0, 300)}`)

  // 状态字母：删除 D、重命名 R、未跟踪 U
  const flags = value.sections.unstaged.map((row) => row.status)
  assert.ok(flags.includes('M') && flags.includes('D') && flags.includes('U'), `段内状态字母：${flags.join(',')}`)
  const stagedStatuses = value.sections.staged.map((row) => row.status)
  assert.ok(stagedStatuses.includes('R'), `暂存段应当有 R：${stagedStatuses.join(',')}`)
  assert.ok(stagedStatuses.includes('A'), `暂存段应当有 A：${stagedStatuses.join(',')}`)

  // ── 取真 diff 并渲染展开态 ──────────────────────────────────────────────
  {
    const diff = await handleDiff(ctx, { cwd: repo, path: 'src/lib/index.js', section: 'unstaged' })
    assert.strictEqual(diff.ok, true, JSON.stringify(diff.error))
    const expanded = renderWith(host.internals, value, { status: 'ready', section: 'unstaged', path: 'src/lib/index.js', value: diff.value })
    assert.ok(expanded.includes('d'), 'diff 正文的新增行应当出现')
    assert.ok(expanded.includes('@@'), 'hunk 头应当出现')
  }

  // ── 未跟踪文件（走 --no-index）与二进制 ─────────────────────────────────
  {
    const untrackedRow = value.sections.unstaged.find((row) => row.path === 'untracked.md')
    assert.strictEqual(untrackedRow.untracked, true, '未跟踪标记必须由真宿主给出')
    const diff = await handleDiff(ctx, { cwd: repo, path: 'untracked.md', section: 'unstaged', untracked: true })
    assert.strictEqual(diff.ok, true, '未跟踪文件必须能取 diff（--no-index 的退出码 1 是成功）')
    const expanded = renderWith(host.internals, value, { status: 'ready', section: 'unstaged', path: 'untracked.md', value: diff.value })
    assert.ok(expanded.includes('u1'), '未跟踪文件的内容应当显示')
  }

  // ── 真冲突：conflicts 段 + 能逐行显示 ───────────────────────────────────
  {
    const conflictRepo = initRepo(path.join(sandbox, 'conflict'))
    write(conflictRepo, 'shared.txt', 'base1\nbase2\n')
    git(conflictRepo, ['add', '-A']); git(conflictRepo, ['commit', '-qm', 'base'])
    git(conflictRepo, ['checkout', '-q', '-b', 'side'])
    write(conflictRepo, 'shared.txt', 'side1\nside2\n'); git(conflictRepo, ['commit', '-qam', 'side'])
    git(conflictRepo, ['checkout', '-q', 'main'])
    write(conflictRepo, 'shared.txt', 'main1\nmain2\n'); git(conflictRepo, ['commit', '-qam', 'main'])
    let threw = false
    try { git(conflictRepo, ['merge', '--no-commit', 'side']) } catch { threw = true }
    assert.strictEqual(threw, true, 'fixture 必须真的产生冲突')

    const conflictValue = (await handleChanges(ctx, { cwd: conflictRepo })).value
    assert.strictEqual(conflictValue.sections.conflicts.length, 1)
    const text2 = renderWith(host.internals, conflictValue)
    assert.ok(text2.includes('合并更改'), `冲突段头应当出现：${text2.slice(0, 200)}`)
    assert.ok(text2.includes('shared.txt'), '冲突文件名应当出现')

    // 真 payload 喂进渲染：展开态必须显示冲突标记，且是一份**真 patch**（不是空、不是整篇新增）。
    const diff = await handleDiff(ctx, { cwd: conflictRepo, path: 'shared.txt', section: 'unstaged', unmerged: true })
    assert.strictEqual(diff.value.kind, 'text')
    const expanded = renderWith(host.internals, conflictValue, { status: 'ready', section: 'conflicts', path: 'shared.txt', value: diff.value })
    assert.ok(expanded.includes('<<<<<<<'), '冲突标记应当显示出来')
    assert.ok(expanded.includes('main1'), 'HEAD 侧内容应当作为上下文显示')
  }

  // ── 干净工作树：这时说「没有改动」才是对的 ──────────────────────────────
  {
    const cleanRepo = initRepo(path.join(sandbox, 'clean'))
    write(cleanRepo, 'a.txt', 'a\n')
    git(cleanRepo, ['add', '-A']); git(cleanRepo, ['commit', '-qm', 'init'])
    const cleanValue = (await handleChanges(ctx, { cwd: cleanRepo })).value
    const text3 = renderWith(host.internals, cleanValue)
    assert.ok(text3.includes('没有未提交的改动'), '真的干净时才说这句话')
  }

  console.log(`end-to-end-render.test.cjs: OK (sandbox=${sandbox})`)
}

async function cleanup() {
  try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch (error) { /* Windows 句柄占用 */ }
}

main()
  .then(cleanup)
  .catch(async (error) => {
    console.error(error)
    await cleanup()
    process.exit(1)
  })
