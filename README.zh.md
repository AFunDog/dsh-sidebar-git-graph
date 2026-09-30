# dsh-sidebar-git-graph

[![ci](https://github.com/AFunDog/dsh-sidebar-git-graph/actions/workflows/ci.yml/badge.svg)](https://github.com/AFunDog/dsh-sidebar-git-graph/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

给 **DSH（DeepSeek Harness）** 加一个右侧栏页面：把当前会话的仓库画成**分支/合并关系图**
（VS Code 风格 —— 彩色泳道、分叉与汇入的贝塞尔曲线、ref 芯片、点开看提交详情），
并在它上方给出**工作树改动区**。

**只读**：不 checkout、不 commit、不 reset、不 rebase、不 fetch/push、不 add、不 restore、
不 `worktree add/remove/prune`。
只跑 `rev-parse`、`status`、`for-each-ref`、`log`、`diff`、`worktree list` 六条命令。

![Git 图谱页面：彩色泳道、ref 芯片、提交行](docs/screenshot.png)

> 上面这张截图拍于「更改」区之前，只显示提交图。

## 特性

- **工作树改动，VS Code 式两段**：图上方的**更改**与**暂存的更改**（合并中还会多出**合并更改**），
  每行带状态字母（`M`/`A`/`D`/`R`/`C`/`U`）与增删行数；点一行就地展开它的 diff，两段可折叠且记得住。
- **一眼看清多分支关系**：并发的每条历史线占一条泳道，分叉/汇回处画曲线，合并提交的圆点更大，
  当前 HEAD 所在泳道更醒目。
- **每个提交带 ref 芯片**：本地分支 / 远程分支 / 标签；当前分支用主题的品牌色填充，文字用主题里
  与它配对的那支前景色。
- **一个工作区，多个仓库**：工作区里同时躺着好几个仓库是常态（本插件自己的 checkout 就在
  `vendor/@zeng/` 下挂着一个嵌套仓库）。这时头部会长出一个下拉框，列出找到的每个仓库，
  选择按工作区记忆。工作区自己只是某个仓库的子目录也没问题——外层那个仓库同样会被列出来。
  发现过程**不会跑出工作区**：只向下扫，且层数、目录数、仓库数、耗时四个闸门都封着。
- **同一个仓库的每个工作树**：一个仓库可以有多个工作树（`git worktree add`），各有各的分支、
  各有各的未提交改动，而关联工作树通常**根本不在工作区目录里**（这个功能就是为一对**兄弟目录**
  的工作树做的）。下拉框把它们全列出来，**每一项标着它自己的分支**，可以自由切换，切换后看到的
  就是这个工作树自己的图谱与改动。主工作树、分离头、被 lock 的工作树都有标记；目录已经不在的
  工作树不列出、但会在提示里给出条数，不会悄悄少一个。清单来自 `git worktree list`，
  所以从**任意一个**工作树出发都能看到全集——站在关联工作树里，主工作树同样可选。
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
dsh plugin --profile web add github:AFunDog/dsh-sidebar-git-graph#v0.2.0

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
lib/changes.js    宿主半  —— 纯函数：工作树改动的 argv 构造 + 解析
lib/worktrees.js  宿主半  —— 纯函数：`git worktree list` 的 argv 构造 + 解析
lib/repos.js      宿主半  —— 「这个工作区里有几个仓库」的发现器
lib/workspace.js  宿主半  —— sessionId → 工作目录、工作区白名单、围栏
lib/client.js     浏览器半 —— tab 注册、泳道布局、SVG 渲染（单文件）
test/             零依赖测试（node scripts/test.mjs 一把跑完）
```

路由按请求信封里的 `method` 分派：`graph`（提交 DAG）、`changes`（工作树状态）、`diff`（单文件 patch）。

1. 浏览器半拿到会话的工作目录，向宿主要一份快照。
2. 宿主按可信度解析工作区（会话服务 → 持久化工作区表 → 工作区注册表 → 最近写入的会话目录），
   拒绝既不在已注册工作区内、又不是该会话自身 cwd 的路径；然后挑要画的仓库：浏览器点名的那个
   （得先过围栏，再用 `rev-parse` 确认它真的是仓库根）→ 否则工作目录所在的那个 → 否则扫到的第一个；
   清环境、10s 超时、48 MiB 输出上限地跑五条只读命令（含 `worktree list`），返回
   `{ repo, repos[], selection, worktrees, refs, commits[{ sha, parents, author, email, time, subject, refs }] }`。
   仓库清单是**两级来源**：`git worktree list`（同一个仓库的各个工作树，各带自己的分支）＋
   扫盘（工作区里的独立仓库），逐项标 `kind` 区分。
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
| 仓库扫描层数 | 同上 | `5` | 0–8。往工作区里找几个仓库供下拉选择；`0` = 不扫，只认工作目录所在的仓库。工作区特别大导致清单扫不全时，把它调小。 |
| 历史范围 | 页面头部 | 全部分支 | 全部分支 / 仅当前分支。 |
| 提交搜索 | 页面头部 | — | 高亮命中并逐个跳转。 |

## 已知限制

- **只读是设计**：不暂存、不提交、不切分支、不 push。要改工作树就用别的工具。
- **未跟踪文件没有 +/− 计数**：`git diff --no-index` 只比较两个路径，要行数就得**每个文件起一个进程**
  （一个还没 `add` 过的仓库里可能是几百次）。所以段头只统计拿得到计数的行，拿不到的**留空**，
  而不是印一个会被读成「没有改动」的 `0`。一个文件两侧都改过（`MM`）会**同时出现在两段**——
  那正是这两段的含义。
- **内嵌的独立仓库是一行不可点的目录**：git 不会下钻进「仓库里的仓库」（`-uall` 也不下钻），
  所以外层仓库只看得见一个目录，它没有 diff 可显示。页面在那一行上说明原因，而不是点了没反应。
- **上限**：一次最多 3000 行改动、单个文件最多 512 KiB patch；两者都会在页面上如实说明，
  而不是悄悄截掉。
- **窗口有上限**（单次最多 2000 条，默认 400）；更老的历史会明确提示"被截断"，而不是静默丢弃。
- **仓库发现是有上限的扫盘**：层数、目录数、仓库数、耗时四道闸门，踩到任何一条都会在页面上
  如实说明（而不是假装清单就是全的）；解决办法是把扫描层数调小。显然不会住着"想单独画的仓库"
  的目录（`node_modules`、`target`、`.venv`、构建产物…）不向下递归——但每个仍会 stat 一次，
  所以一个恰好叫 `build` 的仓库不会被漏掉。
- **下拉里只会出现从工作区够得到的仓库**：工作区自身、它里面的、把它包住的那个，以及
  **工作区所属仓库的工作树**（以 `git worktree list` 为准）。别的路径即使浏览器点名，宿主也会
  拒绝；并且会用 `rev-parse` 复核它确实是仓库根。
- **每个工作树各读各的**：`git status` 与 `git log` 都是按工作树算的，所以每个工作树显示自己的
  分支、自己的未提交改动、自己的 `HEAD`；页面从不把两个工作树合成一份。
  目录已不在的（`prunable`）与裸仓库不列出，只在提示里给出条数。
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
npm test        # = node scripts/test.mjs：先 node --check 每个 lib 文件，再逐个跑测试
```

route 测试需要 `PATH` 里有 `git`。`scripts/test.mjs` 自己发现 `test/*.test.cjs`——在 workflow 里
手写测试清单已经坑过一次：新加的三个测试文件曾经一个都没在 CI 里跑。

<details>
<summary>拿真机主题核对颜色令牌</summary>

颜色令牌是唯一一处**写错不报错**的地方：`var(--写错了, fallback)` 会静默走 fallback，于是
"名字写错"表现为"颜色看着不对"。本插件就真的发过这个 bug——当前分支徽标用的是
`--dsw-alias-label-inverse`，这个名字不存在，于是文字继承主题正文色，而底色是
`--dsw-alias-brand-primary`；浅色主题下这两者解析到**同一个值**，对比度 1.00:1
（深色主题下就是白底白字）。正确的名字是 `--dsw-alias-label-primary-foreground`
（DSH 自己给 `button-primary-fill` = `brand-primary` 配的那支），修好后是 18.9:1 与 18.1:1。

`test/style-tokens.test.cjs` 内置了一份 `--dsw-alias-*` 全量令牌快照，CSS 里用了快照之外的名字
就失败。要让快照跟真实主题重新对一遍：

```sh
ZGG_THEME_FILE=<dsh>/node_modules/@deepseek-ai/dsh-client-ui-theme/lib/client.js \
  node test/style-tokens.test.cjs
```
</details>

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
7. **颜色令牌写错名字不会报错**：`var(--写错了, fallback)` 静默走 fallback。当前分支徽标曾经用
   `--dsw-alias-label-inverse`（不存在）→ 文字继承正文色 → 浅色主题下与底色 `brand-primary`
   同为 `#0f1115`、深色主题下同为 `#f9fafb`，**两个主题都是 1.00:1**，深色下就是白底白字。
   别靠眼睛，`test/style-tokens.test.cjs` 拿真实令牌表逐个核对。
8. **git 没有"列出嵌套仓库"的命令**：嵌套的独立仓库在父仓库眼里只是几个被忽略的目录，
   `git submodule` 看不见它们，只能扫盘。扫盘就得有闸门（层数/目录数/仓库数/耗时），
   而且**并发批次里也要查上限**——只在循环顶端查会冲过头（实测 130 个仓库一趟冲到 128 条）。
9. **CI 里手写测试文件清单会过期**：新加了测试但忘了写进 workflow，CI 照样全绿。
   改成 `scripts/test.mjs` 自动发现`test/*.test.cjs`。
10. **`String.split(sep, limit)` 的 limit 是「丢弃剩余」而不是「并进最后一项」**：
    `'a file with spaces.txt'.split(' ', 11)[10]` 得到的是 `'a'`。porcelain v2 每条记录的
    路径都在最后且**可以含空格**，用固定下标取值会把这种路径悄悄截断。改用「切前 N 段、
    剩余全部 join 回来」的写法。这条是先写错、被测试逼出来的。
11. **`u`（未合并/冲突）记录与 `1`/`2` 形状都不同**：它是 **11 字段**
    （`u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`）。照 `1` 的 9 字段去解析会
    整条丢掉冲突文件——**静默的数据丢失**，而且只在真冲突时出现。别照文档猜，造一次真冲突
    dump 出来再写。
12. **`git diff --no-index` 的退出码 1 表示「有差异」而不是失败**，而且有差异时 stderr 是空的。
    不特判的表现是「未跟踪文件永远打不开 diff」，且**没有任何错误信息**可查。
13. **重命名一定要把新旧两个路径都传给 `git diff`**：只给新路径时 `-M` 认不出重命名，
    输出退化成「new file mode + 整文件新增」（实测：`snapshot` 的新增行数从 1 条变成 41 条）。
14. **别用 PowerShell 管道看 `-z` 输出**：PowerShell 按换行切分并字符串化，而 `-z` 输出里
    没有换行，整块会变成一个元素，再看 NUL 边界极易误读（本轮第一次就误读了一条 rename 记录）。
    逐字节的事用 Node 的 `encoding:'buffer'` 拿 Buffer 自己按 NUL 切。
15. **`--literal-pathspecs` 是必须的**：没有它，浏览器传来的 `path` 会走 pathspec 语法，
    `:(top)*` 这类值能把「读一个文件」放大成「读整个仓库」。
16. **未合并（冲突）路径上 `git diff` 给的是 combined diff**：hunk 头是 `@@@`（三个 @）、
    正文行是**两字符**前缀（`++` / ` +` / `+ `）。统一 diff 的解析器读不懂它，会**静默返回
    空数组**——一个不报错的空答案（冲突文件的 diff 一片空白）。修法是冲突文件改走
    `git diff HEAD`（HEAD → 工作树，普通 unified 格式，正好把带冲突标记的磁盘内容如实展示），
    并且解析器**认出来就自报 `combined`**，不再假装"没有改动"。
17. **冲突文件与未跟踪文件的状态字母都是 `U`**：前端**不能**靠字母判断该不该走 `--no-index`。
    猜错就是把整个文件当成新增——同样是不报错的错答案。宿主必须显式给出
    `untracked` 标记（`changes.js` 的两个分支各自写着 `untracked: true/false`）。
18. **`method` 不是旧契约的一部分**：0.3.0 之前宿主忽略它，一律回提交图数据。而浏览器半
    **每次刷新都会重新加载**（rev 取自文件 mtime）、宿主半却要重启才换——所以「宿主是旧的」
    是一个**常态**，不是异常。必须校验响应形状，否则会把一个从没提过改动的载荷渲染成
    「没有未提交的改动」：一句斩钉截铁的假话。
19. **别用「屏蔽系统配置」来净化 git 环境**：`GIT_CONFIG_NOSYSTEM=1` 会把系统配置一起丢掉，
    而 Git for Windows 正是在**系统**配置里写着 `core.autocrlf=true`。于是「索引存 LF、
    工作区是 CRLF」的仓库**每一行都算改动**——实测 `+1 −0` 变成 `+88 −87`，
    加了一行的文件被画成整体重写；旁边四个文件因为索引里本来就是 CRLF 恰好正常，
    「大部分行都对」极易让人放过。把 `GIT_CONFIG_SYSTEM` 设成**空串**是同样的效果（实测），
    所以「改成重定向」也不安全。正确做法是**两个都不设**，让 git 自己找系统配置；
    要防凭据泄漏就白名单化**环境变量**（本来就在做）。核对办法：把计数与
    `git diff --numstat` 逐行比。
20. **关联工作树对任何文件系统扫盘都是隐形的**。`git worktree add` 把工作树放在你指定的任何
    位置——常见的就是主工作树的**兄弟目录**，两者之间唯一的联系是那边一行 `.git` **文件**
    （`gitdir: …/.git/worktrees/<name>`）。按目录往下扫既找不到它、也得不到任何"它存在"的线索；
    而在它里面跑 `rev-parse --show-toplevel` 得到的是**它自己**，所以"在不在工作区里 / 包不包住
    工作区"两个方向都是 false。要问 `git worktree list`——而且必须问**宿主自己选定**的那个仓库，
    **绝不能问正在被校验的那个路径**：`worktree list` 至少会列出被问的那个仓库自己，
    拿申请者去问等于让它自己给自己签通行证，围栏会当场失效（第一版就是这么写的，
    `test/route.test.cjs` 的「工作区之外的仓库必须被拒」当场变红）。
21. **`worktree list --porcelain -z` 用两个 NUL 分隔记录、单个 NUL 分隔字段**。路径是绝对路径、
    正斜杠，且 `-z` 下**不加引号**（含空格的路径原样输出），所以拿到的路径仍必须规范化后再比较。
    可选行有 `detached`（此时**没有** `branch` 行）、`locked`、`prunable <原因>`、`bare`；
    后两者可能**带原因**，判据要按词匹配而不是整行相等。`locked` 只表示"不能 remove"——
    内容完全可读，必须照常列出；`prunable` 表示目录已经不在，必须剔除。

## 许可

MIT，见 [LICENSE](LICENSE)。

[English](README.md)
