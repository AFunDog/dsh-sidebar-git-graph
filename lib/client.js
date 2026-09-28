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
    const CSS = `
.zgg-root {
  --zgg-lane-0: var(--dsw-alias-brand-primary, currentColor);  --zgg-lane-1: var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary, currentColor));
  --zgg-lane-2: var(--dsw-alias-state-warning-primary, var(--dsw-alias-brand-primary, currentColor));
  --zgg-lane-3: var(--dsw-alias-state-danger-primary, var(--dsw-alias-brand-primary, currentColor));
  --zgg-lane-4: var(--dsw-alias-brand-primary, currentColor);
  --zgg-lane-5: var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary, currentColor));
  --zgg-lane-6: var(--dsw-alias-state-warning-primary, var(--dsw-alias-brand-primary, currentColor));
  --zgg-lane-7: var(--dsw-alias-state-danger-primary, var(--dsw-alias-brand-primary, currentColor));
  --zgg-lane-8: var(--dsw-alias-brand-primary, currentColor);
  --zgg-lane-9: var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary, currentColor));
  --zgg-lane-4: color-mix(in oklab, var(--dsw-alias-brand-primary) 65%, var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary)) 35%);
  --zgg-lane-5: color-mix(in oklab, var(--dsw-alias-brand-primary) 35%, var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary)) 65%);
  --zgg-lane-6: color-mix(in oklab, var(--dsw-alias-state-warning-primary, var(--dsw-alias-brand-primary)) 65%, var(--dsw-alias-brand-primary) 35%);
  --zgg-lane-7: color-mix(in oklab, var(--dsw-alias-state-danger-primary, var(--dsw-alias-brand-primary)) 70%, var(--dsw-alias-brand-primary) 30%);
  --zgg-lane-8: color-mix(in oklab, var(--dsw-alias-brand-primary) 50%, var(--dsw-alias-state-danger-primary, var(--dsw-alias-brand-primary)) 50%);
  --zgg-lane-9: color-mix(in oklab, var(--dsw-alias-state-success-primary, var(--dsw-alias-brand-primary)) 50%, var(--dsw-alias-state-warning-primary, var(--dsw-alias-brand-primary)) 50%);
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
.zgg-chip[data-kind="tag"] { color: var(--dsw-alias-state-warning-primary, var(--dsw-alias-label-primary, inherit)); }
.zgg-chip[data-current="true"] { background: var(--dsw-alias-brand-primary, transparent); color: var(--dsw-alias-label-inverse, inherit); border-color: transparent; }
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
.zgg-detail code { font-family: var(--dsw-font-mono, monospace); }
.zgg-empty { padding: 12px 8px; color: var(--dsw-alias-label-secondary, inherit); }
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
    // 数据
    // ───────────────────────────────────────────────────────────────────────

    /**
     * 问宿主要一份图谱快照。
     * @param payload - `{ sessionId, cwd, max, skip, scope }`。
     * @returns `{ ok:true, value }` 或 `{ ok:false, error }`。
     */
    async function requestGraph(payload) {
      try {
        const rpcId = `dsh-sidebar-git-graph-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
        const response = await fetch(ROUTE, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'client-request', rpcId, method: 'graph', payload }),
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

      const [state, setState] = useState({ status: 'loading' })
      const [scope, setScope] = useState('all')
      const [query, setQuery] = useState('')
      const [matchAt, setMatchAt] = useState(0)
      const [selected, setSelected] = useState(null)
      const [scrollTop, setScrollTop] = useState(0)
      const [viewHeight, setViewHeight] = useState(360)
      const bodyRef = useRef(null)
      const requestSeq = useRef(0)
      const loadRef = useRef(null)

      const load = useCallback(async () => {
        const seq = requestSeq.current + 1
        requestSeq.current = seq
        setState((previous) => (previous.status === 'ready' ? { ...previous, refreshing: true } : { status: 'loading' }))
        const outcome = await requestGraph({ sessionId, cwd, max: maxCommits, skip: 0, scope })
        if (requestSeq.current !== seq) return
        if (outcome.ok) setState({ status: 'ready', value: outcome.value, refreshing: false })
        else setState({ status: 'error', error: outcome.error })
      }, [sessionId, cwd, maxCommits, scope])
      loadRef.current = load

      // 首次可见时加载；每次可见性恢复或作用域变化都重取（不可见时完全不请求）。
      useEffect(() => {
        if (!visible) return undefined
        load()
        return undefined
      }, [visible, load])

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

      const head = h('div', { className: 'zgg-head' },
        h('span', { className: 'zgg-repo' }, value !== undefined ? value.repo.name : 'Git 图谱'),
        value !== undefined
          ? h('span', { className: 'zgg-branch', title: value.repo.upstream !== null ? `上游 ${value.repo.upstream}` : '没有上游' },
            value.repo.detached ? `分离头 ${shortSha(value.commits.find((commit) => commit.head === true)?.sha ?? '')}` : (value.repo.branch ?? '(未知分支)'))
          : null,
        value !== undefined
          ? h('span', { className: 'zgg-counts' }, `↑${value.repo.ahead} ↓${value.repo.behind}`, value.repo.dirty > 0 ? ` · ${value.repo.dirty} 个改动` : '')
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
            isCurrent: ref.kind === 'branch' && value !== undefined && value.repo.branch === ref.name,
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

      const notices = []
      if (value !== undefined && value.truncated === true) {
        notices.push(h('div', { key: 'truncated', className: 'zgg-notice' },
          `只画了最近 ${rows.length} 条提交（更老的历史被截断）`))
      }
      if (value !== undefined && value.repo.initial === true) {
        notices.push(h('div', { key: 'initial', className: 'zgg-notice' }, '这是空仓库：还没有任何提交。'))
      }

      // 诊断句柄（控制台读得到，排查时不必靠截图）：读
      // __DSH_GIT_GRAPH__ 就能看到阶段、窗口区间、道数、泳道配色与错误，不必靠截图判断。
      try {
        globalThis.__DSH_GIT_GRAPH__ = {
          version: 1,
          phase: state.status,
          repo: value !== undefined ? value.repo : null,
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
        }
      } catch (error) { /* 诊断失败绝不影响渲染 */ }

      return h('div', { className: 'zgg-root' }, head,
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
        CSS,
        constants: { TAB_ID, KIND, TITLE, ROUTE, PALETTE, ROW_H, LANE_W, PAD_L },
      },
    }
  },
})
