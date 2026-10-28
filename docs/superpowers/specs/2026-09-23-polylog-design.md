# Polylog — Design Spec

**Date:** 2026-09-23
**Status:** approved, pending implementation plan

---

## 1. What Polylog Is

A VS Code extension that shows **one merged, filterable git log across every repository
in the workspace**, and lets you click any commit to see its changed files and open them
in the native diff editor.

The one-line pitch:

> One git log across every repo in your workspace. Search commits by message across all
> of them at once, and see the changed files without switching repositories.

### The gap it fills

Multi-root and sibling-repo workspaces are common (polyrepo services, a vendored
dependency next to its consumer, a docs repo beside its product). Every existing VS Code
git extension handles them the same way: a **repository picker**. You see one repo's
history at a time.

Surveyed 2026-09-23:

| Extension | Multi-repo support | Merged log? |
|---|---|---|
| GitLens | Repositories view lists all repos | No — commit search is per-repo |
| GitCharm | "Repository tabs above the commit list let you filter the log to a single repository at a time" | No — tabs |
| Git Graph | Repo dropdown | No |
| Git History | — | No |
| Git Orbit, Multi-Repo Manager, Multi Repo Git Commands | Batch *operations* across repos | No — they batch actions, not history |

Nobody merges the log. That is the whole product.

JetBrains IDEs do have this (the VCS Log tool window merges all registered VCS roots into
one filterable timeline), which is where the idea comes from. Polylog brings that one
capability to VS Code without trying to clone the rest of the IDE.

### Non-goals for v1

Stated explicitly so the plan does not drift into them:

- No writes. No fetch, pull, checkout, cherry-pick, or any git operation that changes state.
- No commit graph. Commits in unrelated repos share no topology; merged lanes would be meaningless.
- No branch or path filters. Text, author, repo and date only. (Author added 2026-09-23 by
  maintainer decision: pushed down as `git log --author`, literal and case-insensitive,
  ANDed with the message search; a "Me" button fills in the user's git email.) **Amended 2026-09-24:** branch (panel spec §13) and path (panel spec §21.4) filters are now in, both pushed down into git.
- No GitHub/GitLab/remote integration, no PR awareness.
- No submodule-specific handling. A submodule that VS Code reports as a repository is
  treated as any other repository.
- No blame, no file history, no stash/shelf UI.

---

## 2. Measurements That Decided the Architecture

Benchmarked on a real polyrepo workspace: **68 sibling repositories, 16,314 commits total**,
largest repo 5,633 commits. Warm cache, Linux, NVMe.

| Operation | Time |
|---|---|
| `git log -n 50` across all 68 repos, serial | **330 ms** |
| Same, 16-way parallel | **25 ms** |
| `git log --all --grep=<term>` across all 68 repos (full history), serial | **640 ms** |

**Consequence: no index, no cache, no database.** A background SQLite index would add a
native dependency, a sync subsystem and a class of staleness bugs in order to improve on
25 ms. Polylog spawns `git log` on demand and merges in memory. This is the single most
important decision in the spec, and it is measured rather than assumed.

**Corollary: push every filter down into git.** `--grep`, `--since`, `--until` and the repo
subset are all arguments to `git log`. Git does the searching; JavaScript only merges
already-filtered, already-sorted streams. This is what keeps the cost flat as history grows.

---

## 3. Architecture

### Modules

Seven modules. Three are pure functions with no VS Code import — that is where the unit
tests live.

| Module | Responsibility | Depends on |
|---|---|---|
| `repoDiscovery.ts` | Enumerate repositories in the workspace | vscode |
| `gitLog.ts` | Run `git log` for **one** repo, parse records into `Commit[]` | injected spawn fn |
| `mergeStream.ts` | Merge N date-sorted arrays into one stream + next cursor | **pure** |
| `filterModel.ts` | Filter state → `git log` argv + repo subset | **pure** |
| `commitDetail.ts` | `git show --numstat` for one commit → changed files | injected spawn fn |
| `revisionProvider.ts` | `TextDocumentContentProvider` for `polylog:` URIs | vscode |
| `logPanel.ts` | Webview host: HTML, message passing, debounce, lifecycle | vscode |

`extension.ts` wires them together and registers commands. It contains no logic.

### Repository discovery

Primary source is the built-in git extension's API:

```ts
const git = vscode.extensions.getExtension("vscode.git")?.exports.getAPI(1);
git.repositories // → Repository[], each with rootUri
```

This is free and correct: it already respects the user's `git.repositoryScanMaxDepth`,
handles multi-root workspaces, and updates as repos are opened or closed. Subscribe to
`onDidOpenRepository` / `onDidCloseRepository` to stay current.

Polylog uses that API **only for discovery**. It does not use `Repository.log()` — that
surface cannot express `--grep`, so it would force filtering in JavaScript and throw away
the architecture in section 2.

Fallback: if the git extension is unavailable or reports nothing while the workspace
plainly contains repos, fall back to a bounded directory walk (depth from
`polylog.scanDepth`, default 2). This is also the escape hatch for users whose repos sit
deeper than VS Code's own scan depth.

### Reading commits

One `git log` per repository, with a NUL-delimited format so no field can be confused with
a delimiter:

```
git log --format=%H%x00%ct%x00%an%x00%ae%x00%s%x00%P%x1e -n <pageSize> [filters...]
```

Records separated by `%x1e` (record separator), fields by NUL. Subjects containing
newlines, quotes, unicode or emoji parse correctly without escaping.

`%P` (parent SHAs) is carried not for graphing — there is no graph — but because the
diff in the next section needs it: a **root commit has no `<sha>^`**, so its "before"
side must resolve to empty rather than to a revision that does not exist.

Spawns run through a concurrency pool (default 16). All spawns are async; nothing
synchronous ever touches the extension host.

### Merging and paging — windowed fan-out with a date cursor

1. Query each repo for the newest `pageSize` commits (default 200) matching the filters.
2. Merge by committer date descending; tie-break on SHA so the order is stable.
3. Render.
4. "Load more" re-queries every repo with `--until=<committer date of the oldest row shown>`
   and merges the result onto the tail.

Memory stays bounded regardless of repository size, so a user with a 500k-commit monorepo
gets the same behavior as one with five small repos. No index required.

**Known limitation, stated in the UI rather than hidden:** commits in unrelated repositories
have no causal relationship, so committer date is the only available sort key. A rebase or a
skewed clock can place a commit out of intuitive order. The date column is always visible so
the ordering is never mysterious, and the sort is documented as best-effort.

### Viewing a commit's changes

Selecting a commit runs `git show --numstat --format= <sha>` in that commit's repository,
producing the changed-file list with add/delete counts.

Clicking a file opens VS Code's real diff editor:

```ts
vscode.commands.executeCommand("vscode.diff", before, after, title);
```

where `before` and `after` are `polylog:` URIs resolved by a `TextDocumentContentProvider`
that runs `git show <sha>:<path>`. A file added in the commit resolves its "before" side to
empty content rather than erroring.

Polylog registers its **own** URI scheme rather than reusing the git extension's `git:`
URIs, whose format is internal to `vscode.git` and has changed between releases.

### Error handling

A repository can fail for ordinary reasons: shallow clone, a permissions problem, an
interrupted rebase, a path that is no longer a repository, no commits at all.

Every failure is **contained to its repository**. The repo is excluded from the merge and
reported as a dismissible row-level notice in the panel naming the repo and the reason. One
bad repository never fails the other sixty-seven, and never raises a modal dialog.

### Extension-host responsiveness

The extension host is a single thread shared with every other extension. Two rules, both
load-bearing:

- **Filter input is debounced 250 ms.** Without it, typing a six-character search term
  launches 408 child processes.
- **In-flight spawns are killed when the filter changes.** A superseded fan-out is
  cancelled, not awaited.

---

## 4. UI and UX

Design quality is a first-class goal, not a finishing pass.

### Layout

A webview in an **editor tab** (not a sidebar — the content is a wide table). Filter bar
across the top, commit list left, changed files right.

```
┌──────────────────────────────────────────────────────────┐
│ 🔍 <search>          ▾ 4 repos   ▾ Last 30 days      ⟳   │
├────────────────────────────────┬─────────────────────────┤
│ ● feat: add retry to uploader  │ 11 files                │
│   acme-api      dana    2h ago │ ▾ acme-api          3   │
│ ● fix: guard nil response      │    upload.go            │
│   acme-web      rin     5h ago │    upload_test.go       │
│ ● chore: bump deps             │ ▾ acme-web          8   │
│   acme-libs     dana    1d ago │    client.ts            │
├────────────────────────────────┴─────────────────────────┤
│ Load more                              214 commits       │
└──────────────────────────────────────────────────────────┘
```

Rejected alternatives: a three-pane GoLand clone (a permanent repo sidebar becomes its own
scrolling, searchable list at 68 repos while costing width the commit subject needs), and a
stacked list-above-detail layout (spends vertical space, the scarce axis in an editor tab).

### Theming — the hard constraint

**Every color and font comes from VS Code theme variables.** No hard-coded hex, no bundled
webfont, no assumption about light or dark.

- Color: `--vscode-editor-background`, `--vscode-foreground`,
  `--vscode-descriptionForeground`, `--vscode-list-hoverBackground`,
  `--vscode-list-activeSelectionBackground`, `--vscode-focusBorder`,
  `--vscode-charts-{red,blue,green,…}` for the on-demand repo accents.
- Type: `--vscode-font-family` / `--vscode-editor-font-family` for SHAs and paths.
- Must render correctly in light, dark **and high-contrast** themes.

This is the constraint that most extension webviews get wrong, and it is why the design
system in section 6 is scoped to structure rather than palette.

### Repo identity

The repository is a **plain sortable column** in the theme's foreground color. Color is
applied only to repositories the user has actively filtered down to (at most 8), drawn from
the `--vscode-charts-*` ramp.

Rationale: categorical color perception tops out around 8–12 hues. At 68 repositories a
per-repo chip is decoration rather than information, and hand-assigned hues collapse in
high-contrast themes. Color is spent where it carries meaning — on a small, user-chosen set.

**Amended 2026-09-23 (maintainer decision):** every repository now gets a chip, as in the
JetBrains VCS Log. There are six hues: five `--vscode-charts-*` colors plus
`--vscode-terminal-ansiCyan`, because VS Code aliases `charts.orange` to a translucent
minimap color that is unset in high contrast. Since 2026-09-24 (panel spec §18) the baseline hue
comes from the repo's name. Amended 2026-10-28: the Log repairs collisions between adjacent
repository bands, including after filtering, paging or folding; each repository keeps one
hue across the displayed log and its repository pane, and existing hues are preferred.
The chip is a 16% tint (24%
in light themes) behind text in `--vscode-foreground`, so contrast never depends on the
hue, and in
high-contrast themes it is an outline instead of a tint. The repo name is always printed, so
color stays a marker, not the identifier. Rows are one line (repo | subject | author | date),
the changed files are a folder tree, and the full commit message sits below them.

### Filters

Three, each mapping to a `git log` flag:

| Control | Flag | Notes |
|---|---|---|
| Search box | `--grep=<text>` | Case-insensitive by default (`-i`). The motivating case: find every commit mentioning a ticket id or feature name, across all repos at once. |
| Repo multi-select | repo subset | Searchable dropdown with All / None. Essential at high repo counts. |
| Date range | `--since` / `--until` | Presets (24h, 7d, 30d, All) plus custom. |

Filter state persists per workspace in `workspaceState`.

### Keyboard

The audience comes from an IDE where this is keyboard-driven. Non-negotiable for v1:

| Key | Action |
|---|---|
| `↑` / `↓` | Move commit selection (detail follows) |
| `Enter` | Open the selected commit's first changed file |
| `/` or `Ctrl/Cmd+F` | Focus the search box |
| `Esc` | Clear search / return focus to the list |
| `Tab` | Move between filter bar, list and detail |

Focus must be visible at all times via `--vscode-focusBorder`.

### States

Every state is designed, not defaulted:

- **Loading** — results stream in as repos respond. Skeleton rows, no layout shift, no spinner flash for a 25 ms query.
- **Empty (no filter)** — explains what Polylog does and how many repos it found.
- **Empty (filtered)** — names the filter that excluded everything and offers to clear it.
- **No repos found** — points at `git.repositoryScanMaxDepth` and `polylog.scanDepth`, the actual cause.
- **Partial failure** — results plus a notice naming the failed repos.

### Virtualization and accessibility

The list is virtualized; only visible rows exist in the DOM. Rows carry proper
`role="row"` / `role="gridcell"` semantics, the list is a single tab stop with roving
`tabindex`, and every icon-only control has an accessible name. A webview forfeits the free
accessibility a native TreeView provides, so it must be supplied deliberately.

---

## 5. Testing

Following the house pattern: plain `assert` unit tests, `@vscode/test-electron` integration
tests, both under `src/` so typecheck and lint cover them.

**Unit** (`src/*.test.ts`, no VS Code import):

- `mergeStream` — ordering; equal timestamps tie-broken by SHA; empty inputs; single repo; cursor correctness across pages; a repo exhausted mid-merge.
- `filterModel` — filter state → argv; empty search omits `--grep` entirely; date presets; repo subset; argument injection is impossible (no shell, args passed as an array).
- `gitLog` parsing — NUL/RS records; subjects containing newlines, quotes, unicode, emoji; empty output; truncated final record.
- `commitDetail` — `--numstat` parsing including renames, binary files (`-`/`-` counts), and adds/deletes.

**Integration** (`src/*.itest.ts`): build temp git repositories in a temp dir with scripted
commits, open as a multi-root workspace, and assert that the panel lists commits from all of
them merged, that the filter narrows them, and that clicking a file opens a diff.

`$HOME` must be isolated and `git` given a deterministic identity and dates so the fixtures
are reproducible across machines and CI.

---

## 6. Design Tooling

[Impeccable](https://github.com/pbakaus/impeccable) (Apache-2.0, zero dependencies) is
installed project-scoped for design work:

```
npx impeccable install --providers=claude --scope=project
```

It is **not committed** — the payload is gitignored and reinstalled from the command above,
which keeps a third-party Apache-2.0 tree out of an MIT repository.

**Scoped use.** Impeccable's structural commands are in scope: `layout`, `shape`, `clarify`,
`distill`, `critique`, `audit`, `harden`, `adapt`, `optimize`. Its expressive commands —
`colorize`, `typeset`, `bolder`, `delight`, `overdrive` — are **out of scope**, because they
exist to give a product a distinctive visual voice and a VS Code panel needs the opposite:
it must be indistinguishable from the editor chrome under any of the user's themes. The
theming constraint in section 4 overrides any design-system suggestion that conflicts with
it. Impeccable's detector rules (contrast, focus states, gray-on-color, nested cards) remain
fully in scope and should run in CI.

### Standalone browser harness

The webview is built so its HTML/CSS/JS also render in a plain browser, via a dev harness
that supplies mock commit data and a shim defining the `--vscode-*` variables for dark,
light and high-contrast.

This is a deliberate architectural choice with three payoffs: design iteration in a browser
reload instead of an extension-host restart, impeccable's live iteration and detectors work
against the real markup, and theme correctness becomes testable rather than hoped for.

The harness is dev-only — gitignored output, excluded from the VSIX.

---

## 7. Privacy: Neutral Fixtures Are a Constraint

Polylog's subject matter is multi-repo workspaces, and the one it was designed against is a
private employer monorepo. Every fixture, screenshot, test name, doc example and changelog
entry will be tempted toward those real names.

**Rule: no employer name, no internal repository, service, branch, ticket or module names
anywhere in this repository** — including test fixtures, design docs, the CHANGELOG, the
README and every screenshot or recording.

Canonical placeholders: `acme-web`, `acme-api`, `acme-libs`, `origin/release-1.4`, authors
`dana` / `rin`.

This is enforced, not merely intended: **CI fails on a denylist grep** of those strings
across the tree. The precedent is direct — in a sibling project an employer org name and
internal module paths reached both marketplaces inside a shipped VSIX before they were
caught and scrubbed. A CI check is cheaper than a scrub release.

Related: the repository carries a **local** git identity (`lntvan166 <lntvan166@gmail.com>`)
overriding the machine's global work identity, so commits are never authored with a work
address.

---

## 8. Packaging

| Field | Value |
|---|---|
| `name` | `polylog` |
| `displayName` | `Polylog — Multi-Repo Git Log` |
| `publisher` | `lntvan166` |
| `license` | MIT |
| `categories` | SCM Providers |
| `keywords` | git, log, history, multi-repo, monorepo, polyrepo, multi-root, commits, workspace |
| `activationEvents` | `onCommand:polylog.open` (lazy — nothing runs until asked) |

Build and release follow the sibling project's proven setup: TypeScript bundled with
esbuild, eslint + `tsc --noEmit` in CI across Linux/macOS/Windows, `.vscodeignore` excluding
`docs/`, `.claude/`, `CLAUDE.md` and the dev harness, and publication to both the VS Code
Marketplace (`vsce`) and Open VSX (`ovsx`) so Cursor, VSCodium and Windsurf auto-update.

Publishing is gated behind a `release` skill and never happens unprompted.

### Settings

| Setting | Default | Purpose |
|---|---|---|
| `polylog.pageSize` | 200 | Commits fetched per repo per page |
| `polylog.maxConcurrency` | 16 | Parallel `git log` processes |
| `polylog.scanDepth` | 2 | Fallback discovery depth when the git extension reports nothing |
| `polylog.excludeRepos` | `[]` | Glob patterns for repos to leave out |

---

## 9. Open Questions

Deferred deliberately; none blocks the implementation plan.

1. **Worktrees.** VS Code reports a git worktree as its own repository, so worktrees of the same repo would appear as separate rows sharing commits. Acceptable for v1; revisit if it reads as duplication in practice.
2. **`--all` versus checked-out branch.** v1 searches the current branch's history. Whether to offer an "all branches" toggle depends on whether users miss it.
3. **Marketplace icon and demo GIF.** Needed before the first publish, not before the first build.
