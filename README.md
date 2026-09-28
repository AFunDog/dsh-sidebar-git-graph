# dsh-sidebar-git-graph

[![ci](https://github.com/AFunDog/dsh-sidebar-git-graph/actions/workflows/ci.yml/badge.svg)](https://github.com/AFunDog/dsh-sidebar-git-graph/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A **right-sidebar page for DSH (DeepSeek Harness)** that draws the current session's
repository as a **branches-and-merges commit graph** — VS Code style: colored lanes,
bezier curves where branches split and merge, ref chips, per-commit details.

**Read-only.** It never runs `checkout`, `commit`, `reset`, `rebase`, `fetch` or `push`.
The only git commands it runs are `rev-parse`, `status`, `for-each-ref` and `log`.

![The Git graph page: colored lanes, ref chips, commit rows](docs/screenshot.png)

## Features

- **Branch/merge relationships at a glance** — one lane per concurrent line of history, curved
  connectors where a branch forks or merges back, thicker dots on merge commits, and the HEAD
  lane emphasized.
- **Ref chips per commit** — local branch / remote branch / tag, with the current branch inverted.
- **Header at a glance** — repository name, current branch, `↑ahead ↓behind`, dirty-file count.
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

Then restart `dsh web` (the host half adds a route) and hard-refresh the browser. Open the
right sidebar's `+` menu and pick **Git graph**. The page follows the session you are viewing:
switch sessions and it re-reads that session's workspace.

<details>
<summary>Pin a version, or install from a local clone</summary>

```sh
# pin a tag (recommended: lockfiles record the resolved commit)
dsh plugin --profile web add github:AFunDog/dsh-sidebar-git-graph#v0.1.0

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

The service contract is re-stated locally (only `registerTab` / `openTab` are used) and is
activated with `ctx.inject`, never a static `inject`: a statically declared service that is
absent would park this plugin's fiber, which shows up as "works after a hot reload, gone after
a restart".

## How it works

```
lib/index.js      host half  — POST /dsh-sidebar-git-graph/api, git execution, trust fence
lib/git-read.js   host half  — pure: argv builders + parsers (importable by plain node)
lib/workspace.js  host half  — sessionId → working directory, workspace allow-list, fence
lib/client.js     browser half — tab registration, lane layout, SVG rendering (single file)
test/             three zero-dependency test files (node test/<file>.cjs)
```

1. The browser half reads the session's working directory and asks the host for a snapshot.
2. The host resolves which workspace belongs to that session (session service → persisted
   workspace table → workspace registry → newest session directory), refuses paths that are
   neither registered nor the session's own cwd, runs the four read-only commands with a
   sanitized environment, a 10 s timeout and a 48 MiB output cap, and answers with
   `{ repo, refs, commits[{ sha, parents, author, email, time, subject, refs }] }`.
3. The browser half lays the commits out into lanes with one pass over `--topo-order` history
   and renders SVG bezier connectors under a virtualized row list.

The layout function and the geometry builder are pure and exposed on the plugin's `internals`
so the test suite can drive them without a browser.

## Settings

| Setting | Where | Default | Meaning |
|---|---|---|---|
| Commits loaded per read | *Settings → Side cards → Git graph → feature settings* (dsh-better-sidebar only) | `400` | 100–2000. Bigger is more complete and slower on first read. |
| History scope | page header | all branches | *All branches* or *current branch only*. |
| Commit search | page header | — | Highlights matches and steps through them. |

## Limitations

- **Read-only by design.** No checkout/commit/push. To change branches, use another tool.
- **The window is bounded** (up to 2000 commits per read, default 400); older history is
  reported as truncated rather than silently dropped.
- **Search does not filter the graph** — filtering would break lane continuity, which is the
  whole point of the page; matches are highlighted and stepped through instead.
- **Lane colors** are derived from DSH theme tokens with `color-mix()`. On a browser without
  `color-mix()`, lanes fall back to the four theme state colors in rotation.
- **Persisted DSH internals are a fallback only** — reading `storages/workspace.json` and
  `sessions/` is the last resort when the session/workspace services are unavailable.
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
node --check lib/index.js && node --check lib/client.js
node test/git-read.test.cjs     # parsers
node test/lane-layout.test.cjs  # lane layout, driven through a vm-loaded bundle
node test/route.test.cjs        # end-to-end against a throwaway repo in the temp directory
```

`git` must be on `PATH` for the route test.

## License

MIT — see [LICENSE](LICENSE).

[中文说明](README.zh.md)
