/**
 * 渲染冒烟测试：把 GraphView 真的渲染一次，并喂它各种**畸形/边界**的宿主响应。
 *
 * 为什么值得单独一条：GraphView 里抛出的错会把整页（含下面的提交图）变成空白。
 * 而"宿主返回了形状不对的响应"完全可能——宿主半与浏览器半先后升级，或将来有人改契约。
 * 已有的测试都在测**纯函数**，没有一条真的跑过 GraphView 的渲染路径，白屏因此在测试里是隐形的。
 *
 * 怎么喂进去：GraphView 的 state 是内部的，props 里塞不进去。这里用一个可编排的 react 桩——
 * `useState` 按**调用顺序**依次返回预先排好的值，于是能精确控制它拿到的每一份数据。
 * 调用顺序由源码决定（见下面 VALUES 的注释），顺序变了测试会直接报出来，不会静默失效。
 *
 * 跑法：node test/render-smoke.test.cjs
 */
const assert = require('node:assert')
const { loadInternals } = require('./helpers/load-client.cjs')

/** 收集整棵树的文本；结构异常会在遍历中直接暴露。 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  return textOf(node.children)
}

/**
 * 造一个 react 桩：`useState` 依次弹出 `values`，其余 hook 直通。
 *
 * `values` 的顺序必须与 GraphView 里 useState 的调用顺序一致：
 *   [0] state(graph 请求结果)      [1] changesState(改动请求结果)
 *   [2] scope  [3] query  [4] matchAt  [5] selected  [6] scrollTop  [7] viewHeight
 *   [8] repoChoice  [9] folded  [10] diffTarget
 */
function makeReact(values) {
  let index = 0
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: props === null || props === undefined ? {} : props,
      children: children.flat().filter((child) => child !== null && child !== undefined && child !== false),
    }),
    useCallback: (fn) => fn,
    // 不执行 effect：避免真的发请求/挂监听。渲染路径的正确性不依赖它们跑没跑。
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (initial) => {
      // 占位项（undefined）要落回**真实初值**，而不是变成 undefined ——
      // 真的 useState('') 给的是 ''，给 undefined 会让 query.trim() 这种调用炸掉，
      // 那测出来的就是测试桩的毛病而不是页面的毛病。
      const provided = index < values.length ? values[index] : undefined
      index += 1
      const value = provided === undefined ? initial : provided
      return [typeof value === 'function' ? value() : value, () => {}]
    },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
}

/** 宿主 graph 响应的一个正常形状。 */
function graphValue(overrides) {
  const commit = {
    sha: 'a'.repeat(40), parents: [], author: 'A', email: 'a@e.com', time: 1700000000,
    subject: 'init', head: true, refs: [{ name: 'main', kind: 'branch' }],
  }
  const base = {
    state: 'ready',
    repo: { root: 'D:/repo', name: 'repo', branch: 'main', detached: false, initial: false, upstream: null, ahead: 0, behind: 0, dirty: 1 },
    refs: [{ name: 'main', kind: 'branch', sha: commit.sha, isCurrent: true }],
    commits: [commit],
    truncated: false, scanned: 1, skip: 0, gitVersion: '2.49.0', generatedAt: 1,
    workspace: { cwd: 'D:/repo', source: 'claimed' },
    repos: [{ root: 'D:/repo', name: 'repo', rel: '', depth: 0, outside: false, current: true }],
    selection: { requested: null, source: 'cwd', fallback: false },
    reposTruncated: false, reposTruncatedBy: [],
  }
  return { ...base, ...(overrides === undefined ? {} : overrides) }
}

/** 宿主 changes 响应的一个正常形状。 */
function changesValue(overrides) {
  const base = {
    state: 'ready',
    repo: { root: 'D:/repo', name: 'repo', branch: 'main', detached: false, initial: false, upstream: null, ahead: 0, behind: 0 },
    sections: {
      conflicts: [],
      unstaged: [{ path: 'a/b.js', status: 'M', added: 3, deleted: 1, xy: '.M' }],
      staged: [{ path: 'pkg.json', status: 'M', added: 1, deleted: 1, xy: 'M.' }],
    },
    totals: {
      conflicts: { count: 0, added: 0, deleted: 0, counted: 0 },
      unstaged: { count: 1, added: 3, deleted: 1, counted: 1 },
      staged: { count: 1, added: 1, deleted: 1, counted: 1 },
    },
    truncated: false,
    countsAvailable: true,
    workspace: { cwd: 'D:/repo', source: 'claimed' },
    repos: [{ root: 'D:/repo', name: 'repo', rel: '', depth: 0, outside: false, current: true }],
    gitVersion: '2.49.0',
    generatedAt: 1,
  }
  return { ...base, ...(overrides === undefined ? {} : overrides) }
}

/** 渲染一次（用给定的前十项 state）。返回 `{ text, sandbox }`。 */
function render(states, props) {
  const internals = loadInternals({ react: makeReact(states) })
  const element = internals.GraphView(props)
  let text
  assert.doesNotThrow(() => { text = textOf(element) })
  return { text, sandbox: internals.sandbox }
}

/** 常用的一套 state 前缀（前两项 = graph / changes 结果，后面用初值）。 */
const baseStates = (graph, changes, tail) => [graph, changes, ...(tail === undefined ? [] : tail)]

const PROPS = { ctx: { get: () => undefined, logger: { info() {}, warn() {} } }, sessionId: 's1', cwd: 'D:/repo', visible: true }

function main() {
  const loaded = loadInternals()
  assert.strictEqual(typeof loaded.GraphView, 'function', 'GraphView 必须导出来给冒烟测试用')

  // ── 正常态 ───────────────────────────────────────────────────────────────
  {
    const { text } = render(baseStates(
      { status: 'ready', value: graphValue(), refreshing: false },
      { status: 'ready', value: changesValue(), refreshing: false },
    ), PROPS)
    assert.ok(text.includes('repo'), '仓库名要出现')
    assert.ok(text.includes('main'), '分支要出现')
    assert.ok(text.includes('更改'), '「更改」段头要出现')
    assert.ok(text.includes('暂存的更改'), '「暂存的更改」段头要出现')
    assert.ok(text.includes('+3'), '段头计数要出现')
    assert.ok(text.includes('b.js'), '文件 basename 要出现')
  }

  // ── 工作树干净 ───────────────────────────────────────────────────────────
  {
    const empty = { count: 0, added: 0, deleted: 0, counted: 0 }
    const { text } = render(baseStates(
      { status: 'ready', value: graphValue(), refreshing: false },
      {
        status: 'ready',
        value: changesValue({ sections: { conflicts: [], unstaged: [], staged: [] }, totals: { conflicts: empty, unstaged: empty, staged: empty } }),
        refreshing: false,
      },
    ), PROPS)
    assert.ok(text.includes('没有未提交的改动'), '干净时要给一句明确的话，而不是空白')
  }

  // ── 各类畸形宿主响应：**不许抛**（抛出来就是整页白屏）────────────────────
  //
  // 这些是"宿主半与浏览器半版本错位"时最可能出现的形状。
  const deformities = [
    ['value 缺 sections', { sections: undefined }],
    ['sections 是 null', { sections: null }],
    ['sections 缺一段', { sections: { unstaged: [{ path: 'a.js', status: 'M' }] } }],
    ['某一段是 null', { sections: { conflicts: null, unstaged: null, staged: null } }],
    ['某一段不是数组', { sections: { conflicts: 'nope', unstaged: {}, staged: 42 } }],
    ['totals 整个缺失', { totals: undefined }],
    ['totals 缺一段', { totals: { unstaged: { count: 1, added: 1, deleted: 0, counted: 1 } } }],
    ['totals 是 null', { totals: null }],
    ['repos 是 null', { repos: null }],
    ['repo 缺字段', { repo: { root: 'D:/x', name: 'x' } }],
    ['countsAvailable 缺失', { countsAvailable: undefined }],
    ['行缺 path', { sections: { conflicts: [], unstaged: [{ status: 'M' }], staged: [] } }],
    ['行 path 是数字', { sections: { conflicts: [], unstaged: [{ path: 42, status: 'M' }], staged: [] } }],
  ]
  for (const [label, patch] of deformities) {
    const graphState = { status: 'ready', value: graphValue(), refreshing: false }
    const changesState = { status: 'ready', value: changesValue(patch), refreshing: false }
    let text
    assert.doesNotThrow(() => { text = render(baseStates(graphState, changesState), PROPS).text }, `畸形响应不该让页面炸：${label}`)
    assert.strictEqual(typeof text, 'string', label)
  }

  // ── graph 侧的各种状态 ───────────────────────────────────────────────────
  {
    const cases = [
      ['loading', { status: 'loading' }],
      ['error', { status: 'error', error: { code: 'not-a-repo', message: '不在仓库里' } }],
      ['error 无 message', { status: 'error', error: { code: 'no-git' } }],
      ['error 是 null', { status: 'error', error: null }],
      ['空提交', { status: 'ready', value: graphValue({ commits: [], refs: [] }) }],
      ['空仓库', { status: 'ready', value: graphValue({ commits: [], refs: [], repo: { ...graphValue().repo, initial: true } }) }],
      ['commits 是 null', { status: 'ready', value: graphValue({ commits: null }) }],
      ['refs 是 null', { status: 'ready', value: graphValue({ refs: null }) }],
      ['repo 是 null', { status: 'ready', value: graphValue({ repo: null }) }],
      ['截断', { status: 'ready', value: graphValue({ truncated: true }) }],
      ['仓库清单截断', { status: 'ready', value: graphValue({ reposTruncated: true, reposTruncatedBy: ['dirs'] }) }],
      ['selection 是 null', { status: 'ready', value: graphValue({ selection: null }) }],
    ]
    for (const [label, graphState] of cases) {
      const changesState = { status: 'ready', value: changesValue(), refreshing: false }
      assert.doesNotThrow(() => render(baseStates(graphState, changesState), PROPS), `graph 状态「${label}」不该炸`)
    }
    // 错误态确实把话说出来了。
    const { text } = render(baseStates({ status: 'error', error: { code: 'not-a-repo', message: '不在仓库里' } }, { status: 'ready', value: changesValue(), refreshing: false }), PROPS)
    assert.ok(text.includes('不在仓库里'), '错误文案要显示出来')
  }

  // ── changes 侧的各种状态 ─────────────────────────────────────────────────
  {
    const cases = [
      ['loading', { status: 'loading' }],
      ['error', { status: 'error', error: { code: 'git-failed', message: 'git status 失败' } }],
      ['error 无 message', { status: 'error', error: { code: 'no-git' } }],
    ]
    for (const [label, changesState] of cases) {
      assert.doesNotThrow(() => render(baseStates({ status: 'ready', value: graphValue() }, changesState), PROPS), `changes 状态「${label}」不该炸`)
    }
  }

  // ── 展开的 diff：四种非文本态都要能渲染 ──────────────────────────────────
  {
    // useState 顺序：0 state、1 changesState、2 scope、3 query、4 matchAt、5 selected、
    // 6 scrollTop、7 viewHeight、8 repoChoice、9 folded、10 diffTarget。
    // 所以给索引 2..9 各留一个占位（8 个），diffTarget 才是第 11 项。
    const tail = Array.from({ length: 8 }, () => undefined)
    const kinds = [
      ['loading', { status: 'loading', section: 'unstaged', path: 'a/b.js' }],
      ['error', { status: 'error', section: 'unstaged', path: 'a/b.js', error: { code: 'git-failed', message: 'boom' } }],
      ['binary', { status: 'ready', section: 'unstaged', path: 'a/b.js', value: { kind: 'binary' } }],
      ['dir', { status: 'ready', section: 'unstaged', path: 'a/b.js', value: { kind: 'dir' } }],
      ['too-large', { status: 'ready', section: 'unstaged', path: 'a/b.js', value: { kind: 'too-large' } }],
      ['truncated text', { status: 'ready', section: 'unstaged', path: 'a/b.js', value: { kind: 'text', lines: [{ kind: 'add', text: 'x', newNo: 1 }], truncated: true } }],
      ['unparsed', { status: 'ready', section: 'unstaged', path: 'a/b.js', value: { kind: 'text', lines: [], unparsed: true } }],
    ]
    for (const [label, target] of kinds) {
      const states = baseStates({ status: 'ready', value: graphValue() }, { status: 'ready', value: changesValue(), refreshing: false }, [...tail, target])
      let text
      assert.doesNotThrow(() => { text = render(states, PROPS).text }, `展开 ${label} 不该炸`)
      // 展开态必须能在页面上看到一点东西（不能静默什么都不显示）。
      assert.ok(text.length > 0, label)
    }
    // 二进制与 unparsed 的文案要真的出现。
    const binaryStates = baseStates({ status: 'ready', value: graphValue() }, { status: 'ready', value: changesValue(), refreshing: false },
      [...tail, { status: 'ready', section: 'unstaged', path: 'a/b.js', value: { kind: 'binary' } }])
    assert.ok(render(binaryStates, PROPS).text.includes('二进制'), '二进制文案要出现')
  }

  // ── 旧版宿主：绝不能把「没问过」显示成「没有改动」───────────────────────
  //
  // 2026-09-30 真机抓到的形态：宿主半没重启，`method` 被忽略，`changes` 回的是 graph 载荷，
  // `ok: true` 且无错误。若只做「缺字段补空数组」，页面会印出
  // **「✓ 没有未提交的改动」**——一个斩钉截铁的假话。
  // 这里断言：那种响应必须走**错误态**，且话里要提到重启。
  {
    const graphPayload = {
      state: 'ready',
      repo: { root: 'D:/x', name: 'x', branch: 'main', detached: false, initial: false, upstream: null, ahead: 0, behind: 0, dirty: 0 },
      refs: [], commits: [], truncated: false, scanned: 0, skip: 0,
      gitVersion: '2.49.0', generatedAt: 1,
      workspace: { cwd: 'D:/x', source: 'requested' },
      repos: [], selection: { requested: null, source: 'cwd', fallback: false },
      reposTruncated: false, reposTruncatedBy: [],
    }
    // 这条路径由 GraphView 之外的分支判断（见 looksLikeChanges），这里直接验「话术与状态」：
    const internals = loadInternals()
    assert.strictEqual(internals.looksLikeChanges(graphPayload), false)
    // 用错误态渲染一次，确认文案能显示出来且不炸。
    const text = render(baseStates(
      { status: 'ready', value: graphValue() },
      { status: 'error', error: { code: 'stale-host', message: internals.STALE_HOST_COPY } },
    ), PROPS).text
    assert.ok(text.includes('旧版'), `旧版宿主必须明说，而不是显示"没有改动"：${text.slice(0, 120)}`)
    assert.ok(!text.includes('没有未提交的改动'), '绝不能在这种情形下说"没有改动"')
  }

  // ── props 缺失 ───────────────────────────────────────────────────────────
  {
    const graphState = { status: 'ready', value: graphValue() }
    const changesState = { status: 'ready', value: changesValue() }
    assert.doesNotThrow(() => render(baseStates(graphState, changesState), { ctx: PROPS.ctx }), 'props 全缺时也不该炸')
    assert.doesNotThrow(() => render(baseStates(graphState, changesState), { ctx: PROPS.ctx, sessionId: null, cwd: null, visible: false }))
    assert.doesNotThrow(() => render(baseStates(graphState, changesState), { ...PROPS, visible: false }))
    assert.doesNotThrow(() => render(baseStates(graphState, changesState), { ...PROPS, bindRefresh: () => () => {} }), 'bindRefresh 在时也不该炸')
  }

  // ── 诊断句柄必须被写出来（排查靠它）─────────────────────────────────────
  {
    const internals = loadInternals({ react: makeReact(baseStates(
      { status: 'ready', value: graphValue() },
      { status: 'ready', value: changesValue() },
    )) })
    internals.GraphView(PROPS)
    const handle = internals.sandbox.__DSH_GIT_GRAPH__
    assert.ok(handle !== undefined && handle !== null, '渲染后必须留下 __DSH_GIT_GRAPH__ 诊断句柄')
    assert.ok(handle.changes !== undefined, '诊断句柄要带 changes 段')
    for (const key of ['phase', 'counts', 'totals', 'countsAvailable', 'folded', 'open']) {
      assert.ok(key in handle.changes, `诊断句柄的 changes 缺 ${key}`)
    }
    // 跨 realm 的对象要搬回本 realm 再比（否则 deepStrictEqual 假失败）。
    assert.deepStrictEqual(JSON.parse(JSON.stringify(handle.changes.counts)), { conflicts: 0, unstaged: 1, staged: 1 }, '诊断句柄要报宿主实际返回的行数')
  }

  console.log('render-smoke.test.cjs: OK')
}

main()
