/**
 * 测试用的客户端加载器：把浏览器半身（单文件惰性 CJS 工厂）在 `node:vm` 里跑起来。
 *
 * 为什么不直接 require：`lib/client.js` 的顶层是 `window.__ModuleLoader__.load({...})`，
 * 它根本不是 CommonJS 模块。这里喂一个桩 `__ModuleLoader__` + 一个最小 `document`，
 * 只取工厂返回的 `internals`（纯度函数与 CSS）——不引 jsdom、不起浏览器。
 *
 * 注意：跨 vm realm 造出来的数组/对象原型与本 realm 不同，`deepStrictEqual` 会假失败。
 * 调用方要用本文件导出的 `toPlain` 把它们搬回来。
 */
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const BUNDLE = path.join(__dirname, '..', '..', 'lib', 'client.js')

/** 最小 react 桩：只够构造元素与调用 hook，不参与断言。 */
function reactStub() {
  return {
    createElement: () => ({}),
    useCallback: (fn) => fn,
    useEffect: () => {},
    useMemo: (fn) => fn(),
    useRef: (value) => ({ current: value }),
    useState: (value) => [value, () => {}],
    useSyncExternalStore: (_subscribe, snapshot) => snapshot(),
  }
}

/**
 * 加载客户端 bundle。
 * @param extraGlobals - 额外塞进沙箱的全局（例如桩 `localStorage`）。
 * @returns 工厂导出的 `internals`。
 */
function loadInternals(extraGlobals) {
  const source = fs.readFileSync(BUNDLE, 'utf8')
  const registered = []
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(entry) { registered.push(entry) },
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
    ...(extraGlobals === undefined ? {} : extraGlobals),
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox, { filename: BUNDLE })

  assert.strictEqual(registered.length, 1, '应恰好注册一次模块')
  const entry = registered[0]
  assert.strictEqual(entry.id, '@zeng/dsh-sidebar-git-graph')
  const plugin = entry.factory((name) => {
    if (name === 'react') return reactStub()
    throw new Error(`未预料的 require：${name}`)
  })
  assert.strictEqual(typeof plugin.apply, 'function')
  // 跨 vm realm 的数组原型不同，deepStrictEqual 会假失败——只比长度。
  assert.strictEqual(plugin.inject.length, 0, '不得静态 inject 第三方服务（冷启动陷阱）')
  return plugin.internals
}

/**
 * 把 vm 里造出来的值搬回本 realm（这些结构本来就是纯 JSON）。
 * @param value - 任意值。
 * @returns 同值的本 realm 副本。
 */
function toPlain(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

module.exports = { BUNDLE, loadInternals, toPlain }
