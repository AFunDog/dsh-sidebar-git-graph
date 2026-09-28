#!/usr/bin/env node
/**
 * Build a throwaway repository with a deliberately *interesting* history — three branches,
 * two merges, a tag and a couple of long subjects — so the graph page can be judged (and
 * screenshotted) on a repository whose contents are nobody's private business.
 *
 * Usage (node >= 22):
 *   node scripts/make-demo-repo.mjs [target-dir] [--seed D:/GitRepository/demo-seed.json]
 *
 * With --seed the history is read from a small JSON file instead:
 *   { "commits": [ { "message": "...", "files": { "a.txt": "..." } } ] }
 * which is how the screenshot repository is kept byte-identical across machines.
 *
 * Prints the created directory on the last line.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const args = process.argv.slice(2)
const positional = []
let seedPath
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--seed') {
    seedPath = args[index + 1]
    index += 1
    continue
  }
  positional.push(args[index])
}
const target = positional[0] === undefined
  ? mkdtempSync(join(tmpdir(), 'dsh-sidebar-git-graph-demo-'))
  : resolve(positional[0])

function git(cwd, argv) {
  return execFileSync('git', argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function write(cwd, name, text) {
  const target = join(cwd, name)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, text, 'utf8')
}

function commit(cwd, message, files, dateIso) {
  for (const [name, text] of Object.entries(files)) write(cwd, name, text)
  git(cwd, ['add', '.'])
  const env = dateIso === undefined ? {} : { GIT_AUTHOR_DATE: dateIso, GIT_COMMITTER_DATE: dateIso }
  execFileSync('git', ['commit', '-m', message], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
}

function historyFromSeed(file) {
  const parsed = JSON.parse(readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed.commits) || parsed.commits.length === 0) {
    throw new Error(`${file}: expected a non-empty "commits" array`)
  }
  return parsed.commits
}

/** The built-in demo history: main + two branches, both merged back, plus a tag. */
const BUILT_IN = [
  { message: 'feat: 初始化仓库与说明', files: { 'README.md': '# demo\n', 'src/app.js': 'export const app = 1\n' } },
  { message: 'feat: 增加渲染管线骨架', files: { 'src/render.js': 'export const render = () => {}\n' } },
  { message: 'fix: 修掉初始化时的一处竞态', files: { 'src/app.js': 'export const app = 2\n' } },
  { branch: 'feature/lanes', message: 'feat(lanes): 泳道分配第一版', files: { 'src/lanes.js': 'export const lanes = []\n' } },
  { message: 'feat(lanes): 支持分叉与汇入的曲线', files: { 'src/lanes.js': 'export const lanes = [1]\n' } },
  { checkout: 'main', message: 'docs: 补一段使用说明', files: { 'README.md': '# demo\n\nusage: open the page\n' } },
  { branch: 'try/octopus', message: 'chore: 试一试并行分支', files: { 'src/extra.js': 'export const extra = true\n' } },
  { checkout: 'main', merge: 'feature/lanes', message: 'merge: 合入 feature/lanes' },
  { tag: 'v0.1.0', message: 'chore: 打第一个标签', files: { 'CHANGELOG.md': '## 0.1.0\n' } },
  { merge: 'try/octopus', message: 'merge: 合入 try/octopus' },
  { message: 'feat: 侧栏页面接上真实数据', files: { 'src/app.js': 'export const app = 3\n' } },
]

function build(repo) {
  if (existsSync(repo)) rmSync(repo, { recursive: true, force: true })
  mkdirSync(repo, { recursive: true })
  git(repo, ['init'])
  git(repo, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
  git(repo, ['config', 'user.name', 'Demo Author'])
  git(repo, ['config', 'user.email', 'demo@example.com'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  git(repo, ['config', 'core.autocrlf', 'false'])

  const script = seedPath === undefined ? BUILT_IN : historyFromSeed(seedPath)
  for (const step of script) {
    if (typeof step.branch === 'string') {
      git(repo, ['checkout', '-b', step.branch])
      commit(repo, step.message, step.files ?? {}, step.date)
      continue
    }
    if (typeof step.checkout === 'string') git(repo, ['checkout', step.checkout])
    if (typeof step.merge === 'string') {
      git(repo, ['merge', '--no-ff', '-m', step.message, step.merge])
    } else {
      commit(repo, step.message, step.files ?? {}, step.date)
    }
    if (typeof step.tag === 'string') git(repo, ['tag', step.tag])
  }
  git(repo, ['checkout', 'main'])
  return repo
}

const created = build(target)
const refs = git(created, ['for-each-ref', '--format=%(refname:short)', 'refs/heads', 'refs/tags']).trim().split('\n')
console.log(`branches/tags: ${refs.join(', ')}`)
console.log(`commits: ${git(created, ['rev-list', '--count', '--all']).trim()}`)
console.log(created)
