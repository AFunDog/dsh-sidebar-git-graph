/**
 * dsh-sidebar-git-graph — 浏览器半身。
 *
 * 注册一个右侧栏页面「Git 图谱」：把宿主 `POST /dsh-sidebar-git-graph/api` 给的提交 DAG 画成
 * VS Code 风格的多分支关系图（彩色泳道 + 贝塞尔汇入/分出曲线 + ref 芯片）。
 * 只读：本页面没有任何写操作。
 *
 * 注册路线（按优先级）：
 *   1. `ctx.betterSidebar.registerTab`（dsh-better-sidebar 的公开扩展点）——页面会同时
 *      出现在它的 `+` 菜单与设置页「侧边卡片」里（可开关）。**不放进静态 inject**：
 *      静态声明一个可能缺席的服务会让本插件 fiber 挂起，表现是"热重载正常、重启后 tab
 *      消失"（dsh-docs-panel / dsh-sentinel 两个真实插件都记录过这个冷启动陷阱）。这里用
 *      `ctx.inject(['betterSidebar'], …)` 等它出现。服务契约在本地最小重述（只用到
 *      `registerTab` / `openTab`），不 value-import 第三方包——因此本包**零依赖**，
 *      better-sidebar 怎么演进都不会把这个插件带崩。
 *   2. 回退：better-sidebar 缺席时用 DSH 原生 `ctx.sidebarRightTabs` + `sidebar.right.pane.tab`
 *      注册同名的 tab 类型（同一列、同一个 `+` 菜单，只是没有那张开关卡片）。回退有 2s
 *      观察窗，避免与 better-sidebar 的激活顺序赛跑时两边都注册。
 *
 * 加载协议：`window.__ModuleLoader__.load({ id, factory })` 惰性 CJS 工厂；`require('react')`
 * 是平台 seed 词。**单文件自包含**——该协议不支持入口同步 require 另一个相对 client*.js。
 */
window.__ModuleLoader__.load({
  id: '@zeng/dsh-sidebar-git-graph',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } = React

    const TAB_ID = '@zeng/dsh-sidebar-git-graph:graph'
    const KIND = 'dsh-sidebar-git-graph'
    const TITLE = 'Git 图谱'
    const DESCRIPTION = '分支/合并的提交关系图（只读）'
    const ROUTE = '/dsh-sidebar-git-graph/api'
    const PALETTE = 10
    const ROW_H = 24
    const LANE_W = 14
    const PAD_L = 8
    const OVERSCAN = 6
    const DEFAULT_MAX = 400
    /** 仓库清单的默认扫描层数（够到本仓库在 vendor 里的嵌套仓库需要 5 层）。 */
    const DEFAULT_SCAN_DEPTH = 5

    // ───────────────────────────────────────────────────────────────────────
    // 纯函数层（可被 Node 直接测试：见 test/lane-layout.test.cjs）
    // ───────────────────────────────────────────────────────────────────────

    /**
     * 单趟泳道分配。
     *
     * 前提：commits 必须已按 git `--topo-order` 给出（子提交在前、父提交在后）。
     * 维护一个「活跃道」数组 `active[lane] = 该道正在等待的 sha | null`，
     * 提交落在最早等它的那道；其余等它的道在本行汇入并释放；父提交按序接管本道或新开道。
     *
     * @param commits - `{ sha, parents[] }` 数组。
     * @param paletteSize - 配色环大小。
     * @returns `{ rows, laneCount, dangling, colorCount }`；rows[i] 描述第 i 行要画什么。
     */
    function assignLanes(commits, paletteSize) {
      const size = Number.isFinite(paletteSize) && paletteSize > 0 ? Math.trunc(paletteSize) : PALETTE
      const list = Array.isArray(commits) ? commits : []
      const active = []
      const colors = []
      let nextColor = 0
      const rows = []
      let laneCount = 0

      const openLane = (from) => {
        const start = Number.isFinite(from) && from > 0 ? Math.trunc(from) : 0
        for (let lane = start; lane < active.length; lane += 1) {
          if (active[lane] === null) {
            colors[lane] = nextColor % size
            nextColor += 1
            return lane
          }
        }
        active.push(null)
        colors.push(nextColor % size)
        nextColor += 1
        return active.length - 1
      }

      for (const commit of list) {
        const entry = commit === null || commit === undefined ? {} : commit
        const sha = typeof entry.sha === 'string' ? entry.sha : ''
        const parents = Array.isArray(entry.parents) ? entry.parents.filter((parent) => typeof parent === 'string' && parent !== '') : []

        // 1. 哪些道在等这个提交
        const waiting = []
        for (let lane = 0; lane < active.length; lane += 1) {
          if (active[lane] !== null && active[lane] === sha) waiting.push(lane)
        }
        const up = waiting.length > 0
        const lane = up ? waiting[0] : openLane(0)
        if (colors[lane] === undefined || colors[lane] < 0) colors[lane] = nextColor++ % size
        const color = colors[lane]

        // 2. 其余等它的道：本行汇入主道后释放
        const merges = []
        for (let index = 1; index < waiting.length; index += 1) {
          const from = waiting[index]
          merges.push({ from, to: lane, color: colors[from] === undefined || colors[from] < 0 ? color : colors[from] })
          active[from] = null
          colors[from] = -1
        }

        // 3. 父提交：第一个接管本道，其余已有道就指过去、没有就新开
        active[lane] = null
        colors[lane] = color
        const branches = []
        for (let index = 0; index < parents.length; index += 1) {
          const parent = parents[index]
          if (index === 0) {
            active[lane] = parent
            continue
          }
          const existing = active.indexOf(parent)
          if (existing >= 0) {
            branches.push({ from: lane, to: existing, color: colors[existing] === undefined || colors[existing] < 0 ? color : colors[existing] })
            continue
          }
          const target = openLane(lane + 1)
          active[target] = parent
          branches.push({ from: lane, to: target, color: colors[target] })
        }

        // 4. 既不等本提交、也不是本行曲线端点的道：直穿过去
        const touched = new Set([lane])
        for (const merge of merges) {
          touched.add(merge.from)
          touched.add(merge.to)
        }
        for (const branch of branches) {
          touched.add(branch.from)
          touched.add(branch.to)
        }
        const verticals = []
        for (let other = 0; other < active.length; other += 1) {
          if (active[other] === null || touched.has(other)) continue
          verticals.push({ lane: other, color: colors[other] === undefined || colors[other] < 0 ? 0 : colors[other] })
        }

        laneCount = Math.max(laneCount, active.length, lane + 1)
        rows.push({ sha, lane, color, up, down: parents.length > 0, verticals, merges, branches })
      }

      const dangling = []
      for (let lane = 0; lane < active.length; lane += 1) {
        if (active[lane] !== null) dangling.push(lane)
      }
      return { rows, laneCount, dangling, colorCount: nextColor }
    }

    /**
     * 一行的全部线段（SVG path d + 颜色索引）。布局与渲染分离，这一层完全可测。
     * @param layout - assignLanes 的结果。
     * @param index - 行号。
     * @returns `{ d, color, kind }` 数组，kind ∈ vertical/merge/branch/up/down。
     */
    function rowGeometry(layout, index) {
      const row = layout.rows[index]
      if (row === undefined) return []
      const x = (lane) => PAD_L + lane * LANE_W + LANE_W / 2
      const top = index * ROW_H
      const mid = top + ROW_H / 2
      const bottom = top + ROW_H
      const paths = []
      for (const vertical of row.verticals) {
        paths.push({ d: `M ${x(vertical.lane)} ${top} L ${x(vertical.lane)} ${bottom}`, color: vertical.color, kind: 'vertical' })
      }
      for (const merge of row.merges) {
        paths.push({ d: edgePath(x(merge.from), top, x(merge.to), mid), color: merge.color, kind: 'merge' })
      }
      for (const branch of row.branches) {
        paths.push({ d: edgePath(x(branch.from), mid, x(branch.to), bottom), color: branch.color, kind: 'branch' })
      }
      // 本提交自己那一段：上边→圆点（up），圆点→下边（down）。
      if (row.up) paths.push({ d: `M ${x(row.lane)} ${top} L ${x(row.lane)} ${mid}`, color: row.color, kind: 'up' })
      if (row.down) paths.push({ d: `M ${x(row.lane)} ${mid} L ${x(row.lane)} ${bottom}`, color: row.color, kind: 'down' })
      return paths
    }

    /**
     * 三次贝塞尔（控制点在竖直方向居中），用于分支/合并的平滑过渡。
     * @param x0 - 起点 x。@param y0 - 起点 y。@param x1 - 终点 x。@param y1 - 终点 y。
     * @returns path 的 d 属性。
     */
    function edgePath(x0, y0, x1, y1) {
      if (x0 === x1) return `M ${x0} ${y0} L ${x1} ${y1}`
      const middle = (y0 + y1) / 2
      return `M ${x0} ${y0} C ${x0} ${middle} ${x1} ${middle} ${x1} ${y1}`
    }

    /**
     * 图谱列宽。
     * @param layout - assignLanes 的结果。
     * @returns 像素宽度。
     */
    function graphWidth(layout) {
      return PAD_L * 2 + Math.max(1, layout.laneCount) * LANE_W
    }

    /**
     * 相对时间（中文，从秒级时间戳算）。
     * @param seconds - unix 秒。
     * @param now - 当前 unix 秒。
     * @returns 人类可读的短文案。
     */
    function relativeTime(seconds, now) {
      if (!Number.isFinite(seconds) || seconds <= 0) return ''
      const delta = Math.max(0, Math.trunc(now - seconds))
      if (delta < 60) return '刚刚'
      const minutes = Math.floor(delta / 60)
      if (minutes < 60) return `${minutes} 分钟前`
      const hours = Math.floor(minutes / 60)
      if (hours < 24) return `${hours} 小时前`
      const days = Math.floor(hours / 24)
      if (days < 30) return `${days} 天前`
      const months = Math.floor(days / 30)
      if (months < 12) return `${months} 个月前`
      return `${Math.floor(days / 365)} 年前`
    }

    /** 短 sha。 */
    function shortSha(sha) {
      return typeof sha === 'string' ? sha.slice(0, 8) : ''
    }

    /**
     * 把一个仓库相对路径拆成「末级目录」+「文件名」，给侧栏这种窄容器用。
     *
     * 侧栏大约 300px，印整条 `profiles/web/vendor/@zeng/x/lib/index.js` 会把 basename
     * 直接挤成省略号——而 basename 恰恰是唯一能认出这个文件的信息。所以列表里只印
     * basename，目录只留**末一级**（`…/lib`），完整路径放 title。
     *
     * `@scope/pkg/file.js` 这种要保留两段目录：`@scope` 与 `pkg` 一起才有意义，
     * 只留 `pkg` 会把两个 scope 下的同名包显示成一模一样。
     * @param value - 仓库相对路径（`/` 分隔）。
     * @returns `{ base, dir }`；根目录下的文件 dir 为空串。
     */
    function splitPath(value) {
      const text = typeof value === 'string' ? value : ''
      const parts = text.split('/').filter((part) => part !== '')
      if (parts.length === 0) return { base: text, dir: '' }
      const base = parts[parts.length - 1]
      const rest = parts.slice(0, -1)
      if (rest.length === 0) return { base, dir: '' }
      // 作用域包：与文件名相邻的**上一级**目录若是 `@scope`，就连它一起留（`@scope/pkg`）。
      // 注意判的是 rest 的**末尾**而不是开头：`node_modules/@zeng/dsh-kit/file.json` 的
      // rest 是 `[node_modules, @zeng, dsh-kit]`，作用域在倒数第二段，不在第一段。
      const scoped = rest.length >= 2 && rest[rest.length - 2].startsWith('@')
      const keep = scoped ? 2 : 1
      return { base, dir: `…/${rest.slice(-keep).join('/')}` }
    }

    /**
     * 段头计数的显示文本：`+12 −4`。
     *
     * 拿不到计数的段（未跟踪文件、计数命令失败）**不显示 0**——「0」是"没有增减"这个
     * 具体断言，而事实是"我们不知道"。宁可什么都不显示。
     * @param totals - 宿主给的 `{ count, added, deleted, counted }`。
     * @returns 元素数组。
     */
    function totalsText(h, totals) {
      if (totals === null || totals === undefined || totals.counted === 0) return []
      const parts = []
      if (totals.added > 0) parts.push(h('span', { key: 'a', className: 'zgg-added' }, `+${totals.added}`))
      if (totals.deleted > 0) parts.push(h('span', { key: 'd', className: 'zgg-deleted' }, `−${totals.deleted}`))
      return parts
    }

    /**
     * 单行改动的显示文案（纯函数，可测）。
     *
     * `container` 行（内嵌仓库）**没有 diff 可取**：git 不下钻进一个内嵌仓库，
     * `--no-index` 对着目录会报 `Could not access '<dir>/null'`。所以它必须是不可点的，
     * 并且明说为什么——否则就是"点了没反应"。
     * @param row - 宿主给的改动行。
     * @returns `{ base, dir, orig, title, clickable, note }`。
     */
    function fileRowView(row) {
      const { base, dir } = splitPath(row.path)
      const isContainer = row.container === true
      const orig = typeof row.origPath === 'string' && row.origPath !== ''
        ? splitPath(row.origPath).base
        : ''
      return {
        base,
        dir,
        orig,
        title: row.path,
        clickable: !isContainer,
        note: isContainer ? '内嵌仓库，不显示改动' : '',
      }
    }

    /** 状态字母 → 中文说明（title 用）。 */
    const STATUS_COPY = {
      M: '已修改',
      A: '新增',
      D: '已删除',
      R: '重命名',
      C: '复制',
      U: '未跟踪',
      T: '类型变化',
    }

    /** 一个改动行。 */
    function changeRow(h, row, options) {
      const view = fileRowView(row)
      const children = [
        h('span', {
          key: 'flag',
          className: 'zgg-flag',
          'data-status': row.status,
          title: STATUS_COPY[row.status] ?? row.status,
        }, row.status),
        h('span', { key: 'base', className: 'zgg-file-base' }, view.base),
      ]
      if (view.orig !== '') {
        children.push(h('span', { key: 'orig', className: 'zgg-file-orig', title: row.origPath }, `← ${view.orig}`))
      }
      if (view.dir !== '') {
        children.push(h('span', { key: 'dir', className: 'zgg-file-dir', title: row.path }, view.dir))
      }
      if (view.note !== '') {
        children.push(h('span', { key: 'note', className: 'zgg-file-note' }, view.note))
      }
      children.push(h('span', { key: 'spacer', className: 'zgg-file-spacer' }))
      if (typeof row.added === 'number' || typeof row.deleted === 'number') {
        children.push(h('span', { key: 'counts', className: 'zgg-file-counts' },
          typeof row.added === 'number' && row.added > 0 ? h('span', { className: 'zgg-added' }, `+${row.added}`) : null,
          ' ',
          typeof row.deleted === 'number' && row.deleted > 0 ? h('span', { className: 'zgg-deleted' }, `−${row.deleted}`) : null))
      }
      return h('div', {
        key: `${options.section}:${row.path}`,
        className: 'zgg-file',
        'data-status': row.status,
        'data-clickable': view.clickable ? 'true' : 'false',
        'data-selected': options.selected === true ? 'true' : 'false',
        title: view.title,
        onClick: view.clickable ? options.onClick : undefined,
      }, children)
    }

    /** 一个可折叠的段。 */
    function changeSection(h, options) {
      const rows = Array.isArray(options.rows) ? options.rows : []
      if (rows.length === 0) return null
      const totals = options.totals
      return h('div', { key: `section-${options.section}`, className: 'zgg-section' },
        h('div', {
          className: 'zgg-section-head',
          onClick: options.onToggle,
          role: 'button',
          'aria-expanded': options.folded ? 'false' : 'true',
        },
        h('span', { className: 'zgg-section-caret' }, options.folded ? '▸' : '▾'),
        h('span', { className: 'zgg-section-title' }, options.title),
        h('span', { className: 'zgg-section-count' }, String(totals !== undefined && totals !== null ? totals.count : rows.length)),
        h('span', { className: 'zgg-section-counts' }, ...totalsText(h, totals))),
        // flatMap：一行可能带出「它自己 + 就地展开的 diff」两个元素。
        options.folded ? null : rows.flatMap((row) => options.renderRow(row)))
    }

    /**
     * 「仓库清单没扫完」的文案。
     *
     * 宿主一直在给 `reposTruncatedBy`（`['repos'|'dirs'|'time']`），而这里以前是一句固定的话，
     * 让用户**把扫描层数调小**。撞到**层数**这道闸时那句话正好说反了：层数越小扫得越少。
     * @param by - 宿主给的截断原因数组。
     * @returns 一句准确的话。
     */
    function reposTruncatedCopy(by) {
      const reasons = Array.isArray(by) ? by : []
      if (reasons.includes('time')) return '仓库清单没扫完（扫描超时），下拉里可能少了几个：调小「仓库扫描层数」可以扫得更快。'
      if (reasons.includes('dirs')) return '仓库清单没扫完（目录太多），下拉里可能少了几个：调小「仓库扫描层数」可以扫得完。'
      if (reasons.includes('repos')) return '仓库清单没扫完（找到的仓库已达上限 100 个），下拉里可能少了几个：调小「仓库扫描层数」。'
      return '仓库清单没扫完，下拉里可能少了几个：调小「仓库扫描层数」可以扫得完。'
    }

    /** 非文本改动（二进制 / 目录 / 太大 / 取不到）的文案。 */
    const DIFF_STATE_COPY = {
      binary: '二进制文件，无法显示改动',
      combined: '这是合并冲突的合并格式差异，暂不逐行显示',
      dir: '这是一个目录，没有可显示的改动',
      'too-large': '文件过大，无法显示改动',
      unavailable: '这些改动的内容已不可用',
    }

    /**
     * 这个响应看起来是**改动**载荷吗（而不是别的 method 的载荷）。
     *
     * 为什么必须有这一条：**旧版宿主不认识 `method`，会静默把它当成 `graph`**，
     * 于是请求 `changes` 拿回来的是提交图数据（`{refs, commits, …}`），`ok: true`、没有错误。
     * 如果只做「缺字段就补空数组」的归一化，三个段就都变成空 → 页面显示
     * **「✓ 没有未提交的改动」**，而客户端其实**一个改动都没问过**。
     * 那是一个斩钉截铁的假话，比白屏更糟：白屏你还知道出事了，这个你会当真。
     *
     * 判据用「有 sections 这个对象」，因为这是改动载荷独有的顶层字段。
     * @param value - 宿主返回的 value。
     * @returns 是否像改动载荷。
     */
    function looksLikeChanges(value) {
      if (value === null || typeof value !== 'object') return false
      const sections = value.sections
      return sections !== null && typeof sections === 'object'
    }

    /**
     * 这个响应看起来是**diff** 载荷吗。
     * @param value - 宿主返回的 value。
     * @returns 是否像 diff 载荷。
     */
    function looksLikeDiff(value) {
      if (value === null || typeof value !== 'object') return false
      return typeof value.kind === 'string' && value.kind !== ''
    }

    /** 宿主版本对不上时的统一话术（DSH 的 method 分派是 0.3.0 才有的）。 */
    const STALE_HOST_COPY = '宿主还是旧版，没在服务「更改」这套接口：重启 dsh web 后就正常了。'

    /**
     * 这次画的是**哪个**仓库、为什么（纯函数，可测）。
     *
     * 会话 worktree 联动引入了两个新状态，都必须让用户看得见：
     *   - `followed`：正在跟随会话标签（用户可能奇怪"我没选这个啊"）；
     *   - `rejected`：有标签但用不了（**最糟的失败模式**是静默换一个仓库还不吭声）。
     * @param selection - 宿主给的 `value.selection`。
     * @returns `{ kind:'none' }` / `{ kind:'followed', tagged }` / `{ kind:'rejected', tagged, reason }`。
     */
    function tagNotice(selection) {
      if (selection === null || selection === undefined || typeof selection !== 'object') return { kind: 'none' }
      const tagged = typeof selection.tagged === 'string' && selection.tagged !== '' ? selection.tagged : ''
      if (selection.tagApplied === true) {
        return tagged === '' ? { kind: 'none' } : { kind: 'followed', tagged }
      }
      if (typeof selection.tagReason === 'string' && selection.tagReason !== '') {
        return { kind: 'rejected', tagged, reason: selection.tagReason }
      }
      return { kind: 'none' }
    }

    /**
     * 把 `tagNotice` 的结果渲染成一句人话（没有可说的就返回空串）。
     * @param notice - `tagNotice` 的结果。
     * @param repoName - 实际画的那个仓库名（rejected 时要说"已改画 X"）。
     * @returns 文案；空串表示不显示。
     */
    function tagNoticeCopy(notice, repoName) {
      if (notice === null || notice === undefined) return ''
      if (notice.kind === 'followed') {
        return `正在跟随会话的 worktree 标签：${notice.tagged}。在下面的下拉里选一个仓库即可改为固定画它。`
      }
      if (notice.kind === 'rejected') {
        const why = {
          missing: '那个目录已经不在了',
          'not-root': '那个路径不是仓库根',
          fenced: '那个路径不在本页可访问的范围内（它既不在工作区里，也不是本仓库的工作树）',
        }[notice.reason] ?? '那个路径用不了'
        const where = notice.tagged === '' ? '' : `（${notice.tagged}）`
        return `会话的 worktree 标签${where}用不了：${why}。已改画 ${repoName}。`
      }
      return ''
    }

    /**
     * 新载荷带 `schema: 2`；旧宿主没有这个字段。
     *
     * 图谱的 graph/changes/diff 在旧宿主上仍能用（字段是增量的），所以这里**不**把它
     * 当致命错误——只是告诉用户"联动没生效，因为宿主半是旧版"。与改动区的
     * `looksLikeChanges` 那种"整块接口都没有"的情况不同，不要一律按坏处理。
     * @param value - 宿主返回的 value。
     * @returns 是否带新版形状标记。
     */
    function isNewHost(value) {
      return value !== null && typeof value === 'object' && value.schema === 2
    }

    /**
     * 就地展开的 diff 视图（纯构造，可测）。
     * @param h - React.createElement。
     * @param state - `{ status:'loading'|'ready'|'error', value?, error? }`。
     * @returns 元素树；`null` 表示这一行没有展开。
     */
    function diffView(h, state) {
      if (state === null || state === undefined) return null
      if (state.status === 'loading') {
        return h('div', { className: 'zgg-diff' }, h('div', { className: 'zgg-diff-state' }, '正在读取改动…'))
      }
      if (state.status === 'error') {
        return h('div', { className: 'zgg-diff' }, h('div', { className: 'zgg-diff-state' }, errorText(state.error)))
      }
      const value = state.value
      if (value === undefined || value.kind !== 'text') {
        const copy = DIFF_STATE_COPY[value !== undefined ? value.kind : 'unavailable'] ?? '没有可显示的改动'
        return h('div', { className: 'zgg-diff' }, h('div', { className: 'zgg-diff-state' }, copy))
      }
      const lines = Array.isArray(value.lines) ? value.lines : []
      if (lines.length === 0) {
        const copy = value.unparsed === true
          ? '这个 patch 的格式没认出来，无法逐行显示'
          : '这个文件没有文本改动'
        return h('div', { className: 'zgg-diff' }, h('div', { className: 'zgg-diff-state' }, copy))
      }
      const children = []
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (line.kind === 'hunk') {
          children.push(h('div', { key: index, className: 'zgg-diff-hunk' }, line.text))
          continue
        }
        if (line.kind === 'meta') {
          children.push(h('div', { key: index, className: 'zgg-diff-meta' }, line.text))
          continue
        }
        const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ''
        children.push(h('div', { key: index, className: 'zgg-diff-line', 'data-kind': line.kind },
          h('span', { className: 'zgg-diff-no' }, typeof line.oldNo === 'number' ? String(line.oldNo) : ''),
          h('span', { className: 'zgg-diff-no' }, typeof line.newNo === 'number' ? String(line.newNo) : ''),
          h('span', { className: 'zgg-diff-sign' }, sign),
          // 空行也要有一个可撑高的内容，否则 `min-height` 之外什么都没有时行会塌。
          h('span', { className: 'zgg-diff-text' }, line.text === '' ? ' ' : line.text)))
      }
      if (value.truncated === true) {
        children.push(h('div', { key: 'truncated', className: 'zgg-diff-hunk' }, '改动太长，只显示了一部分'))
      }
      return h('div', { className: 'zgg-diff' }, children)
    }

    /** 错误码 → 页面文案。 */
    const ERROR_COPY = {
      'no-git': '在 PATH 里找不到 git 可执行文件',
      'not-a-repo': '这个工作目录不在任何 git 仓库里',
      'no-workspace': '拿不到工作目录：会话没有记录 cwd，也没有已注册的工作区',
      forbidden: '请求被信任围栏拒绝了（请从本机浏览器访问）',
      'git-failed': 'git 命令执行失败',
      http: '宿主没有响应',
    }

    /**
     * 把错误对象翻成一句人话。
     *
     * 宿主给的 `message` 最具体（例如"工作目录不存在：D:/gone"），优先用它；`detail` 是 git
     * 自己的 stderr 尾巴，附在后面；都没有才退回错误码的通用文案。
     */
    function errorText(error) {
      if (error === null || error === undefined) return '未知错误'
      const message = typeof error.message === 'string' && error.message !== '' ? error.message : undefined
      const base = message ?? ERROR_COPY[error.code] ?? '未知错误'
      const detail = typeof error.detail === 'string' && error.detail !== '' ? error.detail : undefined
      if (detail === undefined || message === undefined) return base
      return `${base}（${detail}）`
    }

    // ───────────────────────────────────────────────────────────────────────
    // 样式：全部颜色来自皮肤令牌（无颜色字面量）；泳道配色用 color-mix 派生
    // ───────────────────────────────────────────────────────────────────────

    const STYLE_ID = 'dsh-sidebar-git-graph-style'
    // 颜色令牌只允许取自 DSH 皮肤（`--dsw-alias-*`），不许写颜色字面量。**令牌名必须
    // 当真**：写错名字不会报错，只会静默走 fallback——本项目就因此踩过「深色主题下
    // current 分支徽标白底白字」（`--dsw-alias-label-inverse` 并不存在，正确的是
    // `--dsw-alias-label-primary-inverted` / `--dsw-alias-label-primary-foreground`）。
    // test/style-tokens.test.cjs 会拿主题里的真实令牌表逐个核对，别再靠眼睛。
    const CSS = `
.zgg-root {
  --zgg-lane-0: var(--dsw-alias-brand-primary, currentColor);  --zgg-lane-1: var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary, currentColor));
  --zgg-lane-2: var(--dsw-alias-state-warn-primary, var(--dsw-alias-brand-primary, currentColor));
  --zgg-lane-3: var(--dsw-alias-state-error-primary, var(--dsw-alias-brand-primary, currentColor));
  --zgg-lane-4: var(--dsw-alias-brand-primary, currentColor);
  --zgg-lane-5: var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary, currentColor));
  --zgg-lane-6: var(--dsw-alias-state-warn-primary, var(--dsw-alias-brand-primary, currentColor));
  --zgg-lane-7: var(--dsw-alias-state-error-primary, var(--dsw-alias-brand-primary, currentColor));
  --zgg-lane-8: var(--dsw-alias-brand-primary, currentColor);
  --zgg-lane-9: var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary, currentColor));
  --zgg-lane-4: color-mix(in oklab, var(--dsw-alias-brand-primary) 65%, var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary)) 35%);
  --zgg-lane-5: color-mix(in oklab, var(--dsw-alias-brand-primary) 35%, var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary)) 65%);
  --zgg-lane-6: color-mix(in oklab, var(--dsw-alias-state-warn-primary, var(--dsw-alias-brand-primary)) 65%, var(--dsw-alias-brand-primary) 35%);
  --zgg-lane-7: color-mix(in oklab, var(--dsw-alias-state-error-primary, var(--dsw-alias-brand-primary)) 70%, var(--dsw-alias-brand-primary) 30%);
  --zgg-lane-8: color-mix(in oklab, var(--dsw-alias-brand-primary) 50%, var(--dsw-alias-state-error-primary, var(--dsw-alias-brand-primary)) 50%);
  --zgg-lane-9: color-mix(in oklab, var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary)) 50%, var(--dsw-alias-state-warn-primary, var(--dsw-alias-brand-primary)) 50%);
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  /* 自己拥有滚动：原生 tab 体所在的 .paneBody 本身也是滚动容器，
     两层都能滚会让外层先把内容滚走、虚拟窗口却不更新（实测踩过）。 */
  overflow: hidden;
  font-size: 12px;
  color: var(--dsw-alias-label-primary, inherit);
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.zgg-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 6px 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l4, transparent);
  flex: 0 0 auto;
}
.zgg-repo { font-weight: 600; }
.zgg-branch {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 0.5px solid var(--dsw-alias-border-l4, transparent);
  background: var(--dsw-alias-bg-layer-2, transparent);
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.zgg-counts { color: var(--dsw-alias-label-secondary, inherit); font-variant-numeric: tabular-nums; }
.zgg-spacer { flex: 1 1 auto; }
.zgg-select, .zgg-search, .zgg-button {
  font: inherit;
  color: inherit;
  background: var(--dsw-alias-bg-layer-2, transparent);
  border: 0.5px solid var(--dsw-alias-border-l4, transparent);
  border-radius: 6px;
  padding: 2px 6px;
  min-width: 0;
}
.zgg-search { width: 130px; }
/* 仓库下拉：宽度跟着内容走但有上限，长路径靠 title 兜底，不能把工具栏挤爆。 */
.zgg-repo-select { flex: 0 1 auto; max-width: 60%; font-weight: 600; text-overflow: ellipsis; }
.zgg-button { cursor: pointer; }
.zgg-button:hover { background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, transparent)); }
.zgg-button:disabled { cursor: default; opacity: 0.5; }
.zgg-body { position: relative; flex: 1 1 auto; min-height: 0; overflow: auto; }
.zgg-sizer { position: relative; }
.zgg-svg { position: absolute; left: 0; pointer-events: none; }
.zgg-row {
  position: absolute;
  left: 0;
  right: 0;
  height: 24px;
  display: flex;
  align-items: center;
  gap: 6px;
  padding-right: 8px;
  white-space: nowrap;
  overflow: hidden;
  cursor: default;
}
.zgg-row:hover { background: var(--dsw-alias-bg-layer-2, transparent); }
.zgg-row[data-selected="true"] { background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, transparent)); }
.zgg-row[data-dim="true"] { opacity: 0.35; }
.zgg-graphcell { flex: 0 0 auto; }
.zgg-subject { overflow: hidden; text-overflow: ellipsis; }
.zgg-meta { color: var(--dsw-alias-label-secondary, inherit); flex: 0 0 auto; }
.zgg-chip {
  flex: 0 0 auto;
  padding: 0 5px;
  border-radius: 999px;
  border: 0.5px solid currentColor;
  font-size: 11px;
  line-height: 16px;
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.zgg-chip[data-kind="branch"] { color: var(--dsw-alias-brand-primary, inherit); }
.zgg-chip[data-kind="remote"] { color: var(--dsw-alias-label-secondary, inherit); }
.zgg-chip[data-kind="tag"] { color: var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-primary, inherit)); }
/* 当前分支：底色是 brand-primary，前景必须配官方那支前景令牌。
   深色主题下 brand-primary 是近白色，前景令牌是近黑色；写反/写错名字就是白底白字。 */
.zgg-chip[data-current="true"] {
  background: var(--dsw-alias-brand-primary, transparent);
  color: var(--dsw-alias-label-primary-foreground, var(--dsw-alias-label-primary-inverted, inherit));
  border-color: transparent;
}
.zgg-notice { padding: 8px; color: var(--dsw-alias-label-secondary, inherit); }
.zgg-detail {
  margin: 0 8px 8px 8px;
  padding: 6px 8px;
  border: 0.5px solid var(--dsw-alias-border-l4, transparent);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2, transparent);
  white-space: pre-wrap;
  word-break: break-all;
}
.zgg-detail code { font-family: var(--dsw-font-markdown-code-font-family, monospace); }
.zgg-empty { padding: 12px 8px; color: var(--dsw-alias-label-secondary, inherit); }

/* ── 工作树改动区 ─────────────────────────────────────────────────────────
   与下方的提交图**各自滚动**：图谱那边是虚拟列表，有自己的 scrollTop 与窗口区间，
   混进同一个滚动容器会让虚拟窗口算错（见 .zgg-root 那段的注释）。上限 45% 是为了
   改动很多时不要把图挤没。 */
.zgg-changes {
  flex: 0 0 auto;
  max-height: 45%;
  overflow: auto;
  border-bottom: 0.5px solid var(--dsw-alias-border-l4, transparent);
}
.zgg-changes-clean {
  padding: 6px 8px;
  color: var(--dsw-alias-label-secondary, inherit);
  display: flex;
  align-items: center;
  gap: 6px;
}
.zgg-changes-clean-mark { color: var(--dsw-alias-state-success-primary, inherit); font-weight: 700; }
.zgg-section-head {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  cursor: pointer;
  user-select: none;
  /* 段头吸顶：改动多时滚下去仍知道自己在哪一段。 */
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--dsw-alias-bg-layer-1, transparent);
}
.zgg-section-head:hover { background: var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1, transparent)); }
.zgg-section-caret { flex: 0 0 auto; width: 10px; color: var(--dsw-alias-label-secondary, inherit); }
.zgg-section-title { font-weight: 600; }
.zgg-section-count {
  color: var(--dsw-alias-label-secondary, inherit);
  font-variant-numeric: tabular-nums;
  padding: 0 4px;
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-2, transparent);
}
.zgg-section-counts { margin-left: auto; font-variant-numeric: tabular-nums; font-size: 11px; }
.zgg-added { color: var(--dsw-alias-state-success-primary, inherit); }
.zgg-deleted { color: var(--dsw-alias-state-error-primary, inherit); }
.zgg-file {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 1px 8px 1px 12px;
  white-space: nowrap;
  overflow: hidden;
}
.zgg-file[data-clickable="true"] { cursor: pointer; }
.zgg-file[data-clickable="true"]:hover { background: var(--dsw-alias-bg-layer-2, transparent); }
.zgg-file[data-selected="true"] { background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, transparent)); }
.zgg-flag {
  flex: 0 0 auto;
  width: 11px;
  text-align: center;
  font-weight: 700;
  font-size: 11px;
  font-family: var(--dsw-font-markdown-code-font-family, monospace);
}
/* 状态字母的配色全部来自既有主题令牌，不引新颜色。 */
.zgg-flag[data-status="M"] { color: var(--dsw-alias-state-warn-primary, inherit); }
.zgg-flag[data-status="A"], .zgg-flag[data-status="U"] { color: var(--dsw-alias-state-success-primary, inherit); }
.zgg-flag[data-status="D"] { color: var(--dsw-alias-state-error-primary, inherit); }
.zgg-flag[data-status="R"], .zgg-flag[data-status="C"] { color: var(--dsw-alias-label-secondary, inherit); }
.zgg-file-base { flex: 0 0 auto; }
/* 目录只显示末级：侧栏太窄，印整条路径会立刻把 basename 挤没。
   完整路径在 title 里，鼠标停一下就有。 */
.zgg-file-dir {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit));
}
.zgg-file-orig {
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit));
}
.zgg-file-spacer { flex: 1 1 auto; }
.zgg-file-counts { flex: 0 0 auto; font-variant-numeric: tabular-nums; font-size: 11px; }
/* 内嵌仓库那种目录行：不可点，说明文字要弱化。 */
.zgg-file-note { flex: 0 1 auto; color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit)); font-size: 11px; }

/* ── 就地展开的 diff ─────────────────────────────────────────────────────
   侧栏只有 ~300px，统一 diff 在这里必然是挤的。这里的选择是**保留上下文、就地展开**，
   代价是长行要横向滚动（而不是折行——折行会让 +/- 的对齐彻底失效，那正是 diff 的意义）。
   配色抄官方工具卡片用的那套专设令牌，换主题时与官方一致。 */
.zgg-diff {
  margin: 2px 0 6px 0;
  border-top: 0.5px solid var(--dsw-alias-border-l4, transparent);
  border-bottom: 0.5px solid var(--dsw-alias-border-l4, transparent);
  background: var(--dsw-alias-bg-layer-2, transparent);
  overflow-x: auto;
  overflow-y: hidden;
  font-family: var(--dsw-font-markdown-code-font-family, monospace);
  font-size: 11px;
  line-height: 16px;
}
.zgg-diff-state { padding: 6px 8px; color: var(--dsw-alias-label-secondary, inherit); font-family: inherit; }
.zgg-diff-line {
  display: grid;
  grid-template-columns: 3.2em 3.2em 1.1em minmax(max-content, 1fr);
  white-space: pre;
  min-height: 16px;
}
.zgg-diff-no {
  text-align: right;
  padding-right: 4px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit));
  background: var(--dsw-alias-bg-layer-1, transparent);
  user-select: none;
}
.zgg-diff-sign { text-align: center; user-select: none; }
.zgg-diff-text { padding-left: 4px; }
.zgg-diff-line[data-kind="add"] { background: var(--dsw-alias-file-diff-added-bg, transparent); }
.zgg-diff-line[data-kind="del"] { background: var(--dsw-alias-file-diff-deleted-bg, transparent); }
.zgg-diff-line[data-kind="add"] .zgg-diff-no { background: var(--dsw-alias-file-diff-added-gutter, transparent); color: var(--dsw-alias-file-diff-added-marker, inherit); }
.zgg-diff-line[data-kind="del"] .zgg-diff-no { background: var(--dsw-alias-file-diff-deleted-gutter, transparent); color: var(--dsw-alias-file-diff-deleted-marker, inherit); }
.zgg-diff-line[data-kind="add"] .zgg-diff-sign { color: var(--dsw-alias-file-diff-added-marker, inherit); }
.zgg-diff-line[data-kind="del"] .zgg-diff-sign { color: var(--dsw-alias-file-diff-deleted-marker, inherit); }
.zgg-diff-line[data-kind="ctx"] .zgg-diff-text { color: var(--dsw-alias-label-secondary, inherit); }
.zgg-diff-hunk {
  padding: 2px 8px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit));
  background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-layer-2, transparent));
  white-space: pre;
}
.zgg-diff-meta {
  padding: 0 8px;
  color: var(--dsw-alias-label-tertiary, var(--dsw-alias-label-secondary, inherit));
  white-space: pre;
}
`

    /** 样式只注入一次（按 DOM 里是否已有该 id 判断，HMR 重挂也不会重复）。 */
    function ensureStyle() {
      if (typeof document === 'undefined') return
      if (document.getElementById(STYLE_ID) !== null) return
      const style = document.createElement('style')
      style.id = STYLE_ID
      style.textContent = CSS
      document.head.appendChild(style)
    }

    /** 泳道颜色变量。 */
    function laneColor(index) {
      const slot = ((Number.isFinite(index) ? Math.trunc(index) : 0) % PALETTE + PALETTE) % PALETTE
      return `var(--zgg-lane-${slot}, currentColor)`
    }

    // ───────────────────────────────────────────────────────────────────────
    // 仓库选择（一个工作区里常常不止一个仓库）
    // ───────────────────────────────────────────────────────────────────────

    /** 「这个工作区上次画的是哪个仓库」的存储键前缀。 */
    const REPO_KEY_PREFIX = 'dsh-sidebar-git-graph:repo:'
    /** 段折叠状态的存储键（不分工作区：这是全局偏好，不是每个仓库的事实）。 */
    const FOLDED_KEY = 'dsh-sidebar-git-graph:folded'

    /**
     * 读回段的折叠状态。
     * @returns `{ staged, unstaged, conflicts }`，缺省全展开。
     */
    function readFolded() {
      const empty = { staged: false, unstaged: false, conflicts: false }
      try {
        const saved = globalThis.localStorage?.getItem(FOLDED_KEY)
        if (typeof saved !== 'string' || saved === '') return empty
        const parsed = JSON.parse(saved)
        if (parsed === null || typeof parsed !== 'object') return empty
        return {
          staged: parsed.staged === true,
          unstaged: parsed.unstaged === true,
          conflicts: parsed.conflicts === true,
        }
      } catch (error) { return empty }
    }

    /**
     * 记住段的折叠状态。
     * @param value - `{ staged, unstaged, conflicts }`。
     */
    function saveFolded(value) {
      try { globalThis.localStorage?.setItem(FOLDED_KEY, JSON.stringify(value)) } catch (error) { /* 无痕模式等，忽略 */ }
    }

    /**
     * 读回上次选的仓库根。按工作区分别记忆：不同工作区里同名仓库很常见。
     * @param cwd - 工作目录。
     * @returns 绝对路径，或 undefined（没记过 / 存储不可用）。
     */
    function readSavedRepo(cwd) {
      if (typeof cwd !== 'string' || cwd === '') return undefined
      try {
        const saved = globalThis.localStorage?.getItem(REPO_KEY_PREFIX + cwd)
        return typeof saved === 'string' && saved !== '' ? saved : undefined
      } catch (error) { return undefined }
    }

    /**
     * 记住这次选的仓库根。
     * @param cwd - 工作目录。
     * @param root - 仓库根绝对路径。
     */
    function saveRepo(cwd, root) {
      if (typeof cwd !== 'string' || cwd === '' || typeof root !== 'string' || root === '') return
      try { globalThis.localStorage?.setItem(REPO_KEY_PREFIX + cwd, root) } catch (error) { /* 无痕模式等，忽略 */ }
    }

    /**
     * 下拉项里跟在仓库名后面的那截：同一个工作区里重名的仓库靠它区分。
     * 工作区根写「工作区根」；工作区**之外**的仓库（工作区只是它的一个子目录）截末两段，
     * 因为相对路径这时长这样：`..\..\..`，给人看没意义。
     * @param repo - 宿主给的仓库项。
     * @returns 短后缀。
     */
    function repoSuffix(repo) {
      const rel = typeof repo.rel === 'string' ? repo.rel : ''
      if (repo.outside !== true && rel === '') return '工作区根'
      const parts = String(repo.outside === true ? repo.root : rel).split(/[\\/]+/).filter((part) => part !== '')
      const tail = parts.slice(-2).join('/')
      return repo.outside === true ? `…/${tail}` : tail
    }

    /**
     * 下拉项的整行文案。
     *
     * **关联工作树（`kind: 'worktree'`）显示分支而不是路径**：同一个仓库的各个工作树
     * 常常就在同一个父目录下、名字只差一个后缀，路径区分度很低；而它们的分支几乎必然不同
     * ——那才是人在这个下拉里要找的东西。主工作树额外标出来，否则「哪个是主工作区」只能靠猜。
     *
     * 路径之外的信息（分支、锁定）**不能省**：省掉用户就只能看到一个目录名，
     * 而那正是分不清两个工作树的原因（本次要修的就是这个）。
     * @param repo - 宿主给的仓库项。
     * @returns 显示文案。
     */
    function repoOptionLabel(repo) {
      if (repo.kind !== 'worktree') return `${repo.name} · ${repoSuffix(repo)}`
      const marks = []
      if (repo.main === true) marks.push('主工作树')
      if (repo.locked === true) marks.push('已锁定')
      // 分离头的工作树没有分支名：用短 sha 顶替。退回路径后缀是最后手段——
      // 那种情况下名字与路径几乎重复，信息量为零，所以只在连 sha 都拿不到时才用。
      let where
      if (typeof repo.branch === 'string' && repo.branch !== '') where = repo.branch
      else if (typeof repo.head === 'string' && repo.head !== '') where = `分离头 ${repo.head.slice(0, 8)}`
      else where = repoSuffix(repo)
      return `${repo.name} · ${where}${marks.length === 0 ? '' : `（${marks.join('，')}）`}`
    }

    /**
     * 仓库控件：只有一个仓库时是纯文本（没有可选项的下拉框只是噪声），多个时才是下拉。
     *
     * 抽成纯构造（自己接 `h`）是为了能测：`option` 的 `value` 必须是**仓库根**而不是
     * 相对路径或名字——写错了的表现是"点了没反应"，而那不是能靠读代码看出来的。
     * @param h - React.createElement。
     * @param options - `{ repos, currentRoot, title, onPick }`。
     * @returns 元素树。
     */
    function repoPicker(h, options) {
      const list = Array.isArray(options.repos) ? options.repos : []
      if (list.length <= 1) {
        return h('span', { className: 'zgg-repo', title: options.currentRoot ?? '' }, options.title)
      }
      return h('select', {
        className: 'zgg-select zgg-repo-select',
        value: options.currentRoot ?? '',
        title: options.currentRoot ?? '切换仓库',
        'aria-label': '切换仓库',
        onChange: (event) => options.onPick(event.target.value),
      }, list.map((repo) => h('option', {
        key: repo.root,
        value: repo.root,
        title: repo.root,
      }, repoOptionLabel(repo))))
    }


    // ───────────────────────────────────────────────────────────────────────
    // 数据
    // ───────────────────────────────────────────────────────────────────────

    /**
     * 问宿主要一份图谱快照。
     * @param payload - `{ sessionId, cwd, repo, repoHint, scanDepth, max, skip, scope }`。
     *   `repo` 是用户**本次手点**的仓库根；`repoHint` 是 localStorage 里**上次记住**的；
     *   两者都不传＝让宿主自己挑（宿主还会看会话 worktree 标签）。
     * @returns `{ ok:true, value }` 或 `{ ok:false, error }`。
     */
    async function requestGraph(payload) {
      return requestHost('graph', payload)
    }

    /**
     * 问宿主要一份工作树改动清单。
     * @param payload - `{ sessionId, cwd, repo, repoHint, scanDepth }`。
     * @returns `{ ok:true, value }` 或 `{ ok:false, error }`。
     */
    async function requestChanges(payload) {
      return requestHost('changes', payload)
    }

    /**
     * 问宿主要一个文件的 patch。
     * @param payload - `{ sessionId, cwd, repo, repoHint, section, path, origPath, untracked }`。
     * @returns `{ ok:true, value }` 或 `{ ok:false, error }`。
     */
    async function requestDiff(payload) {
      return requestHost('diff', payload)
    }

    /**
     * 往宿主路由发一次请求。
     *
     * 三个 method 共用同一个信封，只有 `method` 不同——宿主侧按它分派。
     * @param method - `'graph'` / `'changes'` / `'diff'`。
     * @param payload - method 自己的载荷。
     * @returns `{ ok:true, value }` 或 `{ ok:false, error }`。
     */
    async function requestHost(method, payload) {
      try {
        const rpcId = `dsh-sidebar-git-graph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
        })
        if (!response.ok) {
          return { ok: false, error: { code: response.status === 403 ? 'forbidden' : 'http', message: `HTTP ${response.status}` } }
        }
        const body = await response.json()
        const result = body !== null && body !== undefined ? body.result : undefined
        if (result !== null && result !== undefined && result.ok === true) return { ok: true, value: result.value }
        if (result !== null && result !== undefined && result.error !== undefined) return { ok: false, error: result.error }
        return { ok: false, error: { code: 'bad-response', message: '响应形状不对' } }
      } catch (error) {
        return { ok: false, error: { code: 'network', message: String(error !== null && error !== undefined && error.message !== undefined ? error.message : error) } }
      }
    }

    /** 读本插件自己的设置（better-sidebar 的 pluginSettings[<descriptor id>]）。 */
    const EMPTY_SETTINGS = {}
    function readPluginSettings(store) {
      if (store === null || store === undefined || typeof store.getSnapshot !== 'function') return EMPTY_SETTINGS
      try {
        const snapshot = store.getSnapshot()
        const prefs = snapshot !== null && snapshot !== undefined ? snapshot.prefs : undefined
        const map = prefs !== null && prefs !== undefined ? prefs.pluginSettings : undefined
        const own = map !== null && map !== undefined ? map[TAB_ID] : undefined
        return own !== null && typeof own === 'object' ? own : EMPTY_SETTINGS
      } catch (error) { return EMPTY_SETTINGS }
    }

    /** 订阅本插件设置变化（拿不到 store 就退化为静态值）。 */
    function usePluginSettings(store) {
      const subscribe = useCallback((callback) => {
        if (store === null || store === undefined || typeof store.subscribe !== 'function') return () => {}
        try { return store.subscribe(callback) } catch (error) { return () => {} }
      }, [store])
      const snapshot = useCallback(() => readPluginSettings(store), [store])
      try {
        return useSyncExternalStore(subscribe, snapshot, snapshot)
      } catch (error) {
        return EMPTY_SETTINGS
      }
    }

    // ───────────────────────────────────────────────────────────────────────
    // 视图
    // ───────────────────────────────────────────────────────────────────────

    /** ref 芯片。 */
    function refChip(ref, key) {
      const name = ref.kind === 'tag' ? `⌂ ${ref.name}` : ref.name
      return h('span', {
        key,
        className: 'zgg-chip',
        'data-kind': ref.kind,
        'data-current': ref.isCurrent === true ? 'true' : 'false',
        title: `${ref.kind === 'branch' ? '本地分支' : ref.kind === 'remote' ? '远程分支' : '标签'}：${ref.name}`,
      }, name)
    }

    /**
     * 页面主体。
     * @param props - `{ ctx, sessionId, cwd, visible, bindRefresh, store }`。
     */
    function GraphView(props) {
      ensureStyle()
      const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
      const cwd = typeof props.cwd === 'string' && props.cwd !== '' ? props.cwd : undefined
      const visible = props.visible !== false
      const settings = usePluginSettings(props.store)
      const maxCommits = Number.isFinite(settings.maxCommits) ? Math.min(2000, Math.max(100, Math.trunc(settings.maxCommits))) : DEFAULT_MAX
      const scanDepth = Number.isFinite(settings.scanDepth) ? Math.min(8, Math.max(0, Math.trunc(settings.scanDepth))) : DEFAULT_SCAN_DEPTH

      const [state, setState] = useState({ status: 'loading' })
      const [changesState, setChangesState] = useState({ status: 'loading' })
      const [scope, setScope] = useState('all')
      const [query, setQuery] = useState('')
      const [matchAt, setMatchAt] = useState(0)
      const [selected, setSelected] = useState(null)
      const [scrollTop, setScrollTop] = useState(0)
      const [viewHeight, setViewHeight] = useState(360)
      // 用户**本次**点名的仓库：undefined = 让宿主自己挑（宿主会看会话 worktree 标签、
      // 再看 cwd 所在仓库）。只有**真的在下拉里点过**才会被设上 —— 见 rememberRepoChoice
      // 与 savedRepoHint 的区别。
      const [repoChoice, setRepoChoice] = useState(undefined)
      // localStorage 里**上次记住**的仓库：降级成**提示**发给宿主，不再当点名。
      //
      // ⚠️ 这个降级是「图谱跟随会话 worktree」联动的**关键**（2026-10-01）：
      // 此前它是以 `repo` **点名**发出去的，于是一旦用户点过一次下拉，那个记忆就
      // **永远压过会话标签**，标签永远轮不到。降级成 `repoHint` 之后优先级变成
      // 「手点 > 会话标签 > 上次记住 > cwd 所在仓库」，与用户直觉一致。
      const [repoHint, setRepoHint] = useState(() => readSavedRepo(cwd))
      // 段的折叠状态（照 VS Code 两段式）。持久化到 localStorage。
      const [folded, setFolded] = useState(() => readFolded())
      // 就地展开的那个文件：`{ section, path, status, value?, error? }`。
      // 键用 section+path：同一个文件在「更改」与「暂存的更改」里是两条不同的 diff。
      const [diffTarget, setDiffTarget] = useState(null)
      const diffSeq = useRef(0)
      const bodyRef = useRef(null)
      const requestSeq = useRef(0)
      const loadRef = useRef(null)

      const load = useCallback(async () => {
        const seq = requestSeq.current + 1
        requestSeq.current = seq
        setState((previous) => (previous.status === 'ready' ? { ...previous, refreshing: true } : { status: 'loading' }))
        setChangesState((previous) => (previous.status === 'ready' ? { ...previous, refreshing: true } : { status: 'loading' }))
        // 两个请求并发：图谱与改动互不依赖，串起来只会让页面慢一倍。
        const [graphOutcome, changesOutcome] = await Promise.all([
          requestGraph({ sessionId, cwd, repo: repoChoice, repoHint, scanDepth, max: maxCommits, skip: 0, scope }),
          requestChanges({ sessionId, cwd, repo: repoChoice, repoHint, scanDepth }),
        ])
        if (requestSeq.current !== seq) return
        if (graphOutcome.ok) setState({ status: 'ready', value: graphOutcome.value, refreshing: false })
        else setState({ status: 'error', error: graphOutcome.error })
        // 形状校验见 looksLikeChanges 的注释：旧版宿主会把 `changes` 当 `graph` 回，
        // 不校验就会把「一个改动都没问过」显示成「没有未提交的改动」。
        if (changesOutcome.ok && looksLikeChanges(changesOutcome.value)) {
          setChangesState({ status: 'ready', value: changesOutcome.value, refreshing: false })
        } else if (changesOutcome.ok) {
          setChangesState({ status: 'error', error: { code: 'stale-host', message: STALE_HOST_COPY } })
        } else {
          setChangesState({ status: 'error', error: changesOutcome.error })
        }
      }, [sessionId, cwd, repoChoice, scanDepth, maxCommits, scope])
      loadRef.current = load

      /**
       * 展开/收起一个文件的 diff。
       *
       * 再点同一条 = 收起。切换时旧请求的结果靠序号丢弃，避免快速点击时后到的旧响应
       * 覆盖新内容（一个只在慢网络上出现、但看起来像"点错了"的 bug）。
       */
      const openDiff = useCallback(async (sectionName, row) => {
        const same = diffTarget !== null && diffTarget.section === sectionName && diffTarget.path === row.path
        if (same) {
          diffSeq.current += 1
          setDiffTarget(null)
          return
        }
        const seq = diffSeq.current + 1
        diffSeq.current = seq
        const target = { section: sectionName, path: row.path, status: row.status }
        setDiffTarget({ ...target, status: 'loading' })
        const outcome = await requestDiff({
          sessionId,
          cwd,
          repo: repoChoice,
          repoHint,
          section: sectionName === 'staged' ? 'staged' : 'unstaged',
          path: row.path,
          origPath: row.origPath,
          // 用宿主给的 `untracked` / `unmerged` 标记，**不要**靠状态字母猜：
          // 冲突文件与未跟踪文件都是字母 `U`，但前者能取普通 diff。
          // 猜错就是拿 `--no-index` 把整个文件当成新增——一个不报错的错答案。
          untracked: row.untracked === true,
          unmerged: sectionName === 'conflicts',
        })
        if (diffSeq.current !== seq) return
        if (outcome.ok && looksLikeDiff(outcome.value)) {
          setDiffTarget({ ...target, status: 'ready', value: outcome.value })
        } else if (outcome.ok) {
          setDiffTarget({ ...target, status: 'error', error: { code: 'stale-host', message: STALE_HOST_COPY } })
        } else {
          setDiffTarget({ ...target, status: 'error', error: outcome.error })
        }
      }, [diffTarget, sessionId, cwd, repoChoice, repoHint])

      // 首次可见时加载；每次可见性恢复或作用域变化都重取（不可见时完全不请求）。
      useEffect(() => {
        if (!visible) return undefined
        load()
        return undefined
      }, [visible, load])

      // 工作区换了（会话切走）：清掉**手点**的那个（它是上一个工作区的），并把
      // **记忆**换成新工作区的那一份。别把上一个工作区的选择带过去——那是错的仓库。
      // 首挂时它读到的是同一个值，React 会自行 bail out，不会多一次请求。
      useEffect(() => {
        setRepoChoice(undefined)
        setRepoHint(readSavedRepo(cwd))
      }, [cwd])

      // 官方刷新命令（原生 tab 的 refresh 命令/菜单）接到同一个 load。
      // 依赖写「是否绑定过」这个稳定的布尔量：适配层每次渲染都给新函数身份，
      // 若依赖它本身会变成每渲染一次就重绑一次。
      const hasBindRefresh = typeof props.bindRefresh === 'function'
      useEffect(() => {
        if (!hasBindRefresh) return undefined
        try {
          return props.bindRefresh(() => { loadRef.current() })
        } catch (error) {
          return undefined
        }
      }, [hasBindRefresh])

      const value = state.status === 'ready' ? state.value : undefined
      const commits = value !== undefined && Array.isArray(value.commits) ? value.commits : []
      const layout = useMemo(() => assignLanes(commits.map((commit) => ({ sha: commit.sha, parents: commit.parents })), PALETTE), [commits])
      const rows = layout.rows
      const total = rows.length * ROW_H
      const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
      const end = Math.min(rows.length, start + Math.ceil(viewHeight / ROW_H) + OVERSCAN * 2)
      const now = Math.floor(Date.now() / 1000)

      const normalizedQuery = query.trim().toLowerCase()
      const matches = useMemo(() => {
        if (normalizedQuery === '') return []
        const found = []
        for (let index = 0; index < commits.length; index += 1) {
          const commit = commits[index]
          const haystack = `${commit.subject} ${commit.author} ${commit.sha}`.toLowerCase()
          if (haystack.includes(normalizedQuery)) found.push(index)
        }
        return found
      }, [commits, normalizedQuery])

      // 搜索命中时把视图滚到当前命中项。
      useEffect(() => {
        if (matches.length === 0) return
        const target = matches[Math.min(matchAt, matches.length - 1)]
        const body = bodyRef.current
        if (body === null) return
        const y = target * ROW_H
        if (y < body.scrollTop || y > body.scrollTop + body.clientHeight - ROW_H) {
          body.scrollTop = Math.max(0, y - body.clientHeight / 2)
        }
      }, [matches, matchAt])

      // 视口高度测量 + scroll 监听。
      //
      // 用**原生**监听而不是 React 的 onScroll：路径更短——effect 里直接读一次当前值并
      // 自己挂监听，不依赖合成事件的委托时机，窗口区间也便于写进诊断句柄。
      //
      // 排查提示：「虚拟窗口不跟随滚动」这个症状在这台机器上实测**不是**代码问题：页面在
      // 后台标签时 Chrome 会把整轮渲染节流，于是 scroll 事件、requestAnimationFrame、
      // Playwright 截图全都不发生（连自己新挂的监听也一次不触发）。先看
      // `document.visibilityState`，再怀疑代码。
      useEffect(() => {
        const body = bodyRef.current
        if (body === null) return undefined
        const measure = () => setViewHeight(body.clientHeight > 0 ? body.clientHeight : 360)
        const onScroll = () => setScrollTop(body.scrollTop)
        measure()
        onScroll()
        body.addEventListener('scroll', onScroll, { passive: true })
        let observer = null
        if (typeof ResizeObserver === 'function') {
          observer = new ResizeObserver(measure)
          observer.observe(body)
        }
        return () => {
          body.removeEventListener('scroll', onScroll)
          if (observer !== null) observer.disconnect()
        }
      }, [state.status])

      const width = graphWidth(layout)
      const graphPaths = []
      for (let index = start; index < end; index += 1) {
        for (const path of rowGeometry(layout, index)) graphPaths.push(path)
      }

      // 一个工作区里只有一个仓库时不给下拉框——没有可选项的控件只是噪声。
      //
      // `repo` 归一化一次：宿主的 ready 响应一定带它，但「宿主与浏览器版本错位」时不一定。
      // 读 `value.repo.root` 时若 repo 是 null，抛出的错会把**整页**（含改动区）变成空白。
      // 缺字段时给一份空壳，页面照常画出能画的部分。
      const EMPTY_REPO = {
        root: '', name: TITLE, branch: null, detached: false, initial: false,
        upstream: null, ahead: 0, behind: 0, dirty: 0,
      }
      const graphRepo = value !== undefined && value.repo !== null && typeof value.repo === 'object'
        ? { ...EMPTY_REPO, ...value.repo }
        : EMPTY_REPO
      // 仓库清单**两个载荷都能给**（graph 与 changes 各带一份），取先到的那个。
      // 以前只认 graph 的：graph 一失败，下拉框就整个消失，而改动区自己的请求
      // 明明已经把同一份清单拿回来了（本次一并修掉）。
      const changesForRepos = changesState.status === 'ready' ? changesState.value : undefined
      const repoList = value !== undefined && Array.isArray(value.repos)
        ? value.repos
        : (changesForRepos !== undefined && Array.isArray(changesForRepos.repos) ? changesForRepos.repos : [])
      const currentRoot = value !== undefined ? graphRepo.root : undefined
      const repoControl = repoPicker(h, {
        repos: repoList,
        currentRoot,
        title: value !== undefined ? graphRepo.name : TITLE,
        onPick: (next) => {
          // 用户在页面上**手点**的：这一档优先级最高，连会话标签也不能盖过它
          // （否则用户点了却看不见变化）。同时记进 localStorage，下次进来仍是它。
          setRepoChoice(next)
          saveRepo(cwd, next)
        },
      })

      const head = h('div', { className: 'zgg-head' },
        repoControl,
        value !== undefined
          ? h('span', { className: 'zgg-branch', title: graphRepo.upstream !== null ? `上游 ${graphRepo.upstream}` : '没有上游' },
            graphRepo.detached ? `分离头 ${shortSha(commits.find((commit) => commit.head === true)?.sha ?? '')}` : (graphRepo.branch ?? '(未知分支)'))
          : null,
        value !== undefined
          ? h('span', { className: 'zgg-counts' }, `↑${graphRepo.ahead} ↓${graphRepo.behind}`, graphRepo.dirty > 0 ? ` · ${graphRepo.dirty} 个改动` : '')
          : null,
        h('span', { className: 'zgg-spacer' }),
        h('select', {
          className: 'zgg-select',
          value: scope,
          title: '历史范围',
          onChange: (event) => setScope(event.target.value),
        },
        h('option', { value: 'all' }, '全部分支'),
        h('option', { value: 'current' }, '仅当前分支')),
        h('input', {
          className: 'zgg-search',
          type: 'search',
          value: query,
          placeholder: '搜索提交',
          onChange: (event) => { setQuery(event.target.value); setMatchAt(0) },
        }),
        normalizedQuery !== ''
          ? h('span', { className: 'zgg-counts' }, matches.length === 0 ? '无匹配' : `${Math.min(matchAt + 1, matches.length)}/${matches.length}`)
          : null,
        normalizedQuery !== '' && matches.length > 1
          ? h('button', {
            className: 'zgg-button',
            type: 'button',
            title: '下一个匹配',
            onClick: () => setMatchAt((previous) => (previous + 1) % matches.length),
          }, '↓')
          : null,
        h('button', {
          className: 'zgg-button',
          type: 'button',
          disabled: state.refreshing === true,
          onClick: () => { load() },
        }, state.refreshing === true ? '刷新中' : '刷新'))

      let body = null
      if (state.status === 'loading') {
        body = h('div', { className: 'zgg-empty' }, '正在读取 git 历史…')
      } else if (state.status === 'error') {
        body = h('div', { className: 'zgg-empty' }, errorText(state.error))
      } else if (rows.length === 0) {
        body = h('div', { className: 'zgg-empty' }, '这个仓库还没有提交。')
      } else {
        const nodes = []
        for (let index = start; index < end; index += 1) {
          const row = rows[index]
          const commit = commits[index]
          const matched = normalizedQuery === '' || matches.includes(index)
          nodes.push(h('div', {
            key: commit.sha,
            className: 'zgg-row',
            'data-selected': selected === commit.sha ? 'true' : 'false',
            'data-dim': matched ? 'false' : 'true',
            style: { top: `${index * ROW_H}px` },
            onClick: () => setSelected((previous) => (previous === commit.sha ? null : commit.sha)),
          },
          h('span', { className: 'zgg-graphcell', style: { width: `${width - 8}px` } }),
          commit.refs.map((ref, refIndex) => refChip({
            ...ref,
            isCurrent: ref.kind === 'branch' && value !== undefined && graphRepo.branch === ref.name,
          }, `${commit.sha}-${refIndex}`)),
          h('span', { className: 'zgg-subject', title: `${shortSha(commit.sha)} ${commit.subject}` }, commit.subject),
          h('span', { className: 'zgg-meta' }, commit.author, ' · ', relativeTime(commit.time, now))))
        }
        const detail = selected === null ? null : commits.find((commit) => commit.sha === selected)
        body = [
          h('div', { key: 'sizer', className: 'zgg-sizer', style: { height: `${total}px` } },
            h('svg', {
              className: 'zgg-svg',
              width,
              height: Math.max(0, (end - start) * ROW_H),
              style: { top: `${start * ROW_H}px` },
              viewBox: `0 0 ${width} ${Math.max(0, (end - start) * ROW_H)}`,
              'aria-hidden': 'true',
            }, h('g', { transform: `translate(0 ${-start * ROW_H})` },
              graphPaths.map((path, pathIndex) => h('path', {
                key: pathIndex,
                d: path.d,
                fill: 'none',
                stroke: laneColor(path.color),
                'stroke-width': path.kind === 'vertical' || path.kind === 'up' || path.kind === 'down' ? 1.6 : 1.8,
                'stroke-linecap': 'round',
              })),
              rows.slice(start, end).map((row, offset) => h('circle', {
                key: `dot-${offset}`,
                cx: PAD_L + row.lane * LANE_W + LANE_W / 2,
                cy: (start + offset) * ROW_H + ROW_H / 2,
                r: row.merges.length > 0 || row.branches.length > 0 ? 4.2 : 3.4,
                fill: laneColor(row.color),
                stroke: 'var(--dsw-alias-bg-layer-1, transparent)',
                'stroke-width': 1,
              })))),
            nodes),
          detail === undefined || detail === null ? null : h('div', { key: 'detail', className: 'zgg-detail' },
            h('div', null, h('code', null, detail.sha)),
            h('div', null, `${detail.author} <${detail.email}> · ${new Date(detail.time * 1000).toLocaleString()}`),
            h('div', null, detail.subject),
            h('div', null, `父提交：${detail.parents.length === 0 ? '（根提交）' : detail.parents.map(shortSha).join(', ')}`),
            detail.refs.length === 0 ? null : h('div', null, `refs：${detail.refs.map((ref) => ref.name).join(', ')}`)),
        ]
      }

      // ── 「更改」区（VS Code 式两段）─────────────────────────────────────
      //
      // 与提交图**各自滚动**（见 CSS 注释）：图谱是虚拟列表，有自己的 scrollTop
      // 与窗口区间，混进同一个滚动容器会让虚拟窗口算错。
      const changesValue = changesState.status === 'ready' ? changesState.value : undefined
      // 归一化一次，后面就不必到处判空。
      //
      // 这里**不是**多虑：GraphView 里抛出的错会把整个页面（含下面的提交图）变成空白，
      // 而"宿主返回了一个形状不对的响应"是完全可能的（宿主半与浏览器半先后升级、
      // 或将来有人改了契约）。少画一个区，好过整页白屏——与宿主半 parseLog 的取向一致。
      const EMPTY_TOTALS = { count: 0, added: 0, deleted: 0, counted: 0 }
      // 注意判的是「是不是对象」而不是「!== undefined」：`null !== undefined` 为真，
      // 只判 undefined 会让 `sections: null` 直接漏进去并在读 `.conflicts` 时炸。
      // （这条是 render-smoke.test.cjs 逼出来的。）
      const asRecord = (value) => (value !== null && typeof value === 'object' ? value : {})
      const rawSections = asRecord(changesValue !== undefined ? changesValue.sections : undefined)
      const changeSections = changesValue === undefined
        ? undefined
        : {
          conflicts: Array.isArray(rawSections.conflicts) ? rawSections.conflicts : [],
          unstaged: Array.isArray(rawSections.unstaged) ? rawSections.unstaged : [],
          staged: Array.isArray(rawSections.staged) ? rawSections.staged : [],
        }
      const rawTotals = asRecord(changesValue !== undefined ? changesValue.totals : undefined)
      const sectionTotals = (key, rows) => {
        const value = rawTotals[key]
        if (value !== null && typeof value === 'object') return value
        return { ...EMPTY_TOTALS, count: rows.length }
      }
      const toggleFold = (key) => {
        setFolded((previous) => {
          const next = { ...previous, [key]: previous[key] !== true }
          saveFolded(next)
          return next
        })
      }

      const renderChangeRow = (sectionName) => (row) => {
        const expanded = diffTarget !== null && diffTarget.section === sectionName && diffTarget.path === row.path
        const out = [changeRow(h, row, {
          section: sectionName,
          selected: expanded,
          onClick: () => { openDiff(sectionName, row) },
        })]
        if (expanded) {
          out.push(h('div', { key: `${sectionName}:${row.path}:diff` }, diffView(h, diffTarget)))
        }
        return out
      }

      let changesPanel = null
      if (changesState.status === 'loading') {
        changesPanel = h('div', { className: 'zgg-changes-clean' }, '正在读取改动…')
      } else if (changesState.status === 'error') {
        changesPanel = h('div', { className: 'zgg-changes-clean' }, errorText(changesState.error))
      } else if (changeSections !== undefined) {
        const conflictRows = changeSections.conflicts
        const unstagedRows = changeSections.unstaged
        const stagedRows = changeSections.staged
        const clean = conflictRows.length === 0 && unstagedRows.length === 0 && stagedRows.length === 0
        if (clean) {
          changesPanel = h('div', { className: 'zgg-changes-clean' },
            h('span', { className: 'zgg-changes-clean-mark' }, '✓'),
            '没有未提交的改动')
        } else {
          const blocks = []
          if (conflictRows.length > 0) {
            blocks.push(changeSection(h, {
              section: 'conflicts',
              title: '合并更改',
              rows: conflictRows,
              totals: sectionTotals('conflicts', conflictRows),
              folded: folded.conflicts === true,
              onToggle: () => toggleFold('conflicts'),
              renderRow: renderChangeRow('conflicts'),
            }))
          }
          // 顺序照 VS Code：更改在上、暂存的更改在下。
          blocks.push(changeSection(h, {
            section: 'unstaged',
            title: '更改',
            rows: unstagedRows,
            totals: sectionTotals('unstaged', unstagedRows),
            folded: folded.unstaged === true,
            onToggle: () => toggleFold('unstaged'),
            renderRow: renderChangeRow('unstaged'),
          }))
          blocks.push(changeSection(h, {
            section: 'staged',
            title: '暂存的更改',
            rows: stagedRows,
            totals: sectionTotals('staged', stagedRows),
            folded: folded.staged === true,
            onToggle: () => toggleFold('staged'),
            renderRow: renderChangeRow('staged'),
          }))
          const panelNotices = []
          if (changesValue.truncated === true) {
            panelNotices.push(h('div', { key: 'changes-truncated', className: 'zgg-notice' },
              '改动太多，只列出了前 3000 条（其余的没显示）。'))
          }
          if (changesValue.countsAvailable === false) {
            panelNotices.push(h('div', { key: 'counts-missing', className: 'zgg-notice' },
              '拿不到每行的 +/− 计数，列表本身仍然完整。'))
          }
          changesPanel = [blocks, ...panelNotices]
        }
      }

      const notices = []
      if (value !== undefined && value.truncated === true) {
        notices.push(h('div', { key: 'truncated', className: 'zgg-notice' },
          `只画了最近 ${rows.length} 条提交（更老的历史被截断）`))
      }
      if (value !== undefined && graphRepo.initial === true) {
        notices.push(h('div', { key: 'initial', className: 'zgg-notice' }, '这是空仓库：还没有任何提交。'))
      }
      if (value !== undefined && value.selection !== undefined && value.selection !== null && value.selection.fallback === true) {
        // 理由必须分开说：以前无论什么原因都讲成「上次选的那个仓库不在了」，
        // 而实测最容易撞上的那一类恰恰是**仓库好好的**、只是路径出了围栏
        // （关联工作树在本次修好之前就全落在这一类里）。
        const requested = typeof value.selection.requested === 'string' ? value.selection.requested : ''
        const why = {
          missing: '那个目录已经不在了',
          prunable: '那个工作树已被删除（git 还记着它，可以跑 git worktree prune 清掉）',
          'not-root': '那个路径不是仓库根',
        }[value.selection.reason] ?? '那个路径不在可访问范围内'
        notices.push(h('div', { key: 'repo-fallback', className: 'zgg-notice' },
          `${why}，已改画 ${graphRepo.name}（${graphRepo.root}）${requested === '' ? '' : `；点名的是 ${requested}`}`))
      }
      if (value !== undefined && value.reposTruncated === true) {
        notices.push(h('div', { key: 'repos-truncated', className: 'zgg-notice' }, reposTruncatedCopy(value.reposTruncatedBy)))
      }
      // ── 会话 worktree 联动（2026-10-01）────────────────────────────────────
      // 跟着会话标签画了，就要**说一句**：否则页面自己换了仓库，用户只会觉得莫名其妙
      // （尤其是他上一次明明在下拉里选过别的）。这是"跟着谁"的可见性，不是装饰。
      // 反过来，**有标签但用不了更要说** —— 静默换一个仓库是这里最糟的失败模式。
      const tNotice = tagNotice(value === undefined ? undefined : value.selection)
      const tCopy = tagNoticeCopy(tNotice, graphRepo.name)
      if (tCopy !== '') {
        notices.push(h('div', { key: 'tag-' + tNotice.kind, className: 'zgg-notice' }, tCopy))
      }
      // 有工作树**没能列进来**时必须说：否则「我有 N 个工作树、页面上只有 M 个」
      // 就是一句没说出口的话（与改动区的 truncated 提示同一取向）。
      if (value !== undefined && value.worktrees !== undefined && value.worktrees !== null && value.worktrees.total > value.worktrees.listed) {
        const missing = []
        if (Array.isArray(value.worktrees.prunable) && value.worktrees.prunable.length > 0) missing.push(`${value.worktrees.prunable.length} 个目录已不在`)
        if (Array.isArray(value.worktrees.bare) && value.worktrees.bare.length > 0) missing.push(`${value.worktrees.bare.length} 个是裸仓库`)
        notices.push(h('div', { key: 'worktrees-missing', className: 'zgg-notice' },
          `这个仓库共 ${value.worktrees.total} 个工作树，列了 ${value.worktrees.listed} 个（${missing.join('，') || '其余不可用'}）`))
      }

      // 诊断句柄（控制台读得到，排查时不必靠截图）：读
      // __DSH_GIT_GRAPH__ 就能看到阶段、窗口区间、道数、泳道配色与错误，不必靠截图判断。
      try {
        globalThis.__DSH_GIT_GRAPH__ = {
          version: 3,
          phase: state.status,
          repo: value !== undefined ? value.repo : null,
          repos: repoList.map((repo) => ({ root: repo.root, current: repo.current, kind: repo.kind ?? 'repo', branch: repo.branch ?? null })),
          selection: value !== undefined ? value.selection : null,
          // 工作树：总数 / 进下拉的条数 / 没进来的原因。排查"下拉里少了那个工作树"先看这里。
          worktrees: value !== undefined && value.worktrees !== undefined ? value.worktrees : null,
          repoChoice: repoChoice ?? null,
          scanDepth,
          rows: rows.length,
          lanes: layout.laneCount,
          dangling: layout.dangling.length,
          window: [start, end],
          scrollTop,
          viewHeight,
          colors: [...new Set(graphPaths.map((path) => path.color))].sort((a, b) => a - b),
          width,
          truncated: value === undefined ? null : value.truncated,
          error: state.status === 'error' ? state.error : null,
          // 改动区：段行数、折叠状态、展开的是哪个文件。排查"列表不对"时先看这里，
          // 它给的是**宿主实际返回**的数字，而不是页面渲染出来的。
          changes: {
            phase: changesState.status,
            counts: changeSections === undefined
              ? null
              : {
                conflicts: changeSections.conflicts.length,
                unstaged: changeSections.unstaged.length,
                staged: changeSections.staged.length,
              },
            totals: changesValue === undefined ? null : changesValue.totals,
            countsAvailable: changesValue === undefined ? null : changesValue.countsAvailable,
            truncated: changesValue === undefined ? null : changesValue.truncated,
            folded: { ...folded },
            open: diffTarget === null ? null : { section: diffTarget.section, path: diffTarget.path, status: diffTarget.status },
            error: changesState.status === 'error' ? changesState.error : null,
          },
        }
      } catch (error) { /* 诊断失败绝不影响渲染 */ }

      return h('div', { className: 'zgg-root' }, head,
        changesPanel === null ? null : h('div', { className: 'zgg-changes' }, changesPanel),
        h('div', {
          className: 'zgg-body',
          ref: bodyRef,
          'data-window': `${start}-${end}`,
          'data-rows': rows.length,
          'data-lanes': layout.laneCount,
        },
          body,
          ...notices))
    }

    /**
     * 原生回退路径的适配层：槽位把 tab 信息作为 hook 注入（`tabInfo`），
     * 用它拿到 `tab.visible` 并把官方刷新命令接到同一个 load。
     * `tabInfo` 是否存在由注册时的 `inject` 决定，因此跨渲染稳定，不会破坏 hook 顺序。
     */
    function NativeBody(bodyProps) {
      let info
      if (typeof bodyProps.tabInfo === 'function') {
        try { info = bodyProps.tabInfo() } catch (error) { info = undefined }
      }
      const tab = info !== undefined && info !== null ? info.tab : undefined
      return h(GraphView, {
        ctx: bodyProps.ctx,
        sessionId: bodyProps.sessionId,
        visible: tab === undefined || tab.visible !== false,
        bindRefresh: tab === undefined || tab.actions === undefined
          ? undefined
          : (run) => tab.actions.bindCommands({ refresh: run }),
      })
    }

    // ───────────────────────────────────────────────────────────────────────
    // 图标（自绘 SVG；颜色走 currentColor，不引任何官方客户端包）
    // ───────────────────────────────────────────────────────────────────────
    function graphIcon(size) {
      const dimension = Number.isFinite(size) ? size : 16
      return h('svg', {
        width: dimension,
        height: dimension,
        viewBox: '0 0 16 16',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': 1.4,
        'stroke-linecap': 'round',
        'aria-hidden': 'true',
      },
      h('path', { key: 'trunk', d: 'M4 2.5 V13.5' }),
      h('path', { key: 'branch1', d: 'M4 6 C 4 8, 8 7, 8 9 V11' }),
      h('path', { key: 'branch2', d: 'M8 9 C 8 11, 12 10, 12 12 V13.5' }),
      h('circle', { key: 'n1', cx: 4, cy: 4.5, r: 1.6, fill: 'currentColor', stroke: 'none' }),
      h('circle', { key: 'n2', cx: 8, cy: 8, r: 1.6, fill: 'currentColor', stroke: 'none' }),
      h('circle', { key: 'n3', cx: 12, cy: 13, r: 1.6, fill: 'currentColor', stroke: 'none' }))
    }

    // ───────────────────────────────────────────────────────────────────────
    // 注册
    // ───────────────────────────────────────────────────────────────────────

    /** better-sidebar 的服务契约（本地最小重述；不 value-import 该包）。 */
    function betterSidebarTab(service) {
      return {
        id: TAB_ID,
        title: () => TITLE,
        description: () => DESCRIPTION,
        icon: (size) => graphIcon(size),
        order: 22,
        single: true,
        settings: {
          pluginToggles: [
            {
              key: 'maxCommits',
              title: '每次加载的提交数',
              desc: '越大越完整，首次读取也越慢（100–2000）。',
              type: 'number',
              min: 100,
              max: 2000,
              unit: '条',
            },
            {
              key: 'scanDepth',
              title: '仓库扫描层数',
              desc: '一个工作区里有多个仓库时，向下找几层来列出它们（0 = 只认工作目录所在的仓库）。',
              type: 'number',
              min: 0,
              max: 8,
              unit: '层',
            },
          ],
        },
        component: (tabProps) => h(GraphView, {
          ctx: tabProps.ctx,
          store: tabProps.store,
          sessionId: tabProps.scope !== undefined && tabProps.scope !== null ? tabProps.scope.sessionId : undefined,
          cwd: tabProps.scope !== undefined && tabProps.scope !== null ? tabProps.scope.cwd : undefined,
          visible: tabProps.visible,
        }),
      }
    }

    /**
     * 原生回退：用 DSH 自己的右侧栏 tab 类型注册同名页面。
     * @param ctx - 客户端上下文。
     * @returns 是否注册成功。
     */
    function registerNative(ctx) {
      const tabs = ctx.get('sidebarRightTabs')
      const slots = ctx.get('slots')
      if (tabs === undefined || tabs === null || typeof tabs.register !== 'function') return false
      if (slots === undefined || slots === null || typeof slots.inject !== 'function') return false
      try {
        ctx.effect(() => tabs.register({
          id: TAB_ID,
          kind: KIND,
          title: () => TITLE,
          guide: [{
            id: 'graph',
            order: 22,
            title: () => TITLE,
            description: () => DESCRIPTION,
            icon: (iconProps) => graphIcon(iconProps !== undefined && iconProps !== null ? iconProps.size : 16),
          }],
        }), 'dsh-sidebar-git-graph: tab type (native fallback)')
        ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
          name: 'sidebar.right.pane.tab',
          key: TAB_ID,
          inject: (sessionId) => ({ sessionId: typeof sessionId === 'string' ? sessionId : String(sessionId === undefined || sessionId === null ? '' : sessionId) }),
        }, (bodyProps) => h(NativeBody, { ...bodyProps, ctx }))), 'dsh-sidebar-git-graph: tab body (native fallback)')
        return true
      } catch (error) {
        log(ctx, 'warn', `dsh-sidebar-git-graph: native fallback registration failed: ${String(error)}`)
        return false
      }
    }

    /** 客户端上下文的 logger 不一定存在，日志失败绝不能影响注册。 */
    function log(ctx, level, message) {
      try {
        const logger = ctx !== null && ctx !== undefined ? ctx.logger : undefined
        if (logger !== null && logger !== undefined && typeof logger[level] === 'function') logger[level](message)
      } catch (error) { /* 忽略 */ }
    }

    /** 空 inject：两个服务都可能缺席，靠 ctx.get / ctx.inject 自己等（不阻塞本 fiber）。 */
    const inject = []

    function apply(ctx) {
      let claimed = false
      const claim = () => {
        if (claimed) return false
        claimed = true
        return true
      }

      // 回退观察窗：better-sidebar 若在场，它 provide 在 apply 开头，通常同一次 tick 就能看到；
      // 2s 内没等到就用原生注册（此后即使它再出现也不重复注册）。
      let attempts = 0
      const timer = setInterval(() => {
        attempts += 1
        if (claimed) { clearInterval(timer); return }
        if (ctx.get('betterSidebar') !== undefined) { clearInterval(timer); return }
        if (attempts >= 40) {
          clearInterval(timer)
          if (claim() && registerNative(ctx)) log(ctx, 'info', 'dsh-sidebar-git-graph: registered the native sidebar tab (dsh-better-sidebar absent)')
        }
      }, 50)
      ctx.effect(() => () => clearInterval(timer), 'dsh-sidebar-git-graph: fallback timer')

      ctx.inject(['betterSidebar'], (scoped) => {
        clearInterval(timer)
        if (!claim()) return
        const service = scoped.get('betterSidebar')
        if (service === undefined || service === null || typeof service.registerTab !== 'function') {
          if (registerNative(ctx)) log(ctx, 'info', 'dsh-sidebar-git-graph: registered the native sidebar tab (service shape unexpected)')
          return
        }
        scoped.effect(() => service.registerTab(betterSidebarTab(service)), 'dsh-sidebar-git-graph: better-sidebar tab')
        log(ctx, 'info', 'dsh-sidebar-git-graph: registered the sidebar tab through dsh-better-sidebar')
      })
    }

    return {
      name: 'dsh-sidebar-git-graph-client',
      inject,
      apply,
      // 供 Node 测试直接取用的纯度函数（不进渲染路径）。
      internals: {
        assignLanes,
        edgePath,
        rowGeometry,
        graphWidth,
        relativeTime,
        shortSha,
        errorText,
        readPluginSettings,
        repoSuffix,
        repoOptionLabel,
        repoPicker,
        readSavedRepo,
        saveRepo,
        reposTruncatedCopy,
        // 更改区
        splitPath,
        fileRowView,
        changeRow,
        changeSection,
        diffView,
        totalsText,
        looksLikeChanges,
        looksLikeDiff,
        STALE_HOST_COPY,
        // 会话 worktree 联动
        tagNotice,
        tagNoticeCopy,
        isNewHost,
        readFolded,
        saveFolded,
        requestHost,
        // 页面本身：只给渲染冒烟测试用——GraphView 里抛错会把整页（含提交图）变成空白，
        // 值得有一条测试真的把它渲染一次。
        GraphView,
        CSS,
        constants: { TAB_ID, KIND, TITLE, ROUTE, PALETTE, ROW_H, LANE_W, PAD_L, DEFAULT_SCAN_DEPTH, REPO_KEY_PREFIX, FOLDED_KEY },
      },
    }
  },
})
