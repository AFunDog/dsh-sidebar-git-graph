/**
 * 宿主路由端到端测试：在系统临时目录里**造一个临时仓库**（绝不在真实
 * 仓库上造历史），跑真正的 git 命令，断言 handleGraph/handleRoute 的输出形状与错误码。
 *
 * DSH_HOME 指向临时目录，避免读到真实的工作区表。
 * 跑法：node test/route.test.cjs
 */
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sidebar-git-graph-test-'))
process.env.DSH_HOME = path.join(sandbox, 'home')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(cwd, name, text) {
  fs.writeFileSync(path.join(cwd, name), text, 'utf8')
}

/** 造一个「主干 + 一条分支 + 一次合并 + 一个标签」的小仓库。 */
function buildRepo() {
  const repo = path.join(sandbox, 'repo')
  fs.mkdirSync(repo, { recursive: true })
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.name', 'Test User'])
  git(repo, ['config', 'user.email', 'test@example.com'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  // 关掉换行符转换：CI 的 Windows runner 上 autocrlf 可能为 true，checkout 会把文件改写成
  // "已修改"，使后面的 merge 因"本地改动会被覆盖"而失败——那是环境噪声，不是被测行为。
  git(repo, ['config', 'core.autocrlf', 'false'])

  write(repo, 'a.txt', 'one\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'feat: 第一个提交'])
  git(repo, ['tag', 'v-test'])

  git(repo, ['checkout', '-b', 'feature/pet'])
  write(repo, 'pet.txt', 'pet\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'feat(pet): 分支上的提交'])

  git(repo, ['checkout', 'main'])
  write(repo, 'b.txt', 'two\n')
  git(repo, ['add', '.'])
  git(repo, ['commit', '-m', 'fix: 主干上的提交'])

  git(repo, ['merge', '--no-ff', '-m', 'merge: 合并 feature/pet', 'feature/pet'])
  write(repo, 'untracked.txt', 'x\n')
  return repo
}

/** 造一个只有一个提交的最小仓库（多仓库测试用，要的是「能画」而不是「画得复杂」）。 */
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true })
  git(dir, ['init'])
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(dir, ['config', 'user.name', 'Test User'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'commit.gpgsign', 'false'])
  git(dir, ['config', 'core.autocrlf', 'false'])
  write(dir, 'a.txt', 'x\n')
  git(dir, ['add', '.'])
  git(dir, ['commit', '-m', `init ${path.basename(dir)}`])
  return dir
}

function fakeCtx() {
  return {
    get: () => undefined,
    logger: { info() {}, warn() {} },
  }
}

function fakeReq(options) {
  const settings = options === undefined ? {} : options
  const body = typeof settings.body === 'string' ? settings.body : ''
  return {
    method: settings.method === undefined ? 'POST' : settings.method,
    headers: settings.headers === undefined ? { 'sec-fetch-site': 'same-origin', host: '127.0.0.1:3080' } : settings.headers,
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.from(body, 'utf8')
    },
  }
}

function fakeRes() {
  const state = { status: 0, headers: null, body: '' }
  return {
    state,
    writeHead(status, headers) {
      state.status = status
      state.headers = headers
    },
    end(text) {
      state.body = text === undefined || text === null ? '' : String(text)
    },
  }
}

function envelope(rpcId, payload) {
  return JSON.stringify({ type: 'client-request', rpcId, method: 'graph', payload })
}

async function main() {
  const host = await import('../lib/index.js')
  const { handleGraph, handleRoute } = host.internals
  const ctx = fakeCtx()
  const repo = buildRepo()

  // ── 正常仓库 ─────────────────────────────────────────────────────────────
  // 让工作树确定性地"脏"：改一个**已跟踪**文件。
  // 不要依赖未跟踪文件（路由用 `--untracked-files=no`，本来就不计），也不要依赖
  // core.autocrlf 之类会自己造出改动的配置——那样的断言在 CI 上会翻车。
  fs.appendFileSync(path.join(repo, 'a.txt'), 'dirty\n', 'utf8')

  const good = await handleGraph(ctx, { cwd: repo, max: 50 })
  assert.strictEqual(good.ok, true, `handleGraph 失败：${JSON.stringify(good.error)}`)
  const value = good.value
  assert.strictEqual(value.state, 'ready')
  assert.strictEqual(value.repo.name, 'repo')
  assert.strictEqual(value.repo.branch, 'main')
  assert.strictEqual(value.repo.detached, false)
  assert.ok(value.repo.dirty >= 1, `改动过的已跟踪文件必须计入脏文件数（实到 ${value.repo.dirty}）`)
  assert.ok(value.gitVersion === undefined || /^\d+\./.test(value.gitVersion), 'git 版本形状')

  const shas = value.commits.map((commit) => commit.sha)
  assert.strictEqual(shas.length, 4, `应有 4 个提交，实到 ${shas.length}`)
  assert.strictEqual(new Set(shas).size, shas.length, '提交不重复')

  const merge = value.commits.find((commit) => commit.subject.startsWith('merge:'))
  assert.ok(merge !== undefined, '应找到合并提交')
  assert.strictEqual(merge.parents.length, 2, '合并提交必须有两个父')
  assert.deepStrictEqual(merge.refs, [{ name: 'main', kind: 'branch' }], 'HEAD 所在分支挂在该提交上')
  assert.strictEqual(merge.head, true)

  // 拓扑序：每个提交都排在自己的父提交之前。
  const position = new Map(shas.map((sha, index) => [sha, index]))
  for (const commit of value.commits) {
    for (const parent of commit.parents) {
      if (!position.has(parent)) continue
      assert.ok(position.get(parent) > position.get(commit.sha), '父提交必须排在子提交之后（--topo-order）')
    }
  }

  const refNames = value.refs.map((ref) => `${ref.kind}:${ref.name}`)
  assert.ok(refNames.includes('branch:main'), `refs 缺 main：${refNames.join(',')}`)
  assert.ok(refNames.includes('branch:feature/pet'), `refs 缺 feature/pet：${refNames.join(',')}`)
  assert.ok(refNames.includes('tag:v-test'), `refs 缺标签：${refNames.join(',')}`)
  assert.ok(!refNames.some((entry) => entry.endsWith('/HEAD')), 'origin/HEAD 不该出现')
  assert.strictEqual(value.refs.find((ref) => ref.name === 'main').isCurrent, true)
  assert.strictEqual(value.truncated, false)
  assert.strictEqual(value.workspace.source, 'claimed-unfenced', '本机没有工作区表时应走无围栏兜底')

  // 只取 1 条 → 必须报截断。
  const limited = await handleGraph(ctx, { cwd: repo, max: 1 })
  assert.strictEqual(limited.ok, true)
  assert.strictEqual(limited.value.commits.length, 1)
  assert.strictEqual(limited.value.truncated, true)

  // 只取 HEAD 历史 → 分支上的提交从窗口里消失，但不该报错。
  const current = await handleGraph(ctx, { cwd: repo, scope: 'current' })
  assert.strictEqual(current.ok, true)
  assert.ok(current.value.commits.length >= 1)

  // ── 不是仓库 ─────────────────────────────────────────────────────────────
  const plain = path.join(sandbox, 'plain')
  fs.mkdirSync(plain, { recursive: true })
  const notRepo = await handleGraph(ctx, { cwd: plain })
  assert.strictEqual(notRepo.ok, false)
  assert.strictEqual(notRepo.error.code, 'not-a-repo')

  // 什么都不给 → 拿不到工作目录。
  const nothing = await handleGraph(ctx, {})
  assert.strictEqual(nothing.ok, false)
  assert.strictEqual(nothing.error.code, 'no-workspace')

  // ── 一个工作区里有多个仓库 ───────────────────────────────────────────────
  // 形态照抄本仓库：工作区**不是**仓库，仓库在它下面几层（其中还有嵌套的）。
  const { canonical } = await import('../lib/workspace.js')
  const canon = (value) => canonical(value) ?? value
  const ws = path.join(sandbox, 'ws')
  const outer = initRepo(path.join(ws, 'aa-outer'))
  const inner = initRepo(path.join(ws, 'vendor', '@scope', 'zz-inner'))
  const outside = initRepo(path.join(sandbox, 'elsewhere', 'other'))

  const auto = await handleGraph(ctx, { cwd: ws })
  assert.strictEqual(auto.ok, true, `工作区不是仓库时也应画出里面的仓库：${JSON.stringify(auto.error)}`)
  assert.strictEqual(auto.value.repo.root, canon(outer), '默认应挑工作区里相对路径最靠前的仓库')
  assert.strictEqual(auto.value.selection.source, 'scan')
  assert.strictEqual(auto.value.selection.requested, null)
  assert.strictEqual(auto.value.selection.fallback, false)
  assert.deepStrictEqual(
    auto.value.repos.map((entry) => entry.name).sort(),
    ['aa-outer', 'zz-inner'],
    `仓库清单应同时列出两层里的仓库：${JSON.stringify(auto.value.repos)}`,
  )
  assert.strictEqual(auto.value.repos.filter((entry) => entry.current === true).length, 1, '只能有一个 current')
  assert.strictEqual(auto.value.repos.find((entry) => entry.current === true).root, canon(outer))
  assert.strictEqual(auto.value.repos.find((entry) => entry.name === 'zz-inner').outside, false)

  // 点名切换 → 画的就是那一个。
  const picked = await handleGraph(ctx, { cwd: ws, repo: inner })
  assert.strictEqual(picked.ok, true)
  assert.strictEqual(picked.value.repo.root, canon(inner))
  assert.strictEqual(picked.value.repo.name, 'zz-inner')
  assert.strictEqual(picked.value.selection.source, 'requested')
  assert.strictEqual(picked.value.selection.fallback, false)
  assert.strictEqual(picked.value.repos.find((entry) => entry.current === true).root, canon(inner))

  // 工作区只是某个仓库的子目录时，那个仓库（在工作区**之外**）也要能画——祖先放行。
  const subdir = path.join(outer, 'sub')
  fs.mkdirSync(subdir, { recursive: true })
  const fromSubdir = await handleGraph(ctx, { cwd: subdir, repo: outer })
  assert.strictEqual(fromSubdir.ok, true, `工作区是仓库子目录时也要能画：${JSON.stringify(fromSubdir.error)}`)
  assert.strictEqual(fromSubdir.value.repo.root, canon(outer))
  assert.strictEqual(fromSubdir.value.selection.source, 'requested')
  assert.strictEqual(fromSubdir.value.repos.find((entry) => entry.root === canon(outer)).outside, true)

  // ── 围栏：只认工作区自身 / 内部 / 祖先 ───────────────────────────────────
  // 1) 工作区之外的仓库 → 不认，退回自动挑（并如实标记 fallback，前端会提示）。
  const faraway = await handleGraph(ctx, { cwd: ws, repo: outside })
  assert.strictEqual(faraway.ok, true)
  assert.strictEqual(faraway.value.repo.root, canon(outer), '工作区之外的仓库必须被拒')
  assert.strictEqual(faraway.value.selection.fallback, true)
  assert.strictEqual(faraway.value.selection.requested, outside)

  // 2) 仓库里的普通子目录不是仓库根 → 不认。
  const notRoot = await handleGraph(ctx, { cwd: ws, repo: subdir })
  assert.strictEqual(notRoot.value.selection.fallback, true, '子目录不算仓库根')

  // 3) 压根不存在的路径 → 不认。
  const ghost = await handleGraph(ctx, { cwd: ws, repo: path.join(ws, 'aa-outer', 'nope') })
  assert.strictEqual(ghost.value.selection.fallback, true)

  // 4) 相对路径 → 不认（只收绝对路径，免得跟工作目录的解析方式纠缠）。
  const relativeRepo = await handleGraph(ctx, { cwd: ws, repo: 'aa-outer' })
  assert.strictEqual(relativeRepo.value.selection.fallback, true)

  // ── 工作目录被删：跳过它，改用还活着的候选（2026-10-17 用户报的真问题）────────
  // 现场：会话 cwd 好好的，而标签页手里攥着一个**已经删掉的关联工作树**。关键在于它就落在
  // 工作区**里面**——所以"被已注册工作区背书"那道闸对它照样放行（`isBackedByWorkspace` 是
  // 包含判定，`canonical` 对不存在的路径退回 `resolve`，于是删掉的工作树仍拿得到通行证）。
  // 旧行为：它就凭这一点压过活着的会话 cwd，紧接着一句「工作目录不存在」在**回退梯子之前**
  // 直接返回——图谱彻底空白，而正确的工作目录就在手边。
  const gone = path.join(ws, '.worktree', 'profile-tier-plan') // 故意不创建：删掉的工作树
  const ctxWith = (options) => ({
    get(name) {
      if (name === 'sessions' && options.sessionCwd !== undefined) {
        return { get: () => ({ header: { cwd: options.sessionCwd } }) }
      }
      if (name === 'workspaceRegistry' && options.workspace !== undefined) {
        return { list: () => [{ path: options.workspace }] }
      }
      return undefined
    },
    logger: { info() {}, warn() {} },
  })

  // 1) 活着的会话 cwd 仍在 → 跳过死路径照常画，并如实交代被跳过的是哪个。
  const live = ctxWith({ sessionCwd: ws, workspace: ws })
  const recovered = await handleGraph(live, { sessionId: 's-live', cwd: gone })
  assert.strictEqual(recovered.ok, true, `一个删掉的工作树不该把整张回退梯子掐掉：${JSON.stringify(recovered.error)}`)
  assert.strictEqual(canon(recovered.value.workspace.cwd), canon(ws), '应改用会话自己的 cwd')
  assert.strictEqual(recovered.value.workspace.source, 'session')
  assert.deepStrictEqual(recovered.value.workspace.stale, { path: gone, source: 'claimed' }, '被跳过的那个必须说出来')
  assert.strictEqual(recovered.value.repo.root, canon(outer), '照常画出工作区里的仓库')

  // 2) 客户端点名的路径**活着**时优先级不变（这条补丁不该动"手点赢过一切"）。
  const stillClaimed = await handleGraph(live, { sessionId: 's-live', cwd: ws })
  assert.strictEqual(stillClaimed.value.workspace.source, 'claimed')
  assert.strictEqual(stillClaimed.value.workspace.stale, null, '没跳过谁就不该有这条提示')

  // 3) 候选全都不在了 → 仍旧报错，而错误里要带**具体是哪个**目录没了。
  const deadCwd = path.join(sandbox, 'gone', 'session-cwd')
  const allDead = await handleGraph(ctxWith({ sessionCwd: deadCwd }), { sessionId: 's-dead', cwd: gone })
  assert.strictEqual(allDead.ok, false)
  assert.strictEqual(allDead.error.code, 'no-workspace')
  assert.ok(allDead.error.message.includes('工作目录不存在'), allDead.error.message)
  assert.ok(allDead.error.message.includes('session-cwd'), `错误里要带具体路径：${allDead.error.message}`)

  // 4) 一个宿主候选都没有、客户端给的路又不存在：照旧把**那条路径**报出来
  //    （别退化成"拿不到工作目录"——那是另一回事，会把诊断带偏）。
  const noCandidates = await handleGraph(ctx, { cwd: gone })
  assert.strictEqual(noCandidates.ok, false)
  assert.strictEqual(noCandidates.error.code, 'no-workspace')
  assert.ok(noCandidates.error.message.includes(gone), `错误里要带具体路径：${noCandidates.error.message}`)

  // 关掉扫描：清单里只剩「工作目录所属仓库」与「点名要的那个」，但点名仍然生效。
  const noScan = await handleGraph(ctx, { cwd: ws, repo: inner, scanDepth: 0 })
  assert.strictEqual(noScan.value.repo.root, canon(inner))
  assert.deepStrictEqual(noScan.value.repos.map((entry) => entry.root), [canon(inner)])

  // 缓存挡不住正确性：同参数再来一遍结果必须一致。
  const again = await handleGraph(ctx, { cwd: ws, repo: inner })
  assert.strictEqual(again.value.repo.root, picked.value.repo.root)
  assert.strictEqual(again.value.commits.length, picked.value.commits.length)

  // ── 路由协议 ─────────────────────────────────────────────────────────────
  const okRes = fakeRes()
  await handleRoute(ctx, fakeReq({ body: envelope('r1', { cwd: repo, max: 10 }) }), okRes)
  assert.strictEqual(okRes.state.status, 200)
  const okBody = JSON.parse(okRes.state.body)
  assert.strictEqual(okBody.type, 'server-response')
  assert.strictEqual(okBody.rpcId, 'r1')
  assert.strictEqual(okBody.result.ok, true)
  assert.strictEqual(okBody.result.value.repo.branch, 'main')
  assert.strictEqual(okRes.state.headers['cache-control'], 'no-store')

  const methodRes = fakeRes()
  await handleRoute(ctx, fakeReq({ method: 'GET' }), methodRes)
  assert.strictEqual(methodRes.state.status, 405)

  const crossRes = fakeRes()
  await handleRoute(ctx, fakeReq({ headers: { 'sec-fetch-site': 'cross-site', host: 'evil.example' } }), crossRes)
  assert.strictEqual(crossRes.state.status, 403)

  const originMismatch = fakeRes()
  await handleRoute(ctx, fakeReq({ headers: { origin: 'https://evil.example', host: '127.0.0.1:3080' } }), originMismatch)
  assert.strictEqual(originMismatch.state.status, 403, 'Origin 与 Host 不一致必须拒绝')

  const originSame = fakeRes()
  await handleRoute(ctx, fakeReq({ headers: { origin: 'http://127.0.0.1:3080', host: '127.0.0.1:3080' }, body: envelope('r2', { cwd: repo, max: 2 }) }), originSame)
  assert.strictEqual(originSame.state.status, 200)
  assert.strictEqual(JSON.parse(originSame.state.body).result.ok, true)

  const badJson = fakeRes()
  await handleRoute(ctx, fakeReq({ body: '{ not json' }), badJson)
  assert.strictEqual(badJson.state.status, 200)
  const badBody = JSON.parse(badJson.state.body)
  assert.strictEqual(badBody.result.ok, false)
  assert.strictEqual(badBody.result.error.code, 'no-workspace', '坏 JSON 退化成空 payload，仍给出明确错误码')

  // ── 提交改了哪些文件（2026-10-17 新增）──────────────────────────────────
  //
  // 另起一个小仓库，而不是往 buildRepo 上摞：上面「4 个提交」是别的断言的基线，加提交会
  // 把它一起改红。这里要的是**形状**：根 / 重命名 / 二进制 / 空提交 / 合并。
  const cRepo = path.join(sandbox, 'crepo')
  fs.mkdirSync(cRepo, { recursive: true })
  git(cRepo, ['init'])
  git(cRepo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(cRepo, ['config', 'user.name', 'Test User'])
  git(cRepo, ['config', 'user.email', 'test@example.com'])
  git(cRepo, ['config', 'commit.gpgsign', 'false'])
  git(cRepo, ['config', 'core.autocrlf', 'false'])

  write(cRepo, 'a.txt', 'one\ntwo\n')
  git(cRepo, ['add', '.'])
  git(cRepo, ['commit', '-m', 'root: a.txt'])
  const cRoot = git(cRepo, ['rev-parse', 'HEAD']).trim()

  git(cRepo, ['mv', 'a.txt', 'renamed.txt'])
  write(cRepo, 'renamed.txt', 'one\ntwo\nthree\n')
  git(cRepo, ['add', '.'])
  git(cRepo, ['commit', '-m', 'refactor: 改名 + 改内容'])
  const cRename = git(cRepo, ['rev-parse', 'HEAD']).trim()

  fs.writeFileSync(path.join(cRepo, 'real.bin'), Buffer.from([0x00, 0x01, 0xff, 0x00, 0x42]))
  git(cRepo, ['add', '.'])
  git(cRepo, ['commit', '-m', 'feat: 二进制'])
  const cBinary = git(cRepo, ['rev-parse', 'HEAD']).trim()

  git(cRepo, ['commit', '--allow-empty', '-m', 'chore: 空提交'])
  const cEmpty = git(cRepo, ['rev-parse', 'HEAD']).trim()

  git(cRepo, ['checkout', '-q', '-b', 'side'])
  write(cRepo, 'side.txt', 'side\n')
  git(cRepo, ['add', '.'])
  git(cRepo, ['commit', '-m', 'side: 加 side.txt'])
  git(cRepo, ['checkout', '-q', 'main'])
  write(cRepo, 'main.txt', 'main\n')
  git(cRepo, ['add', '.'])
  git(cRepo, ['commit', '-m', 'main: 加 main.txt'])
  git(cRepo, ['merge', '-q', '--no-ff', '-m', 'merge: side → main', 'side'])
  const cMerge = git(cRepo, ['rev-parse', 'HEAD']).trim()

  const { handleCommit, handleCommitDiff } = host.internals
  const countAdds = (value) => (Array.isArray(value.lines) ? value.lines.filter((line) => line.kind === 'add').length : -1)

  // 根提交：全部文件都是 A，计数照常有。
  const rootFiles = await handleCommit(ctx, { cwd: cRepo, sha: cRoot })
  assert.strictEqual(rootFiles.ok, true, JSON.stringify(rootFiles.error))
  assert.deepStrictEqual(rootFiles.value.files.map((file) => `${file.status}:${file.path}`), ['A:a.txt'])
  assert.strictEqual(rootFiles.value.totals.counted, 1)

  // 重命名：状态 R + 原路径 + 新路径（实测形状：原路径在前）。
  const renameFiles = await handleCommit(ctx, { cwd: cRepo, sha: cRename })
  assert.strictEqual(renameFiles.value.files.length, 1)
  assert.strictEqual(renameFiles.value.files[0].status, 'R')
  assert.strictEqual(renameFiles.value.files[0].origPath, 'a.txt')
  assert.strictEqual(renameFiles.value.files[0].path, 'renamed.txt')

  // 二进制：计数是 undefined（不是 0），binary 为 true。
  const binaryRow = (await handleCommit(ctx, { cwd: cRepo, sha: cBinary })).value.files.find((file) => file.path === 'real.bin')
  assert.strictEqual(binaryRow.binary, true)
  assert.strictEqual(binaryRow.added, undefined, '二进制没有行数，不能报 0')

  // ⚠️ 回归：合并提交的清单**不能为空**。不带 `--first-parent` 时 git 给的是 combined diff，
  // 干净合并的输出是**空的**——那会把「这个合并引入了 side.txt」说成「没改任何文件」。
  const mergeFiles = await handleCommit(ctx, { cwd: cRepo, sha: cMerge })
  assert.strictEqual(mergeFiles.ok, true, JSON.stringify(mergeFiles.error))
  assert.ok(mergeFiles.value.files.length > 0, `合并提交必须按第一父提交列出文件：${JSON.stringify(mergeFiles.value.files)}`)
  assert.ok(mergeFiles.value.files.some((file) => file.path === 'side.txt'), '相对第一父提交引入的就是 side.txt')

  // 空提交：空清单，不是错误。
  const emptyFiles = await handleCommit(ctx, { cwd: cRepo, sha: cEmpty })
  assert.strictEqual(emptyFiles.ok, true)
  assert.deepStrictEqual(emptyFiles.value.files, [])
  assert.strictEqual(emptyFiles.value.totals.total, 0)

  // 单文件 patch：形状与 `diff` **完全一致**（客户端复用同一个 diffView）。
  const renameDiff = await handleCommitDiff(ctx, { cwd: cRepo, sha: cRename, path: 'renamed.txt', origPath: 'a.txt' })
  assert.strictEqual(renameDiff.ok, true, JSON.stringify(renameDiff.error))
  assert.strictEqual(renameDiff.value.kind, 'text')
  assert.strictEqual(renameDiff.value.sha, cRename)
  assert.strictEqual(renameDiff.value.path, 'renamed.txt')
  assert.ok(renameDiff.value.lines.some((line) => line.kind === 'add' && line.text === 'three'))

  // ⚠️ 重命名必须把新旧两个路径都给：只给新路径时 `-M` 认不出重命名，输出退化成「整文件新增」
  // （实测：3 行改动 → 整个文件算新增）。这条断言就是钉这个的。
  const onlyNew = await handleCommitDiff(ctx, { cwd: cRepo, sha: cRename, path: 'renamed.txt' })
  assert.strictEqual(countAdds(renameDiff.value), 1, '给了原路径 → 只新增 three 这一行')
  assert.ok(countAdds(onlyNew.value) >= 3, `只给新路径会退化成整文件新增（实到 ${countAdds(onlyNew.value)} 行）`)

  // 二进制 patch → kind 'binary'（页面说「二进制文件」，而不是给一个空 diff）。
  const binaryDiff = await handleCommitDiff(ctx, { cwd: cRepo, sha: cBinary, path: 'real.bin' })
  assert.strictEqual(binaryDiff.ok, true)
  assert.strictEqual(binaryDiff.value.kind, 'binary')

  // 合并提交里的**文件 patch** 同样要 `--first-parent`，否则也是空的（实测）。
  const mergeDiff = await handleCommitDiff(ctx, { cwd: cRepo, sha: cMerge, path: 'side.txt' })
  assert.strictEqual(mergeDiff.ok, true, JSON.stringify(mergeDiff.error))
  assert.strictEqual(mergeDiff.value.kind, 'text')
  assert.ok(countAdds(mergeDiff.value) >= 1, '不带 --first-parent 时这里是空的')

  // ── 闸门 ─────────────────────────────────────────────────────────────────
  const badSha = await handleCommit(ctx, { cwd: cRepo, sha: '--upload-pack=touch /tmp/x' })
  assert.strictEqual(badSha.ok, false)
  assert.strictEqual(badSha.error.code, 'bad-sha', '以 - 开头的"选项"绝不能进 argv')

  const ghostSha = await handleCommit(ctx, { cwd: cRepo, sha: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' })
  assert.strictEqual(ghostSha.ok, false)
  assert.strictEqual(ghostSha.error.code, 'no-commit', '找不到的提交要说"找不到了"，而不是笼统的 git 失败')

  const escape = await handleCommitDiff(ctx, { cwd: cRepo, sha: cRoot, path: '../../etc/passwd' })
  assert.strictEqual(escape.ok, false)
  assert.strictEqual(escape.error.code, 'bad-path')

  const noSha = await handleCommitDiff(ctx, { cwd: cRepo, path: 'a.txt' })
  assert.strictEqual(noSha.ok, false)
  assert.strictEqual(noSha.error.code, 'bad-sha')

  // 路由分派：新 method 走同一个信封。
  const commitRes = fakeRes()
  await handleRoute(ctx, fakeReq({
    body: JSON.stringify({ type: 'client-request', rpcId: 'c1', method: 'commit', payload: { cwd: cRepo, sha: cRoot } }),
  }), commitRes)
  const commitBody = JSON.parse(commitRes.state.body)
  assert.strictEqual(commitBody.result.ok, true)
  assert.strictEqual(commitBody.result.value.files.length, 1)

  // 旧宿主对新 method 的回应形状（客户端据此说"重启 DSH 才生效"）。
  const unknownRes = fakeRes()
  await handleRoute(ctx, fakeReq({
    body: JSON.stringify({ type: 'client-request', rpcId: 'c2', method: 'nope', payload: {} }),
  }), unknownRes)
  const unknownBody = JSON.parse(unknownRes.state.body)
  assert.strictEqual(unknownBody.result.ok, false)
  assert.strictEqual(unknownBody.result.error.code, 'bad-method')

  console.log(`route.test.cjs: OK (repo=${repo})`)
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
