# dsh-sidebar-git-graph

[![ci](https://github.com/AFunDog/dsh-sidebar-git-graph/actions/workflows/ci.yml/badge.svg)](https://github.com/AFunDog/dsh-sidebar-git-graph/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给 **DSH（DeepSeek Harness）** 加一个右侧栏页面：把当前会话的仓库画成**分支/合并关系图**
（VS Code 风格 —— 彩色泳道、分叉与汇入的贝塞尔曲线、ref 芯片、点开看提交详情）。

**只读**：不 checkout、不 commit、不 reset、不 rebase、不 fetch/push。只跑 `rev-parse`、
`status`、`for-each-ref`、`log` 四条命令。

![Git 图谱页面：彩色泳道、ref 芯片、提交行](docs/screenshot.png)

## 特性

- **一眼看清多分支关系**：并发的每条历史线占一条泳道，分叉/汇回处画曲线，合并提交的圆点更大，
  当前 HEAD 所在泳道更醒目。
- **每个提交带 ref 芯片**：本地分支 / 远程分支 / 标签，当前分支反色高亮。
- **头部信息**：仓库名、当前分支、`↑ahead ↓behind`、脏文件数。
- **提交信息搜索**：高亮命中并逐个跳转（**不过滤列表** —— 过滤会打断泳道连续性，那正是这个页面的意义）。
- **点行看详情**：完整 sha、作者与邮箱、绝对时间、父提交、参与的 refs。
- **虚拟列表**：窗口内最多 2000 条也只渲染可见行；页面不是当前标签页时**完全不发请求**。
- **错误态有话说**：不是 git 仓库 / PATH 里没有 git / 拿不到工作目录 / 被信任围栏拒绝 / git 失败，
  各有各的文案，不给你一片空白。
- **零依赖、零构建**：宿主半是纯 ESM，浏览器半是手写的单文件 client bundle。
  `lib/` 里读到的就是实际跑的代码，没有构建产物与源码的偏差。

## 安装

```sh
dsh plugin --profile web add github:AFunDog/dsh-sidebar-git-graph
```

装完**重启 `dsh web`**（宿主半要挂路由），再硬刷新浏览器。打开右侧栏选「Git 图谱」——
装了 dsh-better-sidebar 时它在 `+` 菜单里；裸 DSH 下就在侧栏的**引导页**上（该格已经放着引导页时
`+` 控件不会绘制）。
页面跟随你**正在看的会话**：切会话就重新读那个会话的工作区。

<details>
<summary>钉版本 / 从本地克隆安装</summary>

```sh
# 钉 tag（推荐：lockfile 会记下解析到的 commit）
dsh plugin --profile web add github:AFunDog/dsh-sidebar-git-graph#v0.1.0

# 从本地克隆（只接受**绝对**路径 —— 相对路径会被 spec 解析器拒绝）
dsh plugin --profile web add /path/to/dsh-sidebar-git-graph
```
</details>

### 装没装 dsh-better-sidebar 都能用

页面会自动二选一：

| 你的环境 | 行为 |
|---|---|
| 装了 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) | 走它的公开扩展点 `ctx.betterSidebar.registerTab`：出现在 `+` 菜单，并在**设置 → 侧边卡片**里得到一张卡片（开关 + 一个"每次加载条数"的插件设置），名字是「Git 图谱」。 |
| 裸 DSH | 走 DSH 原生的侧栏 tab 类型（`ctx.sidebarRightTabs` + `sidebar.right.pane.tab` 槽）：同一列、同一个 `+` 菜单，只是没有那张设置卡片。 |

服务契约在本地**最小重述**（只用到 `registerTab` / `openTab`），且用 `ctx.inject` 等它出现、
**不写静态 `inject`** —— 静态声明一个可能缺席的服务会让本插件的 fiber 挂起，表现就是
"热重载正常、重启后页面消失"。

## 实现

```
lib/index.js      宿主半  —— POST /dsh-sidebar-git-graph/api、git 执行、信任围栏
lib/git-read.js   宿主半  —— 纯函数：argv 构造 + 解析（可脱离 DSH 直接 import 测试）
lib/workspace.js  宿主半  —— sessionId → 工作目录、工作区白名单、围栏
lib/client.js     浏览器半 —— tab 注册、泳道布局、SVG 渲染（单文件）
test/             三个零依赖测试（node test/<file>.cjs）
```

1. 浏览器半拿到会话的工作目录，向宿主要一份快照。
2. 宿主按可信度解析工作区（会话服务 → 持久化工作区表 → 工作区注册表 → 最近写入的会话目录），
   拒绝既不在已注册工作区内、又不是该会话自身 cwd 的路径；清环境、10s 超时、48 MiB 输出上限地
   跑四条只读命令，返回 `{ repo, refs, commits[{ sha, parents, author, email, time, subject, refs }] }`。
3. 浏览器半用**单趟**扫描把 `--topo-order` 的提交分到泳道，再在虚拟列表下画 SVG 曲线。

布局函数与几何构造是纯函数，挂在插件返回值的 `internals` 上，测试用 `vm` 加载 bundle 直接驱动，
不需要浏览器。

### 泳道算法（不变量）

维护"活跃道"数组 `active[lane] = 该道正在等待的 commit sha`：

1. 提交落在最早等它的那道；没有道在等它 → 新开一条（分支尖端 / 根提交）；
2. 其余等它的道在本行**汇入**并释放（画 merge 曲线）；
3. `parents[0]` 接管本道；额外的父提交若已有道在等就画 branch 曲线指过去，否则在其右侧新开一条；
4. 跑完后仍活跃的道 = **父提交在窗口外**（截断 / 浅克隆）→ 画半截线并在头部提示"历史被截断"。

测试覆盖：线性、菱形（分叉 + 合并）、未合并分支、octopus merge（3 父）、窗口截断、
乱序/缺字段/重复 sha、颜色索引始终落在配色环内。

## 设置

| 设置 | 位置 | 默认 | 含义 |
|---|---|---|---|
| 每次加载的提交数 | 设置 → 侧边卡片 → Git 图谱 → 功能设置（仅 dsh-better-sidebar） | `400` | 100–2000。越大越完整，首次读取越慢。 |
| 历史范围 | 页面头部 | 全部分支 | 全部分支 / 仅当前分支。 |
| 提交搜索 | 页面头部 | — | 高亮命中并逐个跳转。 |

## 已知限制

- **只读是设计**：不提供切分支/提交/push。要写就用别的工具。
- **窗口有上限**（单次最多 2000 条，默认 400）；更老的历史会明确提示"被截断"，而不是静默丢弃。
- **搜索不过滤图**（理由见特性一节）。
- **泳道配色**由 DSH 主题令牌 + `color-mix()` 派生；不支持 `color-mix()` 的浏览器退化为四个主题状态色循环。
- **读持久化实现细节只是兜底**：`storages/workspace.json` 与 `sessions/` 是会话/工作区服务都拿不到时的
  最后一条路，DSH 改了这套布局只会让你退回"没有候选"分支，不会让插件失效。
- 在 DSH `0.1.7-rc.2` + `dsh-better-sidebar` 0.21.1 上真机验证过；原生回退路径有同一套测试覆盖，
  但真机使用得少一些。
- npm 上的 `dsh-git-graph` 是**另一个作者的另一个插件**
  （[enoughpower/dsh-git-graph](https://www.npmjs.com/package/dsh-git-graph)）。
  本插件是 `@zeng/dsh-sidebar-git-graph`，目前只从 GitHub 分发。

## 开发

没有构建步骤：改 `lib/` → 宿主半改动重启 `dsh web`，浏览器半改动硬刷新即可
（bundle 的 `rev` 从文件 mtime 重新推导，刷新就会拿到新内容）。

```sh
node --check lib/index.js && node --check lib/client.js
node test/git-read.test.cjs     # 解析器
node test/lane-layout.test.cjs  # 泳道布局（vm 加载 bundle）
node test/route.test.cjs        # 端到端：在系统临时目录里造一个真仓库
```

route 测试需要 `PATH` 里有 `git`。

### 踩坑记录（写给后来者）

1. **`for-each-ref --format` 只认 `%00`，不认 `%x00`**：`%x00` 是 `--pretty=format` 的写法。
   写成 `%x00` 不报错，而是把 `%x00` 这四个字符原样输出 → 每行只有一个字段 → refs 被静默丢光
   （现象：图里没有任何分支芯片，但 log 正常）。
2. **`--no-optional-locks` 是顶层选项**，必须排在子命令之前。
3. **附注标签要 `%(*objectname)`**：`%(objectname)` 给的是 tag 对象而不是提交，标签会挂不上提交。
4. **`refs/remotes/*/HEAD` 要剔除**，它是符号引用，画上去是噪音。
5. **`node:vm` 里跑 bundle 时 `deepStrictEqual` 会假失败**：跨 realm 的数组/对象原型不同，
   比较前过一遍 `JSON.parse(JSON.stringify(...))` 搬回本 realm。
6. **验证时页面在后台标签会让"看起来是 bug"**：Chrome 会节流整轮渲染，`scroll` 事件、
   `requestAnimationFrame`、连截图都不发生 —— 虚拟列表"不跟随滚动"就是这样被骗了一次。
   先看 `document.visibilityState`。

## 许可

MIT，见 [LICENSE](LICENSE)。

[English](README.md)
