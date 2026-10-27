# Changelog

Changes to Linyra and its Polylog history are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

## [1.4.1] — 2026-10-28

### Changed

- **A listing that reflects the current extension.** Replaced the outdated walkthrough
  with a real VS Code recording and new screenshots of the multi-lane graph, branch
  multi-select, complete commit details, native diffs, file history and branch comparison.
  The editor keeps a natural working layout; focused images make small controls readable.
- **Complete English and Simplified Chinese guides.** Installation now links to the live
  Marketplace listing. Both guides cover the default all-branch scope, filters, hash lookup,
  resizable panes, preserved toolbar actions and explicit Git operations. Open VSX remains
  listed as unavailable until publication is completed.
- **Reproducible, isolated demonstration assets.** The media workflow builds neutral Git
  repositories with real merges, divergent release branches and working-file examples,
  then captures production webviews inside a throwaway VS Code development host. Capture
  files and dependencies remain outside the installed extension.

### Notes

- **This update refreshes documentation and presentation.** The feature set, theme colors,
  approved icon, commands and compatibility identifiers are unchanged from the Marketplace
  build of Linyra 1.4.0. The Chinese guide is included in the installation package.
- **Historical releases remain intact.** The earlier `v1.4.0` GitHub tag and Polylog VSIX are
  preserved; this release provides `whwitpohe.linyra-1.4.1.vsix` under its matching new tag.

## [1.4.0] — 2026-10-27

### Branding and publication

- **A cool-color identity for Linyra.** The approved icon keeps the original Polylog
  three-history merge shape and uses periwinkle, sky blue and mint on midnight navy.
  The extension and 128px publisher icons share the same approved image. The panel keeps
  its theme-aware monochrome merge mark; editor colors and functional controls stay unchanged.
- **Linyra is the fork's independent product name.** The extension now uses
  `whwitpohe.linyra`, with matching English/Chinese listing names, command categories,
  panel titles and messages. The original Polylog copyright and license remain intact.
- **Install and publish under the fork publisher.** The README explains the separate
  extension identity and installation from a Linyra VSIX. Linyra 1.4.0 subsequently became
  public on the VS Code Marketplace under `whwitpohe.linyra` on 2026-10-28.
  Existing `polylog.*` settings, keybindings, commands and view ids stay compatible;
  disable the old extension when switching. Private filter and layout state belongs to
  each extension id. Earlier releases and tags keep their original identity.

### Added

- **A real commit graph across the workspace.** Parent edges are drawn from Git's commit
  ids, with separate colored lanes for parallel branches and ring markers for branch tips
  and merges. Repository identity is part of every edge, so unrelated repositories are never
  connected, even when they contain the same commit hash. Branches and tags pointing at a
  commit appear beside its subject; matching local and remote tips share a compact label
  such as `origin & main`.
- **Searchable branch and author multi-selects.** Start with all local and remote branches,
  choose several branch names to see their combined history, or clear the selection to return
  to all branches. Choose several authors, including **Me**, from a searchable checklist.
  Selections are remembered. A repository with none of the chosen branches is skipped and
  counted in the footer instead of silently showing an unrelated current branch.
- **Commit-date and topological sorting.** The sort menu switches between timestamp order
  and a Git topology walk that keeps children before parents and incoming histories below
  their merge. Both modes work across repositories and Load More, including commits whose
  clocks run backwards. The chosen order is remembered.
- **Fold long linear histories without hiding branch structure.** The graph's explicit
  controls collapse complete linear paths into a counted summary. Branch heads, tags,
  forks, merges and unknown parents remain visible. Expand a path again or use the toolbar's
  expand/collapse controls; commit selection continues to use real commit identities.
- **Locate a commit by full or abbreviated hash.** Paste at least seven hexadecimal characters
  into the existing search box, or use `sha:` with at least four. Git resolves the prefix in
  every selected repository, including old commits outside the current branch. All matching
  commits are listed when a prefix is ambiguous. Other filters are temporarily disabled and
  explained in a note; clearing the hash restores them. Ordinary text remains a commit-message search.
- **Search within the current commit's changed files.** The new file search matches names,
  full paths and rename sources, keeps matching directory ancestors visible, and shows the
  matching count. **Enter** opens the first matching diff; **Escape** clears the query.
  In **All Files**, the search covers the commit's changed files, including unopened folders.
- **A branch sidebar with explicit repository-scoped actions.** Browse local and remote
  branches, search names, mark favorites, and view a branch's history. Context actions include
  comparison with another branch or the working tree, checkout, create, rename, fetch, pull,
  push, merge, rebase, creating a worktree and deleting branches. Git operations use the chosen
  repository and full ref; protected or destructive actions retain their checks and prompts.
- **Simplified Chinese localization.** Commands, menus, filters, pickers, status messages,
  dialogs and both webviews follow VS Code's language. English remains the fallback, while
  repository names, paths, ref names and commit messages remain literal.

### Changed

- **Read a complete commit message below its files.** The commit details area preserves
  paragraphs and trailers, shows author/email, timestamp, copyable hash, repository marker,
  colored references and an expandable list of containing branches. Drag its divider to
  adjust its height or use its small arrow to hide it; the height and visibility are remembered.
- **The Log and Changes share a stable, resizable surface.** Choose side-by-side or stacked
  layouts, hide/show Changes explicitly, or open it in an independently movable editor tab.
  The Log toolbar retains grouping, branch comparison, the Uncommitted sidebar, Fetch All,
  pull actions and repository profiles. Line counts align on the right; file and rename-path
  colors keep the theme's Git status colors.
- **Branch comparison keeps all three regions in one surface.** Repositories, Left and Right
  remain independently scrollable and resizable, with remembered layout and side visibility.
  **Files / Commits**, swap, refresh, branch search, favorites, recent pairs, duplicate changes,
  missing-branch information, shared-file filtering, expand/collapse, paging and context
  actions remain available in explicit controls.

### Fixed

- **Clicking a title or its blank right-hand area no longer collapses an entire Log or
  Compare view.** The native whole-header collapse targets have been removed. Within the
  file and commit trees, only the small arrow or deliberate keyboard action expands or
  collapses a folder or commit; clicking its text selects it.
- **Toolbar features remain reachable after the layout migration.** The old Log actions are
  wired to the same commands, the Changes toolbar has clear selection, all/changed files,
  expand/collapse and a commit-action menu, and Compare retains its side-specific operations.
- **Filtered file actions do not include hidden children.** A folder in a filtered tree no
  longer exposes whole-folder mutation actions; multi-file operations use only visible matching
  file ids. The main and standalone Changes surfaces keep separate selections.
- **Stale selections cannot open a different repository's diff.** Changed-file and Compare
  actions resolve host-owned row ids against the current result; a superseded pair, mode or
  result cannot substitute a path supplied by a webview message. Refresh and swaps retain
  correct rename paths, status decorations and left/right revision order.

### Notes

- The default branch scope is now **all local and remote branches**. Existing explicit branch
  selections are retained; clear them to use the new default. The date default remains the
  last 24 hours.
- Existing native section positions are replaced by the remembered in-panel layouts. The
  Uncommitted view remains a separate sidebar, and diffs continue to open in VS Code's editor.
- Reading history and folding the graph do not modify repositories. Branch-management actions
  write only when explicitly invoked. No history database, index or background fetch is added.

## [1.3.1] — 2026-10-22

### Fixed

- **Uncommitted rows no longer overlap their tags on a narrow panel.** Below about 600px wide,
  a row's file preview and change meter ran under its "2 new" / "staged" tags. They now
  shrink with the panel: the preview is cut with "…" and the meter shortens, back to full
  size when there is room.

## [1.3.0] — 2026-10-21

### Added

- **Combined Changes: select several commits, see one Changes tree.** Ctrl-click (⌘-click on
  macOS), Shift-click or Shift+↑/↓ in the Log selects several commits, in any repositories:
  one piece of work spread over `acme-web` and `acme-api`, say. The Changes view lists each
  changed file once, under its repository, with the selected commits that touched it and its
  net A/M/D/R status. Up to 100 commits; **Clear Selection** in the Changes title bar goes
  back to one, and so does a plain click.
- **A file's diff shows only what the selected commits did to it.** The right side is the
  file after the newest selected commit; the left side is that file with the selected
  commits' changes taken back out, by a three-way merge in memory. A teammate's commit in
  between shows as unchanged context, not as part of your change. Nothing is written to your
  repositories.
- **⚠ when the changes can't be shown apart.** If an unselected commit edited the same lines
  (or the file is binary, or very large), the file is marked ⚠ and its diff runs from before
  the first selected commit to after the last; the tooltip and the diff title name the
  unselected commits included.
- **Files added and removed again, or changed and changed back,** within the selection are
  named in a note at the end of the tree instead of listed.

### Notes

- Combined Changes is read-only: nothing is squashed, rebased or committed. The Uncommitted
  side of the Log keeps its own Ctrl/Shift multi-select for staging and committing.

## [1.2.0] — 2026-10-16

### Added

- **Profiles in the Repo List: named groups of repositories.** Tick the repositories you work
  on together, click **＋ Save as profile…** (it appears as soon as the ticks are neither All
  nor a saved profile) and name them, e.g. `backend`. Clicking the profile ticks exactly
  those repositories again. Search, Author, Branch, Date and Path stay as they are: a profile
  only chooses which repositories `git log` runs in.
- **Profiles live in the workspace setting `polylog.profiles`**, one list per name, each
  repository as its path relative to the workspace folder (in a multi-root workspace, the
  folder's name first). Edit it by hand or share it with the workspace; the Repo List
  redraws, and a repository not in this workspace is skipped and flagged with ⚠.
- **Manage them where you use them.** Right-click a profile for **Show This Profile**,
  **Update to Current Selection**, **Rename…** and **Delete** (it asks first). Right-click a
  repository, in the Repo List or on its rows in the Log, for **Profiles…**: a checklist of
  the profiles it is in, plus **New profile with it…**.
- **Switch Profile…** and **Save Selection as Profile…** in the Log's ⋯ menu and the Command
  Palette; switching works with the Repo List hidden.

### Notes

- Profiles kept in your User settings are listed too, but Polylog only ever writes the
  workspace's own profiles and the ones you just changed, so they never end up in a shared
  workspace file. Rename or delete those in your User settings.

## [1.1.0] — 2026-10-16

### Added

- **Discard All Changes on a repository.** Right-click a repository in the Uncommitted view,
  on the Log's Uncommitted side, or at the top of the Changes view: everything in it goes back
  to the last commit. Staged changes are unstaged first, and new files are deleted, staged or
  not. It always asks first, and acts on exactly the files it listed.
- **Discard staged files and folders too.** Discard was offered only on unstaged files; it is
  now on staged files, the Staged group and folders, and takes the staged change as well.
- **Act on uncommitted work from the Log.** On the Log's Uncommitted side, right-click a
  repository, or the Changes view, for **Commit…**, **Stage All**, **Unstage All** and
  **Discard All Changes**; right-click a file or folder there to **Stage**, **Unstage** or
  **Discard** it. Before, that side was review only.
- **Select several rows at once.** Ctrl/Shift-click files or folders in the Uncommitted and
  Changes views, then Stage, Unstage or Discard them together: one prompt, even when they
  are in different repositories.
- **Stage All and Unstage All** on a repository in the Uncommitted view.
- **Copy Path and Copy Relative Path** on file and folder rows in the Changes, Uncommitted
  and Compare views.
- **Commit actions wherever a commit is shown.** Copy Commit ID, Copy Message and Open on
  Remote on the commit at the top of the Changes view and on Compare's commit rows, as on the
  Log's.
- **File History and Open File on Compare's files**, and an inline **Open File** button on the
  Uncommitted view's files, as in Source Control.
- **Exclude from Polylog and Show All Repositories** on repository menus in the Uncommitted
  view and Compare, as in the Log.

### Changed

- **"Copy SHA" is now "Copy Commit ID"** everywhere, one name for one action.
- **The Command Palette lists only what can run now**: Compare's commands while Compare is
  open, Refresh Uncommitted while its view is shown, Show Only and Pull Repositories Behind
  when one is behind, and only the toggle that applies.

### Fixed

- **Folders in the Uncommitted view have a menu.** Stage, Unstage and Discard worked on a
  folder but were never offered.
- **Deleted files no longer offer Open File**, which could only fail: there is nothing in the
  workspace to open.

## [1.0.1] — 2026-10-02

### Fixed

- **Blame shows in repositories that use SHA-256 commit ids**, not only SHA-1 ones.
- **Pull All names untracked files in the way as such.** When new files you have not
  committed would be overwritten, the warning says "untracked files in the way", not
  "local changes to the same files".
- **Fetch and Pull All stops if `git.path` changes while it fetches**, instead of pulling
  with ↓ marks read by the old git.
- **Pull All says when the repositories behind are already being pulled** one by one, instead
  of "no repository is behind".
- **The single Pull recognizes a diverged branch whatever your system's language**: git's
  message is read in English, as Pull All does.

## [1.0.0] — 2026-10-02

### Added

- **Work on uncommitted changes across every repository.** The **Uncommitted** view, in a
  Polylog side bar (its button in the Log toolbar shows it and hides it again), lists each
  ticked repository with uncommitted work, its Staged and Changes groups and files under
  folders. Stage, Unstage, Discard (it always asks, and deletes exactly the files it listed)
  and Commit… go through VS Code's own Git, so Source Control stays in step. The Log gains a
  **Commits | Uncommitted** switch with a badge counting your uncommitted files.
- **Compare two branches across every repository.** **Compare Branches** (⇄ in the Log
  toolbar) opens the **Polylog Compare** panel tab, hidden until then:
  - **Repositories**: the repositories whose files differ, in their Repo List colors. At the
    top, ◀ left ▾ ⇄ ▶ right ▾, each box opening a searchable branch list (recent pairs,
    ★ favorites, local, remote). Repositories missing a branch are listed apart, and
    identical ones are only counted.
  - **Left** and **Right**: what each branch changed since they split, as folder trees with
    your file icons (**Files**), or as commits (**Commits**). A click opens the file as the
    two branches have it now; right-click → **Changes since the Split** shows only what that
    side changed. A file renamed on one side opens against its old name on the other.
  - **Files already on both branches** (a cherry-pick: changed on both sides, yet the same
    now) are hidden by default and counted in the title; the filter in the title bar lists
    them again, dimmed. Commit counts stay in each row's tooltip: they mislead when the same
    change travels by cherry-pick.
  - It reads again after Fetch All, a pull or a moved branch.
- **Blame in Polylog's diffs.** Put the cursor on a line of any Polylog diff or revision to
  see who last changed it, as of the commit shown; hover for the details. It follows
  `git.blame.editorDecoration.template`; `polylog.blame` turns it off.
- **Pull All Repositories Behind**, and **Fetch and Pull All**, in the Log's `…` menu. Every
  repository showing ↓ is brought up to what the last fetch brought: fast-forward only,
  never a merge commit, and never a stash (`merge.autoStash` is turned off for it). A
  repository that diverged, or whose local changes touch the incoming files, is left as it
  was and named. Fetch and Pull All fetches first.
- **All Files** in the Changes view: a commit's whole tree, like the Explorer, each folder
  read only when opened; unchanged files open as they were at that commit.

### Changed

- **Fetch All shows that it is working, and what it found.** The cloud turns into a spinning
  sync while it runs, the status bar counts "fetching 23/68…", and the result stays for
  8 seconds: how many repositories are behind their upstream, or nothing to pull.
- **Uncommitted work moved out of the commit list.** The pinned uncommitted rows, the eye
  toggle and Review Uncommitted are replaced by the Commits | Uncommitted switch and the
  Uncommitted view.
- **Each view has its own icon**, and the Log toolbar's Compare and Uncommitted buttons keep
  a fixed order and show which is on. Polylog never opens, expands or reveals a view by
  itself.

### Fixed

- **File History of a route folder like `[id]`** lists that folder's commits: paths are
  taken literally, not as globs.
- **A repository that fails while paging keeps the commits already shown**, and Load More no
  longer competes with a reload.
- **A submodule in the Changes view is marked as one**, and does not try to open as a file.
- **File History selects its file** in Changes once the folder holding it is shown, without
  errors in VS Code's log.

## [0.5.0] — 2026-09-29

### Added

- **Pull a repository from its right-click menu.** On a repository showing ↓ (in the
  Repositories pane, or on its commits in the Log), **Pull** runs VS Code's own Pull: your
  pull and rebase settings, its credential prompts, and its messages; conflicts show in
  Source Control. VS Code's Git reads the repository again first, so a remote or upstream
  just set in a terminal is seen. For a repository VS Code's Git does not have open,
  Polylog runs `git pull --ff-only`: it only moves the branch forward, never makes a merge
  commit, says so plainly when the branch has diverged, and stops after a minute without
  an answer. Afterwards the pulled commits appear in the Log and ↓ goes.

### Changed

- **git failures are reported by their `fatal:` or `error:` line**, not by the first
  `hint:` line git prints before it.

## [0.4.0] — 2026-09-29

### Added

- **Fetch All.** The cloud in the Log's toolbar (or the Command Palette) runs `git fetch`
  in every repository, 8 at a time, so the ↓/↑ counts are current. It follows VS Code's
  `git.pruneOnFetch`, never asks for credentials (no terminal prompt, no credential
  dialog), and stops a repository that does not answer after 60 s, together with the
  ssh or credential helpers git started. Failures are named in one warning. This is the
  only thing Polylog ever changes in a repository, and only when you click it.
- **Show Only Repositories Behind**, in the right-click menu and the Log's `…` menu while
  any repository is behind: ticks just the ones with commits to pull.
- **Right-click a commit** in the Log: Copy Commit ID, Copy Message (the whole message,
  not only the subject), or Open on Remote, the commit's page on GitHub, GitLab,
  Bitbucket or Azure DevOps. The page is built from the repository's remote, only ever
  as an http(s) link to that remote's host; credentials in the URL are never opened.

### Performance

- **Startup runs 67 fewer git processes on 68 repositories** (205 instead of 272). In
  0.3.0 VS Code Git's first report of each repository counted as its branch moving, so
  every repository's ↓/↑ was read twice.
- **A date change no longer re-reads every working tree** while uncommitted changes are
  shown (68 `git status` to none on 68 repositories). Saves and VS Code Git's reports keep
  them current. Repositories VS Code Git does not report on (Git disabled, deeper than its
  scan depth, ignored, `git.autorefresh` off) are still read every time; Refresh and
  Review Uncommitted always read fresh.

## [0.3.0] — 2026-09-29

### Added

- **See every repository's uncommitted changes, and review them before you commit.**
  - **Show Uncommitted Changes**, the eye in the Log's toolbar (setting
    `polylog.showUncommitted`, off by default), pins one row per repository with
    uncommitted work above its commits: "Uncommitted changes · 3 files". Selecting it
    lists the files in the Changes tree.
  - **Review Uncommitted Changes**, the checklist, opens a mode like File History. The
    Log lists the repositories with changes; click one and the Changes tree shows its
    uncommitted files.
  - Staged and unstaged changes are both compared with the last commit. Fully staged
    files say "staged", and new files say "new".
  - A file opens with the last commit on the left and your real, editable file on the
    right.
  - The Path filter and the repositories you picked apply. The rows hide while a search,
    author or branch filter is on, since uncommitted work has none of those.
  - Everything is read only while shown: one `git status --branch` per repo, plus
    `git diff --numstat` only where there are changes. Your saves and VS Code Git's own
    events refresh it.
  - The toggle acts at once and saves the setting in the background, and each repository
    appears as soon as it is read. On 68 repositories with 5 dirty, the rows appear in
    0.19 s rather than 1.1 s.

- **Right-click a repository**, in the Repositories pane or on any of its commits in the
  Log: Show Only This Repository, Hide from the Log, Show All Repositories, Open Folder in
  New Window, Copy Path, or Exclude from Polylog. Exclude adds the repository's exact path
  to `polylog.excludeRepos` (so a repository elsewhere with the same name stays), keeps
  your own entries, and offers Undo.
- **See which repositories are behind.** The Repositories pane shows ↓3 beside a
  repository with commits on its upstream you have not pulled, and ↑2 for commits not
  pushed. It is counted from local refs, as of your last fetch (Polylog never fetches),
  after the first page, on Refresh, and when VS Code's Git reports that a repository's
  branch or upstream moved.

### Changed

- **Changing `polylog.excludeRepos` or `polylog.scanDepth` in Settings applies at once**,
  instead of on the next refresh.

### Performance

- **Saving a file no longer re-reads every repository.** With uncommitted changes shown,
  a save (or VS Code Git reporting a change) reads only that repository again, and the
  Log is told only when its files really changed, in a small message of the pinned rows
  instead of the whole Log. On 68 repositories one save went from 138 git processes and
  about 600 KB sent to the panel to 2 processes and nothing sent. A save outside every
  repository reads nothing.
- **Holding ↑/↓ reads only the commit you stop on.** The highlight moves at once; the
  commit's files are read when the keys settle (20 rows held: 2 reads instead of 20).
- **Commits no longer wait for the uncommitted read**, and a saved "Me" filter no longer
  loads an empty page first and then everything again.
- **Branch mode:** each repository goes straight from checking the branch to reading its
  log, instead of every repository waiting for the slowest check.
- **Less work in the panel:** the Repositories pane is not rebuilt on each Search
  keystroke, scrolling paints once per frame, diffs of added or deleted files start no
  git process for their empty side, and file colors in the Changes tree are refreshed
  only for the files that changed.

### Fixed

- **Turning `polylog.showUncommitted` on in Settings** (rather than with the toolbar
  button) now shows the rows at once, instead of on the next git event.
- **Clicking "All repositories" when all were shown** left its box looking unticked.
- **Load More, or leaving Review Uncommitted, could stop responding.** A git process
  cancelled just as it finished was never reported as done, so whatever waited for it
  waited forever.

---

## [0.2.0] — 2026-09-24

### Added

- **Polylog uses the same git as VS Code.** It used to run `git` from PATH only, so with
  `git.path` set, or Git installed but not on PATH (common on Windows), it reported "git
  was not found" while VS Code's own Git worked. It now tries your `git.path` (a path or a
  list), then the git VS Code's Git extension found, then PATH, and uses the first that
  runs. Changing `git.path` takes effect at once: git processes still running on the old
  binary stop, and the Log is read again. If no git can run, the message names every path
  it tried.

- **Filter by several authors at once.** Type an author and press Enter (or a comma, or
  pick a suggestion) to add them as a chip. A commit by any of the chips matches: each
  becomes its own `--author` flag, which git combines as "any of", so the filtering stays
  in git. The box suggests who committed recently across your repositories, with how many
  commits. **Me** is now one more author beside the chips instead of replacing them. A repo
  without a `user.email` is still searched for the other authors. Backspace in an empty
  box removes the last chip.
- **Suggestions look like VS Code's own.** The Author and Branch boxes show their
  suggestions in VS Code's suggest-widget style, with the matching letters highlighted,
  instead of the browser's unthemed dropdown. ↑/↓ move, Enter or Tab picks, Esc closes.

- **Filter by path across every repository.** A new **Path** box keeps only commits that
  touched a file, a folder (everything inside it), or a glob, in each repository at once,
  relative to its root. `*.sql` matches in any folder, `db/*.sql` only in `db/`. It becomes a pathspec after `--` on each
  repo's `git log`, so git does the filtering. Paths that could leave a repository (`..`,
  absolute) or switch on other pathspec magic (a leading `:`) are marked invalid and
  never reach git. File History ignores it, since it already follows one file.

### Performance

- **Suggestions load when you first use them.** Author and Branch suggestions used to be
  read for every repository right after startup. They are now read the first time you
  focus that box, once per set of repositories. On a 68-repository workspace, startup went
  from 273 git processes to 137, and first rows from 0.51 s to 0.37 s. The first focus
  costs about 0.1 s.

### Changed

- **File History shows every commit of the file.** It used to keep the message search
  and author filter from the Log, so a file could look like it had 1 commit instead of 9.
  Opening File History now sets the search, author and Me aside, as it already did the
  date range, and closing it gives all of them back.
- **The listing shows how to install Polylog under its published ID.** Polylog is
  published as `lntvan166.polylog-git`, because the Marketplace name `polylog` belongs to
  another publisher's unrelated extension. The Quick Start now gives the ID, the Quick Open
  (`ext install lntvan166.polylog-git`) and command-line installs, the Open VSX route for
  Cursor, VSCodium and Windsurf, and links to both listings. Listing pages show the README
  from the published package, so this release is what brings the instructions there. No
  code changes.

---

## [0.1.0] — 2026-09-24

The first release.

### Added

- **One git log across every repository in the workspace.** Commits from all of them in
  one list, merged newest first by commit date, each with a chip showing the repository it
  belongs to. The chip column fits your longest repository name. A name too long for the
  space is shortened in the middle, so repositories that share a prefix stay apart, and the
  full name is always in the tooltip. Polylog opens as a tab in the bottom panel, next to Terminal.
- **Search and filters that apply to every repository at once:** commit message
  (literal, case-insensitive), author with a **Me** toggle inside the box, branch, and date range (last
  24 hours by default). Every filter becomes a `git log` flag, so git does the searching;
  there is no index and no cache to go stale.
- **Branch in every repo.** Type or pick a branch such as `origin/release-1.4`; each
  repository that has it shows it, the rest show their current branch, and the footer
  says how many of each.
- **Repositories pane** to choose which repositories the Log shows, with fuzzy search
  and multi-select. **Group by Repository** in the Log's title bar shows or hides it.
- **Native Changes tree** for the selected commit, with git status colors and badges.
  Clicking a file opens its diff in VS Code's diff editor above the panel. Right-click the
  commit to copy its SHA or message.
- **Open File** on a Polylog diff, or on a file in Changes, opens the file as it is in the
  workspace now, at the same line number (the file may have changed since).
- **File History.** Right-click a file in the Explorer, an editor, a tab or the Changes
  tree and choose **Polylog: File History**. The Log shows that file's commits, following
  renames. The diff follows the selection, so `↑`/`↓` steps through its revisions. It
  opens on all time, and closing it restores your date range.
- **The Log and Changes stay open.** A click on either header collapses it, and Polylog
  expands it again straight away. Hiding a view again right after (**Hide 'Changes'**, or
  moving a view out of the panel) is respected until the window reloads, and
  `polylog.keepViewsExpanded` turns this off.
- **Keyboard navigation:** `↑`/`↓`, `Home`/`End`, `PageUp`/`PageDown` to move, `Enter` to
  open the first changed file, `/` to search, `Esc` to clear.
- **Every color comes from your theme**, in light, dark and both high-contrast themes.

### Performance

- On a 68-repository, 16,000-commit workspace the first rows appear 0.4 s after the panel
  opens, and a message search across all history takes 0.6 s.
