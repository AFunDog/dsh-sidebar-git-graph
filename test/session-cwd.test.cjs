/**
 * `sessionCwd()` 的行为测试：cwd 的真源必须是 `workingDirectory` 投影。
 *
 * ## 为什么单独一条
 *
 * `header.cwd` 是**创建期**的不可变元数据 —— 永远是「出生地」。官方
 * `create_worktree` 与 `working_directory({ cd })` **不改它**，而是
 * `append('working-directory/change')`，由 `@deepseek-ai/dsh-working-directory`
 * 折成投影。
 *
 * 只读 `header.cwd` 的插件因此**看不见会话搬家**：官方把 cwd 挪进
 * `<仓库>/.agents/worktrees/<名>` 之后，图谱会继续画主仓库，而且没有任何报错。
 * 这条测试就是钉住「投影优先、缺席回退」这个回退链。
 *
 * 跑法：node test/session-cwd.test.cjs
 */
const assert = require('node:assert')

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

/** 造一个只带 get 的假 ctx。 */
function ctxWith(services) {
  return { get: (key) => services[key] }
}

async function main() {
  const host = await import('../lib/index.js')
  const { sessionCwd } = host.internals

  console.log('sessionCwd（cwd 真源）')

  test('workingDirectory 投影优先于 header.cwd', () => {
    const session = { id: 's', header: { cwd: 'D:/repo' } }
    const ctx = ctxWith({ workingDirectory: { get: () => 'D:/repo/.agents/worktrees/dsh-abc' } })
    assert.strictEqual(sessionCwd(ctx, session), 'D:/repo/.agents/worktrees/dsh-abc')
  })

  test('投影缺席 → 回退 header.cwd（老宿主 / 服务未挂载）', () => {
    const session = { id: 's', header: { cwd: 'D:/repo' } }
    assert.strictEqual(sessionCwd(ctxWith({}), session), 'D:/repo')
  })

  test('⚠️ 投影返回 null → 也要回退，不能当成「没有目录」', () => {
    // `get()` 在投影 init 之前会给 null；把 null 当结论会让图谱整页空白。
    const session = { id: 's', header: { cwd: 'D:/repo' } }
    assert.strictEqual(sessionCwd(ctxWith({ workingDirectory: { get: () => null } }), session), 'D:/repo')
  })

  test('投影抛错 → 回退，且不把异常抛给调用方', () => {
    const session = { id: 's', header: { cwd: 'D:/repo' } }
    const ctx = ctxWith({ workingDirectory: { get: () => { throw new Error('boom') } } })
    assert.doesNotThrow(() => sessionCwd(ctx, session))
    assert.strictEqual(sessionCwd(ctx, session), 'D:/repo')
  })

  test('投影服务形状不对（没有 get）→ 回退', () => {
    const session = { id: 's', header: { cwd: 'D:/repo' } }
    assert.strictEqual(sessionCwd(ctxWith({ workingDirectory: {} }), session), 'D:/repo')
  })

  test('投影给空串 → 回退（空不是有效路径）', () => {
    const session = { id: 's', header: { cwd: 'D:/repo' } }
    assert.strictEqual(sessionCwd(ctxWith({ workingDirectory: { get: () => '' } }), session), 'D:/repo')
  })

  test('两边都没有 → undefined（不是空串，调用方据此判「没有候选」）', () => {
    assert.strictEqual(sessionCwd(ctxWith({}), { id: 's' }), undefined)
    assert.strictEqual(sessionCwd(ctxWith({}), undefined), undefined)
  })

  if (failures > 0) {
    console.error(`\n✗ session-cwd.test.cjs: ${failures} 条失败`)
    process.exit(1)
  }
  console.log('  （全部通过）')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
