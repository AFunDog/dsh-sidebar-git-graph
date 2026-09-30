# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-09-30

### Added

- **A "Changes" area above the graph** (VS Code style). Two foldable sections — *Changes* and
  *Staged Changes*, plus *Merge Changes* when a merge is in progress — with a status letter per
  row (`M`/`A`/`D`/`R`/`C`/`U`), the added/deleted line counts from `git diff --numstat`, and
  click-to-expand inline diffs. Section fold state is remembered.
  - A file changed on both sides (`MM`) appears in **both** sections — that is what the two
    sections mean.
  - Untracked files show no `+/−` counts: `git diff --no-index` takes two paths, so counts would
    cost one process per file. The section header counts only what it can count, and says so
    rather than printing a `0` that would read as "no changes".
  - A nested independent repository appears as one directory row, marked as not clickable with
    the reason shown — `git` does not descend into it, so it has no diff to show.
  - New read-only route methods `changes` and `diff` on the existing
    `POST /dsh-sidebar-git-graph/api`, dispatched by the `method` field of the request envelope
    (which the client had always sent and the host had always ignored). `graph` is unchanged and
    a request with no `method` still means `graph`, so older clients keep working.
  - `lib/changes.js` — argv construction and output parsing as pure functions, importable and
    testable outside DSH.

### Security

- Paths arriving from the browser are fenced twice: `--literal-pathspecs` disables git's pathspec
  magic (without it a path like `:(top)*` turns "read one file" into "read the whole tree"), and
  `isRepoRelativePath` rejects absolute paths, drive letters, `..`, backslashes, a leading `-` or
  `:`, and NUL/newline characters before any git process is spawned.
- Patch output is capped at 512 KiB and diff commands carry `--no-color --no-ext-diff
  --no-textconv`, so a repository's own config cannot make `git diff` execute a command.

### Fixed

- **Every line of a CRLF file was reported as changed.** The sanitized git environment set
  `GIT_CONFIG_NOSYSTEM=1` to keep a repository's own configuration out of the commands. That also
  dropped the *system* config — and Git for Windows ships `core.autocrlf=true` there. In a
  repository whose index holds LF and whose working tree holds CRLF, every line then differs:
  `docs/README.md` went from `+1 −0` to `+88 −87`, and a one-line addition was drawn as a
  whole-file rewrite. Four neighbouring files happened to be stored with CRLF in the index and
  looked correct, so "most rows are right" made it easy to miss. Found by comparing the page's
  numbers against `git diff --numstat` on the same working tree.
  - The fix is to set **neither** `GIT_CONFIG_NOSYSTEM` nor `GIT_CONFIG_SYSTEM`: git then finds
    its own system config, exactly as the user's own `git` does. Pointing `GIT_CONFIG_SYSTEM` at
    an empty string reproduces the same bug (measured), so "redirect it instead" is not a safe
    variant.
  - Repository-level `filter.*` and `diff.*.textconv` are still removed from the command line,
    since those make git execute external programs while reading a repository.
- **A stale host would have been reported as "no uncommitted changes".** Version skew is real
  here: the browser half is re-read on every page load (its `rev` comes from file mtime), while
  the host half only picks up changes on a restart. An older host ignores the request's `method`
  and answers `changes` with *commit-graph* data — `ok: true`, no error, no `sections`. A
  normalize-missing-fields-to-empty-arrays approach then produced three empty sections and the
  page printed **"✓ no uncommitted changes"** for a client that had never asked about the working
  tree at all. A confident false statement is worse than a blank page. The client now checks that
  the response actually looks like the payload it asked for and, when it does not, says so and
  points at the fix (restart `dsh web`). Found on a real machine, in exactly this skew.
- **A conflicted file showed an empty diff.** Unmerged paths make `git diff` emit a *combined*
  diff (`@@@` hunks with two-character prefixes) that a unified-diff reader cannot parse, so the
  parser silently returned zero lines — an empty answer with no error attached. Conflicts now
  compare against `HEAD` (a normal unified diff, showing the file exactly as it is on disk,
  conflict markers and all), and the parser recognises a combined diff and says so rather than
  reporting "no changes".
- The request envelope's `method` field is now honored. An unknown method returns an explicit
  error instead of silently running the commit log, which used to be indistinguishable from
  "my change had no effect".
- **Four crashes that blanked the whole page** when the host returned an unexpected shape
  (`repo: null`, `sections: null`, a missing `totals`, a non-array section). The graph half had
  these too, from before this release. A throw inside the page component takes the commit graph
  down with it, so the risky reads are now normalized up front. Found by
  `test/render-smoke.test.cjs`, which renders the real component against deliberately malformed
  responses.

### Tests

- `test/changes.test.cjs` — parsing of real `git status --porcelain=v2 -z` /
  `git diff --numstat -z` bytes (including the 11-field `u` unmerged record, which is **not**
  shaped like `1`/`2`, and paths containing spaces), plus end-to-end runs against temporary
  repositories: every status letter, `--no-index`'s exit code 1 meaning success, renames needing
  both paths, binary files, empty repositories, the row cap, and the route dispatch.
- A **read-only invariant** test: every argv builder is asserted to produce only
  `status`/`diff`. Adding a staging feature later will fail this test rather than quietly
  contradicting the README.
- `test/changes-view.test.cjs` — the browser half's path shortening (scope packages keep two
  segments), row copy, absent-count handling, non-text diff states, and section fold persistence.
- `test/render-smoke.test.cjs` — renders the real page component against malformed host responses.
  A throw in that component blanks the page *including the commit graph*, and the other tests only
  covered pure functions, so this failure mode was invisible to them. It found four real crashes
  on its first run; the graph half had been carrying three of them since before this release.
- `test/end-to-end-render.test.cjs` — **crosses the two halves**: real repositories, the real host
  handlers, and the real render path, asserting the text on the page against what is actually in
  the working tree. Every other test stopped at the seam between the halves and used a payload
  shape its author had imagined; the stale-host bug lived exactly in that seam. Verified to have
  teeth by mutation: dropping conflict rows, breaking the `untracked` flag, and discarding rename
  origins each make it fail.

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
