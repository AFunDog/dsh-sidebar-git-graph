/**
 * 「图谱跟随会话 worktree」的**客户端发信**测试。
 *
 * 为什么必须有这一条：宿主侧的优先级（`session-worktree-link.test.cjs`）测的是
 * 「宿主拿到 `repoHint` 会怎么排序」，但**没有任何测试**证明客户端真的把
 * localStorage 里那个记忆当 `repoHint` 发出去、而不是仍旧当 `repo` 点名发。
 *
 * 而后者恰恰是**整个联动失效**的方式：只要它还是 `repo`，就会命中最高的那一档，
 * 标签**永远轮不到** —— 宿主侧测试全绿，功能却完全不工作。
 *
 * 手法：把 GraphView 渲染一次，用真 react 桩记下发出去的 fetch 请求体。
 * 与渲染冒烟测试同款桩（useState 按调用顺序弹值）。
 *
 * 跑法：node test/client-payload.test.cjs
 */
const assert = require('node:assert')
const { loadInternals } = require('./helpers/load-client.cjs')

let failures = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    failures += 1
    console.error(`  ✗ ${name}`)
    console.error(`    ${error && error.message ? error.message : String(error)}`)
  }
}

/**
 * 造一个**记录请求**的 react 桩。
 *
 * 与渲染冒烟测试的桩有两处刻意的不同：
 *   ① `useEffect` **真的执行**回调 —— GraphView 的取数是在 effect 里发起的，
 *      不跑它就只能测到薄薄的转发层，测不到「GraphView 到底发了什么」；
 *   ② 因此 useState 的索引必须与 GraphView 的调用顺序严格一致（见 render-smoke.test.cjs）：
 *      [0] state  [1] changesState  [2] scope  [3] query  [4] matchAt  [5] selected
 *      [6] scrollTop  [7] viewHeight  [8] repoChoice  [9] repoHint  [10] folded  [11] diffTarget
 * @param values - 依次弹出的 useState 值。
 * @returns react 桩。
 */
function makeReact(values) {
  let index = 0
  return {
    createElement: (type, props, ...children) => ({
      type,
      props: props === null || props === undefined ? {} : props,
      children: children.flat().filter((c) => c !== null && c !== undefined && c !== false),
    }),
    useCallback: (fn) => fn,
    // **真的跑** effect：GraphView 的 load() 就在里面，不跑就测不到它发什么。
    // 副作用（订阅/定时器）的清理函数会被忽略——本测试只关心发出去的载荷。
    useEffect: (fn) => { try { fn() } catch { /* 渲染期的桩环境不完整，忽略 */ } },
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (initial) => {
      const provided = index < values.length ? values[index] : undefined
      index += 1
      const value = provided === undefined ? initial : provided
      return [typeof value === 'function' ? value() : value, () => {}]
    },
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
}

/** 一个最小的 graph 响应，够 GraphView 渲染即可。 */
function graphValue(overrides) {
  const base = {
    state: 'ready',
    schema: 2,
    repo: { root: 'D:/ws', name: 'ws', branch: 'main', detached: false, initial: false, upstream: null, ahead: 0, behind: 0, dirty: 0 },
    refs: [], commits: [], truncated: false, skip: 0, max: 100, scanned: 1,
    repos: [{ root: 'D:/ws', name: 'ws', rel: '', depth: 0, outside: false, current: true, kind: 'repo' }],
    selection: { requested: null, source: 'cwd', fallback: false, reason: null, tagged: null, tagReason: null, tagApplied: false },
    worktrees: { total: 1, listed: 1, prunable: [], bare: [] },
    reposTruncated: false, reposTruncatedBy: [],
  }
  return { ...base, ...(overrides === undefined ? {} : overrides) }
}

/** 一个最小的 changes 响应。 */
function changesValue() {
  return {
    state: 'ready', schema: 2,
    repo: { root: 'D:/ws', name: 'ws', branch: 'main', detached: false, initial: false, upstream: null, ahead: 0, behind: 0 },
    sections: { conflicts: [], unstaged: [], staged: [] },
    totals: { conflicts: { count: 0, added: 0, deleted: 0, counted: 0 }, unstaged: { count: 0, added: 0, deleted: 0, counted: 0 }, staged: { count: 0, added: 0, deleted: 0, counted: 0 } },
    truncated: false, countsAvailable: true,
    workspace: { cwd: 'D:/ws', source: 'cwd' },
    repos: [{ root: 'D:/ws', name: 'ws', rel: '', depth: 0, outside: false, current: true, kind: 'repo' }],
    reposTruncated: false, reposTruncatedBy: [],
  }
}

const PROPS = {
  ctx: { get: () => undefined, logger: { info() {}, warn() {} } },
  sessionId: 'sess-1',
  cwd: 'D:/ws',
  visible: true,
}

/**
 * 渲染一次 GraphView，**真的**让它把取数请求发出去，返回截到的信封。
 *
 * 这是本文件的核心：只有让 GraphView 自己跑一遍，才能证明它把「上次记住的仓库」
 * 放进了 `repoHint` 而不是 `repo`。直接调 `requestHost` 测不到这一点 ——
 * 那只是转发层，字段是**调用方**填的。
 * @param options - `{ repoChoice, repoHint, savedRepo, tagApplied }`。
 * @returns `{ captured, values }`。
 */
function renderGraphView(options) {
  const captured = []
  const saved = options.savedRepo === undefined ? null : options.savedRepo

  const graphPayload = graphValue(options.tagApplied === true
    ? { selection: { requested: null, source: 'session-worktree', fallback: false, reason: null, tagged: options.savedRepo ?? 'D:/ws/vendor/kit', tagReason: null, tagApplied: true } }
    : {})

  const values = [
    { status: 'ready', value: graphPayload, refreshing: false },
    { status: 'ready', value: changesValue(), refreshing: false },
  ]
  // 索引 2..7 占位（scope/query/matchAt/selected/scrollTop/viewHeight）。
  for (let i = 0; i < 6; i += 1) values.push(undefined)
  values.push(options.repoChoice)   // 8
  values.push(options.repoHint)     // 9

  const internals = loadInternals({
    fetch: async (url, init) => {
      try { captured.push(JSON.parse(init.body)) } catch { /* 忽略 */ }
      return { ok: true, json: async () => ({ result: { ok: true, value: graphPayload } }) }
    },
    localStorage: {
      getItem: () => saved,
      setItem() {},
      removeItem() {},
    },
    react: makeReact(values),
  })

  internals.GraphView({
    ctx: { get: () => undefined, logger: { info() {}, warn() {} } },
    sessionId: 'sess-1',
    cwd: 'D:/ws',
    visible: true,
  })
  return { captured, values }
}

/** 从截到的信封里挑出某个 method 的 payload。 */
function payloadOf(captured, method) {
  const hit = captured.find((req) => req.method === method)
  return hit === undefined ? undefined : hit.payload
}

/** 让微任务跑完（GraphView 的 load 是 async 的）。 */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

async function main() {
  // ── ① 真正的重点：GraphView 自己发出去的载荷 ──────────────────────────────
  //
  // ⚠️ 这一组测的是**整个联动成立的前提**：只要「上次记住的仓库」还是以 `repo`
  // 发出去，它就命中最高的那一档，会话标签**永远轮不到** ——
  // 而宿主侧的优先级测试仍会全绿，功能却完全不工作。
  {
    const { captured } = renderGraphView({ repoChoice: undefined, repoHint: 'D:/ws/vendor/kit' })
    await settle()

    const graph = payloadOf(captured, 'graph')
    test('GraphView 发出的 graph 请求：记忆进 repoHint，绝不进 repo', () => {
      assert.ok(graph !== undefined, `没截到 graph 请求；截到的是 ${JSON.stringify(captured.map((r) => r.method))}`)
      assert.strictEqual(graph.repoHint, 'D:/ws/vendor/kit', '记忆必须走 repoHint')
      assert.strictEqual(graph.repo, undefined, '记忆绝不能出现在 repo 里（那会压过会话标签）')
      assert.strictEqual(graph.sessionId, 'sess-1')
      assert.strictEqual(graph.cwd, 'D:/ws')
    })

    const changes = payloadOf(captured, 'changes')
    test('GraphView 发出的 changes 请求也带 repoHint', () => {
      assert.ok(changes !== undefined, '没截到 changes 请求')
      assert.strictEqual(changes.repoHint, 'D:/ws/vendor/kit')
      assert.strictEqual(changes.repo, undefined)
    })

    test('信封形状正确（宿主按 method 分派，缺了就静默当 graph）', () => {
      assert.ok(captured.length >= 2, `至少两个请求，实到 ${captured.length}`)
      for (const req of captured) {
        assert.strictEqual(req.type, 'client-request')
        assert.ok(typeof req.rpcId === 'string' && req.rpcId !== '', 'rpcId 必须有')
        assert.ok(typeof req.method === 'string' && req.method !== '')
      }
    })
  }

  // ── ② 手点的（repoChoice）走 repo，优先级最高 ────────────────────────────
  {
    const { captured } = renderGraphView({ repoChoice: 'D:/picked', repoHint: 'D:/ws/vendor/kit' })
    await settle()
    const graph = payloadOf(captured, 'graph')
    test('GraphView：手点的进 repo，记忆仍在 repoHint', () => {
      assert.ok(graph !== undefined, '没截到 graph 请求')
      assert.strictEqual(graph.repo, 'D:/picked', '手点的必须进 repo（最高优先级）')
      assert.strictEqual(graph.repoHint, 'D:/ws/vendor/kit')
    })
  }

  // ── ③ localStorage 里的记忆会被 GraphView 读出来当 repoHint ──────────────
  //
  // 上面两组是直接喂 useState 值；这一组走**真实路径**：localStorage 里有值、
  // repoHint 初值由 useState 的 initializer 从它读出来。验证「切走再回来仍记得」
  // 这条原有行为没有被降级弄坏。
  {
    const { captured, values } = renderGraphView({ repoChoice: undefined, repoHint: undefined, savedRepo: 'D:/ws/remembered' })
    await settle()
    const graph = payloadOf(captured, 'graph')
    test('GraphView：localStorage 里的记忆经 useState 初值变成 repoHint', () => {
      // 索引 9 是 repoHint；桩把 undefined 落回 initializer 的结果。
      assert.ok(graph !== undefined, '没截到 graph 请求')
      assert.strictEqual(graph.repoHint, 'D:/ws/remembered', `实际 repoHint=${JSON.stringify(graph.repoHint)}`)
      assert.strictEqual(graph.repo, undefined, '记忆是提示，不是点名')
      assert.ok(values.length > 9)
    })
  }

  // ── ④ readSavedRepo / saveRepo 仍按工作区分键（原有行为没被破坏）─────────
  test('readSavedRepo / saveRepo 仍按工作区分键', () => {
    const store = new Map()
    const scoped = loadInternals({
      fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }),
      localStorage: {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => store.set(k, String(v)),
        removeItem: (k) => store.delete(k),
      },
    })
    scoped.saveRepo('D:/ws-a', 'D:/ws-a/repo')
    scoped.saveRepo('D:/ws-b', 'D:/ws-b/other')
    assert.strictEqual(scoped.readSavedRepo('D:/ws-a'), 'D:/ws-a/repo')
    assert.strictEqual(scoped.readSavedRepo('D:/ws-b'), 'D:/ws-b/other', '两个工作区不能串')
    assert.strictEqual(scoped.readSavedRepo('D:/ws-c'), undefined)
  })

  // ── ⑤ requestHost 仍是薄转发（三处 method 共用同一信封）─────────────────
  test('requestHost：ok / 错误码 / 网络异常三种回法都对', async () => {
    const ok = loadInternals({ fetch: async () => ({ ok: true, json: async () => ({ result: { ok: true, value: { x: 1 } } }) }) })
    const okOut = await ok.requestHost('graph', {})
    assert.strictEqual(okOut.ok, true)
    assert.strictEqual(okOut.value.x, 1)

    const bad = loadInternals({ fetch: async () => ({ ok: true, json: async () => ({ result: { ok: false, error: { code: 'fenced', message: 'nope' } } }) }) })
    const badOut = await bad.requestHost('graph', {})
    assert.strictEqual(badOut.ok, false)
    assert.strictEqual(badOut.error.code, 'fenced')

    const boom = loadInternals({ fetch: async () => { throw new Error('断网了') } })
    const boomOut = await boom.requestHost('graph', {})
    assert.strictEqual(boomOut.ok, false)
    assert.strictEqual(boomOut.error.code, 'network')
  })

  if (failures > 0) {
    console.error(`\n✗ client-payload.test.cjs: ${failures} 条失败`)
    process.exit(1)
  }
  console.log('client-payload.test.cjs: OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
