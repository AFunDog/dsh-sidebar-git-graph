/**
 * 启动安全与打包契约测试：验证「DSH 真的能把这个包加载起来」所需要的每一条。
 *
 * 为什么单独一条：`--dump-config` 只证明**宿主行**能组合，它**看不到**浏览器半。
 * 而下面每一条失败都会让插件静默降级（标题变包名、卡片变灰底）或让客户端装配整体抛错。
 *
 * 这些判据的来源是**官方 0.2.2-rc.1 源码**（`@deepseek-ai/dsh-app-boot` 的
 * `readPluginMeta` / `iconOf`、`dsh-client-modules` 的 `parseDshClient`），
 * 不是我自己重写一遍「我以为的契约」。
 *
 * 与 @zeng/dsh-session-worktree 的 packaging.test.cjs 是**同一套判据**：
 * 那边多了 ⑥⑦⑧（宿主半入口、patch 行 id、零运行时依赖），本包没有 host 工具面，
 * 故只保留与本包相关的项。改判据时两边要一起改。
 *
 * 跑法：node test/packaging.test.cjs
 */
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')

/**
 * 官方包的安装位置：按机器不同而不同，因此**可覆盖**。
 *
 * 官方宿主把 @deepseek-ai/* 打进了 app.asar，普通 node_modules 里没有；
 * 这里只用来做「真函数」比对（有就用，没有就走内置判据）。
 * 设了 ZGG_OFFICIAL_DIR 就额外用官方真函数再验一遍。
 */
const OFFICIAL_DIR = process.env.ZGG_OFFICIAL_DIR
  || 'C:/Users/Zeng/AppData/Local/npm-cache/_npx/4f4f47d9854f3c73/node_modules'
const PKG_ROOT = path.resolve(__dirname, '..')

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

/** 读本包的 package.json。 */
function manifest() {
  return JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'package.json'), 'utf8'))
}

/**
 * 从官方真源码里抠出一个具名函数（花括号配平）。
 *
 * 为什么抠而不 import：官方宿主包在 app.asar 里，普通 Node 解析不到；
 * 而 `dsh-client-modules` 的模块顶层要真的求值 `class ... extends Service`，
 * 抠掉依赖就没法整体加载。只抠纯函数，既拿到真判据又不牵扯运行时依赖图。
 * @param names - 需要的函数名（存在依赖时按需带上）。
 * @returns name → function 的映射；官方源码不可用时返回 undefined。
 */
function officialFunctions(...names) {
  let source
  try {
    source = fs.readFileSync(path.join(OFFICIAL_DIR, '@deepseek-ai/dsh-client-modules/lib/index.js'), 'utf8')
  } catch (error) {
    return undefined
  }
  const extract = (name) => {
    const start = source.indexOf(`function ${name}(`)
    if (start < 0) throw new Error(`官方源码里找不到 ${name}()（契约可能已变，请复核本测试）`)
    let depth = 0
    let index = source.indexOf('{', start)
    for (; index < source.length; index += 1) {
      if (source[index] === '{') depth += 1
      else if (source[index] === '}') {
        depth -= 1
        if (depth === 0) break
      }
    }
    return source.slice(start, index + 1)
  }
  const required = new Set(names)
  if (required.has('parseDshClient')) required.add('optionalStringArray')
  const bodies = [...required].map(extract).join('\n')
  // eslint-disable-next-line no-new-func
  return new Function(`${bodies}\nreturn { ${[...required].join(', ')} }`)()
}

console.log('packaging（打包与启动契约）')

test('① exports["./client"] 存在且指向真实文件', () => {
  const exportsField = manifest().exports
  assert.ok(exportsField !== undefined, '缺 exports 字段')
  assert.strictEqual(exportsField['./client'], './lib/client.js', 'exports["./client"] 必须是 ./lib/client.js')
  assert.ok(fs.existsSync(path.join(PKG_ROOT, 'lib/client.js')), 'lib/client.js 不存在')
})

test('② dsh.client.platform 必须是 web（否则不进浏览器名册）', () => {
  const dsh = manifest().dsh
  assert.ok(dsh !== undefined && dsh.client !== undefined, '缺 dsh.client 声明')
  assert.strictEqual(dsh.client.platform, 'web')
})

test('③ dsh.client 声明能被官方 parseDshClient 接受（含 inject 类型校验）', () => {
  const dsh = manifest().dsh.client
  // 内置判据：platform 是字符串，inject/external/immediately 若存在必须是字符串数组。
  assert.strictEqual(typeof dsh.platform, 'string')
  for (const field of ['inject', 'external']) {
    if (dsh[field] === undefined) continue
    assert.ok(Array.isArray(dsh[field]), `dsh.client.${field} 必须是数组`)
    for (const item of dsh[field]) assert.strictEqual(typeof item, 'string', `dsh.client.${field} 里混进了非字符串：${String(item)}`)
  }
  if (dsh.immediately !== undefined) assert.strictEqual(typeof dsh.immediately, 'boolean')

  // 真函数复核（官方源码可用时；不可用不算失败——不同机器的安装位置不同）。
  const official = officialFunctions('parseDshClient')
  if (official === undefined) {
    console.log('    （官方源码不在 OFFICIAL_DIR，跳过真函数复核）')
    return
  }
  const decl = official.parseDshClient(manifest().name, dsh)
  assert.ok(decl !== undefined, '官方 parseDshClient 解析结果不该是 undefined')
  assert.strictEqual(decl.platform, 'web')
})

test('④ locale 经 exports 暴露，且形状是官方读的 meta.title / meta.description', () => {
  // 官方 readPluginMeta 走 Node 解析器读 `<pkg>/locale/<lang>.json`，受 exports 门禁。
  const exportsField = manifest().exports
  const hasLocaleWildcard = Object.keys(exportsField).some((key) => key === './locale/*.json')
  assert.ok(hasLocaleWildcard, 'exports 必须含 "./locale/*.json"，否则标题回退成包名')
  assert.strictEqual(exportsField['./locale/*.json'], './locale/*.json')

  for (const lang of ['zh', 'en']) {
    const file = path.join(PKG_ROOT, 'locale', `${lang}.json`)
    assert.ok(fs.existsSync(file), `缺 locale/${lang}.json`)
    const dict = JSON.parse(fs.readFileSync(file, 'utf8'))
    // ⚠️ 官方读的是**嵌套一层**的 `meta.title` / `meta.description`；
    // 平铺的 `title` 不被读取，写了会静默回退成包名（2026-11-07 实测踩到）。
    assert.ok(dict.meta !== undefined && typeof dict.meta === 'object', `locale/${lang}.json 缺 meta 对象（官方只认 meta.title）`)
    assert.strictEqual(typeof dict.meta.title, 'string', `locale/${lang}.json 缺 meta.title`)
    assert.ok(dict.meta.title !== '', `locale/${lang}.json 的 meta.title 不能是空串`)
    assert.strictEqual(typeof dict.meta.description, 'string', `locale/${lang}.json 缺 meta.description`)
  }
})

test('⑤ icon 可解析且符合官方限制（SVG/PNG/JPEG/WebP，≤256 KiB）', () => {
  const declared = manifest().icon
  const viaManifest = typeof declared === 'string' ? path.resolve(PKG_ROOT, declared) : undefined
  const viaExport = manifest().exports !== undefined && manifest().exports['./icon'] !== undefined
    ? path.resolve(PKG_ROOT, manifest().exports['./icon'])
    : undefined
  const icon = [viaManifest, viaExport].find((candidate) => candidate !== undefined && fs.existsSync(candidate))
  assert.ok(icon !== undefined, 'icon 既没有可解析的 package.json "icon"，也没有 exports["./icon"] 指向的真实文件')
  // 官方还必须能证明这个文件**在包目录内**（assertPackageOwned），相对路径天然满足。
  const relative = path.relative(PKG_ROOT, icon)
  assert.ok(relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative), `icon 跑出了包目录：${icon}`)
  const bytes = fs.statSync(icon).size
  assert.ok(bytes <= 256 * 1024, `icon 超过官方 256 KiB 上限：${String(bytes)} 字节`)
  assert.ok(['.svg', '.png', '.jpg', '.jpeg', '.webp'].includes(path.extname(icon).toLowerCase()),
    `icon 必须是 SVG/PNG/JPEG/WebP，实际 ${path.extname(icon)}`)
})

test('⑥ locale 里点名的 meta.detail 文档真实存在（点开卡片才有长描述）', () => {
  for (const lang of ['zh', 'en']) {
    const dict = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'locale', `${lang}.json`), 'utf8'))
    const detail = dict.meta === undefined ? undefined : dict.meta.detail
    if (detail === undefined) continue // 可选：缺了官方回退到 README，不是错误
    assert.strictEqual(typeof detail, 'string')
    assert.ok(!path.isAbsolute(detail) && !detail.includes('\\'), `meta.detail 必须是包内正斜杠相对路径，实际 ${detail}`)
    assert.ok(fs.existsSync(path.join(PKG_ROOT, detail)), `locale/${lang}.json 的 meta.detail 指向不存在的文件：${detail}`)
  }
})

test('⑦ 浏览器半的注册 id 等于包名（官方按它配对图行）', () => {
  const source = fs.readFileSync(path.join(PKG_ROOT, 'lib', 'client.js'), 'utf8')
  const match = /__ModuleLoader__\.load\(\{\s*id:\s*['"]([^'"]+)['"]/.exec(source)
  assert.ok(match !== null, 'bundle 里找不到 __ModuleLoader__.load({ id })')
  assert.strictEqual(match[1], manifest().name, `注册 id "${match[1]}" 与包名不符`)
})

test('⑧ cordis.patch.yml 的行用裸包名（不是 ./x.mjs），且 id 稳定', () => {
  const patch = fs.readFileSync(path.join(PKG_ROOT, 'cordis.patch.yml'), 'utf8')
  const idMatch = /-\s*id:\s*(\S+)/.exec(patch)
  const nameMatch = /name:\s*['"]?([^'"\s]+)['"]?/.exec(patch)
  assert.ok(idMatch !== null, 'patch 里没有 id 行')
  assert.ok(nameMatch !== null, 'patch 里没有 name 行')
  assert.strictEqual(nameMatch[1], manifest().name, 'patch 的 name 必须是裸包名')
  assert.ok(!nameMatch[1].startsWith('./'), 'name 不能是裸文件说明符')
  assert.strictEqual(idMatch[1], 'dsh-sidebar-git-graph')
})

test('⑨ package.json files 清单覆盖 icon 与 docs（否则 npm 包体里缺这两样）', () => {
  const files = manifest().files
  assert.ok(Array.isArray(files), '缺 files 字段')
  assert.ok(files.includes('icon.svg'), 'files 里没有 icon.svg —— 发布出去的包会缺图标')
  assert.ok(files.includes('locale'), 'files 里没有 locale')
  const dict = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, 'locale/zh.json'), 'utf8'))
  const detail = dict.meta === undefined ? undefined : dict.meta.detail
  if (detail !== undefined) {
    const top = detail.split('/')[0]
    assert.ok(files.includes(top), `files 里没有 "${top}" —— meta.detail 指向的文档不会被发布`)
  }
})

if (failures > 0) {
  console.error(`\n✗ packaging.test.cjs: ${failures} 条失败`)
  process.exit(1)
}
console.log('  （全部通过）')
