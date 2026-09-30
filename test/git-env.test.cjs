/**
 * git 执行环境的回归测试。
 *
 * 这一条是为 2026-09-30 真机上抓到的一个**我亲手引入的缺陷**立的桩：
 * 插件原本用 `GIT_CONFIG_NOSYSTEM=1` 屏蔽系统 gitconfig，而 Git for Windows 的
 * 系统配置里有 `core.autocrlf=true`。屏蔽之后，工作区是 CRLF、索引是 LF 的仓库
 * **每一行都被算成改动**——实测 `docs/README.md` 从 `1 增 0 删` 变成 `88 增 87 删`，
 * 一个只加了一行的文件在页面上显示成整个文件重写。
 *
 * 更隐蔽的是：同一个仓库里另外四个文件因为索引里本来就是 CRLF，恰好显示正常，
 * 所以「大部分行都对」会让人以为整体没问题。是拿插件输出与 `git diff --numstat`
 * 逐行比对才发现的。
 *
 * 跑法：node test/git-env.test.cjs
 */
const assert = require('node:assert')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'zgg-env-'))
process.env.DSH_HOME = path.join(sandbox, 'home')
fs.mkdirSync(process.env.DSH_HOME, { recursive: true })

function git(cwd, args, options) {
  const settings = options === undefined ? {} : options
  return execFileSync('git', args, {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    env: settings.env === undefined ? process.env : settings.env,
  })
}

async function main() {
  const host = await import('../lib/index.js')
  const { gitEnv, stripExternalCommands, handleChanges } = host.internals

  // ── 1) 系统配置相关的两个变量都不许出现 ──────────────────────────────────
  //
  // 三条实测（真机跑出来的）：
  //   GIT_CONFIG_NOSYSTEM=1  → 症状出现（README.md 从 1/0 变成 88/87）
  //   GIT_CONFIG_SYSTEM=''   → **同样的症状**（空串也会让 git 不读系统配置）
  //   两个都不设             → 与用户自己的 git 一致
  // 所以断言是「两个都不能有」，而不是「换成另一个」。
  {
    const env = gitEnv()
    assert.strictEqual(
      env.GIT_CONFIG_NOSYSTEM, undefined,
      '不能设 GIT_CONFIG_NOSYSTEM：系统配置里的 core.autocrlf 会失效 → 满屏假改动',
    )
    assert.strictEqual(
      env.GIT_CONFIG_SYSTEM, undefined,
      '也不能把 GIT_CONFIG_SYSTEM 设成空串 —— 实测空串同样让 git 不读系统配置，症状一模一样',
    )
    // 环境仍然必须白名单化：绝不能把 API key 或与 git 交互相关的东西透传进去。
    for (const leaky of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'DSH_TOKEN', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'GIT_CONFIG_GLOBAL']) {
      assert.strictEqual(env[leaky], undefined, `环境里不该出现 ${leaky}`)
    }
    assert.strictEqual(env.GIT_TERMINAL_PROMPT, '0')
    assert.strictEqual(env.GIT_OPTIONAL_LOCKS, '0')
    assert.strictEqual(env.GIT_PAGER, 'cat')
  }

  // ── 2) 只移除会执行外部程序的配置，其余一律保留 ──────────────────────────
  {
    const input = [
      '-C', '/repo',
      '-c', 'core.quotepath=false',
      '-c', 'filter.lfs.clean=git-lfs clean -- %f',
      '-c', 'diff.foo.textconv=evil.sh',
      '-c', 'i18n.logOutputEncoding=UTF-8',
      '--no-optional-locks',
      'status', '--porcelain=v2',
    ]
    const out = stripExternalCommands(input)
    assert.ok(!out.some((t) => t.startsWith('filter.')), 'filter.* 必须被移除（它会执行外部命令）')
    assert.ok(!out.some((t) => /textconv/.test(t)), 'diff.*.textconv 必须被移除')
    // 保留的要**成对**保留：不能把 -c 留下而把值删掉。
    assert.ok(out.includes('core.quotepath=false'), '普通配置必须保留')
    assert.ok(out.includes('i18n.logOutputEncoding=UTF-8'), '普通配置必须保留')
    for (let i = 0; i < out.length; i += 1) {
      if (out[i] === '-c') assert.ok(i + 1 < out.length && !out[i + 1].startsWith('-'), '-c 后面必须紧跟它的值，否则值会变成位置参数')
    }
    // 子命令与位置参数不能被改动。
    assert.ok(out.includes('status') && out.includes('--porcelain=v2'), '子命令与选项必须原样保留')

    // 值里不含 `=` 的写法也必须整对丢掉（`-c foo` 在 git 里等于设 foo 为真）。
    const noEquals = stripExternalCommands(['-C', '/r', '-c', 'filter.lfs.process', 'status'])
    assert.deepStrictEqual(noEquals, ['-C', '/r', 'status'], '值里没有 = 时也要整对丢掉')

    // 空数组 / 非数组不许炸。
    assert.deepStrictEqual(stripExternalCommands([]), [])
    assert.deepStrictEqual(stripExternalCommands(undefined), [])
    // 结尾孤零零一个 -c：原样留着，让 git 自己去报错，而不是悄悄构造出畸形 argv。
    assert.deepStrictEqual(stripExternalCommands(['status', '-c']), ['status', '-c'])
  }

  // ── 3) 逐行与「用户自己的 git」对答案 ───────────────────────────────────
  //
  // 这是最本质的一条：插件与外部 git 看同一个工作树，结论必须一致。
  // 换行那条缺陷就是被它抓出来的——同一仓库里四个文件恰好正常、只有 README.md 暴雷，
  // 光看「大部分行都对」是发现不了的。
  //
  // **刻意不去手工制造"只有换行差异"的文件**：实测那取决于 stat 缓存（mtime/size）的
  // 新鲜度——同一次写入可能让 `status` 说 `.M` 而 `diff --numstat` 说没改动，
  // 是个不稳定的 fixture（本机复现过：9 字节 → 12 字节，status 报 `.M`，numstat 空）。
  // 所以这里造一个**确定产生真实差异**的仓库，把断言落在「与外部 git 逐行一致」上——
  // 那才是这条测试真正要守的东西，而它照样能抓住假改动。
  {
    const repo = path.join(sandbox, 'repo')
    fs.mkdirSync(repo, { recursive: true })
    git(repo, ['init'])
    git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    for (const [k, v] of [['user.name', 'T'], ['user.email', 't@e.com'], ['commit.gpgsign', 'false']]) git(repo, ['config', k, v])

    fs.writeFileSync(path.join(repo, 'modified.txt'), 'a\nb\nc\n', 'utf8')
    fs.writeFileSync(path.join(repo, 'rewritten.txt'), 'x\n'.repeat(50), 'utf8')
    fs.writeFileSync(path.join(repo, 'deleted.txt'), 'bye\n', 'utf8')
    fs.writeFileSync(path.join(repo, 'renamed.txt'), 'r\n'.repeat(10), 'utf8')
    git(repo, ['add', '-A'])
    git(repo, ['commit', '-qm', 'init'])

    fs.appendFileSync(path.join(repo, 'modified.txt'), 'd\ne\n', 'utf8')          // +2
    fs.writeFileSync(path.join(repo, 'rewritten.txt'), 'y\n'.repeat(50), 'utf8')  // 每行都变
    fs.rmSync(path.join(repo, 'deleted.txt'))                                      // 删除
    git(repo, ['mv', 'renamed.txt', 'renamed-now.txt'])                            // 暂存重命名
    fs.writeFileSync(path.join(repo, 'untracked.md'), 'u\n', 'utf8')               // 未跟踪

    const outcome = await handleChanges({ get: () => undefined, logger: { info() {}, warn() {} } }, { cwd: repo })
    assert.strictEqual(outcome.ok, true, JSON.stringify(outcome.error))
    const own = new Map(outcome.value.sections.unstaged.map((row) => [row.path, row]))

    // 外部 git（用户自己会跑的那条命令）。
    const external = git(repo, ['-c', 'core.quotepath=false', 'diff', '--numstat'])
    const externalRows = external.split('\n').map((l) => l.trim()).filter((l) => l !== '')
    const externalPaths = new Map(externalRows.map((l) => { const p = l.split('\t'); return [p[2], { added: p[0], deleted: p[1] }] }))

    // 正反两向都必须一致：漏报与**多报**都要抓（多报正是假改动的形状）。
    for (const [p, counts] of externalPaths) {
      const row = own.get(p)
      assert.ok(row !== undefined, `外部 git 说有改动而插件没列出来：${p}`)
      assert.strictEqual(row.added, Number.parseInt(counts.added, 10), `${p} 的 + 计数与外部 git 不一致（插件 ${row.added} vs git ${counts.added}）`)
      assert.strictEqual(row.deleted, Number.parseInt(counts.deleted, 10), `${p} 的 − 计数与外部 git 不一致（插件 ${row.deleted} vs git ${counts.deleted}）`)
    }
    for (const [p, row] of own) {
      if (row.untracked === true) continue
      assert.ok(
        externalPaths.has(p),
        `插件列了 ${p} 而外部 git 认为它没改动（假改动）。` +
        '典型成因是 git 执行环境屏蔽了系统配置，导致 core.autocrlf 之类的设置失效',
      )
    }

    // 具体数值也钉一下，免得两边"一致地错"。
    assert.strictEqual(own.get('modified.txt').added, 2, '真加两行就该是 +2')
    assert.strictEqual(own.get('modified.txt').deleted, 0, '没删行就不该有 −')
    assert.strictEqual(own.get('rewritten.txt').deleted, 50, '整体重写就该是 −50')
    assert.ok(own.has('deleted.txt'), '删掉的文件必须列出来')
    assert.strictEqual(own.get('deleted.txt').status, 'D')
    assert.strictEqual(own.get('untracked.md').untracked, true)
    console.log(`  与外部 git 逐行比对：${externalRows.length} 个已跟踪文件一致`)

    // ── 头部的「N 个改动」与改动区的行数必须是**同一个数** ──────────────
    //
    // 2026-09-30 真机截图里，同一个面板上头部写着「6 个改动」、下面的「更改」段写着 7 ——
    // 因为头部的 status 用了 `--untracked-files=no`（只算已跟踪），而改动区含未跟踪。
    // 同一件事两个数，看图的人只会以为其中一个坏了。
    {
      const inert = { get: () => undefined, logger: { info() {}, warn() {} } }
      const graph = await host.internals.handleGraph(inert, { cwd: repo, max: 1 })
      assert.strictEqual(graph.ok, true, JSON.stringify(graph.error))
      const sectionRows = outcome.value.sections.conflicts.length
        + outcome.value.sections.unstaged.length
        + outcome.value.sections.staged.length
      assert.strictEqual(
        graph.value.repo.dirty, sectionRows,
        `头部的脏文件数（${graph.value.repo.dirty}）必须等于改动区三段的实际行数（${sectionRows}）——` +
        '否则同一个面板上同一件事会有两个数字',
      )
      assert.ok(sectionRows >= 5, `fixture 应当有足够多的改动，实到 ${sectionRows}`)
    }
  }

  console.log('git-env.test.cjs: OK')
}

async function cleanup() {
  try { fs.rmSync(sandbox, { recursive: true, force: true }) } catch (error) { /* Windows 句柄占用 */ }
}

main()
  .then(cleanup)
  .catch(async (error) => {
    console.error(error)
    await cleanup()
    process.exit(1)
  })
