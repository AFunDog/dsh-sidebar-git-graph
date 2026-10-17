/**
 * 「提交改了哪些文件」纯函数层测试：argv 构造 + `--name-status -z` / `--numstat -z` 解析。
 *
 * **本文件的 fixture 全是真跑出来的字节**（2026-10-17 用 Node `encoding:'buffer'` dump），
 * 不是照文档写的：重命名的双路径、二进制的 `-⇥-`、合并的 `MM`、空提交的空输出，都是实测形状。
 * 规矩见 AGENTS.md「别照文档猜，造一次真冲突 dump 出来再写」。
 *
 * 跑法：node test/commit-files.test.cjs
 */
const assert = require('node:assert')

/** 把可读写法转回真字节：`␀` → NUL，`⇥` → TAB。fixture 一律这样写，避免文件里出现裸控制字符。 */
const raw = (text) => text.replace(/␀/g, '\u0000').replace(/⇥/g, '\t')

async function main() {
  const {
    MAX_FILES,
    buildCommitFiles,
    commitFilesArgv,
    commitNumstatArgv,
    commitPatchArgv,
    isShaLike,
    needsFirstParentNotice,
    parseCommitNumstat,
    parseNameStatus,
  } = await import('../lib/commit-files.js')

  const root = 'D:/repo'
  const sha = 'a0a80b2b6c5a3056959b9073398fac56a6134200'

  // ── argv：两条"不报错的错答案"必须被钉死 ────────────────────────────────
  const filesArgv = commitFilesArgv(root, sha)
  assert.ok(filesArgv.includes('--first-parent'), '合并提交不带 --first-parent 会输出空 → 必须带')
  assert.ok(filesArgv.includes('--name-status') && filesArgv.includes('-z'), '状态清单要 NUL 分隔')
  assert.ok(filesArgv.includes('show') && filesArgv.includes(sha), '只跑 show 这一条只读命令')
  assert.ok(filesArgv.includes('--format='), '不能把提交头（作者/日期）混进文件清单')

  const numstatArgv = commitNumstatArgv(root, sha)
  assert.ok(numstatArgv.includes('--first-parent'), '计数同样要按第一父提交比较')
  assert.ok(numstatArgv.includes('--numstat') && numstatArgv.includes('-z'))

  const single = commitPatchArgv(root, { sha, path: 'renamed.txt' })
  const singleDash = single.indexOf('--')
  assert.ok(single.slice(0, singleDash).includes(sha), '⚠️ sha 必须在 `--` 之前：之后的一切都是 pathspec（实测落那边就空输出）')
  assert.deepStrictEqual(single.slice(singleDash + 1), ['renamed.txt'], '非重命名只给新路径')
  assert.ok(single.includes('--first-parent'), '单文件 patch 同样要 --first-parent（实测不带就空）')

  const renamed = commitPatchArgv(root, { sha, path: 'renamed.txt', origPath: 'a.txt' })
  const renamedDash = renamed.indexOf('--')
  assert.deepStrictEqual(renamed.slice(renamedDash + 1), ['a.txt', 'renamed.txt'], '重命名要把新旧两个路径都给，否则退化成「整文件新增」')

  // 只读不变量：本文件永不构造会写仓库的命令。
  for (const argv of [filesArgv, numstatArgv, single, renamed]) {
    for (const forbidden of ['add', 'commit', 'checkout', 'restore', 'reset', 'clean', 'worktree', 'fetch', 'push', 'rm', 'mv', 'stash', 'gc', 'prune', 'update-index', 'apply']) {
      assert.ok(!argv.includes(forbidden), `只读不变量被破坏：argv 里出现了 ${forbidden}`)
    }
  }

  // ── sha 闸（同时是注入闸）────────────────────────────────────────────────
  assert.strictEqual(isShaLike(sha), true)
  assert.strictEqual(isShaLike('a0a80b2b'), true, '短 sha 也放行（git 自己能解析）')
  assert.strictEqual(isShaLike('--upload-pack=touch /tmp/x'), false, '以 - 开头的"选项"不能进 argv')
  assert.strictEqual(isShaLike('--weird'), false)
  assert.strictEqual(isShaLike(''), false)
  assert.strictEqual(isShaLike('HEAD'), false, '只收十六进制 sha，不收任意 revision 表达式')
  assert.strictEqual(isShaLike('main'), false)
  assert.strictEqual(isShaLike('a'.repeat(41)), false, '超长不是 sha')
  assert.strictEqual(isShaLike(undefined), false)
  assert.strictEqual(isShaLike(null), false)

  // ── parseNameStatus：实测形状 ────────────────────────────────────────────
  const normal = parseNameStatus(raw('M␀a.txt␀A␀added.txt␀A␀bin.dat␀D␀带 空格的 中文名.txt␀'))
  assert.deepStrictEqual(normal.map((entry) => `${entry.status} ${entry.path}`), [
    'M a.txt', 'A added.txt', 'A bin.dat', 'D 带 空格的 中文名.txt',
  ], '含空格与中文的路径不需要引号解码')

  const rename = parseNameStatus(raw('R073␀a.txt␀renamed.txt␀'))
  assert.strictEqual(rename.length, 1)
  assert.strictEqual(rename[0].status, 'R')
  assert.strictEqual(rename[0].score, 73, '相似度粘在状态字母后面，是独立字段之外的写法')
  assert.strictEqual(rename[0].origPath, 'a.txt')
  assert.strictEqual(rename[0].path, 'renamed.txt', '重命名记录里**原路径在前、新路径在后**')

  const copy = parseNameStatus(raw('C100␀a.txt␀b.txt␀'))
  assert.strictEqual(copy[0].status, 'C')
  assert.strictEqual(copy[0].origPath, 'a.txt')

  const rootCommit = parseNameStatus(raw('A␀a.txt␀A␀带 空格的 中文名.txt␀'))
  assert.strictEqual(rootCommit.length, 2, '根提交：全部文件都是 A')

  // 合并的 combined 形态（两字母）不该出现（我们始终带 --first-parent），但**真出现了也不能崩**。
  const combined = parseNameStatus(raw('MM␀shared.txt␀'))
  assert.strictEqual(combined.length, 1)
  assert.strictEqual(combined[0].status, 'MM', '认不出来就照原样留着，绝不猜成单字母')
  assert.strictEqual(combined[0].path, 'shared.txt')

  assert.deepStrictEqual(parseNameStatus(''), [], '空提交 → 空清单，不是"解析失败"')
  assert.deepStrictEqual(parseNameStatus(undefined), [])
  assert.deepStrictEqual(parseNameStatus(raw('garbage␀a.txt␀')), [],
    '认不出的记录要跳过，不能把状态字母当路径收下（那会凭空造出一个不存在的文件）')

  // ── parseCommitNumstat：直接复用 changes.js 那份 ─────────────────────────
  const counts = parseCommitNumstat(raw('1⇥0⇥a.txt␀1⇥0⇥added.txt␀1⇥0⇥bin.dat␀0⇥1⇥带 空格的 中文名.txt␀'))
  assert.strictEqual(counts.get('a.txt').added, 1)
  assert.strictEqual(counts.get('带 空格的 中文名.txt').deleted, 1)
  const renameCounts = parseCommitNumstat(raw('1⇥0⇥␀a.txt␀renamed.txt␀'))
  assert.strictEqual(renameCounts.get('renamed.txt').origPath, 'a.txt', '重命名的计数记在**新路径**上')
  const binaryCounts = parseCommitNumstat(raw('-⇥-⇥real.bin␀'))
  assert.strictEqual(binaryCounts.get('real.bin').binary, true)

  // ── buildCommitFiles：并表 + 截断 + 合计 ─────────────────────────────────
  const built = buildCommitFiles({
    nameStatus: parseNameStatus(raw('M␀a.txt␀R073␀x.txt␀renamed.txt␀A␀real.bin␀')),
    numstat: parseCommitNumstat(raw('1⇥2⇥a.txt␀3⇥0⇥␀x.txt␀renamed.txt␀-⇥-⇥real.bin␀')),
  })
  assert.strictEqual(built.files.length, 3)
  assert.deepStrictEqual(built.files.map((f) => f.status), ['M', 'R', 'A'])
  assert.strictEqual(built.files[0].added, 1)
  assert.strictEqual(built.files[0].deleted, 2)
  assert.strictEqual(built.files[1].path, 'renamed.txt', '重命名的计数按新路径匹配到了')
  assert.strictEqual(built.files[1].origPath, 'x.txt')
  assert.strictEqual(built.files[2].binary, true)
  assert.strictEqual(built.files[2].added, undefined, '二进制没有行数，不能报 0')
  assert.deepStrictEqual(built.totals, { count: 3, total: 3, added: 4, deleted: 2, counted: 2 },
    '合计只统计拿得到计数的那些，且把 counted 一起给出——否则"改了 0 行"会是句假话')
  assert.strictEqual(built.truncated, false)

  // 计数缺失（两条命令之间出现差集）不该少列一行文件。
  const missingCounts = buildCommitFiles({ nameStatus: parseNameStatus(raw('M␀a.txt␀')) })
  assert.strictEqual(missingCounts.files.length, 1)
  assert.strictEqual(missingCounts.files[0].added, undefined)
  assert.strictEqual(missingCounts.totals.counted, 0)

  const many = Array.from({ length: 7 }, (_, index) => `M␀f${index}.txt␀`).join('')
  const capped = buildCommitFiles({ nameStatus: parseNameStatus(raw(many)), limit: 3 })
  assert.strictEqual(capped.files.length, 3)
  assert.strictEqual(capped.truncated, true, '截断必须上报')
  assert.strictEqual(capped.totals.total, 7, 'total 是**未截断**前的条数，页面才能说清"共 7 个，列了 3 个"')

  const defaulted = buildCommitFiles({ nameStatus: parseNameStatus(raw(many)) })
  assert.strictEqual(defaulted.files.length, 7)
  assert.ok(MAX_FILES >= 1000, `默认上限应够大，实到 ${MAX_FILES}`)

  // ── 第一父提交的口径要不要说明 ──────────────────────────────────────────
  assert.strictEqual(needsFirstParentNotice(['a', 'b']), true, '合并提交要说清是"与第一父提交比较"')
  assert.strictEqual(needsFirstParentNotice(['a']), false)
  assert.strictEqual(needsFirstParentNotice([]), false, '根提交不需要解释')
  assert.strictEqual(needsFirstParentNotice(undefined), false)

  console.log('commit-files.test.cjs: OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
