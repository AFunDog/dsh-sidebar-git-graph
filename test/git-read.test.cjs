/**
 * dsh-sidebar-git-graph 宿主半纯函数层测试：git 输出解析 + argv 构造。
 *
 * 零依赖（只用 node:assert / node:path），直接 import ESM 源文件，不碰任何运行态状态。
 * 跑法：node test/git-read.test.cjs
 */
const assert = require('node:assert')

const FIELD = '\u0000'
const RECORD = '\u001e'

function record(fields) {
  return fields.join(FIELD) + RECORD
}

async function main() {
  const gitRead = await import('../lib/git-read.js')
  const {
    buildSnapshot,
    logArgv,
    parseDecoration,
    parseLog,
    parseRefs,
    parseStatus,
    refsArgv,
    revParseArgv,
    statusArgv,
  } = gitRead

  // ── argv 构造 ────────────────────────────────────────────────────────────
  assert.deepStrictEqual(revParseArgv('D:/x'), ['-C', 'D:/x', 'rev-parse', '--show-toplevel', '--absolute-git-dir'])

  const statusArgvValue = statusArgv('D:/x')
  assert.deepStrictEqual(statusArgvValue.slice(0, 2), ['-C', 'D:/x'])
  for (const flag of ['status', '--porcelain=v1', '-b', 'core.quotepath=false']) {
    assert.ok(statusArgvValue.includes(flag), `status argv 缺少 ${flag}`)
  }
  // 头部的「N 个改动」必须与改动区那两段用**同一个文件集**。
  // 曾经这里是 `--untracked-files=no`，于是同一页上头部说 6、改动区说 7
  // （2026-09-30 真机截图里就是这么并排显示的）。
  assert.ok(
    statusArgvValue.includes('--untracked-files=all'),
    '头部脏文件数必须含未跟踪，否则与改动区的行数对不上——同一件事两个数',
  )
  assert.ok(
    !statusArgvValue.includes('--untracked-files=no'),
    '不能退回只算已跟踪：那会让头部计数比改动区少',
  )

  const refsArgvValue = refsArgv('D:/x')
  assert.ok(refsArgvValue.includes('for-each-ref'))
  assert.ok(refsArgvValue.includes('refs/heads') && refsArgvValue.includes('refs/remotes') && refsArgvValue.includes('refs/tags'))
  assert.ok(refsArgvValue.some((entry) => entry.includes('%(*objectname)')), '标签必须取解引用后的 sha')

  const allLog = logArgv('D:/x', { max: 400, skip: 0, scope: 'all' })
  for (const flag of ['log', '--topo-order', '--parents', '--max-count=400', '--skip=0', '--branches', '--tags', '--remotes']) {
    assert.ok(allLog.includes(flag), `log argv 缺少 ${flag}`)
  }
  assert.ok(!allLog.includes('HEAD'), 'scope=all 不该钉 HEAD')
  const currentLog = logArgv('D:/x', { max: 5, skip: 10, scope: 'current' })
  assert.ok(currentLog.includes('HEAD') && currentLog.includes('--max-count=5') && currentLog.includes('--skip=10'))
  assert.ok(!currentLog.includes('--branches'), 'scope=current 不该带 --branches')
  // 参数数组化，永远没有 shell 解释的机会。
  assert.ok(allLog.every((entry) => typeof entry === 'string' && !entry.includes('&&') && !entry.includes(';')))

  // ── 装饰串 ───────────────────────────────────────────────────────────────
  assert.deepStrictEqual(parseDecoration(''), { head: false, detached: false, refs: [] })
  assert.deepStrictEqual(parseDecoration('HEAD -> main, origin/main, tag: v1.0'), {
    head: true, detached: false, refs: ['main', 'origin/main', 'v1.0'],
  })
  assert.deepStrictEqual(parseDecoration('HEAD'), { head: true, detached: true, refs: [] })
  assert.deepStrictEqual(parseDecoration('feature/x'), { head: false, detached: false, refs: ['feature/x'] })

  // ── log 解析 ─────────────────────────────────────────────────────────────
  const logText = '\n'
    + record(['a'.repeat(40), 'b'.repeat(40) + ' ' + 'c'.repeat(40), 'AFunDog', 'a@b.c', '1759000000', 'HEAD -> main, origin/main', 'merge: 合并 feature/pet'])
    + record(['b'.repeat(40), 'c'.repeat(40), 'Alice', 'alice@example.com', '1758000000', 'tag: v0.1.6', 'fix: 修一个 bug'])
    + record(['c'.repeat(40), '', 'Root', 'root@example.com', '1757000000', '', 'initial commit'])
    + 'broken record without enough fields' + RECORD
    + RECORD
  const commits = parseLog(logText)
  assert.strictEqual(commits.length, 3, '畸形记录应被跳过')
  assert.strictEqual(commits[0].sha, 'a'.repeat(40))
  assert.deepStrictEqual(commits[0].parents, ['b'.repeat(40), 'c'.repeat(40)], 'merge 提交必须保留两个父')
  assert.strictEqual(commits[0].head, true)
  assert.deepStrictEqual(commits[0].decorationRefs, ['main', 'origin/main'])
  assert.strictEqual(commits[0].time, 1759000000)
  assert.strictEqual(commits[1].subject, 'fix: 修一个 bug')
  assert.deepStrictEqual(commits[2].parents, [], '根提交没有父')
  assert.strictEqual(commits[2].subject, 'initial commit')
  assert.deepStrictEqual(parseLog(''), [])
  assert.deepStrictEqual(parseLog(undefined), [])

  // subject 里带分隔符字符也不能丢字段（真实提交里不该有，但解析必须稳）。
  const weird = parseLog(record(['d'.repeat(40), '', 'X', 'x@y.z', '1', '', `a${FIELD}b`]))
  assert.strictEqual(weird.length, 1)
  assert.strictEqual(weird[0].subject, `a${FIELD}b`)

  // ── refs 解析 ────────────────────────────────────────────────────────────
  const refsText = [
    ['refs/heads/main', 'a'.repeat(40), '', 'origin/main', '*'].join(FIELD),
    ['refs/heads/feature/pet', 'b'.repeat(40), '', '', ' '].join(FIELD),
    ['refs/remotes/origin/main', 'a'.repeat(40), '', '', ' '].join(FIELD),
    ['refs/remotes/origin/HEAD', 'a'.repeat(40), '', '', ' '].join(FIELD),
    ['refs/remotes/origin/feature/pet', 'b'.repeat(40), '', '', ' '].join(FIELD),
    ['refs/tags/v1.0', 'e'.repeat(40), 'f'.repeat(40), '', ' '].join(FIELD),
    ['refs/tags/light', '9'.repeat(40), '', '', ' '].join(FIELD),
    'garbage line',
    '',
  ].join('\n')
  const refs = parseRefs(refsText)
  const names = refs.map((ref) => `${ref.kind}:${ref.name}`)
  assert.deepStrictEqual(names, [
    'branch:main',
    'branch:feature/pet',
    'remote:origin/main',
    'remote:origin/feature/pet',
    'tag:v1.0',
    'tag:light',
  ], 'origin/HEAD 应被剔除，其他保持 git 顺序')
  assert.strictEqual(refs[0].isCurrent, true)
  assert.strictEqual(refs[0].upstream, 'origin/main')
  assert.strictEqual(refs[1].upstream, undefined)
  assert.strictEqual(refs[4].sha, 'f'.repeat(40), '附注标签取解引用后的 sha')
  assert.strictEqual(refs[5].sha, '9'.repeat(40), '轻量标签回退到对象 sha')

  // ── status 解析 ──────────────────────────────────────────────────────────
  const tracking = parseStatus('## main...origin/main [ahead 6, behind 2]\n M a.js\n?? b.js\n')
  assert.deepStrictEqual(
    { branch: tracking.branch, upstream: tracking.upstream, ahead: tracking.ahead, behind: tracking.behind, dirty: tracking.dirty },
    { branch: 'main', upstream: 'origin/main', ahead: 6, behind: 2, dirty: 2 },
  )
  const noUpstream = parseStatus('## feature/x\n')
  assert.strictEqual(noUpstream.branch, 'feature/x')
  assert.strictEqual(noUpstream.upstream, null)
  assert.strictEqual(noUpstream.dirty, 0)
  const detached = parseStatus('## HEAD (no branch)\n')
  assert.strictEqual(detached.detached, true)
  assert.strictEqual(detached.branch, null)
  const initial = parseStatus('## No commits yet on main\n')
  assert.strictEqual(initial.initial, true)
  assert.strictEqual(initial.branch, 'main')
  assert.strictEqual(parseStatus('').dirty, 0)

  // ── 快照合成 ─────────────────────────────────────────────────────────────
  const snapshot = buildSnapshot({
    root: 'D:/repo',
    name: 'repo',
    status: tracking,
    refs,
    commits: [
      { sha: 'a'.repeat(40), parents: ['b'.repeat(40)], author: 'A', email: 'a@b', time: 1, subject: 'one', head: true, decorationRefs: ['main'] },
      { sha: 'b'.repeat(40), parents: [], author: 'A', email: 'a@b', time: 2, subject: 'two', head: false, decorationRefs: [] },
    ],
    max: 400,
    skip: 0,
    gitVersion: '2.43.0',
    now: 99,
  })
  assert.strictEqual(snapshot.state, 'ready')
  assert.strictEqual(snapshot.repo.name, 'repo')
  assert.strictEqual(snapshot.repo.ahead, 6)
  // 同一个 sha 上挂了两个 ref（main 与 origin/main）时两个都要带上。
  assert.deepStrictEqual(snapshot.commits[0].refs, [{ name: 'main', kind: 'branch' }, { name: 'origin/main', kind: 'remote' }])
  assert.deepStrictEqual(snapshot.commits[1].refs, [{ name: 'feature/pet', kind: 'branch' }, { name: 'origin/feature/pet', kind: 'remote' }])
  assert.strictEqual(snapshot.commits[0].head, true)
  assert.strictEqual(snapshot.truncated, false)
  assert.strictEqual(snapshot.gitVersion, '2.43.0')

  const cutOff = buildSnapshot({
    root: 'D:/repo', name: 'repo', status: tracking, refs,
    commits: [{ sha: 'a'.repeat(40), parents: ['z'.repeat(40)], author: 'A', email: 'a@b', time: 1, subject: 'one', head: false, decorationRefs: [] }],
    max: 400, skip: 0, gitVersion: undefined, now: 99,
  })
  assert.strictEqual(cutOff.truncated, true, '父提交落在窗口外必须报截断')

  const atLimit = buildSnapshot({
    root: 'D:/repo', name: 'repo', status: tracking, refs,
    commits: [{ sha: 'a'.repeat(40), parents: [], author: 'A', email: 'a@b', time: 1, subject: 'one', head: false, decorationRefs: [] }],
    max: 1, skip: 0, gitVersion: undefined, now: 99,
  })
  assert.strictEqual(atLimit.truncated, true, '取满 max 条即视为可能还有更老的提交')

  console.log('git-read.test.cjs: OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
