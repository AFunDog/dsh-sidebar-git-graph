/**
 * 仓库发现（lib/repos.js）测试：在临时目录里造一棵有嵌套仓库、有黑名单目录、有
 * `.git` 文件的目录树，断言"找到哪些、漏掉哪些、按什么顺序"。
 *
 * 只造目录、不跑 git：发现器本身只看 `.git` 在不在（真正的"是不是仓库"由宿主用
 * `rev-parse` 二次确认），所以这里不需要真仓库，测起来也快。
 *
 * 跑法：node test/repos.test.cjs
 */
const assert = require('node:assert')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-sidebar-git-graph-repos-'))

/** 造目录（连同父级）。 */
function dir(...parts) {
  const target = path.join(sandbox, ...parts)
  fs.mkdirSync(target, { recursive: true })
  return target
}

/** 造一个"仓库根"：放一个空的 `.git` 目录。 */
function repo(...parts) {
  const target = dir(...parts)
  fs.mkdirSync(path.join(target, '.git'), { recursive: true })
  return target
}

/** 相对 sandbox 的斜杠路径，方便断言（Windows 的反斜杠会让期望值难读）。 */
function rel(target) {
  return path.relative(sandbox, target).split(path.sep).join('/')
}

function rels(result) {
  return result.repos.map((entry) => rel(entry.root))
}

async function main() {
  const { discoverRepos, DEFAULT_DEPTH, MAX_DEPTH } = await import('../lib/repos.js')
  assert.strictEqual(DEFAULT_DEPTH, 5)
  assert.ok(MAX_DEPTH >= DEFAULT_DEPTH)

  // ── 目录树 ───────────────────────────────────────────────────────────────
  const ws = repo('ws')                                        // 工作区自己是个仓库
  repo('ws/pkgA')                                              // 一层深
  repo('ws/deep/one')                                          // 两层深
  repo('ws/deep/one/two/three/four')                           // 五层深：默认深度就该够到，且嵌在上面那个仓库里
  repo('ws/vendor/@scope/nested')                              // vendor 不在黑名单里（本仓库的形态）
  repo('ws/node_modules/some-pkg')                             // 黑名单：不进去
  repo('ws/build')                                             // 黑名单名，但自己做一次 stat 后仍要列出
  repo('ws/parent/node_modules/inner')                         // 黑名单深一层
  // `.git` 是文件（worktree / submodule 的形态）也要认。
  const worktree = dir('ws/worktree-style')
  fs.writeFileSync(path.join(worktree, '.git'), 'gitdir: ../.git/worktrees/x\n', 'utf8')
  // 光有名字像仓库的空目录，不该被认成仓库。
  dir('ws/not-a-repo')

  // ── 默认深度 ─────────────────────────────────────────────────────────────
  const full = await discoverRepos(ws, {})
  const found = rels(full)
  assert.deepStrictEqual(found, [
    'ws',
    'ws/build',
    'ws/deep/one',
    'ws/deep/one/two/three/four',
    'ws/pkgA',
    'ws/vendor/@scope/nested',
    'ws/worktree-style',
  ], `默认深度下的仓库清单不对：${found.join(', ')}`)
  assert.strictEqual(full.truncated, false)
  assert.deepStrictEqual(full.truncatedBy, [])
  assert.ok(full.scanned.dirs > 0, '应记录访问过的目录数')
  assert.ok(full.scanned.ms >= 0)

  // 工作区根排第一（前端下拉的默认项要靠它）。
  assert.strictEqual(full.repos[0].rel, '')
  assert.strictEqual(full.repos[0].name, 'ws')
  assert.strictEqual(full.repos[0].depth, 0)

  // 每一项的形状。注意 `rel` 是相对**工作区**的，`rels()` 是相对 sandbox 的（便于读）。
  const nested = full.repos.find((entry) => rel(entry.root).endsWith('nested'))
  assert.ok(nested !== undefined)
  assert.strictEqual(nested.name, 'nested')
  assert.strictEqual(nested.rel.split(path.sep).join('/'), 'vendor/@scope/nested')
  assert.strictEqual(nested.outside, false)
  assert.ok(nested.depth >= 1)

  // 黑名单命中的那个：深度被记成 -1（没进去，只 stat 过），但必须出现。
  const build = full.repos.find((entry) => rel(entry.root) === 'ws/build')
  assert.ok(build !== undefined, '黑名单名字（build）自己是个仓库时也必须列出')
  assert.strictEqual(build.depth, -1)
  assert.ok(!found.some((entry) => entry.includes('node_modules')), '黑名单目录不该被下去翻')

  // ── 深度 0：不扫 ─────────────────────────────────────────────────────────
  const off = await discoverRepos(ws, { maxDepth: 0 })
  assert.deepStrictEqual(rels(off), ['ws'])

  // ── 浅深度 ───────────────────────────────────────────────────────────────
  const shallow = await discoverRepos(ws, { maxDepth: 1 })
  assert.deepStrictEqual(rels(shallow), ['ws', 'ws/build', 'ws/pkgA', 'ws/worktree-style'])

  const deeper = await discoverRepos(ws, { maxDepth: 2 })
  assert.ok(rels(deeper).includes('ws/deep/one'), '深度 2 时应能看到 ws/deep/one')
  assert.ok(!rels(deeper).includes('ws/deep/one/two/three/four'))

  const notDeepEnough = await discoverRepos(ws, { maxDepth: 4 })
  assert.ok(!rels(notDeepEnough).includes('ws/deep/one/two/three/four'), '深度 4 还够不到 5 层的嵌套仓库')
  assert.ok(rels((await discoverRepos(ws, { maxDepth: 5 }))).includes('ws/deep/one/two/three/four'))

  // ── 工作区自己不是仓库 ───────────────────────────────────────────────────
  const plain = dir('plain')
  repo('plain/only')
  const fromPlain = await discoverRepos(plain, {})
  assert.deepStrictEqual(rels(fromPlain), ['plain/only'], '工作区不是仓库时不该凭空造一条')

  // ── 不存在的目录：不抛错，空表 ───────────────────────────────────────────
  const missing = await discoverRepos(path.join(sandbox, 'nope'), {})
  assert.deepStrictEqual(missing.repos, [])
  assert.strictEqual(missing.truncated, false)

  // ── 闸门：仓库数上限会停下并标 truncated ─────────────────────────────────
  const many = dir('many')
  for (let index = 0; index < 130; index += 1) repo('many', `r${String(index).padStart(3, '0')}`)
  const capped = await discoverRepos(many, {})
  assert.ok(capped.repos.length <= 100, `仓库数上限没生效：${capped.repos.length}`)
  assert.strictEqual(capped.truncated, true)
  // 根目录自己不是仓库，所以这里只该由"仓库数"触发。
  assert.ok(!capped.truncatedBy.includes('dirs'))

  console.log(`repos.test.cjs: OK（默认深度找到 ${found.length} 个仓库）`)
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
