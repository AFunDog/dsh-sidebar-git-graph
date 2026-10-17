/**
 * dsh-sidebar-git-graph 浏览器半的泳道布局测试。
 *
 * 浏览器半是「惰性 CJS 工厂」单文件，所以这里用 vm + 桩 window.__ModuleLoader__ 把它
 * 加载起来（零依赖桩：只喂一个 __ModuleLoader__ 与一个最小 document），
 * 只取 `internals` 里的纯度函数做表格化断言——不引 jsdom、不起浏览器。
 *
 * 跑法：node test/lane-layout.test.cjs
 */
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const BUNDLE = path.join(__dirname, '..', 'lib', 'client.js')

/** 把 client.js 当脚本跑一遍，拿到工厂导出的 internals。 */
function loadInternals() {
  const source = fs.readFileSync(BUNDLE, 'utf8')
  const registered = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) {
          registered.push(entry)
        },
      },
    },
    document: {
      getElementById() { return null },
      createElement() { return { id: '', textContent: '', style: {} } },
      head: { appendChild() {} },
    },
    fetch() { throw new Error('测试不应发请求') },
    console,
    setTimeout,
    clearInterval,
    setInterval,
    Math,
    Date,
    JSON,
    URL,
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: BUNDLE })

  assert.strictEqual(registered.length, 1, '应恰好注册一次模块')
  const entry = registered[0]
  assert.strictEqual(entry.id, '@zeng/dsh-sidebar-git-graph')
  const plugin = entry.factory((name) => {
    if (name === 'react') {
      return {
        createElement: () => ({}),
        useCallback: (fn) => fn,
        useEffect: () => {},
        useMemo: (fn) => fn(),
        useRef: (value) => ({ current: value }),
        useState: (value) => [value, () => {}],
        // 展开块的高度靠 useLayoutEffect 量（见 client.js）：这个文件不渲染 GraphView，
        // 但桩必须与真实 react 同形——缺一个 hook 的表现是 TypeError + 整页白屏。
        useLayoutEffect: () => {},
        useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
      }
    }
    throw new Error(`未预料的 require：${name}`)
  })
  assert.strictEqual(typeof plugin.apply, 'function')
  // 跨 vm realm 的数组原型不同，deepStrictEqual 会假失败——只比长度与内容。
  assert.strictEqual(plugin.inject.length, 0, '不得静态 inject 第三方服务（冷启动陷阱）')
  return plugin.internals
}

function commit(sha, parents) {
  return { sha, parents }
}

async function main() {
  const internals = loadInternals()
  const { edgePath, graphWidth, relativeTime, shortSha, CSS, constants } = internals
  // vm 里造出来的数组/对象原型与本 realm 不同，deepStrictEqual 会假失败：
  // 过一遍 JSON 把它们搬回本 realm（这些结构本来就是纯 JSON）。
  const norm = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
  const assignLanes = (commits, size) => norm(internals.assignLanes(commits, size))
  const rowGeometry = (layout, index, top) => norm(internals.rowGeometry(layout, index, top))

  // ── 常量 ────────────────────────────────────────────────────────────────
  assert.strictEqual(constants.TAB_ID, '@zeng/dsh-sidebar-git-graph:graph')
  assert.strictEqual(constants.ROUTE, '/dsh-sidebar-git-graph/api')
  assert.strictEqual(constants.PALETTE, 10)

  // 皮肤纪律：样式表里不得出现颜色字面量（颜色一律来自 --dsw-alias-* 令牌）。
  const literals = CSS.match(/#[0-9a-fA-F]{3,8}\b/g)
  assert.strictEqual(literals, null, `样式表不应有颜色字面量，实到：${literals === null ? '' : literals.join(',')}`)
  assert.ok(CSS.includes('--dsw-alias-bg-layer-1'), '面板表面必须用面板令牌')
  assert.ok(!CSS.includes('--dsw-specific-sidebar-fill'), '不得消费左导航专属令牌')

  // ── 空输入 ──────────────────────────────────────────────────────────────
  const empty = assignLanes([], 10)
  assert.deepStrictEqual(empty.rows, [])
  assert.strictEqual(empty.laneCount, 0)
  assert.deepStrictEqual(empty.dangling, [])
  assert.deepStrictEqual(assignLanes(undefined, 10).rows, [])

  // ── 线性历史 ────────────────────────────────────────────────────────────
  const linear = assignLanes([
    commit('c3', ['c2']),
    commit('c2', ['c1']),
    commit('c1', []),
  ], 10)
  assert.strictEqual(linear.rows.length, 3)
  assert.strictEqual(linear.laneCount, 1)
  assert.deepStrictEqual(linear.dangling, [])
  assert.deepStrictEqual(linear.rows.map((row) => row.lane), [0, 0, 0])
  assert.deepStrictEqual(linear.rows.map((row) => [row.up, row.down]), [[false, true], [true, true], [true, false]])
  assert.deepStrictEqual(linear.rows[0].verticals, [])
  assert.deepStrictEqual(linear.rows[0].merges, [])
  assert.deepStrictEqual(linear.rows[0].branches, [])
  assert.strictEqual(linear.rows[0].color, 0, '线性历史只有一条道、一个颜色')

  // ── 菱形：分支 + 合并（多分支关系的核心用例）────────────────────────────
  //   M ── 合并 A、B     （M 的父是 A 与 B）
  //   A ── 父 R
  //   B ── 父 R
  //   R ── 根
  const diamond = assignLanes([
    commit('M', ['A', 'B']),
    commit('A', ['R']),
    commit('B', ['R']),
    commit('R', []),
  ], 10)
  assert.strictEqual(diamond.rows.length, 4)
  assert.strictEqual(diamond.laneCount, 2, '一个分叉 + 一次合并 = 两条道')
  assert.deepStrictEqual(diamond.dangling, [])
  // 第一行：本提交在主道，第二个父提交新开一条道 → 一条 branch 曲线
  assert.strictEqual(diamond.rows[0].lane, 0)
  assert.strictEqual(diamond.rows[0].branches.length, 1)
  assert.deepStrictEqual(
    { from: diamond.rows[0].branches[0].from, to: diamond.rows[0].branches[0].to },
    { from: 0, to: 1 },
  )
  assert.strictEqual(diamond.rows[0].up, false, '分支尖端没有上一行')
  assert.strictEqual(diamond.rows[0].down, true)
  // 第二行：主道是 A，另一条道在等 B → 直穿
  assert.deepStrictEqual(diamond.rows[1].verticals, [{ lane: 1, color: 1 }])
  assert.deepStrictEqual(diamond.rows[1].merges, [])
  // 第三行：B 在第二条道上
  assert.strictEqual(diamond.rows[2].lane, 1)
  // 第四行：R 被两条道同时等待 → 落在第一条、另一条汇入
  assert.strictEqual(diamond.rows[3].lane, 0)
  assert.strictEqual(diamond.rows[3].merges.length, 1)
  assert.deepStrictEqual(
    { from: diamond.rows[3].merges[0].from, to: diamond.rows[3].merges[0].to },
    { from: 1, to: 0 },
  )
  assert.deepStrictEqual(diamond.rows[3].verticals, [])
  assert.strictEqual(diamond.rows[3].down, false, '根提交没有向下的线')

  // 每一行都恰好一个提交点，且每行的道号都在 [0, laneCount)。
  for (const row of diamond.rows) {
    assert.ok(row.lane >= 0 && row.lane < diamond.laneCount)
    for (const edge of [...row.merges, ...row.branches, ...row.verticals]) {
      const lanes = [edge.from, edge.to, edge.lane].filter((value) => value !== undefined)
      for (const lane of lanes) assert.ok(lane >= 0 && lane < diamond.laneCount, `道号越界：${lane}`)
    }
  }

  // ── 未合并的分支：两条道一直活着 ────────────────────────────────────────
  const unmerged = assignLanes([
    commit('A', ['R']),
    commit('B', ['R']),
    commit('R', []),
  ], 10)
  assert.strictEqual(unmerged.laneCount, 2)
  assert.deepStrictEqual(unmerged.rows[1].verticals.map((entry) => entry.lane), [0], 'A 那条道要直穿 B 这一行')

  // ── octopus merge：三个父提交 ───────────────────────────────────────────
  const octopus = assignLanes([
    commit('M', ['P1', 'P2', 'P3']),
    commit('P1', ['R']),
    commit('P2', ['R']),
    commit('P3', ['R']),
    commit('R', []),
  ], 10)
  assert.strictEqual(octopus.rows[0].branches.length, 2, '两个额外父提交 → 两条 branch 曲线')
  assert.strictEqual(octopus.laneCount, 3)
  assert.strictEqual(octopus.rows[4].merges.length, 2, '三条道在根提交汇合')
  assert.deepStrictEqual(octopus.dangling, [])

  // ── 窗口截断 / 浅克隆：父提交不在窗口里 ─────────────────────────────────
  const truncated = assignLanes([commit('A', ['Z-not-in-window'])], 10)
  assert.deepStrictEqual(truncated.dangling, [0], '等不到父提交的道必须报悬空')
  assert.strictEqual(truncated.rows[0].down, true, '悬空道的线要继续画下去')

  // ── 乱序 / 缺字段 / 重复 sha：不许抛错 ──────────────────────────────────
  const messy = assignLanes([
    { sha: 'B', parents: undefined },
    null,
    { sha: 'A' },
    commit('A', ['B']),
    commit('A', ['B']),
    { sha: '', parents: ['x'] },
  ], 10)
  assert.strictEqual(messy.rows.length, 6, '空 sha 也要占一行，不吞行')
  assert.ok(messy.laneCount >= 1)

  // 逆序（父在前、子在后）也不抛错——只是画得没那么好看。
  const reversed = assignLanes([commit('R', []), commit('M', ['R'])], 3)
  assert.strictEqual(reversed.rows.length, 2)

  // ── 配色环：道号取模、颜色索引始终在环内 ────────────────────────────────
  const many = []
  for (let index = 20; index >= 0; index -= 1) {
    many.push(commit(`s${index}`, index === 0 ? [] : [`s${index - 1}`]))
  }
  const wide = assignLanes(many, 3)
  for (const row of wide.rows) {
    assert.ok(row.color >= 0 && row.color < 3, `颜色索引必须落在环内：${row.color}`)
    for (const edge of [...row.merges, ...row.branches, ...row.verticals]) {
      const color = edge.color
      assert.ok(color >= 0 && color < 3, `边的颜色索引必须落在环内：${color}`)
    }
  }

  // ── 几何 ────────────────────────────────────────────────────────────────
  const geometry = rowGeometry(diamond, 0)
  const kinds = geometry.map((path) => path.kind).sort()
  assert.deepStrictEqual(kinds, ['branch', 'down'], '第一行只有「向下」与「分出」两段')
  for (const path of geometry) {
    assert.ok(/^M [\d.-]+ [\d.-]+( L| C)/.test(path.d), `path 形状不对：${path.d}`)
    assert.ok(!path.d.includes('NaN'), 'path 里不能出现 NaN')
  }
  // 根提交那一行：从上面下来的主线 + 汇入曲线，没有向下的线。
  assert.deepStrictEqual(rowGeometry(diamond, 3).map((path) => path.kind).sort(), ['merge', 'up'])
  assert.deepStrictEqual(rowGeometry(diamond, 99), [], '越界行返回空数组')
  assert.deepStrictEqual(rowGeometry(linear, 1).map((path) => path.kind).sort(), ['down', 'up'])

  // 合并曲线必须落在「上边 → 本行中点」，分出曲线落在「中点 → 下边」。
  const mergeGeometry = rowGeometry(diamond, 3)[0]
  assert.ok(mergeGeometry.d.includes(' C '), '曲线段必须是贝塞尔')
  assert.strictEqual(edgePath(3, 0, 3, 24), 'M 3 0 L 3 24', '同列退化成直线')
  assert.ok(edgePath(0, 0, 14, 24).includes('C'))

  // ── 展开块插在列表中间时的纵向映射（2026-10-17）────────────────────────────
  //
  // 详情块以前挂在定高列表**之后**（点哪一行都得滚到底），现在插到点中的那一行下面，
  // 于是"行号 → y"不再是 index * ROW_H。**正反两个方向必须一起改**：行/圆点/泳道线用
  // yAt，虚拟窗口用 rowAt 从 scrollTop 反推行号——只改正方向的话，滚过插入块之后窗口会
  // 整体错位 gap/ROW_H 行（症状是滚到下面就白了，或重复渲染同一批行）。
  const offsets = internals.listOffsets({ count: 6, rowHeight: 24, openAt: 2, gap: 100 })
  assert.strictEqual(offsets.total, 6 * 24 + 100, '总高必须把插入块算进去，否则滚不到最后几行')
  assert.strictEqual(offsets.yAt(2), 48, '插入点自己那一行不动')
  assert.strictEqual(offsets.yAt(3), 72 + 100, '它下面每一行整体下移 gap')
  assert.strictEqual(offsets.yAt(5), 120 + 100)
  for (let index = 0; index < 6; index += 1) {
    assert.strictEqual(offsets.rowAt(offsets.yAt(index)), index, `rowAt 必须是 yAt 的逆（第 ${index} 行）`)
    assert.strictEqual(offsets.rowAt(offsets.yAt(index) + 23), index, '行内任意位置都要落回同一行')
  }

  // ⚠️ 面板自己的位置用 `gapTop`（展开行的**下缘**），与 gap 无关——量到高度之前也要站对，
  // 拿 `yAt(openAt + 1)` 去定位会把面板再顶下去一个自己的高度：先一块空白、面板落到空白底下。
  assert.strictEqual(offsets.gapTop, 3 * 24, '插入块顶边 = 展开行的下缘')
  assert.strictEqual(offsets.gapTop, offsets.yAt(2) + 24, 'gapTop 必须紧贴展开行的下缘')
  assert.strictEqual(offsets.gapTop + 100, offsets.yAt(3), '面板底边正好是下一行的顶边：不留缝也不重叠')
  assert.strictEqual(internals.listOffsets({ count: 3, rowHeight: 24, openAt: 2, gap: 50 }).gapTop, 72,
    '展开最后一行：插入块紧跟其后，别越界')

  // 没展开时退化成均匀网格：既有行为一字不改（`gap: 0` 与 `openAt < 0` 都算没展开）。
  const plain = internals.listOffsets({ count: 6, rowHeight: 24, openAt: -1, gap: 100 })
  assert.strictEqual(plain.total, 144)
  assert.strictEqual(plain.yAt(4), 96)
  assert.strictEqual(plain.rowAt(96), 4)
  const noGap = internals.listOffsets({ count: 6, rowHeight: 24, openAt: 2, gap: 0 })
  assert.strictEqual(noGap.total, 144)
  assert.strictEqual(noGap.openAt, -1, 'gap 为 0 等于没展开')
  assert.strictEqual(noGap.gapTop, 3 * 24, '高度还没量到（gap=0）时面板也要站对位置')
  assert.strictEqual(plain.gapTop, null, '没有展开就没有插入块')
  assert.strictEqual(internals.listOffsets({ count: 0 }).total, 0)
  assert.strictEqual(internals.listOffsets({}).openAt, -1)
  assert.strictEqual(internals.listOffsets(undefined).total, 0)

  // 展开最后一行：插入块在它下面，没有"更下面的行"要移。
  const last = internals.listOffsets({ count: 3, rowHeight: 24, openAt: 2, gap: 50 })
  assert.strictEqual(last.total, 3 * 24 + 50)
  assert.strictEqual(last.yAt(2), 48)

  // 行的 y 由调用方给时，泳道线要跟着**拉长**（整行的线段共用同一个 top）。
  const stretched = rowGeometry(linear, 1, 124).map((path) => path.d)
  assert.ok(stretched.length > 0)
  assert.ok(stretched.some((d) => d.includes('124')), `泳道线要跟着插入块下移：${stretched.join(' | ')}`)
  assert.ok(stretched.every((d) => !/(^| )24( |$)/.test(d)), `不该残留未偏移的 y=24：${stretched.join(' | ')}`)
  assert.deepStrictEqual(
    rowGeometry(linear, 1, 24).map((path) => path.d),
    rowGeometry(linear, 1).map((path) => path.d),
    '缺省 top 仍是 index*ROW_H（=24）——既有调用方与既有测试不受影响',
  )

  // 图谱列宽随道数增长，且始终留出内边距。
  assert.ok(graphWidth(diamond) > graphWidth(linear))
  assert.strictEqual(graphWidth(linear), constants.PAD_L * 2 + constants.LANE_W)

  // ── 文案工具 ────────────────────────────────────────────────────────────
  assert.strictEqual(shortSha('abcdef1234567890'), 'abcdef12')
  assert.strictEqual(shortSha(undefined), '')
  assert.strictEqual(relativeTime(1000, 1000), '刚刚')
  assert.strictEqual(relativeTime(1000, 1000 + 120), '2 分钟前')
  assert.strictEqual(relativeTime(1000, 1000 + 7200), '2 小时前')
  assert.strictEqual(relativeTime(1000, 1000 + 86400 * 3), '3 天前')
  assert.strictEqual(relativeTime(0, 1000), '')
  assert.strictEqual(relativeTime(Number.NaN, 1000), '')

  console.log('lane-layout.test.cjs: OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
