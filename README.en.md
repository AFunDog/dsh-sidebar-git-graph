# dsh-sidebar-git-graph

[![ci](https://github.com/AFunDog/dsh-sidebar-git-graph/actions/workflows/ci.yml/badge.svg)](https://github.com/AFunDog/dsh-sidebar-git-graph/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A **right-sidebar page for DSH (DeepSeek Harness)** that draws the current session's
repository as a **branches-and-merges commit graph** — VS Code style: colored lanes,
bezier curves where branches split and merge, ref chips, per-commit details — with a
**working-tree Changes area** above it, for **every working tree of the repository**.

**Read-only.** It never runs `checkout`, `commit`, `reset`, `rebase`, `fetch`, `push`,
`add`, `restore` or `worktree add/remove/prune`. The only git commands it runs are `rev-parse`,
`status`, `for-each-ref`, `log`, `diff` and `worktree list`.

![The Git graph page: colored lanes, ref chips, commit rows, with the working-tree Changes area above](docs/screenshot.png)

> 中文说明见 [README.md](README.md)。Contributing / internals / the full trap list live in
> [AGENTS.md](AGENTS.md).

## Features

- **Working-tree changes, VS Code style** — a **Changes** and a **Staged Changes** section above
  the graph (plus **Merge Changes** during a merge), each row carrying its status letter
  (`M`/`A`/`D`/`R`/`C`/`U`) and its added/deleted line counts. Click a file to expand its diff
  inline; the sections fold and remember it.
- **Branch/merge relationships at a glance** — one lane per concurrent line of history, curved
  connectors where a branch forks or merges back, thicker dots on merge commits, and the HEAD
  lane emphasized.
- **Ref chips per commit** — local branch / remote branch / tag, with the current branch filled in
  the theme's brand color and the theme's matching on-brand foreground.
- **One workspace, several repositories** — a workspace often holds more than one repository (this
  project's own checkout has a nested one under `vendor/@zeng/`). The header then grows a picker
  listing every repository it found; the choice is remembered per workspace. A workspace that is
  itself only a subdirectory of a repository works too — the enclosing repository is offered as
  well. Discovery never leaves the workspace: it scans downwards, bounded by depth, directory
  count, repository count and a time budget.
- **Every working tree of the repository** — a repository can have several
  (`git worktree add`), each on its own branch with its own uncommitted changes, and the linked
  ones usually live **outside** the workspace directory entirely (in the case this feature was
  built for, they are sibling directories). The picker lists all of them, **each labelled with its
  own branch**, so you can switch between the main working tree and a linked one and see that
  working tree's graph and changes. The main working tree, detached heads and locked working trees
  are marked; working trees whose directory is gone are skipped and counted in a notice rather than
  silently dropped. Because the list comes from `git worktree list`, it works from any of them —
  standing in a linked working tree also offers you the main one.
- **Header at a glance** — repository name, current branch, `↑ahead ↓behind`, dirty-file count.
- **Tells you when its picture of the remote is behind** — the graph is drawn from your **local**
  repository and this page never touches the network that is the read-only promise. So a merge
  that just happened *on the remote* is invisible here until someone runs `git fetch`. Rather than
  leave you wondering whether the graph is wrong, the page says how long ago the repository last
  fetched (past 6 hours), and which local branches are behind their upstream. A repository that
  has never been fetched is reported as having no remote instead of as stale.
- **Follows the session's worktree label** — when
  [`@zeng/dsh-session-worktree`](https://github.com/AFunDog/dsh-session-worktree) is installed
  and enabled, the page opens on the working tree that session is labelled with, instead of
  whatever repository the working directory happens to sit in. Which repository wins:
  **your click in the picker** → **the session's worktree label** → the last repository
  remembered for this workspace → the repository of the working directory → the first one found.
  The page says when it is following the label, and says so more loudly when it cannot
  (a label pointing at a directory that is gone, is not a repository root, or is outside what
  this page may read) — it never silently swaps in a different repository. Uninstalling or
  disabling that plugin restores the previous behaviour exactly.
- **Commit search** — highlights matches and steps through them (the graph stays intact; it
  never re-lays-out a filtered list).
- **Details on click** — full sha, author + email, absolute time, parents, participating refs.
- **Virtualized list** — a 2000-commit window still renders only the visible rows; nothing is
  requested while the page is not the visible tab.
- **Honest error states** — not a git repository / no `git` on `PATH` / no workspace / trust
  fence refused / git failed each get their own message instead of a blank page.
- **Zero dependencies, no build step** — the host half is plain ESM, the browser half is a
  single hand-written client-bundle file. What you read in `lib/` is what runs.

## Install

```sh
dsh plugin --profile web add github:AFunDog/dsh-sidebar-git-graph
```

Then restart `dsh web` (the host half adds a route) and hard-refresh the browser. Open the right
sidebar and pick **Git graph** — from the `+` menu when dsh-better-sidebar is installed, or from
the sidebar's guide page on a bare DSH (the `+` control is not drawn while that pane already
holds the guide tab). The page follows the session you are viewing:
switch sessions and it re-reads that session's workspace.

<details>
<summary>Pin a version, or install from a local clone</summary>

```sh
# pin a tag (recommended: lockfiles record the resolved commit)
dsh plugin --profile web add github:AFunDog/dsh-sidebar-git-graph#v0.2.0

# from a local clone (absolute path only — relative paths are rejected by spec parsing)
dsh plugin --profile web add /path/to/dsh-sidebar-git-graph
```
</details>

### With or without dsh-better-sidebar

The page works both ways, and picks automatically:

| Your setup | What happens |
|---|---|
| [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) installed | The page registers through its public `ctx.betterSidebar.registerTab` service: it shows up in the `+` menu, gets a card in *Settings → Side cards* (with an on/off switch and a per-plugin setting for the commit window), and appears under **Git graph**. |
| Bare DSH | The page registers with DSH's own sidebar tab type (`ctx.sidebarRightTabs` + the `sidebar.right.pane.tab` slot) — same column, same `+` menu, minus the settings card. |

## Settings

| Setting | Where | Default | Meaning |
|---|---|---|---|
| Commits loaded per read | *Settings → Side cards → Git graph → feature settings* (dsh-better-sidebar only) | `400` | 100–2000. Bigger is more complete and slower on first read. |
| Repository scan depth | same place | `5` | 0–8. How deep to look for repositories to offer in the picker; `0` means "no scan — only the repository the working directory is in". Lower it if a huge workspace reports an incomplete list. |
| History scope | page header | all branches | *All branches* or *current branch only*. |
| Commit search | page header | — | Highlights matches and steps through them. |

## Limitations

- **Read-only by design.** No staging, no commit, no checkout, no push. To change the working
  tree, use another tool.
- **Untracked files carry no `+/−` counts.** `git diff --no-index` compares exactly two paths, so
  per-file counts would mean one process per file — hundreds of them in a repository that has not
  been `add`ed yet. The section header counts what it can and leaves the rest blank rather than
  printing a `0` that would read as "nothing changed". A file changed on both sides shows up in
  both sections, which is what the two sections are for.
- **A nested repository is one non-clickable row.** `git` does not descend into a repository
  inside a repository (even with `-uall`), so the outer repository sees a single directory and
  there is no diff to show for it. The page says so on the row instead of doing nothing when
  clicked.
- **At most 3000 rows**, and at most 512 KiB of patch per file; both are reported in the page
  rather than silently cut.
- **The window is bounded** (up to 2000 commits per read, default 400); older history is
  reported as truncated rather than silently dropped.
- **Repository discovery is bounded, and it scans the filesystem.** Depth, directory count,
  repository count and elapsed time are all capped; hitting a cap is reported in the page instead
  of being hidden, and lowering the scan depth is the fix. Directories that never hold repositories
  of interest (`node_modules`, `target`, `.venv`, build output, …) are not descended into — though
  each of them is still stat'd once, so a repository that happens to be named `build` is still
  found.
- **The picker only offers what is reachable from the workspace** — the workspace itself, something
  inside it, the repository that encloses it, or a **working tree of the repository the workspace
  is in** (as reported by `git worktree list`). The host refuses any other path even if the
  browser asks for it, and re-checks with `rev-parse` that the path really is a repository root.
- **A working tree is read on its own.** `git status` and `git log` are per working tree, so each
  one shows its own branch, its own uncommitted changes and its own `HEAD`; the page never merges
  two working trees into one view. Working trees that are gone (`prunable`) and bare repositories
  are listed as a count in a notice rather than offered.
- **Search does not filter the graph** — filtering would break lane continuity, which is the
  whole point of the page; matches are highlighted and stepped through instead.
- **Lane colors** are derived from DSH theme tokens with `color-mix()`. On a browser without
  `color-mix()`, lanes fall back to the four theme state colors in rotation.
- Verified on DSH `0.1.7-rc.2` with `dsh-better-sidebar` 0.21.1; the native fallback path is
  covered by the same tests but has had less real-world use.
- The npm name `dsh-git-graph` belongs to a **different** plugin by another author
  ([enoughpower/dsh-git-graph](https://www.npmjs.com/package/dsh-git-graph)). This one is
  `@zeng/dsh-sidebar-git-graph` and is currently distributed from GitHub only.

## Development

No build step: edit `lib/`, restart `dsh web` for host-half changes, hard-refresh for browser-half
changes (a changed client bundle is picked up with a reload — its `rev` is re-derived from the
file's mtime).

```sh
npm test        # = node scripts/test.mjs: node --check on every lib file, then every test
```

The architecture map, the lane-layout invariant, the theme-token checks and the
implementer traps live in [AGENTS.md](AGENTS.md).

## License

MIT — see [LICENSE](LICENSE).

[中文说明](README.md)
