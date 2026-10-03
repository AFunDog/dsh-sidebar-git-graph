# AGENTS.md — dsh-sidebar-git-graph

面向智能体与贡献者的工程文档：架构地图、泳道算法不变量、主题令牌核对流程，以及全部踩坑记录。
产品说明（特性 / 安装 / 设置 / 限制）见 [README.md](README.md)（中文，默认）或
[README.en.md](README.en.md)（English）。

- 语言：中文为主（与仓库其他文档一致）；代码与命令保持原文。
- 修改本文件时同步核对引用的测试文件名与命令仍然存在。

## 文件地图

```
lib/index.js      host half  — POST /dsh-sidebar-git-graph/api, git execution, trust fence
lib/git-read.js   host half  — pure: argv builders + parsers (importable by plain node)
lib/changes.js    host half  — pure: working-tree argv builders + parsers
lib/worktrees.js  host half  — pure: `git worktree list` argv builder + parser
lib/repos.js      host half  — "how many repositories are in this workspace" discovery
lib/workspace.js  host half  — sessionId → working directory, workspace allow-list, fence
lib/client.js     browser half — tab registration, lane layout, SVG rendering (single file)
test/             zero-dependency tests (node scripts/test.mjs runs them all)
```

The route dispatches on the request envelope's `method`: `graph` (commit DAG), `changes`
(working-tree status) and `diff` (one file's patch).

1. The browser half reads the session's working directory and asks the host for a snapshot.
2. The host resolves which workspace belongs to that session (session service → persisted
   workspace table → workspace registry → newest session directory), refuses paths that are
   neither registered nor the session's own cwd, then picks the repository to draw: the one the
   browser named (if it passes the fence and `rev-parse` agrees it is a repository root), else the
   one containing the workspace, else the first one it finds inside the workspace. It runs the
   five read-only commands (including `worktree list`, which supplies the working trees of that
   repository) with a sanitized environment, a 10 s timeout and a 48 MiB output cap, and answers
   with
   `{ repo, repos[], selection, worktrees, refs, commits[{ sha, parents, author, email, time, subject, refs }] }`.
   The repository list has **two sources**: `git worktree list` (the working trees of the one
   repository, each with its own branch) and the directory scan (independent repositories inside
   the workspace), tagged per entry with `kind`.
3. The browser half lays the commits out into lanes with one pass over `--topo-order` history
   and renders SVG bezier connectors under a virtualized row list.

The layout function and the geometry builder are pure and exposed on the plugin's `internals`
so the test suite can drive them without a browser.

### Better-sidebar seam

The service contract is re-stated locally (only `registerTab` / `openTab` are used) and is
activated with `ctx.inject`, never a static `inject`: a statically declared service that is
absent would park this plugin's fiber, which shows up as "works after a hot reload, gone after
a restart".

### 泳道算法（不变量）

维护"活跃道"数组 `active[lane] = 该道正在等待的 commit sha`：

1. 提交落在最早等它的那道；没有道在等它 → 新开一条（分支尖端 / 根提交）；
2. 其余等它的道在本行**汇入**并释放（画 merge 曲线）；
3. `parents[0]` 接管本道；额外的父提交若已有道在等就画 branch 曲线指过去，否则在其右侧新开一条；
4. 跑完后仍活跃的道 = **父提交在窗口外**（截断 / 浅克隆）→ 画半截线并在头部提示"历史被截断"。

测试覆盖：线性、菱形（分叉 + 合并）、未合并分支、octopus merge（3 父）、窗口截断、
乱序/缺字段/重复 sha、颜色索引始终落在配色环内。

## 主题令牌核对

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

## 开发约定

- **route 测试需要 `PATH` 里有 `git`。**
- `scripts/test.mjs` 自动发现 `test/*.test.cjs`——在 workflow 里手写测试清单已经坑过一次：
  新加的三个测试文件一个都没在 CI 里跑。别再手写清单。
- **`node:vm` 里跑 bundle 时 `deepStrictEqual` 会假失败**：跨 realm 的数组/对象原型不同，
  比较前过一遍 `JSON.parse(JSON.stringify(...))` 搬回本 realm。
- **验证时页面在后台标签会让"看起来是 bug"**：Chrome 会节流整轮渲染，`scroll` 事件、
  `requestAnimationFrame`、连截图都不发生——虚拟列表"不跟随滚动"就是这样被骗了一次。
  先看 `document.visibilityState`。
- **git 没有"列出嵌套仓库"的命令**：嵌套的独立仓库在父仓库眼里只是几个被忽略的目录，
  `git submodule` 看不见它们，只能扫盘。扫盘就得有闸门（层数/目录数/仓库数/耗时），
  而且**并发批次里也要查上限**——只在循环顶端查会冲过头（实测 130 个仓库一趟冲到 128 条）。
- **CI 里手写测试文件清单会过期**（同上，自动发现是唯一正解）。

## 踩坑记录（写给后来者，按受咬顺序）

### git 输出解析

1. **`for-each-ref --format` 只认 `%00`，不认 `%x00`**：`%x00` 是 `--pretty=format` 的写法。
   写成 `%x00` 不报错，而是把 `%x00` 这四个字符原样输出 → 每行只有一个字段 → refs 被静默丢光
   （现象：图里没有任何分支芯片，但 log 正常）。
2. **`--no-optional-locks` 是顶层选项**，必须排在子命令之前。
3. **附注标签要 `%(*objectname)`**：`%(objectname)` 给的是 tag 对象而不是提交，标签会挂不上提交。
4. **`refs/remotes/*/HEAD` 要剔除**，它是符号引用，画上去是噪音。
5. **`String.split(sep, limit)` 的 limit 是「丢弃剩余」而不是「并进最后一项」**：
   `'a file with spaces.txt'.split(' ', 11)[10]` 得到的是 `'a'`。porcelain v2 每条记录的
   路径都在最后且**可以含空格**，用固定下标取值会把这种路径悄悄截断。改用「切前 N 段、
   剩余全部 join 回来」的写法。这条是先写错、被测试逼出来的。
6. **`u`（未合并/冲突）记录与 `1`/`2` 形状都不同**：它是 **11 字段**
   （`u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`）。照 `1` 的 9 字段去解析会
   整条丢掉冲突文件——**静默的数据丢失**，而且只在真冲突时出现。别照文档猜，造一次真冲突
   dump 出来再写。
7. **`git diff --no-index` 的退出码 1 表示「有差异」而不是失败**，而且有差异时 stderr 是空的。
   不特判的表现是「未跟踪文件永远打不开 diff」，且**没有任何错误信息**可查。
8. **重命名一定要把新旧两个路径都传给 `git diff`**：只给新路径时 `-M` 认不出重命名，
   输出退化成「new file mode + 整文件新增」（实测：`snapshot` 的新增行数从 1 条变成 41 条）。
9. **别用 PowerShell 管道看 `-z` 输出**：PowerShell 按换行切分并字符串化，而 `-z` 输出里
   没有换行，整块会变成一个元素，再看 NUL 边界极易误读（本轮第一次就误读了一条 rename 记录）。
   逐字节的事用 Node 的 `encoding:'buffer'` 拿 Buffer 自己按 NUL 切。
10. **`--literal-pathspecs` 是必须的**：没有它，浏览器传来的 `path` 会走 pathspec 语法，
    `:(top)*` 这类值能把「读一个文件」放大成「读整个仓库」。
11. **未合并（冲突）路径上 `git diff` 给的是 combined diff**：hunk 头是 `@@@`（三个 @）、
    正文行是**两字符**前缀（`++` / ` +` / `+ `）。统一 diff 的解析器读不懂它，会**静默返回
    空数组**——一个不报错的空答案（冲突文件的 diff 一片空白）。修法是冲突文件改走
    `git diff HEAD`（HEAD → 工作树，普通 unified 格式，正好把带冲突标记的磁盘内容如实展示），
    并且解析器**认出来就自报 `combined`**，不再假装"没有改动"。
12. **冲突文件与未跟踪文件的状态字母都是 `U`**：前端**不能**靠字母判断该不该走 `--no-index`。
    猜错就是把整个文件当成新增——同样是不报错的错答案。宿主必须显式给出
    `untracked` 标记（`changes.js` 的两个分支各自写着 `untracked: true/false`）。
13. **别用「屏蔽系统配置」来净化 git 环境**：`GIT_CONFIG_NOSYSTEM=1` 会把系统配置一起丢掉，
    而 Git for Windows 正是在**系统**配置里写着 `core.autocrlf=true`。于是「索引存 LF、
    工作区是 CRLF」的仓库**每一行都算改动**——实测 `+1 −0` 变成 `+88 −87`，
    加了一行的文件被画成整体重写；旁边四个文件因为索引里本来就是 CRLF 恰好正常，
    「大部分行都对」极易让人放过。把 `GIT_CONFIG_SYSTEM` 设成**空串**是同样的效果（实测），
    所以「改成重定向」也不安全。正确做法是**两个都不设**，让 git 自己找系统配置；
    要防凭据泄漏就白名单化**环境变量**（本来就在做）。核对办法：把计数与
    `git diff --numstat` 逐行比。

### worktree 与仓库发现

14. **关联工作树对任何文件系统扫盘都是隐形的**。`git worktree add` 把工作树放在你指定的任何
    位置——常见的就是主工作树的**兄弟目录**，两者之间唯一的联系是那边一行 `.git` **文件**
    （`gitdir: …/.git/worktrees/<name>`）。按目录往下扫既找不到它、也得不到任何"它存在"的线索；
    而在它里面跑 `rev-parse --show-toplevel` 得到的是**它自己**，所以"在不在工作区里 / 包不包住
    工作区"两个方向都是 false。要问 `git worktree list`——而且必须问**宿主自己选定**的那个仓库，
    **绝不能问正在被校验的那个路径**：`worktree list` 至少会列出被问的那个仓库自己，
    拿申请者去问等于让它自己给自己签通行证，围栏会当场失效（第一版就是这么写的，
    `test/route.test.cjs` 的「工作区之外的仓库必须被拒」当场变红）。
15. **`worktree list --porcelain -z` 用两个 NUL 分隔记录、单个 NUL 分隔字段**。路径是绝对路径、
    正斜杠，且 `-z` 下**不加引号**（含空格的路径原样输出），所以拿到的路径仍必须规范化后再比较。
    可选行有 `detached`（此时**没有** `branch` 行）、`locked`、`prunable <原因>`、`bare`；
    后两者可能**带原因**，判据要按词匹配而不是整行相等。`locked` 只表示"不能 remove"——
    内容完全可读，必须照常列出；`prunable` 表示目录已经不在，必须剔除。

### 图形渲染

16. **一条分支曲线的目的地泳道不等于"已处理"**。泳道布局每行会输出分叉/汇入的曲线，加上
    只是路过的泳道。把每个曲线端点都标记成"这条泳道本行已画"很诱人——但分叉曲线有两种
    完全不同的去向：
    - 该泳道是**本行新开的**（父提交此前不在途）：上方不会有线进来，这里再画贯穿线就是
      一根悬空短线——必须省略；
    - 该泳道**早已在等那个父提交**（更早的提交把它送上了途）：上方有线进来**且**必须继续
      往下——贯穿线是必须的，跳过它正好删掉这一行的泳道。

    第二种情况连接曲线仍然会画，所以那一行看起来不是空的，而是"线在它底下被擦掉了一格"。
    修复前在本机 **8 个仓库里扫出 40 处接缝断线**（共扫 3109 处接缝）。这个不变量断言起来很
    便宜：对每一行边界，第 r 行下缘带墨的 x 位置集合必须等于第 r+1 行上缘的集合。
    `test/graph-continuity.test.cjs` 做的就是这件事，跑手写形状 + 300 个带种子的随机 DAG。

17. **`pointer-events: none` 挡不住元素被盖住**。图谱 SVG 是滚动定高器的第一个子元素，
    而每个提交行都是 DOM 顺序靠后的绝对定位不透明盒子。行在 SVG 之后绘制，所以任何主题真的
    会填充背景的行——`:hover` 或 `[data-selected="true"]`——都会把那一行的泳道列盖掉。
    SVG 需要显式 `z-index`（以及它的定位父元素），这正是 `test/graph-continuity.test.cjs`
    同时钉住这条样式契约的原因；命中测试仍然正确，因为 SVG 仍是 `pointer-events: none`，
    点泳道列仍然选中该行。

### 客户端/宿主契约与新鲜度

18. **`method` 不是旧契约的一部分**：0.3.0 之前宿主忽略它，一律回提交图数据。而浏览器半
    **每次刷新都会重新加载**（rev 取自文件 mtime）、宿主半却要重启才换——所以「宿主是旧的」
    是一个**常态**，不是异常。必须校验响应形状，否则会把一个从没提过改动的载荷渲染成
    「没有未提交的改动」：一句斩钉截铁的假话。
19. **载荷版本检查必须用 `>=`，绝不能用 `===`**：`isNewHost` 曾比较 `schema === 2`；
    加一个字段升到 `3` 之后，浏览器半把**更新**的宿主判成旧的、劝用户重启——与事实正好相反，
    而且只在同时存在两半不同版本的机器上才看得见。判断某个字段存在与否就按那个字段来
    （`freshnessNotice` 就是这么做的），总版本判断保持单调。
20. **"我看见它合并了，图上怎么没有"是 fetch 新鲜度问题，不是绘图 bug**。图谱按设计只画本地，
    诚实的回答需要**本地仓库对远端认知的年龄**，而这份年龄从 refs 推不出来——本地分支和它
    **过期**的远程跟踪 ref 指向**同一个**提交，behind 计数是 `0`，远端却已经又走了十个提交。
    要 stat `FETCH_HEAD`，而且要在**两处** stat：实测某台机器上一个关联工作树自己的
    `.git/worktrees/<name>/FETCH_HEAD` 是 10:36，主工作树却是 11:10——只读一处就会把
    新鲜的仓库报成过期，而用户正站在另一个工作树里。取两者较新者。另外注意：覆盖一个已有
    ref **不会**碰父目录的 mtime（实测 `refs/remotes` 停在 09-20 而 `origin/develop` 是 10-02），
    所以永远别 stat 目录；从未 fetch 过的仓库根本没有 `FETCH_HEAD`，那是「没有远端」，
    不是「过期」。

## License

MIT — see [LICENSE](LICENSE).
