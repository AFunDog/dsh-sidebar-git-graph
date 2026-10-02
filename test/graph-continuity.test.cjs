/**
 * 图谱**连续性**回归测试：泳道线不许在行与行之间断掉，且不许被行底色盖住。
 *
 * 这两条都是 2026-10-02 用户报的**画得不对**，各修一次。两条都不是"崩了"，是"看起来少一截"，
 * 所以任何「不抛错就算过」的测试都抓不到——这里断言的是**几何与层叠**本身。
 *
 * ── 症状 1：行接缝处断线 ────────────────────────────────────────────────────
 * 真实仓库 `Live2DUnityUpdate` 400 行里恰好一处：合并提交 → 分支提交 → 合并提交，
 * 中间那个提交的第二父提交**早就在等**（另一条道上）。那一行整段没有竖线，
 * 于是线在它上边缘凭空断掉。全机扫盘：8 个仓库、3109 个接缝里 40 处。
 *
 * ── 症状 2：鼠标悬停在某行，那行的图谱被行底色盖住 ──────────────────────────
 * SVG 是 sizer 的第一个子节点，行是 position:absolute 的不透明方块且排在它之后。
 * CSS 的绘制顺序按 DOM 序，所以 `pointer-events:none` 挡不住**绘制**上的覆盖。
 * 这条测试断言 CSS 里 `.zgg-svg` 有 z-index（纯函数测不到层叠，只能断言样式表契约）。
 *
 * 跑法：node test/graph-continuity.test.cjs
 */
const assert = require('node:assert')
const { loadInternals, toPlain } = require('./helpers/load-client.cjs')

/**
 * 一行的全部线段。把 path 的 d 解析成 (x0,y0)→(x1,y1)，贝塞尔只取端点——
 * 曲线的两个控制点都在竖直中点，端点才是与相邻行相接的地方。
 */
function segments(client, layout, index) {
  const x = (lane) => client.constants.PAD_L + lane * client.constants.LANE_W + client.constants.LANE_W / 2
  return toPlain(client.rowGeometry(layout, index)).map((path) => {
    const numbers = path.d.match(/-?[\d.]+/g).map(Number)
    const straight = path.d.includes(' L ')
    return {
      kind: path.kind,
      x0: numbers[0],
      y0: numbers[1],
      x1: straight ? numbers[2] : numbers[6],
      y1: straight ? numbers[3] : numbers[7],
      // 该行每条线段理应对齐到泳道中心线，用来抓"画歪了"。
      laneX: x,
    }
  })
}

/**
 * 行接缝处的连续性：第 r 行下边缘有线的每个 x，第 r+1 行上边缘同 x 也必须有线（反之亦然）。
 * @returns 断缝描述数组，空数组 = 连续。
 */
function seams(client, layout) {
  const { ROW_H } = client.constants
  const bands = []
  for (let index = 0; index < layout.rows.length; index += 1) bands.push(segments(client, layout, index))

  /** 某行在 y 高度上"有线"的 x 集合。 */
  const endsAt = (segs, y) => {
    const set = new Set()
    for (const seg of segs) {
      if (seg.y0 === y) set.add(seg.x0)
      if (seg.y1 === y) set.add(seg.x1)
    }
    return set
  }

  const breaks = []
  for (let index = 0; index + 1 < layout.rows.length; index += 1) {
    const y = (index + 1) * ROW_H
    const below = endsAt(bands[index], y)
    const above = endsAt(bands[index + 1], y)
    const missingBelow = [...below].filter((value) => !above.has(value))
    const missingAbove = [...above].filter((value) => !below.has(value))
    if (missingBelow.length > 0 || missingAbove.length > 0) {
      breaks.push({ index, y, missingBelow, missingAbove })
    }
  }
  return breaks
}

/** 用 sha/parents 造提交数组。 */
const chain = (entries) => entries.map(([sha, parents]) => ({ sha, parents }))

function main() {
  const client = loadInternals()
  const { assignLanes, edgePath, graphWidth, CSS, constants } = client
  const { ROW_H, LANE_W, PAD_L } = constants

  // ── 症状 1 的最小复现（真实仓库那 4 行的**逐字**前缀）────────────────────
  //
  //   dc722621 ── 父 [d9b8491a, 4ad1af0a]   第二父 4ad1af0a 还不存在 → 新开 1 号道
  //   4ad1af0a ── 父 [10e15ccb]            在 1 号道上，1 号道继续等 10e15ccb
  //   d9b8491a ── 父 [ada865b4, 10e15ccb]  ★ 问题行：第二父 10e15ccb **已经在 1 号道上等**
  //                                          → 走 existing 分支，曲线 0→1
  //   ada865b4 ── 父 [10e15ccb]            仍在 0 号道
  //   10e15ccb ── 根
  //
  // 这 5 行就是从 Live2DUnityUpdate 扫出来的那处断缝（原文第 0–2 行 + 它的父提交）。
  const layout = toPlain(assignLanes(chain([
    ['dc722621', ['d9b8491a', '4ad1af0a']],
    ['4ad1af0a', ['10e15ccb']],
    ['d9b8491a', ['ada865b4', '10e15ccb']],
    ['ada865b4', ['10e15ccb']],
    ['10e15ccb', []],
  ]), constants.PALETTE))

  assert.strictEqual(layout.rows.length, 5)

  // 问题行：d9b8491a 的第二个父提交早在 1 号道上等 → 一条 branch 曲线 0→1
  const problemRow = layout.rows[2]
  assert.strictEqual(problemRow.sha, 'd9b8491a')
  assert.deepStrictEqual(
    problemRow.branches.map((branch) => ({ from: branch.from, to: branch.to })),
    [{ from: 0, to: 1 }],
    '该行必须有「主道 → 已在等第二父提交的那条道」的分支曲线',
  )
  // ★ 这就是那个 bug：曲线终点所在的道**不是**本行新开的——它上面有线、下面还要继续等
  //   那个父提交，所以必须有一条竖线贯穿整行。修之前这里 verticals 是空的，
  //   于是 1 号道在上一行下边缘与下一行上边缘之间**凭空缺了一整行**（肉眼就是断线）。
  assert.deepStrictEqual(
    problemRow.verticals.map((vertical) => vertical.lane),
    [1],
    '已在等的道必须有竖线贯穿本行（否则线在行接缝处断开）',
  )
  // 相邻两行也要有那条线，确认断的确实只有中间这一行。
  assert.deepStrictEqual(layout.rows[1].verticals.map((vertical) => vertical.lane), [0])
  assert.deepStrictEqual(layout.rows[3].verticals.map((vertical) => vertical.lane), [1])

  // 整个最小形状不许有任何断缝。
  assert.deepStrictEqual(seams(client, layout), [], '最小复现形状不许有断缝')

  // ── 真正的最小形状：只有**两行** ──────────────────────────────────────────
  //
  //   M ── 父 [A, C]    C 不在飞 → 新开 1 号道
  //   A ── 父 [B, C]    ★ C 已经在飞 → 走 existing 分支；这一行必须有 1 号道的竖线
  // 修之前这一行的 verticals 是空的，线在两行之间断掉。
  const minimal = toPlain(assignLanes(chain([['M', ['A', 'C']], ['A', ['B', 'C']]]), constants.PALETTE))
  assert.strictEqual(minimal.rows.length, 2, '最小形状只有两行')
  assert.deepStrictEqual(minimal.rows[1].verticals.map((vertical) => vertical.lane), [1],
    '两行形状也必须接住上一行下来的线')
  assert.deepStrictEqual(seams(client, minimal), [], '两行形状不许有断缝')

  // ── 对照组：新开的道**不该**有竖线（否则会把修法做过头）──────────────────
  //
  //   M1 ── 父 [A, C]   C 新开一条道（上面没有线），所以那一行不该有 1 号道的竖线
  const fresh = toPlain(assignLanes(chain([['M1', ['A', 'C']], ['A', []], ['C', []]]), constants.PALETTE))
  assert.deepStrictEqual(
    fresh.rows[0].verticals.map((vertical) => vertical.lane),
    [],
    '本行新开的道上面没有线，不该画竖线',
  )
  assert.deepStrictEqual(seams(client, fresh), [])

  // ── 不变量：一批形状都不许出现断缝 ────────────────────────────────────────
  const shapes = {
    线性: chain([['c3', ['c2']], ['c2', ['c1']], ['c1', []]]),
    菱形: chain([['M', ['A', 'B']], ['A', ['R']], ['B', ['R']], ['R', []]]),
    未合并分叉: chain([['A', ['R']], ['B', ['R']], ['R', []]]),
    octopus: chain([['M', ['P1', 'P2', 'P3']], ['P1', ['R']], ['P2', ['R']], ['P3', ['R']], ['R', []]]),
    // 两个合并提交共用同一个第二父提交：真实仓库里那种"合过来又合回去"
    交叉合并: chain([
      ['M2', ['M1', 'C']],
      ['M1', ['A', 'B']],
      ['A', ['C']],
      ['B', ['C']],
      ['C', []],
    ]),
    // 头两个提交都是合并、且第二父提交共用（Live2DUnityUpdate 开头正是这个形状）
    双合并同尾: chain([
      ['N', ['M', 'S']],
      ['M', ['A', 'S']],
      ['A', ['S']],
      ['S', []],
    ]),
    窗口截断: chain([['A', ['Z-不在窗口里']]]),
  }
  for (const [name, commits] of Object.entries(shapes)) {
    const result = toPlain(assignLanes(commits, constants.PALETTE))
    assert.deepStrictEqual(seams(client, result), [], `形状「${name}」出现断缝`)
  }

  // ── 随机形状：连续性是**不变量**，不是这几个例子的巧合 ────────────────────
  // 固定种子的线性同余，保证可复现（不引随机库，也不靠 Math.random）。
  let seed = 20261002
  const next = (bound) => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed % bound
  }
  let checked = 0
  for (let round = 0; round < 300; round += 1) {
    const count = 2 + next(24)
    const shas = []
    for (let index = 0; index < count; index += 1) shas.push(`s${index}`)
    const commits = []
    for (let index = 0; index < count; index += 1) {
      // 父提交只能指向更老的（topo-order 的前提），每个提交 0–3 个父。
      const parentCount = next(4)
      const parents = []
      for (let slot = 0; slot < parentCount; slot += 1) {
        const target = index + 1 + next(Math.max(1, count - index - 1))
        if (target < count) parents.push(shas[target])
      }
      commits.push({ sha: shas[index], parents })
    }
    // 合并提交至少要两个不同父，否则形状没意义。
    for (const commit of commits) commit.parents = [...new Set(commit.parents)]
    const result = toPlain(assignLanes(commits, constants.PALETTE))
    const breaks = seams(client, result)
    assert.deepStrictEqual(breaks, [], `随机形状第 ${round} 轮出现断缝：${JSON.stringify(breaks[0])}`)
    checked += 1
  }

  // ── 几何体检：不许有 NaN，且每条线段都要落在自己的行区间内 ──────────────
  const geometry = toPlain(assignLanes(shapes.交叉合并, constants.PALETTE))
  for (let index = 0; index < geometry.rows.length; index += 1) {
    const top = index * ROW_H
    const bottom = top + ROW_H
    for (const seg of segments(client, geometry, index)) {
      assert.ok(Number.isFinite(seg.x0) && Number.isFinite(seg.y0) && Number.isFinite(seg.x1) && Number.isFinite(seg.y1),
        `线段坐标出现非有限值：${JSON.stringify(seg)}`)
      assert.ok(seg.y0 >= top && seg.y1 <= bottom, `线段越出自己的行区间：${JSON.stringify(seg)}`)
      assert.ok(seg.y0 <= seg.y1, `线段方向反了：${JSON.stringify(seg)}`)
      // 端点必须落在某条泳道的中心线上（曲线终点与竖线都在中心线）。
      assert.ok(Math.abs(seg.x0 - seg.laneX(Math.round((seg.x0 - PAD_L - LANE_W / 2) / LANE_W))) < 1e-6,
        `线段起点不在泳道中心线上：${JSON.stringify(seg)}`)
    }
    // 行宽足够装下所有道。
    assert.ok(graphWidth(geometry) >= PAD_L * 2 + geometry.laneCount * LANE_W)
  }
  assert.strictEqual(edgePath(15, 0, 15, 24), 'M 15 0 L 15 24', '同列仍应退化成直线')

  // ── 症状 2：图谱必须画在行底色**之上** ────────────────────────────────────
  //
  // 层叠顺序是浏览器的活，纯函数测不到；能在这里钉住的是**样式表契约**：
  // SVG 有 z-index，且它的层叠上下文（sizer）是定位元素。
  // 真机像素证据见本次修复的记录：悬停行内 24/24 个采样像素曾被行底色覆盖，
  // 加上 z-index 后 0/24。
  const svgRule = CSS.match(/\.zgg-svg\s*\{[^}]*\}/)
  assert.ok(svgRule !== null, 'CSS 里应当有 .zgg-svg 规则')
  assert.ok(/z-index:\s*[1-9]/.test(svgRule[0]),
    '.zgg-svg 必须有正 z-index：行是不透明绝对定位方块且排在 SVG 之后，否则悬停/选中时会把图谱盖住')
  assert.ok(svgRule[0].includes('pointer-events: none'),
    'SVG 仍须不参与命中测试（行才点得到）')
  const sizerRule = CSS.match(/\.zgg-sizer\s*\{[^}]*\}/)
  assert.ok(sizerRule !== null && sizerRule[0].includes('position: relative'),
    '.zgg-sizer 必须是定位元素，z-index 才有意义')
  // 行本身不许比 SVG 更高：否则等于把上面那条又改回去了。
  const rowRule = CSS.match(/\.zgg-row\s*\{[^}]*\}/)
  assert.ok(rowRule !== null, 'CSS 里应当有 .zgg-row 规则')
  assert.ok(!/z-index:\s*[1-9]/.test(rowRule[0]),
    '.zgg-row 不得带正 z-index（会把图谱重新盖住）')

  console.log(`graph-continuity.test.cjs: OK（含 ${checked} 轮随机形状的不变量检查）`)
}

main()
