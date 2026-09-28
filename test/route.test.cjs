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
