# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-28

First public release. Extracted from a private multi-machine DSH configuration repository,
where it had been running against DSH `0.1.7-rc.2` and `dsh-better-sidebar` 0.21.1.

### Added

- Right-sidebar page **Git graph**: a read-only commit graph over the session's workspace.
  - Lane layout in a single pass over `--topo-order` history; bezier connectors for branch
    forks and merges; merge commits drawn with a larger dot; the HEAD lane emphasized.
  - Ref chips per commit (local branch / remote branch / tag), with the current branch inverted.
  - Header with repository name, current branch, `↑ahead ↓behind` and dirty-file count.
  - Commit search that highlights matches and steps through them without re-laying-out the graph.
  - Click a row for full sha, author, email, absolute time, parents and participating refs.
  - Virtualized rows (the visible window is what gets rendered); nothing is requested while the
    page is not the visible tab.
- Host half with a read-only `POST /dsh-sidebar-git-graph/api` route:
  - `rev-parse`, `status --porcelain=v1 -b`, `for-each-ref`, and a `--topo-order --parents` log.
  - Sanitized child environment, 10 s per-command timeout, 48 MiB output cap, argument arrays only.
  - Same-origin trust fence plus a workspace allow-list (a client-supplied `cwd` is only honored
    when the host can back it).
  - Explicit error codes (`no-git`, `not-a-repo`, `no-workspace`, `git-failed`, `forbidden`)
    instead of thrown errors, so the page can always say something useful.
- Two registration routes, chosen automatically:
  - `ctx.betterSidebar.registerTab` when dsh-better-sidebar is present (page in the `+` menu and
    a card with an on/off switch in *Settings → Side cards*, plus a per-plugin commit-window
    setting). Activated through `ctx.inject`, never a static `inject`.
  - DSH's own `ctx.sidebarRightTabs` + `sidebar.right.pane.tab` slot when it is not.
- Three zero-dependency test files: parsers, lane layout (driven through a `vm`-loaded bundle),
  and an end-to-end route test against a throwaway repository under the system temp directory.

[Unreleased]: https://github.com/AFunDog/dsh-sidebar-git-graph/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/AFunDog/dsh-sidebar-git-graph/releases/tag/v0.1.0
