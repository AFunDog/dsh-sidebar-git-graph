/**
 * 仓库选择器（客户端半身）测试：下拉项文案与"按工作区记住选择"这两件事。
 *
 * 单独测的理由：这两处都是**看代码觉得显然、用起来才发现错**的地方。
 *   - 后缀只截末两段：嵌套仓库的 `vendor/@scope/zz-inner` 与同名的 `zz-inner` 得能分开，
 *     而工作区**之外**的仓库相对路径是 `..\..`，直接显示等于没显示；
 *   - 记忆必须按工作区分键：两个工作区里各有一个 `backend` 是常态，串了就莫名其妙。
 *
 * 跑法：node test/repo-picker.test.cjs
 */
const assert = require('node:assert')
const { loadInternals } = require('./helpers/load-client.cjs')

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

async function main() {
  const storage = fakeStorage()
  const internals = loadInternals({ localStorage: storage })
  const { repoSuffix, repoOptionLabel, repoPicker, readSavedRepo, saveRepo, constants } = internals

  // ── 下拉项后缀 ───────────────────────────────────────────────────────────
  assert.strictEqual(repoSuffix({ root: 'D:\\ws', rel: '', outside: false }), '工作区根')
  assert.strictEqual(
    repoSuffix({ root: 'D:\\ws\\vendor\\@scope\\zz-inner', rel: 'vendor\\@scope\\zz-inner', outside: false }),
    '@scope/zz-inner',
    '嵌套仓库要带上它的上一层，才能和同名的仓库区分开',
  )
  assert.strictEqual(
    repoSuffix({ root: 'D:\\ws\\pkg', rel: 'pkg', outside: false }),
    'pkg',
    '只有一段时就是它自己',
  )
  assert.strictEqual(
    repoSuffix({ root: 'D:\\GitRepository\\dsh-config', rel: '..\\..', outside: true }),
    '…/GitRepository/dsh-config',
    '工作区之外的仓库要看绝对路径的末两段，相对路径的 `..\\..` 没法读',
  )
  assert.strictEqual(
    repoSuffix({ root: '/home/me/proj', rel: '../proj', outside: true }),
    '…/me/proj',
    '走 POSIX 分隔符也一样',
  )

  // ── 下拉项的整行文案 ─────────────────────────────────────────────────────
  // 关联工作树（kind: 'worktree'）显示**分支**而不是路径：同一个仓库的各个工作树常常
  // 就在同一个父目录下、名字只差一个后缀 —— 路径的区分度很低，而分支几乎必然不同。
  assert.strictEqual(
    repoOptionLabel({ root: 'D:\\ws', rel: '', outside: false, name: 'ws', kind: 'repo' }),
    'ws · 工作区根',
    '普通仓库（含嵌套仓库）维持原样',
  )
  assert.strictEqual(
    repoOptionLabel({ root: 'D:\\a\\proj', rel: '..\\..', outside: true, name: 'proj', kind: 'worktree', branch: 'feat/x', main: false }),
    'proj · feat/x',
    '关联工作树要显示它自己的分支 —— 那才是人在这个下拉里要找的东西',
  )
  assert.strictEqual(
    repoOptionLabel({ root: 'D:\\a\\proj', rel: '', outside: false, name: 'proj', kind: 'worktree', branch: 'main', main: true }),
    'proj · main（主工作树）',
    '主工作树要标出来，否则"哪个是主工作区"只能靠猜',
  )
  assert.strictEqual(
    repoOptionLabel({ root: 'D:\\a\\det', rel: '..\\det', outside: true, name: 'det', kind: 'worktree', branch: null, detached: true, head: 'abcdef1234567890', main: false }),
    'det · 分离头 abcdef12',
    '分离头的工作树没有分支名：用短 sha 顶替，比印一遍与名字重复的路径有用',
  )
  assert.strictEqual(
    repoOptionLabel({ root: 'D:\\a\\det', rel: '..\\det', outside: true, name: 'det', kind: 'worktree', branch: null, detached: true, head: null, main: false }),
    'det · …/a/det',
    '连 sha 都拿不到时才退回路径后缀',
  )
  assert.strictEqual(
    repoOptionLabel({ root: 'D:\\a\\lk', rel: '..\\lk', outside: true, name: 'lk', kind: 'worktree', branch: 'b/z', locked: true, main: false }),
    'lk · b/z（已锁定）',
    '被 lock 的工作树内容可读，标记出来免得被当成坏了',
  )
  // 旧宿主不带 kind（前后端版本错位）：必须退回老文案，不能显示成空或崩。
  assert.strictEqual(
    repoOptionLabel({ root: 'D:\\ws', rel: '', outside: false, name: 'ws' }),
    'ws · 工作区根',
    'kind 缺席时要退回老行为（宿主半与浏览器半会先后升级）',
  )

  // ── 按工作区记忆 ─────────────────────────────────────────────────────────
  assert.strictEqual(readSavedRepo('D:/ws'), undefined, '没记过就是 undefined')
  saveRepo('D:/ws', 'D:/ws/vendor/@scope/zz-inner')
  assert.strictEqual(readSavedRepo('D:/ws'), 'D:/ws/vendor/@scope/zz-inner')
  assert.strictEqual(readSavedRepo('D:/other'), undefined, '别的作区不该读到同一个选择')
  saveRepo('D:/other', 'D:/other/backend')
  assert.strictEqual(readSavedRepo('D:/ws'), 'D:/ws/vendor/@scope/zz-inner', '两个工作区互不覆盖')
  assert.strictEqual(readSavedRepo('D:/other'), 'D:/other/backend')
  assert.strictEqual(storage.map.size, 2, '一个工作区一条记录')

  // 空值不该写进去（免得把好好的记忆擦成空串）。
  saveRepo('D:/ws', '')
  assert.strictEqual(readSavedRepo('D:/ws'), 'D:/ws/vendor/@scope/zz-inner')
  saveRepo('', 'D:/ws')
  assert.strictEqual(readSavedRepo('D:/ws'), 'D:/ws/vendor/@scope/zz-inner')
  assert.strictEqual(readSavedRepo(undefined), undefined)
  assert.strictEqual(readSavedRepo(null), undefined)

  // 存储不可用（无痕模式等）不该炸：不许抛错，只是不记。
  const hostile = loadInternals({
    localStorage: {
      getItem() { throw new Error('storage disabled') },
      setItem() { throw new Error('storage disabled') },
    },
  })
  assert.strictEqual(hostile.readSavedRepo('D:/ws'), undefined)
  hostile.saveRepo('D:/ws', 'D:/ws/a')

  // ── 控件元素树 ───────────────────────────────────────────────────────────
  // 记录式的 h：把 createElement 的入参原样留下，就能断言"造出来的是什么"。
  const record = (type, props, ...children) => ({
    type,
    props: props === null || props === undefined ? {} : props,
    children: children.flat(),
  })

  const one = repoPicker(record, { repos: [{ root: 'D:/ws', rel: '', outside: false, name: 'ws' }], currentRoot: 'D:/ws', title: 'ws', onPick() {} })
  assert.strictEqual(one.type, 'span', '只有一个仓库时不该出现下拉框')
  assert.strictEqual(one.props.className, 'zgg-repo')
  assert.strictEqual(one.children[0], 'ws')

  const two = repoPicker(record, {
    repos: [
      { root: 'D:/ws', rel: '', outside: false, name: 'ws' },
      { root: 'D:/ws/vendor/@scope/zz-inner', rel: 'vendor\\@scope\\zz-inner', outside: false, name: 'zz-inner' },
    ],
    currentRoot: 'D:/ws/vendor/@scope/zz-inner',
    title: 'ws',
    onPick() {},
  })
  assert.strictEqual(two.type, 'select')
  assert.ok(two.props.className.includes('zgg-repo-select'), '要挂上自己的类名才有的样式')
  assert.strictEqual(two.props.value, 'D:/ws/vendor/@scope/zz-inner', '当前项必须选中，否则下拉显示的和画出来的不是一个仓库')
  assert.strictEqual(two.props['aria-label'], '切换仓库')
  assert.strictEqual(two.children.length, 2)
  assert.deepStrictEqual(
    two.children.map((option) => ({ type: option.type, value: option.props.value, title: option.props.title, text: option.children[0] })),
    [
      { type: 'option', value: 'D:/ws', title: 'D:/ws', text: 'ws · 工作区根' },
      { type: 'option', value: 'D:/ws/vendor/@scope/zz-inner', title: 'D:/ws/vendor/@scope/zz-inner', text: 'zz-inner · @scope/zz-inner' },
    ],
    'option 的 value 必须是仓库**根**：写名字或相对路径的话，选完宿主机认不出来',
  )

  // 选中回调拿到的就是仓库根。
  const picked = []
  const interactive = repoPicker(record, {
    repos: [{ root: 'a', rel: '', outside: false, name: 'a' }, { root: 'b', rel: 'b', outside: false, name: 'b' }],
    currentRoot: 'a',
    title: 'a',
    onPick: (root) => picked.push(root),
  })
  interactive.props.onChange({ target: { value: 'b' } })
  assert.deepStrictEqual(picked, ['b'])

  // 空列表（还没加载出来）走纯文本分支，不该崩。
  const none = repoPicker(record, { repos: [], currentRoot: undefined, title: 'Git 图谱', onPick() {} })
  assert.strictEqual(none.type, 'span')
  assert.strictEqual(none.children[0], 'Git 图谱')

  // ── 两半身的默认值必须一致 ───────────────────────────────────────────────
  const { DEFAULT_DEPTH } = await import('../lib/repos.js')
  assert.strictEqual(
    constants.DEFAULT_SCAN_DEPTH,
    DEFAULT_DEPTH,
    '浏览器半身与宿主半身的默认扫描层数必须一致，否则「没设置过」的两个人看到的清单不一样',
  )

  console.log('repo-picker.test.cjs: OK')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
