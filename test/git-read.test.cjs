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
    describeFreshness,
    logArgv,
    parseDecoration,
    parseLog,
    parseRefs,
    parseRepoPaths,
    parseStatus,
    parseTrack,
    refsArgv,
    revParseArgv,
    statusArgv,
  } = gitRead

  // ── argv 构造 ────────────────────────────────────────────────────────────
  // 三个路径一次问出来：工作树根 / 本工作树 gitdir / **共享** gitdir（新鲜度要用后者）。
  assert.deepStrictEqual(revParseArgv('D:/x'), ['-C', 'D:/x', 'rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'])

  // ── rev-parse 三行输出 ───────────────────────────────────────────────────
  // 主工作树：commonDir 是**相对**路径（实测 git 2.49 在 Windows 上回 `.git`）。
  assert.deepStrictEqual(
    parseRepoPaths('D:/repo\nD:/repo/.git\n.git\n', 'D:/repo'),
    { root: 'D:/repo', gitDir: 'D:/repo/.git', commonDir: 'D:/repo/.git' },
    'commonDir 为相对路径时必须按 -C 目录解析成绝对路径',
  )
  // 关联工作树：commonDir 是**绝对**路径（同一个 git，两种形状，所以必须都支持）。
  assert.deepStrictEqual(
    parseRepoPaths('D:/repo/.worktree/wt\nD:/repo/.git/worktrees/wt\nD:/repo/.git\n', 'D:/repo/.worktree/wt'),
    { root: 'D:/repo/.worktree/wt', gitDir: 'D:/repo/.git/worktrees/wt', commonDir: 'D:/repo/.git' },
    '关联工作树的 commonDir 是绝对的，不能被当成相对路径拼坏',
  )
  // 反斜杠基准目录也要能拼。
  assert.strictEqual(parseRepoPaths('C:\\r\nC:\\r\\.git\n.git\n', 'C:\\r').commonDir, 'C:\\r\\.git')
  // 输出不足三行时不许抛，也不许造一个假路径出来。
  assert.deepStrictEqual(parseRepoPaths('D:/repo\n', 'D:/repo'), { root: 'D:/repo', gitDir: null, commonDir: null })

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
  // 上游状态（新鲜度提示要用）：少了这两项，"本地分支落后远端"在页面上就无从说起。
  const refsFormat = refsArgvValue.find((entry) => entry.startsWith('--format='))
  assert.ok(refsFormat.includes('%(upstream:track)'), 'for-each-ref 必须取 upstream:track（落后/领先/gone）')
  assert.ok(refsFormat.includes('%(upstream:remotename)'), 'remotename 用来区分"没配上游"与"上游 gone"')

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
    ['refs/heads/main', 'a'.repeat(40), '', 'origin/main', '*', '', 'origin'].join(FIELD),
    ['refs/heads/feature/pet', 'b'.repeat(40), '', '', ' ', '', ''].join(FIELD),
    // 落后上游 10 个：用户报的那个案例里 develop 就是这个状态。
    ['refs/heads/develop', 'c'.repeat(40), '', 'origin/develop', ' ', '[behind 10]', 'origin'].join(FIELD),
    // 上游被删（gone）：与"没配上游"是两回事，必须分得开。
    ['refs/heads/orphaned', 'd'.repeat(40), '', 'origin/orphaned', ' ', '[gone]', 'origin'].join(FIELD),
    // 双向都有。
    ['refs/heads/both', '1'.repeat(40), '', 'origin/develop', ' ', '[ahead 2, behind 60]', 'origin'].join(FIELD),
    ['refs/remotes/origin/main', 'a'.repeat(40), '', '', ' ', '', ''].join(FIELD),
    ['refs/remotes/origin/HEAD', 'a'.repeat(40), '', '', ' ', '', ''].join(FIELD),
    ['refs/remotes/origin/feature/pet', 'b'.repeat(40), '', '', ' ', '', ''].join(FIELD),
    ['refs/tags/v1.0', 'e'.repeat(40), 'f'.repeat(40), '', ' ', '', ''].join(FIELD),
    ['refs/tags/light', '9'.repeat(40), '', '', ' ', '', ''].join(FIELD),
    'garbage line',
    '',
  ].join('\n')
  const refs = parseRefs(refsText)
  const names = refs.map((ref) => `${ref.kind}:${ref.name}`)
  assert.deepStrictEqual(names, [
    'branch:main',
    'branch:feature/pet',
    'branch:develop',
    'branch:orphaned',
    'branch:both',
    'remote:origin/main',
    'remote:origin/feature/pet',
    'tag:v1.0',
    'tag:light',
  ], 'origin/HEAD 应被剔除，其他保持 git 顺序')
  assert.strictEqual(refs[0].isCurrent, true)
  assert.strictEqual(refs[0].upstream, 'origin/main')
  assert.strictEqual(refs[0].hasUpstream, true, '配了上游（remotename 有值）即使 track 为空也算配了')
  assert.strictEqual(refs[1].upstream, undefined)
  assert.strictEqual(refs[1].hasUpstream, false, '没配上游的分支')
  // 落后数是"本地就知道"的陈旧证据，页面据此说"落后 N 个提交"。
  assert.strictEqual(refs[2].behind, 10)
  assert.strictEqual(refs[2].ahead, null)
  assert.strictEqual(refs[2].upstreamGone, false)
  // gone：上游 ref 没了。**不能**当成"没配上游"，也不能当成落后 0。
  assert.strictEqual(refs[3].upstreamGone, true)
  assert.strictEqual(refs[3].hasUpstream, true, 'gone 仍是"配过上游"，只是那个 ref 不在了')
  assert.strictEqual(refs[3].behind, null, 'gone 时 behind 是"不知道"，不是 0')
  assert.strictEqual(refs[4].ahead, 2)
  assert.strictEqual(refs[4].behind, 60)
  // 远端分支与标签不该带上游字段（带了是噪音，也容易让页面误报）。
  assert.strictEqual(refs[5].hasUpstream, undefined)
  assert.strictEqual(refs[8].ahead, undefined)
  assert.strictEqual(refs[7].sha, 'f'.repeat(40), '附注标签取解引用后的 sha')
  assert.strictEqual(refs[8].sha, '9'.repeat(40), '轻量标签回退到对象 sha')

  // ── upstream:track 解析（形状全部来自真仓库实测）─────────────────────────
  assert.deepStrictEqual(parseTrack(''), { gone: false, ahead: null, behind: null })
  assert.deepStrictEqual(parseTrack('[behind 10]'), { gone: false, ahead: null, behind: 10 })
  assert.deepStrictEqual(parseTrack('[ahead 2, behind 60]'), { gone: false, ahead: 2, behind: 60 })
  assert.deepStrictEqual(parseTrack('[ahead 3]'), { gone: false, ahead: 3, behind: null })
  assert.deepStrictEqual(parseTrack('[gone]'), { gone: true, ahead: null, behind: null })
  // 认不出来的形状：一律"不知道"，绝不猜成 0（猜错就是页面上一句假话）。
  assert.deepStrictEqual(parseTrack('[something new]'), { gone: false, ahead: null, behind: null })

  // ── 远端新鲜度 ───────────────────────────────────────────────────────────
  // 用户报的那个案例：本地 origin/develop 与本地 develop 指向同一个提交，
  // 于是 behind 是 0 —— 只有"取回时间"能发现陈旧。这正是 stale 这一档存在的理由。
  const DAY = 24 * 60 * 60 * 1000
  const now = 1_800_000_000_000
  const fresh = describeFreshness({ fetchHeadMs: now - 60_000, refMs: null, now })
  assert.strictEqual(fresh.never, false)
  assert.strictEqual(fresh.stale, false, '刚取回过不该提示')
  assert.strictEqual(fresh.ageSeconds, 60)
  const old = describeFreshness({ fetchHeadMs: now - 2 * DAY, refMs: null, now })
  assert.strictEqual(old.stale, true, '两天没取回必须提示')
  assert.strictEqual(old.ageSeconds, 2 * 24 * 60 * 60)
  // 取两处里**较新**的那个：主工作树刚 fetch、关联工作树很久没 fetch 时不该误报。
  const mixed = describeFreshness({ fetchHeadMs: now - 5 * DAY, refMs: now - 30_000, now })
  assert.strictEqual(mixed.stale, false, '必须取较新的那个时间戳')
  assert.strictEqual(mixed.ageSeconds, 30)
  // 从没取回过 = "没有远端可言"，不是"数据旧了"。
  const never = describeFreshness({ fetchHeadMs: null, refMs: null, now })
  assert.deepStrictEqual(never, { lastFetchAt: null, ageSeconds: null, stale: false, never: true })
  assert.strictEqual(describeFreshness({ fetchHeadMs: Number.NaN, refMs: 0, now }).never, true, '0/NaN 不是有效时间戳')
  // 边界：正好卡在阈值上算陈旧吗？阈值是 6 小时，取 >=。
  assert.strictEqual(describeFreshness({ fetchHeadMs: now - 6 * 60 * 60 * 1000, refMs: null, now }).stale, true)
  assert.strictEqual(describeFreshness({ fetchHeadMs: now - 6 * 60 * 60 * 1000 + 1, refMs: null, now }).stale, false)
  // 时钟回拨（fetch 时间在未来）不许算出负数年龄。
  assert.strictEqual(describeFreshness({ fetchHeadMs: now + DAY, refMs: null, now }).ageSeconds, 0)

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
