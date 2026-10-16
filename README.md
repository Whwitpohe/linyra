# Polylog

**One git log across every repository in your workspace.**

Every VS Code git extension gives you a repository *picker*: one repo's history at a time.
Polylog merges them. Every commit from every repository sits in one list, newest first. You
can search and filter all of them at once, and click any commit to see its files in VS
Code's own diff editor.

---

<!-- Media MUST use absolute raw.githubusercontent.com URLs, not repo-relative
     paths: the VS Code Marketplace and Open VSX both render this README on their
     own domains and will not resolve `media/...`, so relative links show as
     broken images on the listing pages. The images are excluded from the VSIX,
     so push them to main before publishing. -->

![Polylog: one search finds a ticket's commits in four repositories, and each opens in the native diff editor](https://raw.githubusercontent.com/lntvan166/polylog/main/media/demo.gif)

Ticket ACME-142 touched four repositories. Searching for it once in Polylog lists all
four commits, and each one opens in the native diff editor.

## Screenshots

**The merged log.** Every commit from every repo, with a colored chip showing where it
lives. The Changes tree follows your selection, and clicking a file opens its diff above.

![The merged log of six repositories, with a commit's diff open in the editor](https://raw.githubusercontent.com/lntvan166/polylog/main/media/screenshot-log.png)

**File History.** Right-click any file and choose **Polylog: File History** to get the
commits that touched it, across renames. The diff follows as you step through them with
`↑`/`↓`.

![File History for one file, following renames, with the diff following the selection](https://raw.githubusercontent.com/lntvan166/polylog/main/media/screenshot-file-history.png)

**A branch in every repo.** Type `origin/release-1.4` to see that branch in every
repository that has it. The others fall back to their current branch, and the footer
shows how many repos use each.

![The log on origin/release-1.4: found in three repositories, current branch in the other three](https://raw.githubusercontent.com/lntvan166/polylog/main/media/screenshot-branch.png)

**Your theme, not ours.** Every color comes from your VS Code theme, so Polylog looks like
the rest of your editor. That includes light, dark and both high-contrast themes.

![Polylog in Dark Modern, Light Modern, High Contrast and High Contrast Light](https://raw.githubusercontent.com/lntvan166/polylog/main/media/screenshot-themes.png)

---

## Quick Start

1. Install **Polylog** (extension ID `lntvan166.polylog-git`) in any of these ways:
   - **Extensions view:** search for `lntvan166.polylog-git`, or "Polylog", and pick the
     one by **lntvan166**. Another publisher's unrelated extension is also called polylog.
   - **Quick Open** (`Ctrl+P` / `Cmd+P`): `ext install lntvan166.polylog-git`
   - **Command line:** `code --install-extension lntvan166.polylog-git`
   - **Cursor, VSCodium, Windsurf:** it is on [Open VSX](https://open-vsx.org/extension/lntvan166/polylog-git)
     under the same ID.
   - Listings: [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=lntvan166.polylog-git)
     · [Open VSX](https://open-vsx.org/extension/lntvan166/polylog-git)
2. Open a folder or multi-root workspace containing more than one git repository.
3. Run **Polylog: Open Merged Log** from the Command Palette (`Ctrl+Shift+P` /
   `Cmd+Shift+P`), or click the **Polylog** tab in the bottom panel next to Terminal.

Nothing to configure. Polylog shows every repository VS Code's Git extension has open,
plus any it finds in your workspace folders (up to `polylog.scanDepth` levels deep). Use
`polylog.excludeRepos` to leave some out.

---

## Features

- **One merged log.** Every repository's commits in one list, newest first by commit
  date, with a colored chip showing each commit's repo.
- **Search across every repo.** Search commit messages (literal, case-insensitive) across
  every repository at once.
- **Filters:**
  - **Authors:** type a name or email. Enter, a comma or a picked suggestion adds it as a
    chip, and a commit by any of the chips matches. Suggestions list who committed
    recently across your repos. **Me** is a toggle inside the box that adds each repo's own
    `user.email`.
  - **Path**: only commits touching a file, a folder (everything inside it), or a glob, in
    every repository at once. Paths are relative to each repo's root. `*.sql` matches in
    any folder; `db/*.sql` only in `db/`.
  - **Branch**, applied in every repo that has it.
  - **Date range:** last 24 hours by default, or 7 days, 30 days, all time, or a custom
    range.
- **Repositories pane.** Pick which repositories to show, with fuzzy search and
  multi-select. Toggle it with **Group by Repository** in the Log's title bar.
  - **↓3 ↑2** beside a name: commits on its upstream you haven't pulled, and commits you
    haven't pushed, as of the last fetch. **Fetch All** (the cloud in the Log's toolbar)
    runs `git fetch` in every repository, a few at a time, and never prompts for
    credentials; Polylog fetches only when you ask. **Show Only Repositories Behind**
    (right-click, or the Log's `…` menu) then ticks just the ones with commits to pull.
    Right-click a repository showing ↓ to **Pull** it: through VS Code's own Git (your
    pull settings, its credential prompts, conflicts in Source Control), or
    `git pull --ff-only` for a repository VS Code's Git does not have open.
    **Pull All Repositories Behind** (the Log's `…` menu, or right-click a repository) brings
    every repository with ↓ up to what the last fetch brought, fast-forward only and without
    fetching again; **Fetch and Pull All** fetches first. A repository that diverged, or whose
    local changes touch the incoming files, is left as it was and named.
  - **Right-click a repository**, in the pane or on any of its commits in the Log: Show
    Only This Repository, Hide from the Log, Show All Repositories, Open Folder in New
    Window, Copy Path, or Exclude from Polylog (adds its path to `polylog.excludeRepos`,
    with an Undo).
- **Right-click a commit** in the Log: Copy Commit ID, Copy Message (the whole message),
  or Open on Remote, its page on GitHub, GitLab, Bitbucket or Azure DevOps (from the
  repository's `origin`; credentials in the URL are never opened).
- **Native Changes tree.** Its title says what it shows (`acme-api · 3f9a2c1 · 2 files`, or
  `… · uncommitted · …`). Git status colors and `A`/`M`/`D`/`R` badges. Click a file to
  open its diff in the editor area. Right-click the commit to copy its SHA or message.
  **All Files** (in its title bar) shows the commit's whole tree, like the Explorer: the
  folders holding changes open, each other folder read only when you open it, deleted files
  still listed, and unchanged files opening as they were at that commit.
- **Blame in diffs.** Put the cursor on a line of any Polylog diff or revision to see who last
  changed it, as of the commit shown (hover for the details). It uses the format of
  `git.blame.editorDecoration.template`; turn it off with `polylog.blame`.
- **Open File** on any Polylog diff (the title-bar button, or a file's right-click in
  Changes) opens the file as it is in your workspace now, at the same line number.
- **Uncommitted changes, across every repo:**
  - **The Uncommitted view** (in the Polylog side bar, like Source Control: its button in the
    Log toolbar shows it, and hides it again): one
    row per ticked repository with uncommitted work, its **Staged** and **Changes** groups,
    files under folders. Hover for **Stage**, **Unstage**, **Discard** (a file, a folder, a
    group, staged or not; it always asks first) and, on a repository, **Commit…**; right-click
    a repository for **Stage All**, **Unstage All** and **Discard All Changes** (everything in
    it, back to the last commit). All
    through VS Code's own Git, so Source Control stays in step. Each file opens the diff Source Control would.
  - **Commits | Uncommitted**, the switch at the top of the Log: its badge counts your
    uncommitted files. The Uncommitted side lists the repositories with work (files, a
    change meter, staged and new tags, when last edited); click one to review its files in
    the Changes tree. Right-click a row, or the Changes tree, for **Commit…**, **Stage All**, **Unstage
    All** and **Discard All Changes**; right-click a file or folder there to **Stage**,
    **Unstage** or **Discard** it. Ctrl/Shift-click to act on several rows at once (one
    prompt, even across repositories).
  - Read once in the background after the Log's first page, then kept current by your
    saves and VS Code's Git, one repository at a time.
- **Compare Branches** (⇄ in the Log toolbar, or the Command Palette) opens the **Polylog
  Compare** panel tab, hidden until then; ⇄ again (or × in its title) hides it: three views
  side by side. It compares two branches in every ticked
  repository, for example `origin/release-1.4` (◀ left, what you merge from) and
  `origin/main` (▶ right, where it goes).
  - **Repositories** lists the repositories whose files differ, in their Repo List colors (commit
    counts are in each row's tooltip; they mislead when the same change travels by cherry-pick).
    A ▸ unfolds the changes committed on both sides (cherry-picks). Repositories that lack a
    branch are listed at the bottom.
    At the top: **◀ left ▾ ⇄ ▶ right ▾**, each box opening a searchable branch list (recent
    pairs, ★ favorites, local, remote), then **Files | Commits** and **Refresh**.
  - **Left** and **Right** show the selected repository's two sides:
    - **Files** (the default): what each side changed since the branches split, as a folder
      tree with your file icons. A file changed on both sides is marked **both**. One the two
      branches now have the same (a cherry-pick: nothing to merge) is hidden, and counted in the
      title; **Show Files Already on Both** (the filter in the title bar) lists it, dimmed.
    - **Commits**: each side's commits, each expanding to its files.

    Click a file to open it as the two branches have it now (the target branch on the left);
    right-click → **Changes since the Split** shows only what that side changed (what the merge
    brings in).
- **File History.** From the Explorer, an editor, a tab, or a file in Changes. Follows
  renames, and always shows every commit of the file: it sets your date range, search and
  author aside while open, and gives them back when you close it.
- **Keyboard first.** The selection drives everything, so you can review a day's work
  without touching the mouse.

| Key | Action |
|---|---|
| `↑` / `↓`, `Home` / `End`, `PageUp` / `PageDown` | Move the selection; the changed files follow |
| `Enter` | Open the selected commit's first changed file |
| `/` or `Ctrl/Cmd+F` | Search commit messages |
| `Esc` | Clear the search, then return to the list |

---

**Where things are:** the **Polylog** panel tab holds the Log and the Changes view; the
**Polylog Compare** tab holds Compare; the Uncommitted view is in the Polylog side bar. Drag
any view elsewhere and VS Code keeps it there (views you moved yourself stay put after an
update).

## How It Works

```
 Filters (search · authors · path · branch · dates · repos)
                 │  passed straight through as git log flags
     ┌───────────┼───────────┬───────────┐
  git log     git log     git log     git log      one process per repository,
  acme-web    acme-api    acme-libs   …            16 at a time
     └───────────┴─────┬─────┴───────────┘
                       ▼
          merged by commit date, streamed a page at a time
                       ▼
             Log  ·  Changes  ·  diff editor
```

Polylog has **no index, no cache and no database**. Git does all the searching. Every
filter becomes a `git log` flag (`--grep`, `--author`, `--since`/`--until`, a ref, a pathspec), so each
repository returns only matching commits, and Polylog merges those already-filtered lists.

On a 68-repository, 16,000-commit workspace:

- The full `git log` fan-out takes **25 ms**.
- A message search across all of history takes **640 ms**.
- The first rows appear **0.4 s** after the panel opens.

An index would add a background process and a way to show stale results, for a gain
measured in milliseconds. Typing in a filter waits 250 ms before searching. A new search
stops any `git` processes still running, rather than waiting for them.

Unrelated repositories share no history, so the merge is by commit date. A rebase or a
skewed clock can place a commit out of order.

---

## Extension Settings

| Setting | Default | Description |
|---|---|---|
| `polylog.pageSize` | `200` | Commits fetched per repository per page. |
| `polylog.maxConcurrency` | `16` | Maximum number of `git` processes running at once. |
| `polylog.scanDepth` | `2` | Folder levels to search the workspace folders for repositories, in addition to those the Git extension has open. |
| `polylog.excludeRepos` | `[]` | Glob patterns for repositories to leave out, matched against the folder name and full path. |
| `polylog.blame` | `true` | Show who last changed the cursor's line in Polylog's diffs and revisions. |

---

## Requirements

| Requirement | Notes |
|---|---|
| VS Code 1.85+ | Or a compatible editor that installs from Open VSX |
| Git | The same git as VS Code: your `git.path` setting, then the git VS Code's Git extension found, then `git` on `PATH`. Changing `git.path` takes effect at once |

Polylog only reads history, except when you ask it to fetch or pull.

---

## Contributing & Issues

Found a bug or have a feature request?
[Open an issue on GitHub](https://github.com/lntvan166/polylog/issues).

Development:

    npm install
    npm run compile && npm test          # lint/typecheck: npm run lint, npm run typecheck
    npm run harness                      # webview in a browser: http://localhost:5178/gallery.html
    xvfb-run -a npm run test:integration # real VS Code, three fixture repos
    xvfb-run -a npm run perf:startup     # time to first rows on a generated 68-repo workspace
    node dev/demo/seed.mjs               # the demo workspace in the screenshots: /tmp/polylog-demo
    dev/demo/capture.sh <polylog.vsix>   # re-shoot the screenshots and GIF (Linux, Xvfb)

---

## License

MIT — see [LICENSE](LICENSE)
