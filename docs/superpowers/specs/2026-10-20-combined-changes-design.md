# Combined Changes: several commits, one Changes tree — Design

Status: approved in brainstorming on 2026-10-20. The interactive demo (brainstorm companion,
`.superpowers/brainstorm/3153255-1792471689/content/session-changes-demo.html`, not committed) is
the visual reference. Part names follow the UI Map (`dev/ui-map/index.html`, `/ui-map`).

## 1. Goal

One piece of work often lands as several commits spread across several repositories: in
`acme-web`, commit `a` fixes `header.ts`, `b` fixes `header.css`, `c` fixes `header.ts` again,
and meanwhile two commits went into `acme-api`. Today the Changes view shows one commit at a time,
so following what the session did to `header.ts` means opening `a`, then `c`, and adding the
changes up in your head.

**Combined Changes:** select several commits in the Log view, in any repositories. The Changes
view then lists **each file once**, grouped by repository, and a file's diff shows **only what the
selected commits did to it**:

- **right side** — the real file after the newest selected commit that touched it;
- **left side** — that same file with the selected commits' changes taken back out.

Edits from commits **not** selected, such as a teammate's commit between `a` and `c`, appear on
both sides as unchanged context. They are visible, but they are not shown as changes. The maintainer
chose this explicitly over the simpler "file before `a` ↔ file after `c`" diff.

### Non-goals

- Squashing, rebasing, cherry-picking, or making a PR or patch from the selection. It is read-only.
- Choosing commits automatically ("all my commits since 9:00"). Commits are picked by hand. The
  existing Author and Date range filters already narrow the list to pick from.
- Multi-select on the Uncommitted side of the Log, in the Compare tab, or in File History.
- Any index, cache or stored "session". A selection lives only as long as it stays selected
  (CLAUDE.md constraint 1).

### Anti-goals (this is a failure even if it technically works)

- A diff that silently passes someone else's changes off as part of the selection. When the
  selected changes can't be shown apart from them, the view **says so** (section 4.3); it never
  shows a wrong diff, and it never shows an error instead of a diff.
- Any change to how a **plain single click** behaves today.
- Touching the user's repository: no checkout, worktree, index, ref or stash, and no objects
  written to `.git` (section 4.2).

## 2. Selecting commits (Log view, Commit list)

| # | Rule |
|---|------|
| 1 | **Click** selects one commit, exactly as today; the Changes view shows that commit as today. |
| 2 | **Ctrl-click** (⌘-click on macOS) adds or removes a commit. Removing the last one leaves it selected (there is always at least one). |
| 3 | **Shift-click** selects every listed commit from the anchor (the last plain-clicked or Ctrl-clicked row) to the clicked row, across repositories, in list order. **Ctrl+Shift-click** adds that range to the selection. |
| 4 | Keyboard: **Shift+↑/↓** extends the selection from the anchor; **↑/↓** alone goes back to a single selection. (My call: no Ctrl+A, since a list can hold thousands of rows.) |
| 5 | Selected rows use `list.inactiveSelectionBackground`, and the focused row uses `list.activeSelectionBackground`, as in VS Code's own lists. Every selected row has `aria-selected="true"`, and the list sets `aria-multiselectable="true"`. In high contrast, selected rows get a dotted `focusBorder` outline and the focused row a dashed one. |
| 6 | **Limit (my call): 100 commits.** A click past the limit does nothing, and a notice in the Log footer says "Combined Changes shows up to 100 commits". |
| 7 | When the list reloads (a filter change, Refresh, Load more), selected commits that are still listed stay selected and the rest drop. If none are left, the selection behaves as today when the selected commit leaves the list. |
| 8 | **Enter** with several selected opens the first file of the combined tree (as `openFirst` does for one commit). |
| 9 | The Commit menu (right-click) acts on the right-clicked row only, as today. Right-clicking a row outside the selection selects just that row first, the way VS Code's lists behave. No new menu items. |

## 3. The Changes view with several commits

When two or more commits are selected, the native `polylog.changes` tree switches to combined mode.
With one commit selected, everything is exactly as today.

| # | Rule |
|---|------|
| 1 | **View description** (next to "Changes"): `4 commits · 2 repositories`. |
| 2 | A **Clear Selection** title action (`$(clear-all)`), shown only in combined mode (context key `polylog.combined`), goes back to the focused commit alone. |
| 3 | **Root nodes are repositories**, in Repo List order. Each has its accent, and a tooltip listing its selected commits (short sha, subject, author, date). There is no commit node: the selection is not one commit. |
| 4 | Under each repository there is one **folder tree of changed files**, built by the same `fileTree` code the single-commit view uses. **Each file appears once**, however many selected commits touched it. |
| 5 | A **File row's** description shows the short shas of the selected commits that touched it, oldest first (`a3f9 · c7d2`). Its decoration badge is the **net status** (section 4.4), using the same `gitDecoration.*` colors as today. |
| 6 | A file whose selected changes cannot be shown apart (section 4.3) gets a `$(warning)` icon in its description, and a tooltip naming the unselected commits included: "Includes changes from 1 unselected commit: 9c4e1a8 header: wider title…". |
| 7 | A file added and then deleted within the selection, or whose selected changes cancel out (left side equals right side), is **left out**. A message row at the end of the tree names them: "2 files with no net change: src/debug.ts, src/nav.ts". (My call. On the fast path, compare the oldest commit's before-blob with the newest commit's after-blob from `--raw`. On the slow path the merge has already run.) |
| 8 | Clicking a file opens the diff (section 4). The existing file actions (Open File, Copy Path, Copy Relative Path, File History) work as they do for a file of the newest selected commit that touched it. |
| 9 | **All Files** is not available in combined mode (it shows one commit's whole tree). Its toggle is hidden while `polylog.combined` is set, and the user's choice is kept for when one commit is selected again. |
| 10 | Changing the selection kills any reads still in flight for the previous one, and does not wait for them (constraint 4). |

## 4. Reading and the diff

### 4.1 Building the tree (per repository with selected commits, in parallel through the existing pool)

1. One `git show --raw --numstat -z -M --diff-merges=first-parent --format=… <sha…>` per
   repository, listing every selected commit of that repository, gives each selected commit's
   files and statuses. These are the same flags `showArgs` uses, extended to several commits. The
   builder may split this into one spawn per commit if parsing several is awkward.
2. One `git log --raw -z -M --diff-merges=first-parent --format=%H <newest> --not <oldest>^` per
   repository lists the commits **in the range**, so we know which files an **unselected** commit
   in that range also touched. `--diff-merges=first-parent` is required: without it, a teammate's
   change that came in through an unselected merge would be invisible. (For a root commit, drop
   `--not`.) A file takes the **fast path** when no unselected commit in range touched it **and**
   every selected commit that touched it is an ancestor of the newest of them. Its left side is then
   simply `<oldest selected that touched it>^:<path>`. Most files take this path. Every other file
   takes the slow path.
3. For the remaining files (touched by both selected and unselected commits in range), compute
   the left side now (4.2) to know whether to show ⚠. These computations go through the same
   pool, are bounded, and are killed on a selection change.

### 4.2 The left side ("selected changes taken out")

For one file in one repository, let `S` be the selected commits that touched it, ordered oldest
to newest (in topological order; see 4.5), and `last` the newest of them.

- **Right:** `last:<path>`, the real blob, served by the existing `polylog:` revision URI.
- **Left:** start from the right side's text. For each commit `s` in `S`, **newest first**, revert
  `s`'s change to the file with a three-way line merge: *base* = `s:<path>`, *ours* = the
  text so far, *theirs* = `s^:<path>` (first parent). A missing side (added or deleted) counts as
  an empty file that does not exist.
- If every revert merges cleanly, the result is the left side.
- If any revert conflicts, the file **falls back** (4.3).

**My call: do the three-way merge in a pure TypeScript module** (`lineMerge.ts`: a line diff
plus diff3, no `vscode` import, no dependency) rather than with `git merge-file` or
`git merge-tree`. Both git routes need the intermediate text stored as a blob, which writes
objects into the user's `.git`, and that breaks the anti-goal. The inputs are read with `git show
<sha>:<path>`, and nothing is cached: the content provider reads and merges each time VS Code asks
(constraint 1).

**Clean versus conflict follows `git merge-file`'s rule (my call).** Changes on adjacent lines,
with no unchanged line between them, count as a conflict. This is the conservative choice, and it
serves the anti-goal. Unit tests use `git merge-file -p` as an oracle, run on temp files in a
scratch directory and never in the user's repository. Line alignment (Myers, not xdiff's
heuristics) can still differ from git on repeated lines. So a **round-trip guard** backs it up:
the selected changes put back onto the computed left side must reproduce the right side byte
for byte, or the file takes the fallback. A diff over 2,000 edited lines also falls back, as
"too large", to keep the merge short on the extension host.

**Limits (my call):** binary files, and files over **1 MB or 20,000 lines** on any side, skip the
merge and take the fallback. Their title is labeled "binary" or "too large" instead of naming
unselected commits. The merge runs on the host thread (no worker); this cap is what keeps it short
(constraint 4).

The left document is a new `polylog:` URI kind: `{ root, ref: last, path, without: [sha…] }`.
`decodeRevision` validates every entry of `without` as a sha, and the `RevisionProvider` computes
the merge when `without` is present. Because the URI carries the whole selection, VS Code can
reopen it after a restart and get the same text.

### 4.3 Fallback: when the changes can't be shown apart

If an unselected commit in range edited the same lines as a selected one, git cannot separate
them. The file then shows the plain range diff: **left** = `<oldest in S>^:<path>`, **right** =
`last:<path>`. It also gets:

- the ⚠ on its File row (section 3, row 6);
- a diff editor title that says so: `header.css (a3f91c2^ ↔ c7d20e5, includes 1 unselected commit)`.
  VS Code's diff editor has no banner area, so the title carries the message.

### 4.4 Net status of a file

Taken from the selected commits' `--raw` statuses for that path, oldest to newest:

| First | Last | Shown |
|-------|------|-------|
| A | D | left out (section 3, row 7) |
| A | anything else | A |
| anything | D | D |
| D | A (re-added) | M |
| otherwise | | M |

**Renames:** a rename inside the selection is followed by path, so the old path's changes and the
new path's changes are one file, shown as R with the newest path. The left side reads the old path
at each step. If following it gets ambiguous (a copy, or a rename by an unselected commit), the
file takes the fallback (4.3).

### 4.5 Ordering and branches

Selected commits in one repository are ordered by `git rev-list --topo-order --no-walk`. If they
are not all on one line of history (some on another branch), **my call** is to compute the same
way: `last` is the topologically newest, and a revert that doesn't merge falls back with ⚠. No
separate "branches" mode.

Merge commits diff against their first parent, as today.

### 4.6 Diff editor title

- Clean: `header.ts (2 selected commits)`
- Fallback: `header.css (a3f91c2^ ↔ c7d20e5, includes 1 unselected commit)`
- Only one selected commit touched the file and it took the fast path: today's format,
  `header.ts (a3f91c2) — acme-web`.

## 5. Structure

Pure modules (no `vscode`), each with a `*.test.ts` appended to `test:unit`:

- `selectionModel.ts`: click, Ctrl-click, Shift-click, Shift+arrow, the limit, and keeping the
  selection across reloads. The webview uses it.
- `lineMerge.ts`: line diff and diff3. It returns merged text or "conflict".
- `combinedModel.ts`: from per-commit `--raw` records plus the range log, works out each file's
  net status, its selected shas, whether it may conflict, renames, and the left/right refs. It
  also builds the tree descriptors for `changesModel`.

Thin, VS Code-facing changes:

- `protocol.ts`: `select` becomes `{ type: "select"; items: { repoId; sha }[]; focus: { repoId; sha } }`.
  The host validates every entry and applies the limit again (webview input is untrusted). A new
  host-to-webview message, `{ type: "setSelection"; items; focus }`, carries Clear Selection (and
  any other selection change that starts on the host) back to the list.
- Repository accents in the native tree: the host computes the same assignment the webview's
  `assignAccents` makes. Move it into a shared pure module, so the two cannot drift.
- `logView.ts`: one selected commit goes down the existing path, and several go down the combined
  path. Reads for a superseded selection are aborted.
- `changesTree.ts` / `changesModel.ts`: repository root nodes, the combined description, and the
  ⚠ and message rows.
- `revisionUri.ts` / `revisionProvider.ts`: the `without` field.
- `webview/list.ts` / `webview/main.ts`: multi-selection rendering, keys and ARIA.
- `package.json`: the Clear Selection command and title action, `polylog.combined` hiding the All
  Files toggle.

## 6. Testing

- **Unit:** `selectionModel` (every click and key rule in section 2), `lineMerge` (clean revert
  with an unrelated edit at least one line away, an adjacent or overlapping edit gives a conflict,
  added and deleted sides, empty files, trailing newline, agreement with the `git merge-file`
  oracle on a table of cases), `combinedModel` (the net status table, add-then-delete and
  net-zero files left out, renames, the fast path versus the slow path, including an unselected
  merge in range and selected commits on two branches).
- **Integration** (`*.itest.ts`, isolated `$HOME`), with a fixture workspace built from the demo:
  `acme-web` gets `a` (dana: header.ts, header.css, debug.ts added), `x` (rin: header.ts on a
  different line, header.css on the **same** line as `a`) and `c` (dana: header.ts, header.css,
  debug.ts deleted); `acme-api` gets two commits by dana and one by rin. The tests select
  `a, c` plus the two `acme-api` commits and check:
  - the tree has the repository roots, each file once, the net statuses, debug.ts left out with its
    message row, and the ⚠ on header.css only;
  - header.ts's left text contains rin's line 3 unchanged and lacks dana's lines, and its right
    text is `c:src/header.ts`;
  - header.css's diff is `a^ ↔ c` and its title names the included commit;
  - a plain click afterwards restores today's single-commit tree unchanged;
  - `git status --porcelain` and `.git/objects` are unchanged after all of it.
- **Theme:** the browser harness gets mock multi-selection rows. Check dark, light and high
  contrast, as for every webview change.

## 7. Docs

- README: a short "Combined Changes" section (select with Ctrl/Shift, what the diff shows, what ⚠
  means). Images, if any, use absolute `raw.githubusercontent.com` URLs.
- UI Map: add the Changes view's combined mode (repository roots, ⚠ File row, message row, Clear
  Selection) and multi-selected Commit rows; run `/ui-map`.
- CHANGELOG and version stay untouched (constraint 5).

## 8. Risks

- **The merge being subtly wrong** is the worst outcome, because it is exactly the anti-goal.
  Mitigation: `lineMerge` is small, pure and heavily unit-tested, and when in doubt it falls back.
  "Conflict" is the safe answer.
- **Cost on large selections:** the fast path covers most files. The slow path is bounded by the
  pool and the 100-commit limit, and is aborted on change.
- **Protocol change to `select`:** every sender and the integration tests' snapshot seams move to
  the list form in one change.
