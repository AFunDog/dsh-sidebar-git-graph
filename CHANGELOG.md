# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-09-29

### Added

- **Repository picker**: a workspace that holds more than one repository now gets a picker in the
  page header, listing every repository found inside the workspace (and the repository enclosing
  it, when the workspace is only a subdirectory of one). The choice is remembered per workspace.
  - `lib/repos.js` discovers repository roots by scanning downwards, with four gates (depth,
    directory count, repository count, elapsed time) so a request can never turn into a full-disk
    walk. Hitting a gate is reported in the page instead of being hidden.
  - Directories that never hold repositories of interest (`node_modules`, `target`, `.venv`, build
    output, …) are not descended into, but each is still `stat`'d once — a repository that happens
    to be named `build` is still listed.
  - A browser-supplied repository path is fenced to *the workspace, something inside it, or
    something enclosing it*, and then re-checked with `rev-parse` that it really is a repository
    root. Anything else is refused and the page falls back to the automatic choice, saying so.
  - New setting **Repository scan depth** (0–8, default 5; `0` disables the scan).
- `scripts/test.mjs` — `npm test` runs `node --check` over every `lib/` file and then every
  `test/*.test.cjs`, discovered automatically so a new test file cannot be forgotten in CI.
- Tests: repository discovery (`test/repos.test.cjs`), the theme-token guard
  (`test/style-tokens.test.cjs`) and the picker's element tree (`test/repo-picker.test.cjs`).

### Fixed

- **The current-branch chip was invisible in both themes.** It used
  `var(--dsw-alias-label-inverse, inherit)` — a token that does not exist — so its text inherited
  the theme's body colour while its background was `--dsw-alias-brand-primary`. In each theme
  those two resolve to the *same* value (`#f9fafb` in dark, `#0f1115` in light): 1.00:1 contrast,
  i.e. white on white in dark mode. It now uses `--dsw-alias-label-primary-foreground`, the token
  DSH pairs with `button-primary-fill` (= `brand-primary`): 18.9:1 and 18.1:1.
- Two more token typos that were silently falling back: `--dsw-alias-state-warning-primary` →
  `--dsw-alias-state-warn-primary`, `--dsw-alias-state-danger-primary` →
  `--dsw-alias-state-error-primary` (three lane colours were affected), and
  `--dsw-font-mono` → `--dsw-font-markdown-code-font-family`.
- The repository-count cap could overshoot badly: it was only checked at the top of the scan loop,
  so one concurrent batch of 32 directories could blow past it (130 repositories discovered in one
  pass instead of stopping at 100). The cap is now enforced on every push.

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

[Unreleased]: https://github.com/AFunDog/dsh-sidebar-git-graph/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/AFunDog/dsh-sidebar-git-graph/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/AFunDog/dsh-sidebar-git-graph/releases/tag/v0.1.0
