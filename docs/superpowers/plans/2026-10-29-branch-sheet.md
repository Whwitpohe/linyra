# Branch sheet — a branch pill's click opens what the branch is and what to do next

Reference: GitLens 19's graph branch sheet (behavior only; its source is LICENSE.plus). Adapted to
Linyra's rules: several repositories (the sheet names its repository), no hosting integration
(no pull requests, issues, Launchpad), no recompose (interactive rebase is a non-goal), every
write asked first, git processes counted.

## Where and when

- A plain click on a branch, remote or tag pill in a Log row selects that row (as today) and shows
  the sheet in the Changes view's details area, in place of the commit details. The pill sits on
  the branch's tip, so the files above are the tip commit's: the sheet's tip line says so.
- The details heading reads "Branch" while the sheet shows. If the details were folded, they open.
- Selecting another row, Esc in the sheet, or its × returns the commit details.
- Ctrl/Shift-clicks keep their multi-select meaning. The hover card's pills open the sheet too
  (their row selected); the sheet's "Reveal in Repo List" button keeps the old click's meaning.

## Content

Header: kind icon (branch, cloud for remote, tag), the name, the repository (its color dot and
name: several repositories share one Log), "current" when checked out; buttons Reveal in Repo
List, Copy Name, Close.

Tip line: short id (selects it), subject, author · when.

### Local branch

**Upstream card.** "Upstream origin/develop" (or "Not published"). One status and its buttons:

| State (from `%(upstream:track)` of the last fetch) | Status | Buttons |
|---|---|---|
| in step | Up to date | Fetch |
| ahead N | N to push | Push, Fetch |
| behind N | N to pull | Pull (checked out only), Fetch |
| ahead and behind | Diverged: N to push, M to pull | Pull (checked out), Force Push…, Fetch |
| gone | Missing from the remote | Publish |
| no upstream | Not published | Publish |

Force Push… is Push Branch…'s lease (never main, master, `git.branchProtection`).

**Merge target card** (hidden when the branch is its own target, e.g. main on origin/main).
"Merges into origin/main", where the target is the upstream remote's default branch (origin's,
or the only remote's) — the hover card's rule, one for-each-ref plus one rev-list.

| State | Chip | Status | Buttons |
|---|---|---|---|
| ahead N, behind 0 | — | Based on origin/main · N new commits | Review |
| behind M (ahead any) | No conflicts / N conflicts / Unknown | Behind origin/main by M commits | Merge, Rebase (checked out only), Review |
| ahead 0 | Merged | Every commit is on origin/main: safe to delete | Delete Branch… (not checked out) |

Conflicts: one `git merge-tree --write-tree` with a scratch object directory (Compare's check;
git 2.38+, else Unknown), only when behind. Review opens Compare with ◀ the branch, ▶ the target.
Merge and Rebase are the Repo List's own (asked first).

**Next steps.** Switch to develop [Switch] when not checked out (Smart Checkout when local
changes are in the way); Checked out in worktree acme-web-hotfix [Open] when another worktree has
it; Explain [Explain] when Linyra AI is on (unpushed commits for the checked-out branch, the
branch otherwise — the pill menu's commands).

### Remote branch

Tip line; Switch to origin/x (a local branch tracking it, asked as today), Fetch, Review (Compare
◀ it ▶ the checked-out branch).

### Tag

Tip line; Switch to v1.4.0 (detached, asked), Create Branch from v1.4.0…, Push v1.4.0….

## Cost

Opening the sheet: one for-each-ref for the ref (its sha, upstream and track), one for-each-ref
and one rev-list for the merge target (skipped for a remote or tag), one merge-tree only when
behind. Read once per open; read again after one of its actions. Selecting another row aborts it.

## Look

VS Code tokens only. Cards as the commit details' blocks: a section label (11px, description
color), a status line, buttons as VS Code's secondary buttons (small). Chips: No conflicts and Up
to date in the add color, conflicts in the conflict color, Unknown and Merged in the description
color; never color alone (each chip has its word). Narrow: buttons wrap under the status.
Keyboard: the sheet is a region with a heading; Tab moves through its buttons; Esc closes.

## Modules

- `src/branchSheetModel.ts` (pure): parse the ref's for-each-ref line; upstream and merge-target
  states, their labels and buttons; tests.
- `src/branchSheet.ts` (host): reads, the actions (existing commands: linyra.branch.fetch, pull,
  push, checkout, merge, rebase, delete, create; linyra.ai.explainBranch / explainUnpushed;
  Compare through hover.compare).
- `src/webview/branchSheet.ts` + `branchSheet.css`: the sheet.
- Hooks: one hunk in `src/webview/main.ts` (onRevealBranch, selection change), the sheet's
  element in `src/webview/changes/html.ts`, `protocol.ts` appended messages, `logView.ts` routing.
