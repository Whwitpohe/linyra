# Product

<!-- impeccable:product-schema 1 -->

Linyra is independently maintained from [Polylog](https://github.com/lntvan166/polylog)
under the extension identity `whwitpohe.linyra`. The original MIT copyright remains intact.

## Platform

web

A VS Code panel view with an integrated Log and Changes surface, next to Terminal. Branch comparison
uses another integrated surface with Repositories, Left and Right regions. Both render in a plain browser through the
dev harness (spec §6), which is where design iteration and detectors run.

## Stack

Decided by the design spec: TypeScript bundled with esbuild, no framework in the webview.
Plain HTML/CSS/JS inside the webview; the extension host side uses the VS Code API.

## Users

Developers whose VS Code workspace holds many git repositories side by side: polyrepo
services, a vendored dependency next to its consumer, a docs repo beside its product. Many
come from JetBrains IDEs and miss the VCS Log window that merges every root into one
timeline. Their job: find a change — by message, ticket id or feature name — without
knowing in advance which repository it landed in.

## Product Purpose

One merged, filterable git log across every repository in the workspace. Click a commit to
see its changed files; click a file to open it in VS Code's native diff editor.

Success: a user searching for a term sees every matching commit across all repositories in
one list, fast enough that it feels like filtering, not searching.

## Positioning

Every other VS Code git extension (GitLens, GitCharm, Git Graph, Git History) gives a
repository picker — one repo's history at a time. Linyra merges the log. That is the whole
product; everything else is a non-goal.

## Operating Context

- Lives in the bottom panel beside Terminal; diffs open in the editor area above. Opened on
  demand via `linyra.open`.
- Workspaces range from a handful of repos to dozens (designed against 68 repos, 16k
  commits).
- Keyboard-driven audience: ↑/↓ selection, Enter to open, `/` or Ctrl/Cmd+F to search,
  Esc to clear, Tab between regions.
- The user's own VS Code theme — light, dark or high-contrast — is the environment. Linyra
  does not bring its own.

## Capabilities and Constraints

- History reads, hash lookup and graph folding are read-only. Explicit repository and branch
  actions provide fetch, pull, staging, commit and branch management with repository/ref validation.
- The graph uses real parent ids and repository-qualified identities; it never connects unrelated roots.
- Filters include message text, multiple authors, repository subset, date, path and multiple
  branches. All local/remote branches are the default; hash lookup temporarily ignores other filters.
- No index, cache or database; every filter is pushed down into `git log` flags.
- Ordering is by committer date or Git topology, with bounded continuation across pages;
  the chosen mode and its cross-repository behavior are visible.
- One failing repository is contained to a dismissible notice; it never fails the others.
- Open (spec §9): worktree duplication, an "all branches" toggle, marketplace icon and demo
  GIF.

## Brand Commitments

- **Binding visual constraint:** the panel must be indistinguishable from VS Code's own
  chrome under any theme. All color and type come from `--vscode-*` CSS custom properties;
  no hard-coded color, no bundled font, no light/dark assumption. Must render correctly in
  light, dark and high-contrast. Expressive design work (distinctive palette, typography,
  personality) is out of scope by decision.
- Every repository gets a tinted chip from six theme hues — five `--vscode-charts-*` plus
  `--vscode-terminal-ansiCyan`, since `charts-orange` vanishes in real themes (maintainer
  decision, 2026-09-23, amending spec §4). A repo's hue comes from its name and never
  changes with the filter (panel spec §18). The name is always printed; color is a marker.
  High-contrast themes use an outline instead of a tint.
- **Voice:** like VS Code itself. Short, plain, factual. Name the cause and the fix. No
  personality, no jokes, no exclamation marks.
- Fixtures and examples use neutral placeholders only: repos `acme-web`, `acme-api`,
  `acme-libs`; branch `origin/release-1.4`; authors `dana`, `rin`.

## Evidence on Hand

- Benchmark (spec §2): 68 repos / 16,314 commits — `git log -n 50` fan-out 25 ms at 16-way
  parallel (330 ms serial); whole-history `--grep` 640 ms serial. Warm cache, Linux, NVMe;
  re-measure on cold cache or network filesystems before citing it more broadly.
- No users, testimonials, screenshots or demo recordings exist yet. Do not fabricate them.

## Product Principles

1. **Merging is the product.** Any feature that doesn't serve one merged log is a non-goal.
2. **Git does the work.** Filters become `git log` arguments; JavaScript only merges
   already-filtered streams.
3. **Belong to the editor.** It should look and behave like a native VS Code view, not a
   branded app inside one.
4. **Never block.** The extension host is shared; everything is async, debounced and
   cancellable.
5. **Every state is designed.** Loading, empty, filtered-empty, no-repos and partial failure
   each say what happened and what to do.

## Accessibility & Inclusion

WCAG 2.2 AA. Full keyboard operation, visible focus via `--vscode-focusBorder` at all
times, grid semantics (`role="row"` / `role="gridcell"`) on the virtualized list with a
single tab stop and roving `tabindex`, accessible names on every icon-only control, and
correct rendering in high-contrast themes.
