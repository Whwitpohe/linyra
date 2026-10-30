# Linyra

**A multi-repository Git client in the style of the JetBrains (WebStorm) Git Log.**

One merged log for every repository in your workspace, with a branches panel, commit
details, changed files and native diffs beside it — and commit, push, update, check out,
merge and rebase across repositories, from the row each applies to.

[简体中文](https://github.com/Whwitpohe/linyra/blob/main/README.zh-CN.md) · [Install from Marketplace](https://marketplace.visualstudio.com/items?itemName=whwitpohe.linyra) · [Download VSIX](https://github.com/Whwitpohe/linyra/releases) · [Changelog](https://github.com/Whwitpohe/linyra/blob/main/CHANGELOG.md) · [Report an issue](https://github.com/Whwitpohe/linyra/issues)

Find a change that spans your frontend, API, shared libraries and documentation with one
search. Follow its branches and merges, read the complete commit message, and open each
file in VS Code's native diff editor. Then commit, push and update every repository in one
step, each in its own repository.

![Select several branches and authors, switch date/topological order, then fold and expand linear history](https://raw.githubusercontent.com/Whwitpohe/linyra/main/media/v1.5.0/feature-branches.gif)

The recordings use six neutral example repositories and real Git history, and show the
1.5.0 look; since 1.7.0 a row also draws its author's disc, its branch pills and a Changes
column. Screenshots can be opened at full resolution.

## What's new in 1.7.0

- **Search like GitLens's Commit Graph:** `author:`, `file:`, `change:`, `after:`, `ref:`,
  `repo:` and more, each turned into a `git log` flag, with a popup that lists them.
- **A richer Log:** author discs and avatars, branch pills you can click, a hover card, a
  Changes column, a column header, row buttons, and an Uncommitted changes row on top.
- **The branch sheet:** click a branch for its upstream, its merge target with predicted
  conflicts, its next steps, and the same branch in every other repository.
- **More across repositories:** Push… sends every branch with commits to push, checked out or
  not, and force pushes a rewritten one with a lease; Update Project also fast-forwards
  branches that are only behind; Tag Across Repositories…, Run Git Command Across
  Repositories… and Release….
- **Repository state in the Repo List:** each branch's ↓ and ↑, uncommitted marks, a stopped
  merge or rebase with Resolve, Continue and Abort, worktrees, and Smart Checkout.
- **Linyra AI, off until you turn it on:** your own OpenAI-compatible, Anthropic or Gemini
  model explains, reviews, writes commit messages and release notes, and resolves conflicts.
- **Insights:** Visual History, Files and Commits treemaps, and Repository Health.
- **Questions open where you act:** under the button you clicked, not at the top of the
  window; a click anywhere outside closes any popup.

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
[GitHub Releases](https://github.com/Whwitpohe/linyra/releases). Open VSX publication
has not been completed.

## Review a change across repositories

Search a ticket number, phrase or commit message once. Results from the selected
repositories appear together; repository color bands show where each commit belongs.
Click a commit to see its changed files, then click a file to open its native diff.

![Merged history with real branch lanes, repository bands, changed files and a native diff above](https://raw.githubusercontent.com/Whwitpohe/linyra/main/media/v1.5.0/screenshot-log.png)

- **A search language, run by Git.** Plain words search commit messages. Operators narrow
  the search, and each one becomes `git log`'s own flags: `message:` and `-message:`,
  `author:` (`@me`), `committer:`, `commit:`, `file:`, `change:` (a line added or removed),
  `type:merge` / `type:tip` / `is:wip`, `after:` / `before:`, `ref:` (a branch, tag or
  range, such as `ref:main..feature`) and Linyra's `repo:`. The popup under the box lists
  every operator with an example and suggests authors, branches, tags and repositories as
  you type. Match Case, Whole Word, Regex and Match All sit beside it; ↑/↓ recall recent
  searches.
- **Hash lookup.** A full hash or a hexadecimal prefix of at least seven characters locates
  a commit directly; `sha:abcd` accepts prefixes of at least four. The lookup temporarily
  ignores the other filters within the selected repositories; clearing it restores them.
- **Authors and branches.** Search and select several authors or branch names. **Me** uses
  each repository's configured email. Branch selection combines the chosen histories;
  clearing it returns to all local and remote branches. Repositories without a selected
  branch are skipped and counted.
- **Path and time.** Filter by a repository-relative filename, folder or glob, and choose
  24 hours, 7 days, 30 days, all time or a custom date range.
- **Real parent links.** Colored lanes show forks and merges within each repository.
  The Graph column's menu orders by commit date or **By branch structure** (topological)
  and folds long linear paths, keeping branch tips, tags, forks and merges visible.

**What a row shows.** A strip in its repository's color; the author's disc, an initial
ringed in that color (a thicker ring for your commits), or the author's picture from the
repository's own host; the subject with **branch pills** — a branch and the remotes at the
same commit in one pill, the checked-out one bold with its ↑/↓; the author, a **Changes**
column (files and lines as numbers, squares or a bar) and the date. The **column header**
resizes and hides columns and sets the Graph's order and the Date's format. Resting the
pointer opens a **hover card** with the message and counts; the row under the pointer
offers **Undo Commit…** and **Edit Commit Message…** on the checked-out commit and **⋯**,
its menu, on every row. While the ticked repositories have uncommitted work, an
**Uncommitted changes** row sits above the newest commit: click it for that work's files.

**In the clip:** select `main` and `feature/saved-cards`, switch date/topological order,
fold and expand linear paths, then select several authors. Branch tips and real merges
remain visible. Defaults are all local/remote branches and all authors.

**Find an old commit without resetting your filters.** Paste a hash; the lookup finds a
three-month-old commit even with **Last 24 hours** selected. Clear it to restore the log.

![Paste a short hash to locate an old commit, then clear it to restore the previous filters](https://raw.githubusercontent.com/Whwitpohe/linyra/main/media/v1.5.0/feature-hash-lookup.gif)

## Read the complete commit

The commit details read like a VS Code pane: the title, the body as written, then its
repository, copyable hash, author, date, parent links (a click selects that parent) and
branch pills. The checked-out branch's pill starts with **HEAD**; the branches listed under
it are only those the pills do not already name.

![Read colored references and complete metadata, resize or hide the details, and search the commit's files](https://raw.githubusercontent.com/Whwitpohe/linyra/main/media/v1.5.0/feature-commit-review.gif)

**In the clip:** inspect HEAD/local/remote/tag icons and containing branches, hide and
restore the details, drag the divider, then filter the selected commit to `PaymentStep`.

Drag the divider between files and commit details to adjust their heights. The small
arrow hides or restores the details; both the size and visibility are remembered.

The file toolbar retains **All Files / Changed Files**, expand/collapse, clear selection
and commit actions. A changed file looks the same everywhere: its name in its Git status
color (struck through when deleted), a rename's old name, its added/deleted lines and its
status letter. Search changed files by name, path or old rename path. **Enter** opens the
first match; **Escape** clears the file query. The tree moves with the keys VS Code's own
trees use, and typing a name goes to it.

## A branch at a glance

Click a branch pill, in a row or in the commit details, for its **branch sheet** in the
Changes view (or **Show Branch Details**):

- **Upstream:** up to date, to push, to pull, diverged (Pull or Force Push…), gone on the
  remote (Delete Branch… or Publish) or not published; a pencil changes the upstream.
- **Merges into:** its commits not on the merge target, how far behind it is, and whether
  merging conflicts — predicted with `git merge-tree` without writing to the repository
  (Git 2.38+). Merged: safe to delete.
- **Next steps:** never empty — Switch, Check out, Fetch, Create Branch…, Push…, Show
  History, Compare…, the worktree that has it.
- **Across repositories:** on request, the same branch in every ticked repository (checked
  out, ↑ ↓, diverged, gone), with Check Out Everywhere…, Push… and Update Project….

## Compare branches across the workspace

Open **Linyra: Compare Branches** or use the comparison button in the Log toolbar.
Choose the left and right branches once to compare them in the selected repositories.
The repository list identifies differences and reports missing branches.

![Switch comparison between Files and Commits, expand a commit, change repository, swap branches and resize the sides](https://raw.githubusercontent.com/Whwitpohe/linyra/main/media/v1.5.0/feature-compare.gif)

**In the clip:** the release and main branches each have their own changes. Switch
**Files / Commits**, expand commit files, select another repository, swap the pair and
resize the sides. The three panes stay in one stable surface; their original actions remain.

Switch between **Files** and **Commits**, swap sides, refresh, search branches, save
favorites or reuse recent pairs. Each side retains its own mode, shared-file filter,
expand/collapse, paging and context actions. Click a file for the two branch versions in
the native diff; **Changes since the Split** reviews what that side introduced.

- **Several names per side.** A side can list names in order (`develop, develop-k` ↔
  `main, master`, or each repository's **Default branch**): each repository uses the first
  it has, and its row says which (`develop-k → main`). Tick several in the picker; their numbers
  are the order, and ∧ ∨ change it.
- **Conflicts before you merge.** Each repository is merged in memory (`git merge-tree`,
  git 2.38+; nothing is written to the repository): its row shows a check or how many files
  would conflict, those files are marked, **Show Only Conflicts** lists just them, and
  **Preview Merge Result** opens the merged file with its conflict markers.
- **All repositories** at the top of the list shows every repository's files or commits in
  one tree; Ctrl/Shift-click picks several repositories for the same tree (Merge and Release
  Notes then take just those). The list comes first: each row's merge check follows on its own. Each side has a filter box; Commits rows show their date.
- **Act on it:** **Cherry-Pick** the selected commits of a side (Ctrl/Shift-click), **Merge ◀
  into ▶…** (a checklist of the repositories that merge cleanly; one repository from its
  right-click), and **Copy ◀ Commits as Release Notes** (Markdown, by repository). The merge goes
  into ▶ as the boxes say: where ▶ is checked out, `git merge`; where it is not, the branch moves
  without a checkout and your working tree is not touched.
- **Release…** (the Log's ⋯) runs ◀ into ▶ as a release, one reviewed step at a time: the
  release notes, the merge, a tag on ▶ carrying that repository's notes, and the push.

Log/Changes and Compare support side-by-side or stacked layouts, draggable dividers and
explicit visibility controls. Clicking a heading or its empty space does not collapse
an entire view. Folder and commit expansion uses the small arrow or keyboard actions.
**Open Changes in Editor** also provides a separately movable Changes tab.

## Work in every repository at once

- **Push…** (Ctrl+Shift+K) lists every ticked repository's commits to send in one
  checklist: the checked-out branch first, then any other local branch ahead of its
  upstream — a develop merged into master, master not checked out — under its own heading.
  Each repository pushes its ticked branches without a checkout. A branch whose pushed
  commits were rewritten is listed apart and unticked; ticked, it is force pushed with a
  lease on the commit last fetched, after a confirmation that names what the remote would
  lose. Never main, master or VS Code's `git.branchProtection`.
- **Update Project** (Ctrl+T) fetches, then merges, rebases or fast-forwards each
  checked-out branch onto its upstream — asked each time, or set once with the pin beside a
  method (`linyra.updateMethod`); it never autostashes. Other local branches that are only
  behind their upstream are fast-forwarded too, without a checkout.
- **Branches Across Repositories…** (Ctrl+Shift+`) checks out, creates or merges one branch
  name everywhere. Where local changes are in the way, **Smart Checkout** stashes them,
  checks out and puts them back.
- **Tag Across Repositories…** tags each checked-out commit (annotated when given a message)
  and pushes it if asked. **Run Git Command Across Repositories…** runs one command, never
  through a shell, and shows each repository's output; anything that may write asks first.
  **Abort in All Repositories…** ends a merge or rebase stopped in several.
- Afterwards one report says what was done, what was already up to date, what stopped and
  why anything was skipped.

## The Repo List

The tree on the Log's left groups each repository's **Local**, **Remote**, **Tags**,
**Stashes** and **Worktrees**, as the JetBrains Branches panel does. Search it for a
repository or a branch name; clicking a branch filters the Log to it and never checks it
out.

- **State at a glance:** each repository's branch with VS Code's `*` `+` `!` for
  uncommitted work, a mark where it is on another branch than the others, and its ↓ (to
  pull, blue) and ↑ (to push, green). Each local branch shows its own ↓ and ↑ against its
  upstream, as of the last fetch.
- **A stopped merge, rebase, cherry-pick, revert or patch series** shows as a badge
  ("2 conflicts") and a row under the repository: **Resolve Conflicts…** (VS Code's merge
  editor), **Continue**, **Abort…**, **Abort in All Repositories…**.
- **Right-click** for checkout, create, compare, rename, merge, rebase, upstream, worktree,
  fetch, pull, push and delete; for a tag, check out detached, push and delete; for a stash,
  Apply, Pop, Drop or Show Changes; for a worktree, Open in New Window, Reveal, Copy Path
  and Remove Worktree…. Favorites stay on top; **Untick**, **Always Hide (Settings)** and
  saved **profiles** choose what the Log shows.

![The Repositories tree searched for a branch name: each repository opens onto its Local and Remote branches](https://raw.githubusercontent.com/Whwitpohe/linyra/main/media/v1.5.0/screenshot-branch-sidebar.png)

## Commit from the side bar

The Linyra icon in the Activity Bar opens the Commit side bar, like the JetBrains Commit
window: **Changes** and **Unversioned Files** of every ticked repository in a native tree
(with your file icon theme) and a checkbox on each row, one message, **Amend**,
**Sign-off**, **Author…**, **Commit Message History** (Ctrl+M), and **Commit**
(Ctrl+Enter) or **Commit and Push…** (Ctrl+Alt+K). Each repository with checked files gets
its own commit of exactly those files; anything else staged stays staged.

- The message starts from git's `commit.template`, and hints at a line over 72 characters
  or a missing blank line after the subject, without blocking.
- New files are added with the commit when checked, or at once with **Add to VCS**
  (Ctrl+Alt+A), or kept out with **Add to .gitignore**.
- Three commands that are never one another: **Discard Changes** (Ctrl+Alt+Z) takes
  tracked files back to the last commit and never deletes a new file, **Remove from VCS**
  takes an added file out again and keeps it, **Delete…** (Delete) removes new files from
  the disk.
- **Stash Changes…** (with or without new files) and **Apply Patch…** (from a file or the
  clipboard; as changes, with a three-way merge offered, or as the commits of a mailbox)
  work on a repository's row.
- Click a file (or Ctrl+D) for its diff; Group By repository and directory, both or neither.

## Linyra AI (optional)

Off until you turn it on: while `linyra.ai.enabled` is off nothing is sent anywhere and
the AI menu items stay hidden. **Linyra: Configure AI…** opens the Linyra AI page: profiles for OpenAI
and any OpenAI-compatible server (Ollama, LM Studio), Anthropic and Gemini, each with its
model, thinking level and a **Test Connection**. API keys stay in VS Code's secret storage,
each bound to the address it was entered for.

- **Explain** a commit, uncommitted changes, unpushed commits, a branch against yours, or a
  conflict; **Review** commits; **Write Release Notes** from commits or from Compare.
- **Generate Commit Message** in the Commit side bar, following your
  `linyra.ai.commitMessageInstructions`; ✨ also names a stash.
- **Resolve Conflicts with AI…** proposes a resolution per file and asks before writing.
- ✨ in the search box turns a question into the operator query; **Ask AI…** in the Log
  header answers in words, running read-only steps at once and listing anything that would
  write to a repository in one prompt first.
- `linyra.ai.exclude` keeps lockfiles, built files and secrets out of every prompt;
  `linyra.ai.maxPromptTokens` asks before a large request.

## Insights

**Linyra: Insights** (or **Visual History** on a file or folder) opens a tab over the
ticked repositories, one of them, or that path:

- **Visual History:** one bubble per commit, sized by the lines it changed, one row per
  author, in the repository's or the author's color; a click shows the commit in the Log.
- **Files** and **Commits:** treemaps of the tracked files, by size or by how many commits
  touched them in the range, so the hot files stand out.
- **Health:** one row per repository — commit-graph, objects, untracked cache, file system
  monitor, many files, maintenance — each with what it means and a recommendation.
  **Optimize Selected…** names every command in one confirmation; nothing is written
  without it.

## More tools for daily work

| Tool | Where and what it does |
| --- | --- |
| **File History** | Right-click a file in Explorer, an editor/tab or Changes, or a folder for **Folder History**. The Log shows that path's history, following renames: each row's change to the file (its letter and lines), and its uncommitted change on top. **Blame at This Revision** on a row. Search, author and date filters are set aside and restored when you exit. |
| **Combined Changes** | Ctrl/⌘-click or Shift-click commits, including commits from different repositories. Review each file once, with diffs limited to the selected changes where they can be separated. Overlapping unselected changes are marked. No history is rewritten. |
| **Uncommitted work** | Use **Commits / Uncommitted** in the Log: one row per repository with work — its files by kind, the branch with its ↑/↓, the last edit. Explicit stage, unstage, discard and commit actions use VS Code's Git integration. |
| **Commit actions** | Right-click a commit: cherry-pick (several selected commits at once, oldest first), revert, reset the current branch to here, check out the revision, or create a branch or tag there; **Compare with Working Tree…**, **Create Patch…** (the selected commits, to a file or the clipboard) and **Push All up to Here…** (the checked-out branch up to that commit; the ones after it stay local). On the checked-out commit: Undo Commit and Edit Commit Message. |
| **Repository profiles** | Save a repository selection and switch back to it later. Profiles use the shareable `linyra.profiles` workspace setting. |
| **Fetch and pull** | Toolbar/context actions fetch when requested, show ahead/behind counts and select repositories behind their upstream. Pull-all uses fast-forward checks. |
| **Blame and current file** | Native diff/revision editors show line attribution. **Open File** opens the current workspace file at the same line. |
| **Copy and remote links** | Commit and file context menus expose copy actions and remote links for supported Git hosts. |

![File History follows the selected file while its native diff stays open](https://raw.githubusercontent.com/Whwitpohe/linyra/main/media/v1.5.0/screenshot-file-history.png)

## Keyboard and appearance

| Key in the Log | Action |
| --- | --- |
| `↑` / `↓`, `Home` / `End`, `PageUp` / `PageDown` | Move between commits; changed files follow |
| `Shift+↑` / `Shift+↓` | Select several commits |
| `Enter` | Open the selected commit's first changed file |
| `/` or `Ctrl/Cmd+F` | Focus message search |
| `Esc` | Clear search, then return to the list |
| `Ctrl+T` | Update Project |
| `Ctrl+Shift+K` | Push… |
| ``Ctrl+Shift+` `` | Branches Across Repositories… |

A question Linyra asks — a choice, a checklist or a name — opens under the button you
clicked or where you right-clicked, with ↑ ↓ Enter Esc, and any popup closes on a click
outside it. From the Command Palette, VS Code's picker still asks; confirmations stay VS
Code's dialogs.

Colors and typography follow your VS Code theme, including light, dark and both
high-contrast themes. Linyra follows the display language: English and Simplified Chinese
are supported, with English as the fallback.

![The same real workspace in dark, light and both high-contrast themes](https://raw.githubusercontent.com/Whwitpohe/linyra/main/media/v1.5.0/screenshot-themes.png)

## Settings and requirements

Requires **VS Code 1.85+** and **Git** (2.38+ for conflict prediction). Linyra uses your
`git.path`, the Git executable found by VS Code, or Git on `PATH`. Reading history,
searching and folding do not write to repositories; Git operations run when you explicitly
choose them.

| Setting | Default | Purpose |
| --- | --- | --- |
| `linyra.pageSize` | `200` | Commits fetched per repository per page |
| `linyra.maxConcurrency` | `16` | Maximum concurrent Git processes |
| `linyra.scanDepth` | `2` | Repository discovery depth inside workspace folders |
| `linyra.excludeRepos` | `[]` | Repository-name/path patterns to exclude |
| `linyra.profiles` | `{}` | Named repository selections |
| `linyra.blame` | `true` | Line attribution in Linyra diffs and revisions |
| `linyra.updateMethod` | `ask` | How Update Project brings in incoming commits: ask, merge, rebase or fast-forward only |
| `linyra.avatars` | `remote` | Author pictures: `off`, `remote` (only the hosts your remotes name), `remote+gravatar` |
| `linyra.avatarHosts` | `{}` | The kind of server (`gitlab`, `github`) a self-hosted remote is |
| `linyra.avatarUrlTemplate` | `""` | An avatar service of your own (user settings only) |
| `linyra.ai.enabled` | `false` | Turns Linyra AI on; while off, nothing is sent |
| `linyra.ai.profiles` / `linyra.ai.activeProfile` | `[]` / `""` | AI connections and the one in use, written by the Linyra AI page (keys are in secret storage) |
| `linyra.ai.commitMessageInstructions` | `""` | Your rules for AI commit messages |
| `linyra.ai.exclude` | lockfiles, built files, secrets | Files AI prompts leave out |
| `linyra.ai.maxPromptTokens` | `50000` | Ask before sending a larger request (`0`: never ask) |

From 1.4.2, settings use only **`linyra.*`**. Old `polylog.*` settings are not read or
migrated. Set Linyra preferences under the new keys if needed; existing configuration
files are left untouched.

![The native VS Code Settings editor lists Linyra's settings under its own name](https://raw.githubusercontent.com/Whwitpohe/linyra/main/media/v1.5.0/feature-settings.png)

Filters are passed to Git; results are merged as pages arrive. There is no persistent
history index or database, and Linyra does not fetch in the background. Filter input is
debounced and superseded Git reads are cancelled. Author pictures are asked only of the
servers your repositories' remotes name, only for the rows on screen, and kept in memory
until the window reloads.

## Switching from Polylog

Linyra is an independently maintained fork of
[Polylog](https://github.com/lntvan166/polylog), originally created by **lntvan166**.
Its extension ID is **`whwitpohe.linyra`**. Settings, commands, views and revision URIs
use the independent `linyra` namespace, so Linyra and `lntvan166.polylog-git` can coexist.
Custom keybindings for Linyra must use `linyra.*` command IDs. Filters and pane sizes
saved by earlier Linyra builds are migrated within Linyra's own private storage;
the upstream extension's settings and private storage are left untouched.

The original `v1.4.0` GitHub release retains its historical Polylog package. New Linyra
releases use their own matching source tags and VSIX filenames.

## Development and license

See [development and publishing](https://github.com/Whwitpohe/linyra/blob/main/docs/PUBLISHING.md)
and [media capture instructions](https://github.com/Whwitpohe/linyra/blob/main/dev/demo/README.md).
Issues and contributions are welcome at [Whwitpohe/linyra](https://github.com/Whwitpohe/linyra).

**MIT**, based on Polylog by lntvan166. The original copyright, [LICENSE](https://github.com/Whwitpohe/linyra/blob/main/LICENSE)
and third-party notices remain included.
