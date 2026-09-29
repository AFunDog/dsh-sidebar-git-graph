/**
 * 皮肤令牌核对：客户端 CSS 里用到的每一个 `--dsw-*` 变量，都必须在 DSH 的真实令牌表里。
 *
 * 为什么值得单独一个测试：**写错令牌名不会报任何错**。`var(--x, fallback)` 在 `--x`
 * 不存在时静默走 fallback，于是"颜色不对"这类问题会以最难看的方式出现——本项目就踩过：
 * 当前分支徽标写的是 `var(--dsw-alias-label-inverse, inherit)`，这个名字**根本不存在**，
 * 于是前景色继承成主题的正文色；而深色主题下徽标底色 `--dsw-alias-brand-primary` 是近白
 * 色 → 白底白字，字直接看不见。
 *
 * 令牌表是从 DSH 0.1.7-rc.2 的 `@deepseek-ai/dsh-client-ui-theme/lib/client.js` 里抠出来的
 * 静态快照（那个包只在 npx 安装树里，测试环境里不一定解析得到，所以不能把它当依赖）。
 *
 * 想让快照跟真实主题重新对一遍：
 *   ZGG_THEME_FILE=<...>/@deepseek-ai/dsh-client-ui-theme/lib/client.js node test/style-tokens.test.cjs
 * 设了它就会改用文件里的实时令牌表，并顺带断言内置快照没有过期。
 *
 * 跑法：node test/style-tokens.test.cjs
 */
const assert = require('node:assert')
const fs = require('node:fs')
const { loadInternals } = require('./helpers/load-client.cjs')

/** DSH 0.1.7-rc.2 `--dsw-alias-*` 全量令牌。 */
const ALIAS_TOKENS = [
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-document-preview',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-mask-1',
  '--dsw-alias-bg-mask-2',
  '--dsw-alias-bg-mask-3',
  '--dsw-alias-bg-mask-drop',
  '--dsw-alias-bg-mask-photo',
  '--dsw-alias-bg-module-platform',
  '--dsw-alias-bg-multi-select',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-bg-skeleton',
  '--dsw-alias-border-inverted',
  '--dsw-alias-border-inverted2',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l2-darkmode-thin',
  '--dsw-alias-border-l3',
  '--dsw-alias-border-l4',
  '--dsw-alias-brand-primary',
  '--dsw-alias-brand-primary-invert',
  '--dsw-alias-brand-primary-new-colorprimary-new-color',
  '--dsw-alias-brand-text',
  '--dsw-alias-button-contrast-fill',
  '--dsw-alias-button-elevated-fill',
  '--dsw-alias-button-floating-fill',
  '--dsw-alias-button-floating-hover',
  '--dsw-alias-button-ghost-active-border',
  '--dsw-alias-button-ghost-active-fill',
  '--dsw-alias-button-ghost-active-hover',
  '--dsw-alias-button-info-fill',
  '--dsw-alias-button-info-hover',
  '--dsw-alias-button-primary-dimmed',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-button-tool-bar-fill',
  '--dsw-alias-button-tool-bar-fill-invisible',
  '--dsw-alias-button-tool-bar-hover',
  '--dsw-alias-code-diff-added',
  '--dsw-alias-code-diff-deleted',
  '--dsw-alias-file-diff-added-bg',
  '--dsw-alias-file-diff-added-gutter',
  '--dsw-alias-file-diff-added-marker',
  '--dsw-alias-file-diff-deleted-bg',
  '--dsw-alias-file-diff-deleted-gutter',
  '--dsw-alias-file-diff-deleted-marker',
  '--dsw-alias-interactive-bg-active',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-interactive-bg-hover-accent',
  '--dsw-alias-interactive-bg-hover-danger',
  '--dsw-alias-interactive-bg-hover-solid',
  '--dsw-alias-label-caption',
  '--dsw-alias-label-dimmed',
  '--dsw-alias-label-document-preview',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-primary-bluish',
  '--dsw-alias-label-primary-dimmed',
  '--dsw-alias-label-primary-foreground',
  '--dsw-alias-label-primary-inverted',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-link',
  '--dsw-alias-markdown-citation',
  '--dsw-alias-markdown-code-block',
  '--dsw-alias-markdown-code-block-banner',
  '--dsw-alias-markdown-code-segment-selected',
  '--dsw-alias-markdown-code-segment-unselected',
  '--dsw-alias-markdown-inline-code',
  '--dsw-alias-markdown-placeholder',
  '--dsw-alias-markdown-tag',
  '--dsw-alias-menu-icon',
  '--dsw-alias-onboarding-accent',
  '--dsw-alias-onboarding-card-fill',
  '--dsw-alias-onboarding-checkbox-border',
  '--dsw-alias-onboarding-secondary-fill',
  '--dsw-alias-scrollbar-bg-l1',
  '--dsw-alias-scrollbar-bg-l2',
  '--dsw-alias-scrollbar-hover-l1',
  '--dsw-alias-scrollbar-hover-l2',
  '--dsw-alias-settings-card-fill',
  '--dsw-alias-settings-card-stroke',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-business-tertiary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-error-secondary',
  '--dsw-alias-state-idle-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-success-secondary',
  '--dsw-alias-state-success-tertiary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-state-warn-secondary',
  '--dsw-alias-state-warn-tertiary',
  '--dsw-alias-toast-bg',
  '--dsw-alias-toast-label',
  '--dsw-alias-tooltip-bg',
  '--dsw-alias-tooltip-key-bg',
]

/** 非 `alias-` 的令牌（字体、圆角、阴影…）。CSS 里用到几个就收几个。 */
const OTHER_TOKENS = [
  '--dsw-font-markdown-code-font-family',
]

/** 历史踩过的错名：留着当回归防线，免得哪天又被"顺手改回来"。 */
const KNOWN_BAD = [
  '--dsw-alias-label-inverse',
  '--dsw-alias-state-warning-primary',
  '--dsw-alias-state-danger-primary',
  '--dsw-font-mono',
]

/** 从主题文件里抠出实时令牌表；给不出来就返回 null。 */
function loadLiveTokens(file) {
  if (typeof file !== 'string' || file === '') return null
  const text = fs.readFileSync(file, 'utf8')
  const found = new Set()
  for (const match of text.matchAll(/--dsw-[a-z0-9-]+/g)) found.add(match[0])
  return found.size === 0 ? null : found
}

function main() {
  const client = loadInternals()
  const css = client.CSS
  assert.strictEqual(typeof css, 'string')

  const live = loadLiveTokens(process.env.ZGG_THEME_FILE)
  const allowed = live === null
    ? new Set([...ALIAS_TOKENS, ...OTHER_TOKENS])
    : live

  // 设了 ZGG_THEME_FILE 时顺带体检内置快照：它过期了也该有人知道。
  if (live !== null) {
    const stale = ALIAS_TOKENS.filter((token) => !live.has(token))
    assert.deepStrictEqual(stale, [], '内置令牌快照里有主题已经不认的条目，请更新 ALIAS_TOKENS')
    console.log(`  令牌表来源：${process.env.ZGG_THEME_FILE}（实时，${live.size} 个）`)
  } else {
    console.log(`  令牌表来源：内置快照（${allowed.size} 个）；设 ZGG_THEME_FILE 可改用实时主题核对`)
  }

  const used = [...new Set([...css.matchAll(/--dsw-[a-z0-9-]+/g)].map((match) => match[0]))].sort()
  assert.ok(used.length > 0, 'CSS 里应当有皮肤令牌')

  const unknown = used.filter((token) => !allowed.has(token))
  assert.deepStrictEqual(
    unknown,
    [],
    `CSS 引用了皮肤里不存在的令牌（会静默走 fallback，颜色会不对）：\n  ${unknown.join('\n  ')}`,
  )

  for (const bad of KNOWN_BAD) {
    assert.ok(!css.includes(bad), `CSS 里又出现了已知错名 ${bad}`)
  }

  // 颜色不许写字面量：一切都得从皮肤令牌派生，否则换主题就会有一块地方不跟随。
  const colourLiterals = [...css.matchAll(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g)].map((match) => match[0])
  assert.deepStrictEqual(colourLiterals, [], `CSS 里出现了颜色字面量：${colourLiterals.join(', ')}`)

  console.log(`style-tokens.test.cjs: OK（CSS 引用 ${used.length} 个令牌，全部存在）`)
}

main()
