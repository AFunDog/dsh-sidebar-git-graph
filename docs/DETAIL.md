A right-sidebar page that draws the current session's repository as a VS Code-style branch/merge graph, with a **working-tree Changes area** above it.

## What it does

- **Changes, VS Code style, two sections**: **Changes** and **Staged Changes** (plus **Merge Changes** during a merge), each row carrying a status letter (`M`/`A`/`D`/`R`/`C`/`U`) and added/removed line counts. Click a row to expand its diff in place.
- **Many branches at a glance**: each concurrent line of history gets a lane, forks and merges get bezier curves, merge commits draw a larger dot, and the lane holding HEAD stands out.
- **Ref chips on every commit**: local branches, remote branches, tags.
- **One workspace, several repositories**: a workspace commonly holds more than one. A header dropdown lists every repository found, remembered per workspace. Discovery never leaves the workspace — depth, directory, repository, and time limits all cap it.
- **Every working tree of one repository**: the dropdown lists each `git worktree list` entry with its own branch and lets you switch freely; main worktree, detached HEAD, and locked entries are marked.
- **Click a commit for details**: full sha, author, time, parents, refs, plus the **files it changed**, each expandable to its patch. Merge commits compare against the **first parent**, and the title says so.
- **Stale remote awareness**: the graph draws the local repository and never touches the network. The page states how long ago the repository was last fetched and which local branches are behind their upstream — instead of leaving you guessing.
- **Virtualized list**: up to 2000 rows render only what is visible; a page that is not the active tab issues **no requests at all**.

## Read-only guarantee

No checkout, commit, reset, rebase, fetch/push, add, restore, or `worktree add/remove/prune`. Only six commands run: `rev-parse`, `status`, `for-each-ref`, `log`, `diff`, `worktree list`.

## Following the session's worktree label

With [`@zeng/dsh-session-worktree`](https://github.com/AFunDog/dsh-session-worktree) installed and enabled, the page draws **the working tree the session is labelled with** by default, rather than whichever repository the working directory happens to sit in.

Repository priority: **your manual dropdown pick** → **the session's worktree label** → the repository this workspace last remembered → the repository containing the working directory → the first one found. The page says "following the label"; when it cannot, it says why (directory gone / not a repository root / outside what this page may read) — it **never silently switches repositories**. Uninstall or disable that plugin and behaviour is exactly as before.

The link goes through the host-side `ctx.get('sessionWorktree')` service seam, never a browser-side cross-plugin import — the client module table only resolves platform seed words and each package's own id, so third-party packages have no import channel between them.

## Relationship to better-sidebar

With `dsh-better-sidebar` present it uses that package's public `ctx.betterSidebar.registerTab` (the page also appears in its `+` menu and its settings "side cards" list, toggleable); without it, it falls back to DSH's native `ctx.sidebarRightTabs` + `sidebar.right.pane.tab`. Both routes register the same tab type, so it works either way.

## Theme and accessibility

Every colour derives from theme tokens (`--dsw-alias-*`) and follows both light and dark modes. The tests embed a full token snapshot: a CSS name outside that snapshot fails the suite — because a misspelled token silently falls back, showing up as "the colour looks wrong" rather than an error.
