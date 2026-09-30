/**
 * 「更改」区（客户端半身）测试：路径拆分、行文案、非文本态、段折叠记忆。
 *
 * 单独测的理由与 repo-picker 一样——这几处都是**看代码觉得显然、用起来才发现错**的地方：
 *   - 侧栏窄，路径必须只留 basename + 末级目录，但作用域包（`@scope/pkg`）要留两段，
 *     否则两个 scope 下的同名包会长得一模一样；
 *   - 内嵌仓库那种目录行必须**不可点**，否则就是"点了没反应"；
 *   - 拿不到 +/− 计数时不能显示 0（那是"没有增减"这个具体断言，而事实是"不知道"）。
 *
 * 跑法：node test/changes-view.test.cjs
 */
const assert = require('node:assert')
const { loadInternals, toPlain } = require('./helpers/load-client.cjs')

/** 桩 localStorage：够用、可数、可断言。 */
function fakeStorage() {
  const map = new Map()
  return {
    map,
    getItem(key) { return map.has(key) ? map.get(key) : null },
    setItem(key, value) { map.set(key, String(value)) },
    removeItem(key) { map.delete(key) },
  }
}

/** 记录式的 h：把 createElement 的入参原样留下，就能断言"造出来的是什么"。 */
const record = (type, props, ...children) => ({
  type,
  props: props === null || props === undefined ? {} : props,
  children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
})

/** 收集一棵元素树里的全部文本。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

async function main() {
  const storage = fakeStorage()
  const internals = loadInternals({ localStorage: storage })
  const { splitPath, fileRowView, changeRow, changeSection, diffView, totalsText, readFolded, saveFolded } = internals

  // ── 路径拆分 ─────────────────────────────────────────────────────────────
  assert.deepStrictEqual(toPlain(splitPath('a.txt')), { base: 'a.txt', dir: '' })
  assert.deepStrictEqual(toPlain(splitPath('src/lib/index.js')), { base: 'index.js', dir: '…/lib' })
  assert.deepStrictEqual(
    toPlain(splitPath('profiles/web/vendor/@zeng/dsh-kit/lib/index.js')),
    { base: 'index.js', dir: '…/lib' },
    '只留末一级目录：侧栏放不下整条路径，而 basename 是唯一能认出这个文件的信息',
  )
  // 作用域包：@scope/pkg 两段一起留，否则 @a/kit 与 @b/kit 会显示成一样。
  assert.deepStrictEqual(
    toPlain(splitPath('node_modules/@zeng/dsh-kit/package.json')),
    { base: 'package.json', dir: '…/@zeng/dsh-kit' },
    '作用域包要保留两段目录',
  )
  assert.deepStrictEqual(toPlain(splitPath('中文 文件.txt')), { base: '中文 文件.txt', dir: '' })
  assert.deepStrictEqual(toPlain(splitPath('')), { base: '', dir: '' })
  assert.deepStrictEqual(toPlain(splitPath(undefined)), { base: '', dir: '' })

  // ── 行文案 ───────────────────────────────────────────────────────────────
  {
    const plain = fileRowView({ path: 'src/lib/index.js', status: 'M' })
    assert.strictEqual(plain.base, 'index.js')
    assert.strictEqual(plain.clickable, true)
    assert.strictEqual(plain.title, 'src/lib/index.js', '完整路径必须在 title 里')

    // 内嵌仓库：不可点 + 说明原因。
    const container = fileRowView({ path: 'vendor/inner/', status: 'U', container: true })
    assert.strictEqual(container.clickable, false, '目录行不可取 diff，必须不可点')
    assert.ok(container.note.includes('内嵌仓库'), '不可点就要说明为什么，否则等于"点了没反应"')

    const renamed = fileRowView({ path: 'src/new-name.js', origPath: 'src/old-name.js', status: 'R' })
    assert.strictEqual(renamed.orig, 'old-name.js', '重命名要显示原文件的 basename')
  }

  // ── 状态字母与计数 ───────────────────────────────────────────────────────
  {
    const row = changeRow(record, { path: 'a/b.js', status: 'M', added: 8, deleted: 2 }, { section: 'unstaged' })
    assert.strictEqual(row.type, 'div')
    assert.strictEqual(row.props.className, 'zgg-file')
    assert.strictEqual(row.props['data-clickable'], 'true')
    const flag = row.children.find((child) => child.props.className === 'zgg-flag')
    assert.strictEqual(flag.children[0], 'M')
    assert.strictEqual(flag.props['data-status'], 'M', '配色靠 data-status 选，写错就是没有颜色')
    assert.ok(textOf(row).includes('+8'), '计数要显示')
    assert.ok(textOf(row).includes('−2'), '减号用 U+2212，与段头一致')

    // 没有计数时不显示 0。
    const noCounts = changeRow(record, { path: 'u.txt', status: 'U' }, { section: 'unstaged' })
    assert.ok(!textOf(noCounts).includes('+0'), '未跟踪没有计数，不能编一个 0 出来')
    assert.strictEqual(noCounts.children.some((child) => child.props.className === 'zgg-file-counts'), false)

    // 内嵌仓库行没有 onClick。
    const containerRow = changeRow(record, { path: 'vendor/inner/', status: 'U', container: true }, { section: 'unstaged' })
    assert.strictEqual(containerRow.props.onClick, undefined, 'container 行不许挂点击')
    assert.strictEqual(containerRow.props['data-clickable'], 'false')
  }

  // ── 段头：计数缺失时不显示 0 ─────────────────────────────────────────────
  {
    assert.deepStrictEqual(toPlain(totalsText(record, { count: 3, added: 0, deleted: 0, counted: 0 })), [], '没有一行拿得到计数时什么都不显示')
    const parts = totalsText(record, { count: 3, added: 12, deleted: 4, counted: 2 })
    assert.strictEqual(textOf(parts), '+12−4')
    // 只有增或只有删时不要出现 "+0" / "−0"。
    assert.strictEqual(textOf(totalsText(record, { count: 1, added: 5, deleted: 0, counted: 1 })), '+5')
    assert.strictEqual(textOf(totalsText(record, { count: 1, added: 0, deleted: 3, counted: 1 })), '−3')
  }

  // ── 段：折叠 / 顺序 / 空段不渲染 ─────────────────────────────────────────
  {
    const rows = [{ path: 'a.js', status: 'M' }, { path: 'b.js', status: 'M' }]
    const open = changeSection(record, {
      section: 'unstaged', title: '更改', rows, totals: { count: 2, added: 1, deleted: 1, counted: 2 },
      folded: false, onToggle() {}, renderRow: (row) => [changeRow(record, row, { section: 'unstaged' })],
    })
    assert.strictEqual(open.type, 'div')
    const head = open.children[0]
    assert.strictEqual(textOf(head).includes('更改'), true)
    assert.strictEqual(textOf(head).includes('2'), true)
    assert.strictEqual(head.props['aria-expanded'], 'true')
    assert.strictEqual(open.children.length, 3, '段头 + 两行')

    const folded = changeSection(record, {
      section: 'unstaged', title: '更改', rows, totals: { count: 2, added: 1, deleted: 1, counted: 2 },
      folded: true, onToggle() {}, renderRow: (row) => [changeRow(record, row, { section: 'unstaged' })],
    })
    assert.strictEqual(folded.children.length, 1, '折叠时只剩段头')
    assert.strictEqual(folded.children[0].props['aria-expanded'], 'false')

    // 空段整个不渲染（VS Code 也是这样：没有暂存改动就不出现那一段）。
    assert.strictEqual(changeSection(record, {
      section: 'staged', title: '暂存的更改', rows: [], totals: { count: 0, added: 0, deleted: 0, counted: 0 },
      folded: false, onToggle() {}, renderRow: () => [],
    }), null)
  }

  // ── diff 视图：四种非文本态 ──────────────────────────────────────────────
  {
    assert.strictEqual(diffView(record, null), null, '没展开就没有元素')
    assert.ok(textOf(diffView(record, { status: 'loading' })).includes('正在读取'))
    assert.ok(textOf(diffView(record, { status: 'error', error: { code: 'git-failed', message: 'boom' } })).includes('boom'))
    assert.strictEqual(textOf(diffView(record, { status: 'ready', value: { kind: 'binary' } })), '二进制文件，无法显示改动')
    assert.ok(textOf(diffView(record, { status: 'ready', value: { kind: 'dir' } })).includes('目录'))
    assert.ok(textOf(diffView(record, { status: 'ready', value: { kind: 'too-large' } })).includes('过大'))
    // 空 patch 与"没认出来"必须说不同的话。
    assert.ok(textOf(diffView(record, { status: 'ready', value: { kind: 'text', lines: [] } })).includes('没有文本改动'))
    assert.ok(
      textOf(diffView(record, { status: 'ready', value: { kind: 'text', lines: [], unparsed: true } })).includes('没认出来'),
      'patch 解析不出来时不能假装"没有改动"',
    )
  }

  // ── diff 视图：正文 ──────────────────────────────────────────────────────
  {
    const view = diffView(record, {
      status: 'ready',
      value: {
        kind: 'text',
        lines: [
          { kind: 'hunk', text: '@@ -1,3 +1,4 @@' },
          { kind: 'ctx', text: 'keep', oldNo: 1, newNo: 1 },
          { kind: 'del', text: 'gone', oldNo: 2 },
          { kind: 'add', text: 'fresh', newNo: 2 },
          { kind: 'meta', text: '\\ No newline at end of file' },
        ],
      },
    })
    assert.strictEqual(view.props.className, 'zgg-diff')
    // 顺序与输入一致：hunk 头、ctx、del、add、meta。
    // hunk 头与 meta 走各自的类名（没有 data-kind，读出来是 null），
    // 只有 +/-/上下文的正文行带 data-kind —— 配色靠它。
    const kinds = view.children.map((child) => child.props['data-kind'] ?? null)
    assert.deepStrictEqual(toPlain(kinds), [null, 'ctx', 'del', 'add', null])
    assert.strictEqual(view.children[0].props.className, 'zgg-diff-hunk')
    assert.strictEqual(view.children[4].props.className, 'zgg-diff-meta')
    // 行号槽：增行只填新侧，删行只填旧侧。
    const add = view.children.find((child) => child.props['data-kind'] === 'add')
    assert.strictEqual(textOf(add.children[0]), '', '增行没有旧侧行号')
    assert.strictEqual(textOf(add.children[1]), '2')
    assert.strictEqual(textOf(add.children[2]), '+')
    const del = view.children.find((child) => child.props['data-kind'] === 'del')
    assert.strictEqual(textOf(del.children[0]), '2')
    assert.strictEqual(textOf(del.children[1]), '', '删行没有新侧行号')
    assert.strictEqual(textOf(del.children[2]), '-')

    const truncated = diffView(record, { status: 'ready', value: { kind: 'text', lines: [{ kind: 'add', text: 'x', newNo: 1 }], truncated: true } })
    assert.ok(textOf(truncated).includes('只显示了一部分'), '截断必须如实说明')
  }

  // ── 段折叠记忆 ───────────────────────────────────────────────────────────
  {
    // 跨 realm 的对象同样要过 toPlain，否则 deepStrictEqual 全是假失败。
    const foldedShape = (value) => toPlain(value)
    assert.deepStrictEqual(foldedShape(readFolded()), { staged: false, unstaged: false, conflicts: false }, '默认全展开')
    saveFolded({ staged: true, unstaged: false, conflicts: false })
    assert.deepStrictEqual(foldedShape(readFolded()), { staged: true, unstaged: false, conflicts: false })
    saveFolded({ staged: false, unstaged: true, conflicts: false })
    assert.deepStrictEqual(foldedShape(readFolded()), { staged: false, unstaged: true, conflicts: false })
    assert.strictEqual(storage.map.size, 1, '折叠状态是全局偏好，不分工作区')
    // 脏数据不该炸。
    storage.setItem(internals.constants.FOLDED_KEY, '{ not json')
    assert.deepStrictEqual(foldedShape(readFolded()), { staged: false, unstaged: false, conflicts: false })
    storage.setItem(internals.constants.FOLDED_KEY, 'null')
    assert.deepStrictEqual(foldedShape(readFolded()), { staged: false, unstaged: false, conflicts: false })

    const hostile = loadInternals({
      localStorage: {
        getItem() { throw new Error('storage disabled') },
        setItem() { throw new Error('storage disabled') },
      },
    })
    assert.deepStrictEqual(foldedShape(hostile.readFolded()), { staged: false, unstaged: false, conflicts: false })
    hostile.saveFolded({ staged: true, unstaged: true, conflicts: true })
  }

  // ── 旧版宿主：`method` 被忽略，`changes` 回的是 graph 载荷 ────────────────
  //
  // 这是 2026-09-30 在真机上抓到的：宿主半还没重启（0.3.0 的 method 分派未生效），
  // 于是请求 `changes` 拿回来的是**提交图**数据（`{refs, commits, …}`），`ok: true`。
  // 只做「缺字段补空数组」的归一化会让三个段都变空 → 页面显示「✓ 没有未提交的改动」，
  // 而客户端其实一个改动都没问过。**斩钉截铁的假话**，比白屏更糟。
  {
    const { looksLikeChanges, looksLikeDiff, STALE_HOST_COPY } = internals
    // 真实的 graph 载荷（从运行实例里抓的顶层字段）。
    const graphPayload = {
      state: 'ready',
      repo: { root: 'D:/x', name: 'x', branch: 'main' },
      refs: [], commits: [], truncated: false, scanned: 0, skip: 0,
      gitVersion: '2.49.0', generatedAt: 1,
      workspace: { cwd: 'D:/x', source: 'requested' },
      repos: [], selection: { requested: null, source: 'cwd', fallback: false },
      reposTruncated: false, reposTruncatedBy: [],
    }
    assert.strictEqual(looksLikeChanges(graphPayload), false, 'graph 载荷不能被当成改动载荷')
    assert.strictEqual(looksLikeChanges({ sections: { conflicts: [], unstaged: [], staged: [] } }), true)
    assert.strictEqual(looksLikeChanges({ sections: null }), false, 'sections 是 null 也不算')
    assert.strictEqual(looksLikeChanges(null), false)
    assert.strictEqual(looksLikeChanges(undefined), false)
    assert.strictEqual(looksLikeChanges('nope'), false)

    assert.strictEqual(looksLikeDiff({ kind: 'text', lines: [] }), true)
    assert.strictEqual(looksLikeDiff({ kind: 'binary' }), true)
    assert.strictEqual(looksLikeDiff(graphPayload), false, 'graph 载荷不能被当成 diff 载荷')
    assert.strictEqual(looksLikeDiff(null), false)
    assert.strictEqual(looksLikeDiff({ path: 'a.js' }), false, '没有 kind 就不算')

    // 话术必须指向「重启」，而不是含糊的"出错了"。
    assert.ok(/重启/.test(STALE_HOST_COPY), '要让用户知道怎么办：重启 dsh web')
  }

  // ── requestHost 三个 method 走同一个信封 ─────────────────────────────────
  {
    // requestHost 是 requestGraph/requestChanges/requestDiff 的唯一实现：断言它确实把
    // method 放进信封装出去了（宿主按它分派）。
    const calls = []
    const withFetch = loadInternals({
      localStorage: storage,
      fetch: async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) })
        return { ok: true, json: async () => ({ result: { ok: true, value: { marker: calls.length } } }) }
      },
    })
    const a = await withFetch.requestHost('graph', { p: 1 })
    const b = await withFetch.requestHost('changes', { p: 2 })
    const c = await withFetch.requestHost('diff', { p: 3 })
    assert.deepStrictEqual(calls.map((call) => call.body.method), ['graph', 'changes', 'diff'])
    assert.deepStrictEqual(calls.map((call) => call.body.type), ['client-request', 'client-request', 'client-request'])
    assert.strictEqual(calls[0].url, internals.constants.ROUTE)
    assert.ok(calls.every((call) => typeof call.body.rpcId === 'string' && call.body.rpcId !== ''), 'rpcId 不能为空')
    assert.deepStrictEqual([a.value.marker, b.value.marker, c.value.marker], [1, 2, 3])
  }

  console.log('changes-view.test.cjs: OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
