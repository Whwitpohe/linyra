# Linyra

**One Git timeline for every repository in your workspace.**

[简体中文](https://github.com/Whwitpohe/polylog/blob/main/README.zh-CN.md) · [Install from Marketplace](https://marketplace.visualstudio.com/items?itemName=whwitpohe.linyra) · [Download VSIX](https://github.com/Whwitpohe/polylog/releases) · [Report an issue](https://github.com/Whwitpohe/polylog/issues)

Find a change that spans your frontend, API, shared libraries and documentation with one
search. Follow its branches and merges, read the complete commit message, and open each
file in VS Code's native diff editor.

**Linyra's additions** include a real multi-lane Git graph, branch/author checklists,
topological sorting and history folding, hash lookup, richer commit details, a branch
sidebar and resizable panes with explicit collapse controls. The clips below demonstrate
these additions, beyond the merged timeline inherited from Polylog.

![Select several branches and authors, switch date/topological order, then fold and expand linear history](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.2/feature-branches.gif)

The recording uses six neutral example repositories and real Git history. Screenshots
below can be opened at full resolution.

## Start using Linyra

Install **Linyra** by **whwitpohe** from the Marketplace, or run:

```sh
code --install-extension whwitpohe.linyra
```

Open a folder or multi-root workspace containing Git repositories. Run **Linyra: Open
Merged Log** from the Command Palette, or select **Linyra** in the bottom panel.
Repositories opened by VS Code's Git extension are included, along with repositories
found inside your workspace folders.

The initial range is **Last 24 hours** and **All branches**. Choose **All time** to browse
older history. Use the repository checkboxes to narrow the workspace.

For editors using another registry, install the VSIX from
[GitHub Releases](https://github.com/Whwitpohe/polylog/releases). Open VSX publication
has not been completed.

## Review a change across repositories

Search a ticket number, phrase or commit message once. Results from the selected
repositories appear together; repository color bands show where each commit belongs.
Click a commit to see its changed files, then click a file to open its native diff.

![Merged history with real branch lanes, repository bands, changed files and a native diff above](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.1/screenshot-log.png)

- **Message or hash.** Ordinary text searches commit messages, case-insensitively. A full
  hash or hexadecimal prefix of at least seven characters locates a commit directly;
  `sha:abcd` accepts prefixes of at least four. Hash lookup temporarily ignores the other
  filters within the selected repositories; clearing it restores those filters.
- **Authors and branches.** Search and select several authors or branch names. **Me** uses
  each repository's configured email. Branch selection combines the chosen histories;
  clearing it returns to all local and remote branches. Repositories without a selected
  branch are skipped and counted.
- **Path and time.** Filter by a repository-relative filename, folder or glob, and choose
  24 hours, 7 days, 30 days, all time or a custom date range.
- **Real parent links.** Colored lanes show forks and merges within each repository.
  Choose commit-date or topological order. Explicit graph controls fold long linear paths
  while keeping branch tips, tags, forks and merges visible.

**In the clip:** select `main` and `feature/saved-cards`, switch date/topological order,
fold and expand linear paths, then select several authors. Branch tips and real merges
remain visible. Defaults are all local/remote branches and all authors.

**Find an old commit without resetting your filters.** Paste a hash; the lookup finds a
three-month-old commit even with **Last 24 hours** selected. Clear it to restore the log.

![Paste a short hash to locate an old commit, then clear it to restore the previous filters](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.2/feature-hash-lookup.gif)

## Read the complete commit

The Changes area includes the subject, paragraphs and trailers, author/email, timestamp,
copyable hash, repository marker and colored HEAD, branch and tag references. Expand the
list of branches containing a commit when you need to find where it landed.

![Read colored references and complete metadata, resize or hide the details, and search the commit's files](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.2/feature-commit-review.gif)

**In the clip:** inspect HEAD/local/remote/tag icons and containing branches, hide and
restore the details, drag the divider, then filter the selected commit to `PaymentStep`.

Drag the divider between files and commit details to adjust their heights. The small
arrow hides or restores the details; both the size and visibility are remembered.

The file toolbar retains **All Files / Changed Files**, expand/collapse, clear selection
and commit actions. Filenames and rename sources retain Git status colors; added/deleted
line counts align on the right. Search changed files by name, path or old rename path.
**Enter** opens the first match; **Escape** clears the file query. In **All Files** mode,
the query still searches the commit's changed files.

## Compare branches across the workspace

Open **Linyra: Compare Branches** or use the comparison button in the Log toolbar.
Choose the left and right branches once to compare them in the selected repositories.
The repository list identifies differences and reports missing branches.

![Switch comparison between Files and Commits, expand a commit, change repository, swap branches and resize the sides](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.2/feature-compare.gif)

**In the clip:** the release and main branches each have their own changes. Switch
**Files / Commits**, expand commit files, select another repository, swap the pair and
resize the sides. The three panes stay in one stable surface; their original actions remain.

Switch between **Files** and **Commits**, swap sides, refresh, search branches, save
favorites or reuse recent pairs. Each side retains its own mode, shared-file filter,
expand/collapse, paging and context actions. Click a file for the two branch versions in
the native diff; **Changes since the Split** reviews what that side introduced.

Log/Changes and Compare support side-by-side or stacked layouts, draggable dividers and
explicit visibility controls. Clicking a heading or its empty space does not collapse
an entire view. Folder and commit expansion uses the small arrow or keyboard actions.
**Open Changes in Editor** also provides a separately movable Changes tab.

## More tools for daily work

| Tool | Where and what it does |
| --- | --- |
| **File History** | Right-click a file in Explorer, an editor/tab or Changes. Follow renames in one file's history. Search, author and date filters are set aside and restored when you exit. |
| **Combined Changes** | Ctrl/⌘-click or Shift-click commits, including commits from different repositories. Review each file once, with diffs limited to the selected changes where they can be separated. Overlapping unselected changes are marked. No history is rewritten. |
| **Uncommitted work** | Use **Commits / Uncommitted** in the Log, or show the Uncommitted sidebar. Review working files across repositories. Explicit stage, unstage, discard and commit actions use VS Code's Git integration. |
| **Branches sidebar** | Switch **Repositories / Branches** to browse local/remote branches, search and favorite them. Clicking a branch filters history. Context menus provide repository-scoped checkout, create, compare, rename, merge, rebase, worktree, fetch, pull, push and delete actions. |
| **Repository profiles** | Save a repository selection and switch back to it later. Profiles use the shareable `linyra.profiles` workspace setting. |
| **Fetch and pull** | Toolbar/context actions fetch when requested, show ahead/behind counts and select repositories behind their upstream. Pull-all uses fast-forward checks. |
| **Blame and current file** | Native diff/revision editors show line attribution. **Open File** opens the current workspace file at the same line. |
| **Copy and remote links** | Commit and file context menus expose copy actions and remote links for supported Git hosts. |

The branch sidebar is another Linyra addition: search across local/remote branches,
favorite them, or use repository-scoped actions without changing history by clicking a name.

![Linyra's searchable local and remote branch sidebar across three repositories](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.1/screenshot-branch-sidebar.png)

![File History follows the selected file while its native diff stays open](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.1/screenshot-file-history.png)

## Keyboard and appearance

| Key in the Log | Action |
| --- | --- |
| `↑` / `↓`, `Home` / `End`, `PageUp` / `PageDown` | Move between commits; changed files follow |
| `Shift+↑` / `Shift+↓` | Select several commits |
| `Enter` | Open the selected commit's first changed file |
| `/` or `Ctrl/Cmd+F` | Focus message search |
| `Esc` | Clear search, then return to the list |

Colors and typography follow your VS Code theme, including light, dark and both
high-contrast themes. Linyra follows the display language: English and Simplified Chinese
are supported, with English as the fallback.

![The same real workspace in dark, light and both high-contrast themes](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.1/screenshot-themes.png)

## Settings and requirements

Requires **VS Code 1.85+** and **Git**. Linyra uses your `git.path`, the Git executable
found by VS Code, or Git on `PATH`. Reading history, searching and folding do not write
to repositories; Git operations run when you explicitly choose them.

| Setting | Default | Purpose |
| --- | --- | --- |
| `linyra.pageSize` | `200` | Commits fetched per repository per page |
| `linyra.maxConcurrency` | `16` | Maximum concurrent Git processes |
| `linyra.scanDepth` | `2` | Repository discovery depth inside workspace folders |
| `linyra.excludeRepos` | `[]` | Repository-name/path patterns to exclude |
| `linyra.profiles` | `{}` | Named repository selections |
| `linyra.blame` | `true` | Line attribution in Linyra diffs and revisions |

From 1.4.2, settings use only **`linyra.*`**. Old `polylog.*` settings are not read or
migrated. Set Linyra preferences under the new keys if needed; existing configuration
files are left untouched.

![The native VS Code Settings editor shows Linyra's six settings under its own name](https://raw.githubusercontent.com/Whwitpohe/polylog/main/media/v1.4.2/feature-settings.png)

Filters are passed to Git; results are merged as pages arrive. There is no persistent
history index or database, and Linyra does not fetch in the background. Filter input is
debounced and superseded Git reads are cancelled.

## Switching from Polylog

Linyra is an independently maintained fork of
[Polylog](https://github.com/lntvan166/polylog), originally created by **lntvan166**.
Its extension ID is **`whwitpohe.linyra`**. Disable or uninstall
`lntvan166.polylog-git` and reload the window when switching: enable one at a time.
Settings use `linyra.*`; command keybindings remain compatible. Saved filters and pane
sizes belong to each extension's private state and may need to be set again once.

The original `v1.4.0` GitHub release retains its historical Polylog package. New Linyra
releases use their own matching source tags and VSIX filenames.

## Development and license

See [development and publishing](https://github.com/Whwitpohe/polylog/blob/main/docs/PUBLISHING.md)
and [media capture instructions](https://github.com/Whwitpohe/polylog/blob/main/dev/demo/README.md).
Issues and contributions are welcome at [Whwitpohe/polylog](https://github.com/Whwitpohe/polylog).

**MIT**, based on Polylog by lntvan166. The original copyright, [LICENSE](https://github.com/Whwitpohe/polylog/blob/main/LICENSE)
and third-party notices remain included.
