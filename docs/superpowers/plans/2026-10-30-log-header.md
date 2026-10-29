# The Log's column header

The maintainer, comparing with GitLens's Commit Graph: a header over the Log's columns, so each
column can be resized, and each column's options sit on it (shown on hover) instead of in the ⋯
menu. "Its headers line up with the rows below, and hovering one shows its options."

## What it is

One row above the commits, inside the grid (`role="row"` of `role="columnheader"` cells), sticky
at the top of `#list`, on the Commits side only (the Uncommitted side is another list). Its cells
are the rows' cells: one column template drives both, so they cannot drift.

| Column | Header | On hover / focus | Menu |
|---|---|---|---|
| Repository | Repository | Show/Hide Repo List (moves the toolbar's mislabeled "Group by Repository" here) | — |
| Graph | graph icon | ▾ | By commit date · By branch structure (topological) · Collapse/Expand Linear Branches |
| Message | Message | search icon: focuses the Search box | — |
| Hash (optional) | Hash | — | — |
| Author | Author | filter icon: opens the Author box's picker; filled while an author filter is on | — |
| Changes (optional) | Changes | ▾ | Numbers · Squares · Bar · Bipolar Bar |
| Date | Date | filter icon: opens the date range; filled while a range other than All is on | Relative · Absolute time |

An option's state is never only on hover: a filled filter icon, the graph icon pressed while
topological, stay visible. Right-click anywhere on the header, or the gear at its right end (on
hover), opens **Columns**: a checkbox per optional column (Repository name, Hash, Author,
Changes, Date) and Reset Column Widths. Graph and Message always show.

No sorting by clicking a header: sorting by author or message would tear the graph apart. Only
the Graph column decides the order (date or topological), as its menu says.

## Resizing

A sash on each column's inner edge (the edge toward Message): Repository and Graph on their right
edge, Hash, Author, Changes and Date on their left. VS Code's sash look (`--vscode-sash-hoverBorder`),
`col-resize` cursor; double-click puts the column back to its automatic width. Message takes the
rest and keeps at least 120 px. Widths are saved by the host with the other view options
(globalState), as numbers of px, and clamped to each column's range when read.

The Changes column picks its drawing stage from its own width when the user sized it, from the
Log's width otherwise (today's `stageFor`). The graph's width is what its lanes need, up to the
user's width (today: up to 24% of the Log).

## One column model

`src/webview/logColumns.ts`, pure: from the mode (Log or File History), the list's width, the
font's `ch`, the longest repository name, the graph's lane count, the optional columns shown and
the saved widths, it returns the columns in order with their pixel widths and the template
string. `CommitList.paint()` writes it once per full paint as `--log-columns` on `.list-pane`;
`.row`, the header and File History's work row all use `grid-template-columns: var(--log-columns)`.

That replaces the nine templates spread over `styles.css`, `changesColumn.css` and `history.css`
(hash column, Changes column, File History, and their ≤720 / ≤440 px variants). The narrow
variants become the model's: below 720 px the repository is a 3 px band, Hash and Author go;
File History narrows its change column. `fitNames` takes the repository column's width from the
model instead of re-deriving the CSS formula.

Rows already rebuild on every full paint (a resize, new props), so a template change needs no
new rebuild. A drag repaints at most once per frame and reads no layout per row.

## Menus

`src/webview/ui/menu.ts`: one popup menu (anchor, items, radio/checkbox/separator, ↑↓ Home End,
Esc, outside click, focus back to its button). The ⋯ menu and the sort menu move onto it; the
header's menus use it. The ⋯ menu loses Show Hash Column and the Changes drawings (now on the
header); Topological order leaves the filter bar's sort button (now the Graph header's menu).

## Keyboard and screen readers

The header is one Tab stop: a roving tabindex across its buttons, ←/→ move, Enter/Space open,
Shift+F10 or the context-menu key opens Columns. Each cell is a `columnheader`, so a screen reader
names the column of every cell it reads. No `aria-sort`: it means "sorted by this column", which
the Log never is; the Graph header's button says the order in its label ("Graph: by commit date").

## Tests (three angles)

1. Unit: `logColumns` (each mode, width stage, saved widths clamped, Message's minimum, the
   Changes stage from a sized column), `menu` keyboard model where it is pure.
2. Harness (Playwright, four themes, narrow and wide): header cells line up with row cells (each
   column's left/right equal to the rows', ±0.5 px); drag a sash → header and rows widen
   together, the saved width posted; double-click resets; hover shows the controls, focus too;
   each menu changes what it says; Columns hides and shows columns; right-click and Shift+F10
   open Columns; File History's header; no layout read per row while dragging (performance
   observer: one layout per frame).
3. Integration (real VS Code): the saved widths and hidden columns come back after a reload.

Plus a look at the screenshots, an independent review, and `node dev/perf/scrollBench.mjs`
before/after (the header must not cost a scrolling frame anything).
