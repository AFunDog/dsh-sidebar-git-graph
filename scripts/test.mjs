/**
 * 零依赖测试入口：语法检查 lib/ 下的每个文件，然后逐个跑 test/*.test.cjs。
 *
 * 为什么要有个 runner 而不是在 CI 里一行行列命令：列清单会**过期**——新加了测试文件
 * 忘了写进 workflow，CI 照样是绿的（本轮就差点这样：新增 3 个测试文件，原 workflow 只认
 * 2 个）。这里改成自动发现，加了文件就自动进 CI。
 *
 * 跨平台：只用 node 内置能力，不依赖 bash / pwsh 的循环语法。
 * 子进程用 `stdio: 'inherit'`——输出直通，不经过管道。
 *
 * 跑法：node scripts/test.mjs（或 npm test）
 */
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const node = process.execPath

/** 跑一条命令，返回是否成功（输出直通）。 */
function run(label, args) {
  process.stdout.write(`\n=== ${label} ===\n`)
  const result = spawnSync(node, args, { cwd: root, stdio: 'inherit' })
  if (result.error !== undefined && result.error !== null) {
    console.error(`${label}: 起不来子进程：${result.error.message}`)
    return false
  }
  return result.status === 0
}

const failures = []

// 1) 语法检查：lib 下每个文件都要能过（含 client.js——它是浏览器单文件，但也得是合法 JS）。
const libDir = join(root, 'lib')
for (const file of readdirSync(libDir).filter((name) => name.endsWith('.js')).sort()) {
  if (!run(`node --check lib/${file}`, ['--check', join('lib', file)])) failures.push(`lib/${file}`)
}

// 2) 测试文件自动发现：test/*.test.cjs，跑完全部再汇总（不要第一个失败就停，
//    不然一次只能修一个问题）。
const testDir = join(root, 'test')
const tests = readdirSync(testDir).filter((name) => name.endsWith('.test.cjs')).sort()
if (tests.length === 0) {
  console.error('test/ 下没发现任何 *.test.cjs —— 这不是"全过了"，是清单空了')
  process.exit(1)
}
for (const file of tests) {
  if (!run(`node test/${file}`, [join('test', file)])) failures.push(`test/${file}`)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} 项失败：\n  ${failures.join('\n  ')}`)
  process.exit(1)
}
console.log(`\n全部通过：${tests.length} 个测试文件 + lib 语法检查`)
