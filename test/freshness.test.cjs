/**
 * 远端新鲜度的**宿主半**端到端测试：真仓库、真 git、真 FETCH_HEAD。
 *
 * 为什么不能只测纯函数：本功能的全部难点都在**从磁盘上哪儿读到那个时间戳**——
 *   - 关联工作树的 FETCH_HEAD 在 `<repo>/.git/worktrees/<名>/FETCH_HEAD`，
 *     与主工作树的 `.git/FETCH_HEAD` 是**两个文件**（实测时间可以差几十分钟）；
 *   - 覆盖一个已存在的 ref **不会**改变父目录的 mtime（实测 `refs/remotes` 目录
 *     停在 09-20，而 `origin/develop` 文件是 10-02）——所以不能 stat 目录；
 *   - 从没 fetch 过的仓库没有 FETCH_HEAD。
 * 这些只有对着真仓库跑一遍才知道对不对。纯函数测试全绿也可能读错文件。
 *
 * 手法：在 %TEMP% 里造真仓库 + 真裸远端，用 `git fetch` 制造真实的 FETCH_HEAD，
 * 再用文件系统的 utimes 把时间戳搬到"很久以前"（不依赖等待），断言宿主的结论。
 *
 * 跑法：node test/freshness.test.cjs
 */
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zgg-fresh-'))
// 隔离 DSH_HOME：宿主半会去读工作区登记表，别让它碰真实环境。
process.env.DSH_HOME = path.join(sandbox, 'home')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init', '-q'])
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  for (const [k, v] of [['user.name', 'T'], ['user.email', 't@e.com'], ['commit.gpgsign', 'false'], ['core.autocrlf', 'false']]) {
    git(dir, ['config', k, v])
  }
  return dir
}

/** 把一个文件/目录的 mtime 设成 N 秒前（不用真的等）。 */
function ageBy(target, seconds) {
  const when = new Date(Date.now() - seconds * 1000)
  fs.utimesSync(target, when, when)
}

async function main() {
  const host = await import('../lib/index.js')
  const { fetchFreshness, upstreamRefFile, handleGraph } = host.internals
  const ctx = { get: () => undefined, logger: { info() {}, warn() {} } }

  // ── 造：真仓库 + 真裸远端 + 真 fetch ────────────────────────────────────
  const remote = path.join(sandbox, 'remote.git')
  fs.mkdirSync(remote, { recursive: true })
  git(remote, ['init', '-q', '--bare'])

  const repo = initRepo(path.join(sandbox, 'repo'))
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x\n', 'utf8')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-qm', 'init'])
  git(repo, ['remote', 'add', 'origin', remote])
  git(repo, ['push', '-q', '-u', 'origin', 'main'])
  git(repo, ['fetch', '-q', 'origin'])

  const gitDir = git(repo, ['rev-parse', '--absolute-git-dir']).trim()
  const commonDir = path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']).trim())
  const fetchHead = path.join(gitDir, 'FETCH_HEAD')
  assert.strictEqual(fs.existsSync(fetchHead), true, '真 fetch 之后必须有 FETCH_HEAD')

  // ── ① 刚 fetch 过 ⇒ 不陈旧 ──────────────────────────────────────────────
  {
    const fresh = fetchFreshness({ gitDir, commonDir, upstreamRefFile: null, now: Date.now() })
    assert.strictEqual(fresh.never, false, 'fetch 过就不是 never')
    assert.strictEqual(fresh.stale, false, `刚 fetch 过不该报陈旧（age=${fresh.ageSeconds}s）`)
    assert.ok(fresh.ageSeconds < 120, `年龄应当很小，实到 ${fresh.ageSeconds}`)
  }

  // ── ② 把 FETCH_HEAD 搬到 30 小时前 ⇒ 陈旧 ───────────────────────────────
  {
    ageBy(fetchHead, 30 * 60 * 60)
    const old = fetchFreshness({ gitDir, commonDir, upstreamRefFile: null, now: Date.now() })
    assert.strictEqual(old.stale, true, '30 小时没取回必须报陈旧')
    assert.ok(old.ageSeconds >= 30 * 60 * 60 - 5, `年龄应约 30 小时，实到 ${old.ageSeconds}`)
  }

  // ── ③ 从没 fetch 过（删掉 FETCH_HEAD）⇒ never，不是"旧" ─────────────────
  {
    fs.rmSync(fetchHead, { force: true })
    const never = fetchFreshness({ gitDir, commonDir, upstreamRefFile: null, now: Date.now() })
    assert.deepStrictEqual(never, { lastFetchAt: null, ageSeconds: null, stale: false, never: true },
      '没有 FETCH_HEAD 是"从没取回"，不是"数据旧了"')
  }

  // ── ④ ⚠️ 关键：关联工作树与主工作树的 FETCH_HEAD 是**两个文件** ──────────
  //
  // 用户完全可能在主工作树 fetch、却在关联工作树里看图。只读其中一个会误报"陈旧"。
  {
    const linked = path.join(sandbox, 'linked')
    git(repo, ['worktree', 'add', '-q', '-b', 'feat/x', linked, 'main'])
    const linkedGitDir = git(linked, ['rev-parse', '--absolute-git-dir']).trim()
    assert.notStrictEqual(linkedGitDir, gitDir, '关联工作树的 gitdir 必须与主工作树不同')
    // ⚠️ git 一律回**正斜杠**（即使在 Windows），所以这里不能用 path.sep 判。
    assert.ok(/[\\/]worktrees[\\/]/.test(linkedGitDir), `gitdir 应在 worktrees/ 下：${linkedGitDir}`)

    // 造出两个时间差很大的 FETCH_HEAD：主工作树"很久没 fetch"，关联工作树"刚 fetch"。
    const linkedFetch = path.join(linkedGitDir, 'FETCH_HEAD')
    fs.writeFileSync(linkedFetch, 'x\n', 'utf8')
    const mainFetch = path.join(gitDir, 'FETCH_HEAD')
    fs.writeFileSync(mainFetch, 'x\n', 'utf8')
    ageBy(mainFetch, 5 * 24 * 60 * 60)   // 主：5 天前
    ageBy(linkedFetch, 30)               // 关联：30 秒前

    // 只看主工作树那个 → 会误报陈旧（这正是"只读一个文件"的坏处）。
    const onlyMain = fetchFreshness({ gitDir, commonDir: null, upstreamRefFile: null, now: Date.now() })
    assert.strictEqual(onlyMain.stale, true, '只看主工作树那份应当（错误地）报陈旧——这正是要避免的')

    // 两处都看 → 取较新的，不该报。
    // 注意 commonDir 指向主仓库 .git，它下面的 FETCH_HEAD 就是主工作树那个。
    const actualLinkedGitDir = linkedGitDir
    const fromLinked = fetchFreshness({ gitDir: actualLinkedGitDir, commonDir, upstreamRefFile: null, now: Date.now() })
    assert.strictEqual(fromLinked.stale, false,
      '在关联工作树里看图时，主工作树刚 fetch 过就不该报陈旧（两处取较新）')
  }

  // ── ⑤ upstreamRefFile：松散 ref 的存在与路径形状 ────────────────────────
  {
    const file = upstreamRefFile(commonDir, 'origin/main')
    assert.strictEqual(file, path.join(commonDir, 'refs', 'remotes', 'origin', 'main'))
    // 非法输入不许造出怪路径来。
    assert.strictEqual(upstreamRefFile(commonDir, ''), null)
    assert.strictEqual(upstreamRefFile(commonDir, 'origin/../evil'), null, '带 .. 的上游名必须被拒')
    assert.strictEqual(upstreamRefFile(null, 'origin/main'), null)
    // 已配上游的仓库里，这个文件确实存在（真仓库验证路径拼对了）。
    assert.strictEqual(fs.existsSync(file), true, `上游 ref 文件应当存在：${file}`)
  }

  // ── ⑥ 走完整 handleGraph：载荷里真的带上了 freshness 与 staleBranches ───
  {
    // 让本地 main 落后远端：在裸仓库那边推一个新提交，本地不 fetch。
    const other = initRepo(path.join(sandbox, 'other'))
    git(other, ['remote', 'add', 'origin', remote])
    git(other, ['fetch', '-q', 'origin'])
    git(other, ['checkout', '-q', 'main'])
    fs.writeFileSync(path.join(other, 'b.txt'), 'y\n', 'utf8')
    git(other, ['add', '-A'])
    git(other, ['commit', '-qm', 'ahead'])
    git(other, ['push', '-q', 'origin', 'main'])
    // 本地 repo 只更新自己的远端缓存（fetch），于是"落后上游"这个本地事实成立。
    git(repo, ['fetch', '-q', 'origin'])

    const out = await handleGraph(ctx, { cwd: repo, max: 20, scope: 'all' })
    assert.strictEqual(out.ok, true, JSON.stringify(out.error))
    const value = out.value
    assert.ok(value.schema >= 3, `载荷形状版本应当 >= 3，实到 ${value.schema}`)
    assert.ok(value.freshness !== null && typeof value.freshness === 'object', '载荷必须带 freshness')
    assert.ok(Array.isArray(value.staleBranches), '载荷必须带 staleBranches')
    const main = value.staleBranches.find((entry) => entry.name === 'main')
    assert.ok(main !== undefined, `刚推了新提交、本地 fetch 过，main 应当落后：${JSON.stringify(value.staleBranches)}`)
    assert.ok(main.behind >= 1, `落后数应当 >= 1，实到 ${main.behind}`)
    assert.strictEqual(main.upstream, 'origin/main')
  }

  console.log(`freshness.test.cjs: OK (sandbox=${sandbox})`)
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
