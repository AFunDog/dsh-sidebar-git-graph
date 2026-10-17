/**
 * 「点开提交 → 改动文件」客户端半身测试：标题、空/截断/错误的说法、以及那个区块真的画出来。
 *
 * 单独测的理由：这一块有四句**必须说出口**的话，少一句就是四种不报错的错答案——
 *   - 合并提交按第一父提交比较（不说，用户会以为这个合并自己写了 side.txt）；
 *   - 空清单是「空提交」还是「合并相对第一父没改动」（两件事，说法不同）；
 *   - 清单被截断时「共 N 个，列了 M 个」；
 *   - 旧宿主回 `bad-method` → 说清要重启，而不是"点了没反应"。
 *
 * 跑法：node test/commit-files-view.test.cjs
 */
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { loadInternals, toPlain } = require('./helpers/load-client.cjs')

/** 桩 localStorage：这一块不读它，但加载器要有一个像样的。 */
function fakeStorage() {
  const map = new Map()
  return {
    getItem(key) { return map.has(key) ? map.get(key) : null },
    setItem(key, value) { map.set(key, String(value)) },
    removeItem(key) { map.delete(key) },
  }
}

/** 记录式的 h：把 createElement 的入参原样留下。 */
const record = (type, props, ...children) => ({
  type,
  props: props === null || props === undefined ? {} : props,
  children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
})

/** 一棵元素树里的全部文本。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

/** 收集满足条件的元素。 */
function findAll(node, predicate, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, predicate, out)
    return out
  }
  if (predicate(node)) out.push(node)
  findAll(node.children, predicate, out)
  return out
}

async function main() {
  const internals = loadInternals({ localStorage: fakeStorage() })
  const {
    commitErrorText,
    commitFilesEmptyCopy,
    commitFilesSection,
    commitFilesTitle,
    commitFilesTruncatedCopy,
  } = internals

  // ── 标题：数字 + 计数 + 合并口径 ────────────────────────────────────────
  assert.strictEqual(
    commitFilesTitle({ totals: { count: 3, added: 12, deleted: 4 } }, ['parent']),
    '改动文件 3 个 · +12 −4',
  )
  assert.strictEqual(commitFilesTitle({ totals: { count: 1 } }, []), '改动文件 1 个', '没有计数就不编一个 0 出来')
  assert.ok(
    commitFilesTitle({ totals: { count: 1 } }, ['a', 'b']).includes('第一父提交'),
    '合并提交必须说清比较口径，否则用户会以为这个合并自己写了那些文件',
  )
  assert.ok(!commitFilesTitle({ totals: { count: 1 } }, ['a']).includes('第一父提交'))
  assert.strictEqual(commitFilesTitle(undefined, undefined), '改动文件 0 个', '载荷还没到也不能炸')

  // ── 空清单：两种说法是两件事 ─────────────────────────────────────────────
  assert.ok(commitFilesEmptyCopy(['a', 'b']).includes('合并'))
  assert.ok(commitFilesEmptyCopy(['a']).includes('空提交'))
  assert.notStrictEqual(commitFilesEmptyCopy(['a', 'b']), commitFilesEmptyCopy(['a']))

  // ── 截断：两个数字都要在 ─────────────────────────────────────────────────
  assert.strictEqual(
    commitFilesTruncatedCopy({ totals: { count: 3, total: 9 } }),
    '文件太多：共 9 个，只列了前 3 个。',
  )

  // ── 旧宿主 / 真错误 ──────────────────────────────────────────────────────
  assert.ok(commitErrorText({ code: 'bad-method' }).includes('重启'), '旧宿主必须说清要重启')
  assert.strictEqual(
    commitErrorText({ code: 'no-commit', message: '这个提交在本地仓库里已经找不到了（可能被 rebase / gc 掉了）' }),
    '这个提交在本地仓库里已经找不到了（可能被 rebase / gc 掉了）',
    '宿主给的 message 最具体，优先用它',
  )

  // ── 渲染 ─────────────────────────────────────────────────────────────────
  assert.strictEqual(commitFilesSection(record, { target: null }), null, '没展开提交就什么都不画')

  const loading = commitFilesSection(record, { target: { sha: 'aaa', status: 'loading' } })
  assert.ok(textOf(loading).includes('正在读取'))

  const failed = commitFilesSection(record, { target: { sha: 'aaa', status: 'error', error: { code: 'bad-method' } } })
  assert.ok(textOf(failed).includes('重启'), '旧宿主的错误要按旧宿主的话说')

  const empty = commitFilesSection(record, { target: { sha: 'aaa', status: 'ready', value: { sha: 'aaa', files: [], totals: { count: 0, total: 0, added: 0, deleted: 0, counted: 0 } } }, parents: [] })
  assert.ok(textOf(empty).includes('空提交'))

  const value = {
    sha: 'aaa',
    files: [
      { path: 'src/lib/index.js', status: 'M', added: 3, deleted: 1 },
      { path: 'renamed.txt', origPath: 'a.txt', status: 'R', score: 73, added: 1, deleted: 0 },
      { path: 'real.bin', status: 'A', binary: true },
    ],
    totals: { count: 3, total: 3, added: 4, deleted: 1, counted: 2 },
    truncated: false,
  }
  const opened = []
  const tree = commitFilesSection(record, {
    target: { sha: 'aaa', status: 'ready', value },
    diffTarget: null,
    parents: ['p'],
    onOpen: (sha, file) => opened.push([sha, file.path]),
  })

  const rows = findAll(tree, (node) => node.props.className === 'zgg-file')
  assert.strictEqual(rows.length, 3, '三个文件三条行')
  assert.strictEqual(rows[0].props['data-status'], 'M')
  assert.ok(textOf(rows[1]).includes('← a.txt'), '重命名要显示原名（复用更改区那一行的写法）')
  // 二进制没有行数：与「更改」区一致——行上不显示 `+0 −0`（那是"没有增减"这个具体断言，
  // 而事实是"不知道"），也不在行上贴标签；点开时由 diffView 说「二进制文件，无法显示改动」。
  assert.strictEqual(
    findAll(rows[2], (node) => node.props.className === 'zgg-file-counts').length, 0,
    '二进制行不该有计数',
  )
  assert.ok(rows.every((row) => row.props['data-clickable'] !== 'false'), '提交里的文件都应当可点开')

  // 点击回调把 (sha, file) 原样带出去——少了 sha 就会去问错提交的 diff。
  rows[1].props.onClick()
  assert.deepStrictEqual(opened, [['aaa', 'renamed.txt']])

  // 展开的那个文件：行要标成 selected，并在它下面挂一个 diff 视图。
  const withDiff = commitFilesSection(record, {
    target: { sha: 'aaa', status: 'ready', value },
    diffTarget: {
      sha: 'aaa',
      path: 'src/lib/index.js',
      status: 'ready',
      value: { kind: 'text', lines: [{ kind: 'add', text: 'const x = 1', newNo: 7 }], truncated: false },
    },
    parents: ['p'],
    onOpen: () => {},
  })
  const diffRows = findAll(withDiff, (node) => node.props.className === 'zgg-file')
  assert.strictEqual(diffRows[0].props['data-selected'], 'true', '展开的那一行要标出来')
  assert.ok(findAll(withDiff, (node) => node.props.className === 'zgg-diff').length === 1, '恰好一个就地展开的 diff')
  assert.ok(textOf(withDiff).includes('const x = 1'), 'diff 的正文要真的画出来')

  // 展开的是**另一条**提交的文件时，这一条不该标成 selected（键里有 sha）。
  const otherSha = commitFilesSection(record, {
    target: { sha: 'aaa', status: 'ready', value },
    diffTarget: { sha: 'bbb', path: 'src/lib/index.js', status: 'ready', value: { kind: 'text', lines: [] } },
    parents: ['p'],
    onOpen: () => {},
  })
  assert.strictEqual(findAll(otherSha, (node) => node.props.className === 'zgg-file')[0].props['data-selected'], 'false')
  assert.strictEqual(findAll(otherSha, (node) => node.props.className === 'zgg-diff').length, 0)

  // 截断时的提示。
  const truncated = commitFilesSection(record, {
    target: { sha: 'aaa', status: 'ready', value: { ...value, truncated: true, totals: { count: 3, total: 99 } } },
    parents: [],
    onOpen: () => {},
  })
  assert.ok(textOf(truncated).includes('共 99 个'))

  // 形状不对的载荷（宿主半将来改了契约）不能让整页白屏。
  const malformed = commitFilesSection(record, { target: { sha: 'aaa', status: 'ready', value: {} }, parents: [], onOpen: () => {} })
  assert.ok(textOf(malformed).includes('空提交'), '没有 files 字段时按"没有改动"说，但不炸')

  // ── 必须真的被渲染路径用到 ───────────────────────────────────────────────
  //
  // 与 isNewHost 同一条教训（2026-10-01 首版定义了却没调用）：区块写好了、测试也绿，
  // 但详情里没挂它 —— 用户看到的就是"点了提交什么都没多出来"。
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'lib', 'client.js'), 'utf8')
  assert.ok(/commitFilesSection\(h, \{/.test(bundle), 'commitFilesSection 必须在提交详情里被真正调用')
  assert.ok(/target: commitFiles !== null && commitFiles\.sha === detail\.sha/.test(bundle),
    '清单要按 sha 对齐——否则快速换行时会把上一条提交的文件挂到新提交下面')
  assert.ok(/requestCommitFiles\(\{ sessionId, cwd, repo: repoChoice, repoHint, scanDepth, sha: selected \}\)/.test(bundle),
    '展开提交时要真的发请求（只在展开时发，收起时一个字都不问）')
  assert.ok(/origPath: file\.origPath/.test(bundle),
    '单文件 patch 要带上原路径，否则重命名会退化成整文件新增')

  console.log('commit-files-view.test.cjs: OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
