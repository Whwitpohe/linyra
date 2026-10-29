# File trees — one tree of changed files, the same rows and keys everywhere

Linyra draws a tree of changed files in three places. Two are webview code with their own rows,
keys, selection and rendering; the third is VS Code's native tree. This plan makes the two
webview trees one component that looks and works like the native one, then makes it fast with
hundreds of files.

## The three trees today

| | Changes view | Compare's sides | Commit side bar |
|---|---|---|---|
| Code | `src/webview/changes/view.ts` | `src/webview/compare/sideTree.ts` | `src/commitPanel.ts` (`linyra.commit`) |
| Kind | webview | webview | **native TreeView** (checkboxes, Group By) |
| Rows | file, folder, repo | file, folder, repo, commit, "Show N more" | list, repo, folder, file |
| Built by | host `fileTree()` (compressed folders) | host `fileTree()` | host `fileTree()` |

The Commit side bar stays native. CLAUDE.md prefers a native view where one exists: only a native
tree gets the user's file icon theme, its checkboxes (`manageCheckboxStateManually`), VS Code's own
type-to-find and its virtualized list. Moving it into a webview would lose all four. So the shared
component has no checkbox option and no Changes / Unversioned Files groups: no webview tree has
them. Instead, the webview trees copy the native tree's looks and keys, so all three work alike.

Folder compression is already shared: all three build on `src/fileTree.ts`, which joins
single-child folder chains ("internal/upload"). The Changes view's All Files mode reads one folder
at a time (`git ls-tree`), so it cannot know a folder has one child before reading it, and does not
compress. The component draws whatever tree the host sends.

### Every behavior that differs between the two webview trees

| Behavior | Changes view | Compare's side | Chosen | Why |
|---|---|---|---|---|
| Indent | 8 px + 14 per level | 5 px + 14 per level | 8 + 14 | VS Code's tree starts at 8 px; 14 per level both agree on |
| Twisty | 16 px `<button>` in the row, chevron rotated by CSS | 18 px `<button>`, icon swapped | 16 px `aria-hidden` span, rotated | A button inside a treeitem is a nested control screen readers stumble on; `aria-expanded` and ← → already say it |
| File type marks | js jsx mjs ts tsx vue json css scss md html, "JS" "TS" | js jsx ts tsx vue json css, "JSX" "TSX" "CSS" | union, short marks (JS, TS, #, {}, V, M↓, <>) | One mark per language, the narrower one fits 16 px |
| Repository row icon | folder | repo | repo | It is a repository |
| "Show N more" icon | — | file | none (blank column) | It is not a file |
| Rename's old path | right after the name, in the row's status color | in the end block, muted | right after the name, muted | Read with the name, as Source Control and GitLens show it; muted like every description |
| Folder count, commit description | foreground, 11 px | foreground, 11 px | muted, 11 px | VS Code's tree descriptions are muted |
| Note (staged, binary, new, conflict, already on both) | "staged" or the description | muted note | muted note, before the counts | Same place, same look |
| Already on both / conflict | — | dimmed / conflict color row | kept, as row flags | Compare's |
| Click on a folder | toggles it | selects only (twisty toggles) | toggles it | VS Code's default (`workbench.tree.expandMode: singleClick`) |
| Shift-click | range from the anchor | range from the focused row; focus stays | range from the anchor | VS Code's |
| Ctrl+Shift-click | adds the range | — | adds the range | Changes' |
| Shift+↑↓ (Home End PgUp PgDn) | extends the range | moves only | extends the range | VS Code's `list.expandSelectionDown` |
| Ctrl+↑↓ | toggles the next row into the selection | moves only | moves the focus, selection kept; Ctrl+Space toggles the focused row | Changes' could not pass a row without selecting it; this is the Windows list convention, so any set of rows can be picked from the keyboard |
| Space | selects the focused row | nothing | folder: toggles it (VS Code `list.toggleExpand`); file: selects it; Ctrl+Space toggles; Shift+Space range | A checkbox would take Space, but no webview tree has one |
| Ctrl+A | selects all rows | nothing | selects all rows | VS Code `list.selectAll`; Cherry-Pick takes several |
| Type-to-find | — | — (the native Commit tree has VS Code's) | typing a name's first letters focuses the next match; the same letter again cycles | The native tree has it; VS Code's lists do it |
| Focus when the tree gets focus | none (↓ then skips the first row) | none (same) | the first row is focused, not selected | VS Code's; no skipped row |
| Focused row hidden by a collapse | focus dropped | kept on the hidden row | moves to the nearest shown parent; a new page with the tree focused focuses the row nearest | VS Code's; a focused tree always shows where |
| A mouse press in an unfocused tree | — | — | focuses the pressed row (never the first row on the way) | No outline jumping to the top |
| High contrast | selected rows outlined | — | selected outlined, hover dashed | VS Code's high-contrast lists |
| Outline around the whole tree on keyboard focus | yes | yes | no: the focused row's outline shows where focus is | VS Code's lists |
| Filter matches | files by name, path, old path | any row by label, tooltip, description (a folder's count, "1", matched) | a row matches by its own text (files: name, path, old path, note; commits: subject, author, hash; folders, repositories: name); every row under a match shows | A matching folder or commit used to show with none of its files |
| Filter: folders | counts recounted | counts kept | recounted | Says what is shown |
| Filter: collapse | a search's own collapse state, reset each keystroke; the tree's comes back after | the tree's own state, parents forced open | the search's own state | Clearing the search gives back the tree as it was |
| Filter: unread commits | — | forced open, so each one read (a git process each); Expand All read every commit on the side | stay closed until opened; Expand All reads the shown ones | Constraint 1: count git processes |
| Filter: count, nothing-matches text | "3 of 301 files", "No files match “x”." | — | both views say nothing matches; the Changes view keeps its count | Compare's empty tree said nothing |
| Filter: Enter, ↓ | Enter opens the first file | — | Enter opens the first file; ↓ moves into the tree | One filter |
| Filter: Ctrl+F | focuses the filter | — | focuses that tree's filter | One filter |
| Selection sent while filtering | only shown files (a filtered folder must not bulk-act on hidden files) | everything picked | shown files, and Compare's commits | The Changes view's reason holds for Compare's folders; a commit is cherry-picked whole either way |
| Selection sent after a page with the same key | yes (every redraw sent it) | no | yes, once per page | The host drops its selection when it draws a page (the working tree refreshed, Compare's Refresh) |
| Selection pruned to shown rows | yes | no | yes | What is acted on is what is seen |
| Expanded state kept | in the view's state | per page key | unchanged (each view's own) | — |

Kept exactly: row height (25 px, both agree), Enter on a file or "more" opens it, Enter or a
click on a folder toggles it, → opens a folder or goes to its first child, ← closes it or goes to
the parent, right-click keeps the selection it is in, Shift-click selects no text, each view's
default collapse (All Files' unchanged folders; Compare's commits), lazy reads (All Files'
folders, Compare's commits), Expand All asking the host, File History's reveal, and every
message to the host.

## Design

- `src/webview/ui/fileTreeModel.ts` (pure, tested): `flattenTree` (rows, depth, parent,
  position among siblings, open branches still to read), `filterTree`, the keyboard as a function
  of rows and key (`treeKey`), range and toggle selection, type-to-find (`findByPrefix`), and the
  window of rows on screen (`rowWindow`, `scrollToShow`).
- `src/webview/ui/fileTree.ts` + `fileTree.css`: `FileTree<N>`, one class both views mount. Each
  view says what a row draws (`RowParts`: icon, label, status, old path, note, lines,
  description, flags, tooltip, context menu), which rows open onto others, which are read lazily,
  and what to tell the host (open, opened, needs children, selection).
- Rows are positioned absolutely in a sizer as tall as all rows; only the rows on screen (plus a
  few) and the focused one exist. A row element is kept while its node, depth and open state are
  the same; selection and focus change two rows' classes, not all of them. No layout is read per
  row: the view's height comes from a ResizeObserver, scrolling to a row is arithmetic.

## Performance

`node dev/perf/fileTreeBench.mjs` (CPU ×4, median of 8, ms, from the input to two frames after;
three runs). Changes: `changes.html?state=many`, 301 files under two folders. Compare:
`repos.html?files=many`, 480 files in 40 folders on a side.

Two frames (33 ms) is the floor of a single action, one frame (16.7 ms) of a held key. The median
of the three runs' medians:

| Case | Changes before | Changes after | Compare before | Compare after |
|---|---:|---:|---:|---:|
| First render | 349 | 66 | 419 | 83 |
| Collapse All | 33 | 34 | 487 | 49 |
| Expand All | 217 | 50 | 514 | 51 |
| A filter keystroke | 50 | 33 | 550 | 34 |
| Clearing the filter | 271 | 83 | 617 | 67 |
| Holding ↓, per press | 30 | 17 | 71 | 20 |
| Holding ↓, longest press | 38 | 20 | 108 | 40 |
| Rows in the DOM | 303 | 35 | 523 | 46 |

The synchronous part of a first render (the page message, then style and layout forced): Changes
289 → 42 ms, Compare 628 → 49 ms.

What made the difference:

- Only the rows on screen (and the focused one) exist: 35 or 46 instead of 303 or 523.
- A row keeps its element while its node, depth and open state are the same. Moving the
  selection repaints two rows; before, every row's classes and attributes were set on every move.
- Compare's open state was found by searching all rows for each branch (quadratic): Collapse All
  took half a second with 480 files. The flattening knows it.
- No layout is read per row: `scrollIntoView` on every move became arithmetic, and the height
  comes from a ResizeObserver.
- A first version still held ↓ at two frames a press: rows that had left the screen were removed
  after the reordering pass, so every scroll by a row moved all of them (420 elements restyled,
  707 of 811 layout objects dirty). Removing them first leaves 36 and 27; `contain` on the tree
  and its rows keeps a redrawn row's layout and paint to itself.

Commit side bar (native): `dev/perf/commitTreeBench.ts`, the host model at full speed:
300 files 1.8 ms to describe, 1000 files 4.1 ms, 3000 files 9.2 ms; a folder's check and the
redraw after it about the same. VS Code's tree draws only the rows on screen. Nothing to fix.

## Review

An independent review (a subagent reading the code and the old views, not this plan's reasoning)
found, and the branch fixed, each with a harness spec that fails without the fix:

- The host lost the Changes view's selection when a page with the same key arrived (the
  Uncommitted side refreshes on every working-tree change): a menu then acted on one file only.
  Every page now sends the selection again.
- A tree reset while hidden showed blank space when shown: a hidden element ignores a scroll
  written to it. The ResizeObserver writes the tree's own scroll when it is shown again, and no
  layout is read while hidden.
- Filtering Compare's commits sent no commit in the selection, so Cherry-Pick took one of several.
- A mouse press focused the first row before the pressed one; a new page could leave a focused
  tree with no focused row.
- Expand All while filtering read every commit on the side (before this change too).
- Smaller: "No commits match" in All repositories, the Changes filter reading the note it draws,
  a protocol comment.

## Tests

1. Unit (`src/webview/ui/fileTreeModel.test.ts`, `src/fileTree.test.ts`): building and
   compressing, flattening (collapse, depth, positions, lazy), filtering, every key, range and
   toggle selection, type-to-find, the window and scrolling.
2. Harness specs (`dev/harness/tests/fileTree.spec.mjs`, and `fileStatus`, `compare`, `polish`
   with the shared markup's selectors), four themes and a narrow width: the same row parts in both
   views, keys, mouse, filter, a long tree drawing only its window.
3. Integration (`LINYRA_VSCODE_VERSION=1.144.0` and `1.85.0`): the suites driving the Changes
   view, Compare and the Commit side bar; the messages to the host are unchanged.

## Steps

1. Bench and harness scenario (`?files=many`), this plan.
2. The pure model and its tests.
3. The component and its CSS.
4. The Changes view on it.
5. Compare's sides on it.
6. Specs, numbers, review.
