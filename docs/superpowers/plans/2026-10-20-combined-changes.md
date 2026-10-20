# Combined Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Select several commits in the Log (any repositories). The Changes view lists each file
once, and a file's diff shows only what the selected commits did to it.

**Architecture:** Three pure modules carry the logic: `lineMerge` (diff3 with git's
clean/conflict rule), `combinedModel` (range log → per-file net status, fast/slow path) and
`webview/selectionModel` (click and key rules). The host gets one new read path,
`combinedRead.ts`, which reverts the selected commits from the newest blob in memory. A
`polylog:` URI field `without` serves that text, and the Changes tree gains repository roots.
Plain single-click selection keeps today's `select` message and code path untouched.

**Tech Stack:** TypeScript, esbuild, VS Code API, plain `assert` unit tests, `@vscode/test-electron` + mocha integration tests.

**Spec:** `docs/superpowers/specs/2026-10-20-combined-changes-design.md`

## Global Constraints

- No index, cache or stored selection. Every read and merge runs when asked (CLAUDE.md constraint 1).
- Never write to the user's repository: no checkout, worktree, index, ref, stash, and **no object writes** (`hash-object -w`, `merge-tree --write-tree` and `merge-file` in the repo are all forbidden).
- All spawns async. Reads for a superseded selection are aborted, not awaited (constraint 4).
- Colors only from `--vscode-*` variables and theme color ids; it must render in dark, light and high contrast (constraint 2).
- Fixtures use only `acme-*`, `dana`, `rin` (constraint 3).
- Don't touch the `package.json` version or CHANGELOG (constraint 5).
- Selection limit: **100 commits**. Footer notice: `Combined Changes shows up to 100 commits`.
- Merge limits: binary (a NUL byte in the first 8000 bytes, like git), or **> 1,000,000 bytes or > 20,000 lines** on any side → fallback labeled `binary` / `too large`.
- Clean versus conflict = `git merge-file` semantics: changes on adjacent lines conflict; identical changes on both sides merge.
- Every new `src/**/*.test.ts` is appended to `test:unit` in `package.json`, in the existing `esbuild … && node out/<name>.test.cjs` form.
- Subagents: on the current branch, only `git add <files>` + `git commit`. Never `checkout/switch/reset/rebase/stash/branch`. Confirm `git branch --show-current` first.

## Review Focus

1. **A file renamed inside the selection** (`a` edits `old.ts`, `b` renames it to `new.ts`, `c` edits `new.ts`). Expected: one row `new.ts` with badge R, and the diff reverts across the rename. Pinned in Task 3 (`combineRepo` rename case) and Task 4 (`leftSide` follows the old path).
2. **An unselected merge commit between selected commits** that brings in a teammate's edit. Expected: the file takes the slow path, and is never shown on the fast path as `a^ ↔ c`. Pinned in Task 3 (`parseRangeLog` with `--diff-merges=first-parent`, `combineRepo` merge case).
3. **The selection includes a root commit** (no parent). Expected: no `--not`, an empty "before", and no crash. Pinned in Task 3 (`rangeLogArgs` root case).
4. **A file without a trailing newline, or with CRLF line endings.** Expected: the reverted left side keeps the exact bytes of the untouched lines. Pinned in Task 1 (`merge3` trailing-newline and CRLF cases).
5. **The filter changes while combined reads are in flight.** Expected: the tree shows the surviving selection only, and never a stale repository root. Pinned in Task 6 (integration: filter by author mid-selection).

---

### Task 1: `lineMerge` — diff3 with git's rule

**Files:**
- Create: `src/lineMerge.ts`, `src/lineMerge.test.ts`
- Modify: `package.json` (`test:unit`)

**Interfaces:**
- Produces: `export type MergeResult = { ok: true; text: string } | { ok: false }`; `export function merge3(base: string, ours: string, theirs: string): MergeResult`.

- [ ] **Step 1: Write the failing tests** in `src/lineMerge.test.ts`:
  - `merge3("a\nb\nc\nd\ne\n", "a\nB\nc\nd\ne\n", "a\nb\nc\nd\nE\n")` → `{ ok: true, text: "a\nB\nc\nd\nE\n" }` (two changes separated by unchanged lines).
  - adjacent: base `"a\nb\nc\n"`, ours `"a\nB\nc\n"`, theirs `"a\nb\nC\n"` → `{ ok: false }`.
  - overlapping: both change `b` differently → `{ ok: false }`. Both change `b` identically → ok, with that line.
  - only theirs changed → theirs. Only ours changed → ours.
  - empty base (an added file): base `""`, ours `"x\n"`, theirs `""` → `{ ok: false }`, because both sides "changed" the empty region differently, as git does. Base `""` and ours `""` → theirs.
  - no trailing newline: base `"a\nb"`, ours `"a\nb"`, theirs `"a\nB"` → `"a\nB"` (no newline added).
  - CRLF: base `"a\r\nb\r\n"`, ours unchanged, theirs `"a\r\nB\r\n"` → `"a\r\nB\r\n"`.
  - **Oracle table:** for each of the cases above plus 6 randomized small edits (seeded, deterministic), write base/ours/theirs to `fs.mkdtempSync(os.tmpdir())` files and run `git merge-file -p ours base theirs` with `execFileSync`. Exit code 0 ⇔ `ok: true`, and when 0 the stdout equals `text`. The test runs in plain node outside the extension, so sync spawns are fine here.
  - End each test with `console.log("ok - …")`.

- [ ] **Step 2: Append to `test:unit` and run** `npm run test:unit`. Expected: FAIL, `merge3` not exported.

- [ ] **Step 3: Implement `merge3` in `src/lineMerge.ts`.** Split into lines that keep their terminators (`/[^\n]*\n|[^\n]+$/g`) so bytes round-trip exactly. Run a Myers (or LCS) diff of base→ours and of base→theirs into hunks `{ baseStart, baseEnd, lines }`. Walk both hunk lists over base. Hunks that overlap **or touch** (`a.baseEnd >= b.baseStart`, with insertions at the same point counting as touching) conflict, unless their replacement lines and ranges are identical. Otherwise apply them in order. No `vscode` import, no dependency.

- [ ] **Step 4: Run `npm run test:unit`.** Expected: every `ok - ` line for lineMerge, including the oracle table.

- [ ] **Step 5: Commit**
```bash
git add src/lineMerge.ts src/lineMerge.test.ts package.json
git commit -m "feat(combined): lineMerge, a diff3 with git merge-file's clean/conflict rule"
```

### Task 2: `selectionModel` — click and key rules

**Files:**
- Create: `src/webview/selectionModel.ts`, `src/webview/selectionModel.test.ts`
- Modify: `package.json` (`test:unit`)

**Interfaces:**
- Produces:
  ```ts
  export const SELECTION_LIMIT = 100;
  export interface Selection { keys: string[]; focus: string | null; anchor: string | null } // commitKey strings, list order
  export type Gesture =
    | { kind: "click"; key: string; ctrl: boolean; shift: boolean }
    | { kind: "arrow"; key: string; shift: boolean }   // key = the row moved to
    | { kind: "context"; key: string };
  export function applyGesture(s: Selection, g: Gesture, order: readonly string[]): { next: Selection; overLimit: boolean };
  export function keepListed(s: Selection, order: readonly string[]): Selection;
  ```

- [ ] **Step 1: Write the failing tests** in `src/webview/selectionModel.test.ts`, with `order = ["k0".."k9"]`:
  - plain click `k3` → keys `["k3"]`, focus and anchor `k3`.
  - Ctrl-click `k5` from `[k3]` → `["k3","k5"]` in list order, anchor `k5`. Ctrl-click `k5` again → `["k3"]`. Ctrl-click the only key → unchanged.
  - Shift-click `k6` with anchor `k3` → `k3..k6`, anchor stays `k3`. Shift-click `k1` → `k1..k3`.
  - Ctrl+Shift-click `k8` from `[k1]`, anchor `k1`, plus an earlier Ctrl `k5`: the range is added to the existing keys.
  - Shift+arrow to `k4` from anchor `k3` → `[k3,k4]`. Plain arrow → single key.
  - context on a selected key → unchanged. On an unselected key → `[key]`.
  - limit: Shift-click producing 101 keys → `next` equals the input selection and `overLimit: true`. Ctrl-click the 101st → same.
  - `keepListed` drops keys not in `order`. If the focus is dropped, the focus becomes the first kept key. If nothing is kept, the result is `{ keys: [], focus: null, anchor: null }`.

- [ ] **Step 2: Append to `test:unit`, run.** Expected: FAIL, module not found.
- [ ] **Step 3: Implement** both functions in `src/webview/selectionModel.ts` (pure, no DOM).
- [ ] **Step 4: Run `npm run test:unit`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(combined): selectionModel for Ctrl/Shift multi-select`.

### Task 3: `combinedModel` — the range log to files

**Files:**
- Create: `src/combinedModel.ts`, `src/combinedModel.test.ts`
- Modify: `package.json` (`test:unit`)

**Interfaces:**
- Consumes: `ChangeStatus` from `src/types.ts`.
- Produces:
  ```ts
  export interface RawChange { status: ChangeStatus; path: string; oldPath?: string; oldBlob: string; newBlob: string }
  export interface RangeCommit { sha: string; parents: string[]; changes: RawChange[] }   // newest first, topo order
  export function mergeBaseArgs(selected: readonly string[]): string[];               // ["merge-base", "--octopus", ...]
  export function rangeLogArgs(selected: readonly string[], exclude: readonly string[]): string[];
  export function parseRangeLog(stdout: string): RangeCommit[];
  export interface CombinedFile {
    path: string; oldPath?: string; status: ChangeStatus;
    shas: string[];            // selected commits that touched it, oldest first
    last: string;              // newest of shas
    beforeRef: string | null;  // first parent of shas[0] (null: root commit)
    beforePath: string;        // path at shas[0]'s parent
    included: string[];        // unselected commits in range that touched it (any path in its rename chain), oldest first
    fast: boolean;
  }
  export function combineRepo(selected: ReadonlySet<string>, log: readonly RangeCommit[]): { files: CombinedFile[]; noNetChange: string[] };
  ```

- [ ] **Step 1: Write the failing tests** in `src/combinedModel.test.ts`. Build `RangeCommit[]` literals for the spec's example: `c` (dana: header.ts M, header.css M, debug.ts D), `x` (rin: header.ts M, header.css M), `a` (dana: header.ts M, header.css M, debug.ts A), parents linear. Select `{a, c}`:
  - `rangeLogArgs(["c","a"], ["p"])` deep-equals `["log", "--topo-order", "--raw", "-z", "-M", "--no-abbrev", "--diff-merges=first-parent", "--format=%x1e%H %P", "c", "a", "--not", "p"]`. With `exclude` empty there is no `--not` (the root case).
  - `parseRangeLog` on a captured `-z` string with one rename record (`R100`, two paths) and one merge commit (two parents) gives the right `RangeCommit[]`.
  - `combineRepo`: `header.ts` and `header.css` have `shas: [a, c]` and `included: [x]`, so `fast: false`. `debug.ts` is not in `files`, and `noNetChange` is `["debug.ts"]`.
  - A file only `a` touched, with nothing unselected in range: `fast: true`, `beforeRef` = `a`'s first parent.
  - Net status table, with one case per row of spec 4.4: A…M → A; M…D → D; D…A → M; M…M → M.
  - Fast-path net zero: `a` changes blob `1→2`, `c` changes `2→1`, nothing unselected → in `noNetChange`.
  - Rename: `a` M `old.ts`, `b` R `old.ts→new.ts`, `c` M `new.ts`, all selected → one file `new.ts`, status `R`, `oldPath: "old.ts"`, `beforePath: "old.ts"`.
  - An unselected merge `m` in range whose first-parent diff touches `header.ts` → `included: [m]`, `fast: false`.
  - Two branches: `a` and `c` both selected, `c` not a descendant of `a` (by parents in the log) → `fast: false` for files both touched.

- [ ] **Step 2: Append to `test:unit`, run.** Expected: FAIL.
- [ ] **Step 3: Implement.** Reuse `commitDetail.ts`'s `parseRaw` token logic: move it out as an exported helper and keep `parseShow`'s behavior. For `--no-abbrev`, read `oldBlob`/`newBlob` from the raw record's 3rd and 4th fields. Follow renames by walking oldest→newest and keeping a `currentPath → file` map. Net zero on the fast path: first change's `oldBlob` === last change's `newBlob`.
- [ ] **Step 4: Run `npm run test:unit`.** Expected: PASS, and `commitDetail.test` still passes.
- [ ] **Step 5: Commit** `feat(combined): combinedModel — range log to files, net status, fast path`.

### Task 4: The left side — `combinedRead` and the `without` URI

**Files:**
- Create: `src/combinedRead.ts`, `src/combinedRead.test.ts`
- Modify: `src/revisionUri.ts`, `src/revisionUri.test.ts`, `src/revisionProvider.ts`, `package.json` (`test:unit`)

**Interfaces:**
- Consumes: `merge3` (Task 1); `RunGit` from `src/logQuery.ts`.
- Produces:
  ```ts
  // revisionUri.ts
  export interface RevisionRef { …existing; /** Combined Changes: these commits' changes taken out of <ref>:<path>, newest first. */ without?: string[] }
  // combinedRead.ts
  export const MERGE_LIMIT = { bytes: 1_000_000, lines: 20_000 };
  export type LeftSide = { kind: "text"; text: string } | { kind: "fallback"; reason: "conflict" | "binary" | "too large" };
  export function leftSide(run: RunGit, root: string, last: string, path: string, without: readonly string[], signal: AbortSignal): Promise<LeftSide>;
  ```

- [ ] **Step 1: Write the failing tests.**
  - `revisionUri.test.ts`: `without` survives an encode/decode round trip. Decode rejects a `without` that isn't an array of shas, and rejects more than 100 entries.
  - `combinedRead.test.ts`: use a fake `RunGit` keyed by args, serving `show <sha>:<path>` texts and `diff-tree --no-commit-id -r -M --raw -z <sha>` records. Cases: the clean revert of `a, c` with `x` in between (left keeps `x`'s line); a conflict → `fallback/conflict`; a NUL in a blob → `binary`; 20,001 lines → `too large`; a rename in `b` → `a`'s step reads `old.ts`; a file added by the oldest step → that step's "before" is `""`.
- [ ] **Step 2: Append to `test:unit`, run.** Expected: FAIL.
- [ ] **Step 3: Implement `leftSide`.** Start from `last:path`. For each sha in `without`, newest first: run `diff-tree` on that sha to find the record whose new path is the current path (if none, skip the sha), read `sha:path` as base and `sha^:oldPath` as theirs (a missing side is `""`), then `merge3(base, text, theirs)`. Check limits on every text read. Abort through `signal`. In `revisionProvider.ts`, when `rev.without` is set, return `leftSide(...)`'s text, and throw `new Error("Polylog: these changes can't be shown apart")` on a fallback. The tree has already routed fallback files to a plain URI, so this is unreachable in normal use.
- [ ] **Step 4: Run `npm run test:unit`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(combined): left side by reverting selected commits in memory`.

### Task 5: Host — combined selection, the tree and diffs

**Files:**
- Modify: `src/protocol.ts`, `src/logView.ts`, `src/changesModel.ts`, `src/changesModel.test.ts`, `src/changesTree.ts`, `src/extension.ts`, `package.json`

**Interfaces:**
- Consumes: Tasks 3 and 4; `assignAccents`/`accentOf` from `src/webview/view.ts`, which is already host-importable (extension.ts uses it). Move `ACCENT_COLORS` from `uncommittedView.ts` to `view.ts` as an export and import it in both places.
- Produces:
  ```ts
  // protocol.ts
  WebviewMessage |= { type: "selectMany"; items: { repoId: string; sha: string }[]; focus: { repoId: string; sha: string } };
  HostMessage    |= { type: "setSelection"; items: { repoId: string; sha: string }[]; focus: { repoId: string; sha: string } };
  // changesModel.ts
  export interface CombinedOpen { repoId: string; path: string; last: string; without: string[]; fallback?: { beforeRef: string | null; beforePath: string; reason: "conflict" | "binary" | "too large"; included: string[] } }
  export interface CombinedRepo { repoId: string; repoName: string; accent: number; commits: Commit[]; files: (CombinedFile & { open: CombinedOpen })[] }
  export interface CombinedState { status: "loading" | "ready" | "error"; repos: CombinedRepo[]; noNetChange: string[]; count: number; error?: string }
  export interface RepoDesc extends Base { kind: "repo"; repoId: string; accent: number; children: NodeDesc[] }   // NodeDesc |= RepoDesc
  // FileDesc gains: combined?: CombinedOpen
  export function describeCombined(s: CombinedState): { message: string | undefined; roots: NodeDesc[]; description: string };
  export function combinedTitle(name: string, o: CombinedOpen, shaCount: number, repoName: string): string;
  // changesTree.ts
  setCombined(s: CombinedState | null): void;   // set(state) clears combined mode; setCombined clears single
  // command
  "polylog.openCombinedDiff" (o: CombinedOpen) ; "polylog.clearSelection"
  ```

- [ ] **Step 1: Write the failing unit tests** in `changesModel.test.ts`:
  - `describeCombined` on the spec example → `description === "4 commits · 2 repositories"`. Roots are two `repo` nodes in Repo List order. `header.ts`'s description is `"a3f9 · c7d2"`. `header.css`'s description starts with `"$(warning) "` and its tooltip is `"Includes changes from 1 unselected commit: 9c4e1a8 header: wider title, rem font size"`. `message === "1 file with no net change: src/debug.ts"` (plural: `"2 files with no net change: …"`).
  - `combinedTitle`: clean → `"header.ts (2 selected commits)"`. Conflict → `"header.css (a3f91c2^ ↔ c7d20e5, includes 1 unselected commit)"`. Binary → `"logo.png (a3f91c2^ ↔ c7d20e5, binary)"`. One sha on the fast path → `"header.ts (a3f91c2) — acme-web"`.
- [ ] **Step 2: Run `npm run test:unit`.** Expected: FAIL.
- [ ] **Step 3: Implement the model functions**, then the host:
  - `logView.ts` `case "selectMany"`: validate each item with `findCommit`, cap at `SELECTION_LIMIT`, and with ≤ 1 valid item call `showDetail` (today's path). Otherwise call `showCombined(items)`: abort `this.detail` and start a new controller. Per repository, in parallel through the existing pool: `mergeBaseArgs`. If the base is selected, `exclude` = its parents; else `exclude` = `[base]`. Then `rangeLogArgs` → `combineRepo`. Set `loading` first, then `ready`. For `fast: false` files, call `leftSide`: `text` → `open` without fallback, and `text === right` → move to `noNetChange`; `fallback` → `open.fallback`. Abort on a new selection.
  - `clearTreeIfGone` analogue: when rows reload, drop combined commits no longer listed (re-run `showCombined` on what is left, or `showDetail` if one is left).
  - `changesTree.ts`: `getTreeItem` for `repo` nodes → `ThemeIcon("repo", ThemeColor(ACCENT_COLORS[accent]))`, expanded. The tooltip is one line per selected commit: `<sha7> <subject> · <author> · <absoluteTime>`. Combined file rows keep today's `contextValue` (`file` / `fileDeleted`), with `owner = { repoId, sha: last, parent: null }`, so Open File, Copy Path, Copy Relative Path and File History work unchanged. For a file with `combined` → `command: polylog.openCombinedDiff`, and decoration = net status. `setContext("polylog.combined", on)`.
  - `polylog.openCombinedDiff`: with no fallback → left `toUri({ root, ref: last, path, without })`, right `toUri({ root, ref: last, path })`. With a fallback → left `toUri({ root, ref: beforeRef, path: beforePath })`. Title from `combinedTitle`.
  - `polylog.clearSelection`: post `setSelection` with the focus alone, and show that commit as a single selection.
  - `package.json`: both commands. `clearSelection` gets icon `$(clear-all)` in `view/title` with `view == polylog.changes && polylog.combined`, `navigation@0`. Add `&& !polylog.combined` to both All Files `when`s. Hide both commands from the Command Palette.
  - `openFirst` in combined mode opens the first openable file of the first repository.
- [ ] **Step 4: Run `npm run typecheck && npm run lint && npm run test:unit`.** Expected: all pass.
- [ ] **Step 5: Commit** `feat(combined): host — combined Changes tree, diffs, Clear Selection`.

### Task 6: Webview multi-select, harness, integration tests

**Files:**
- Modify: `src/webview/list.ts`, `src/webview/main.ts`, `src/webview/styles.css`, `dev/harness/mock.ts`
- Modify: `src/integration/log.itest.ts` (a new `describe("Combined Changes")` block, placed last)

**Interfaces:**
- Consumes: `applyGesture`, `keepListed`, `SELECTION_LIMIT` (Task 2); `selectMany`/`setSelection` (Task 5).
- Produces: `ListProps.selectedKeys: ReadonlySet<string>` alongside `selected` (the focus index).

- [ ] **Step 1: Write the failing integration test.** In `before`: take the repo roots from `snapshot().repos`. Remember each `HEAD`, then append commits with `commitAt` from `src/fixtures.ts`, times `T0 + 1000…`. In `acme-web`: `a` (dana) creates `src/header.ts` with 10 lines, edits line 6 of it, edits line 2 of `src/header.css` and adds `src/debug.ts`. `x` (rin) edits header.ts line 4 (two lines away from `a`'s) and header.css line 2 (the same line as `a`). `c` (dana) edits header.ts line 8, appends to header.css and deletes debug.ts. In `acme-api`: two dana commits and one rin commit. Refresh. In `after`: `git reset --hard <head>` in each repo and refresh. Assertions:
  - `send({ type: "selectMany", items: [a, c, api1, api2], focus: api2 })` → the Changes snapshot roots are `acme-web` and `acme-api`. header.ts and header.css are listed once each. The message names `src/debug.ts`. Only header.css has the ⚠.
  - `polylog.openCombinedDiff` on header.ts → the left document contains `x`'s line 4 and `a`'s original line 6. The right document equals `git show c:src/header.ts`.
  - header.css → the left URI's ref is `a`'s parent, and the tab label contains `includes 1 unselected commit`.
  - a filter by author `rin` mid-read → no `acme-web` root holding dana's commits remains (Review Focus 5).
  - a plain `select` of `c` afterwards → the snapshot equals the single-commit shape from earlier tests (a `commit` root, today's description).
  - `git status --porcelain` is empty in each repo, and `git count-objects -v` is unchanged before and after the combined reads.
- [ ] **Step 2: Run `npm run test:integration`.** Expected: the new block FAILs (no multi-select yet); every earlier test passes.
- [ ] **Step 3: Implement the webview.** In `list.ts`, the row `click` handler passes `{ ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey }`, and `onKey` passes `shift` for arrow keys. `contextmenu` applies the `context` gesture. Set `aria-multiselectable="true"` on the list, and `aria-selected` from `selectedKeys`. Add a `.row.multi` class for selected-but-not-focused rows: CSS `background: var(--vscode-list-inactiveSelectionBackground)`, plus `outline: 1px dotted var(--vscode-focusBorder)` under `.vscode-high-contrast`. In `main.ts`, keep `state.selection: Selection`. One key → post `select` exactly as today. Two or more → post `selectMany`, debounced the same way `postSelect` is. `overLimit` → show the footer notice `Combined Changes shows up to 100 commits` through the existing `NoticeBar`. Apply `keepListed` in `replaceRows`, and handle `setSelection`. In `dev/harness/mock.ts`, add a mock pre-selection of 3 rows so the harness shows the multi style in all three themes.
- [ ] **Step 4: Run** `npm run typecheck && npm run lint && npm run test:unit && npm run test:integration`. Expected: all pass. Open the browser harness in dark, light and high contrast, and check the multi-selected rows are distinguishable from the focus row in each.
- [ ] **Step 5: Commit** `feat(combined): Ctrl/Shift multi-select in the Log; integration tests`.

### Task 7: Docs — README and UI Map

**Files:**
- Modify: `README.md`, `dev/ui-map/index.html`

- [ ] **Step 1:** README: add a "Combined Changes" section after the Changes view section. Cover Ctrl/⌘-click and Shift-click, what the diff shows (only the selected commits' lines; others as context), what ⚠ means, the 100-commit limit, and that it is read-only. Any image uses an absolute `raw.githubusercontent.com` URL. Neutral names only.
- [ ] **Step 2:** Run `/ui-map`. Add the **Combined Changes** state of the Changes view (repository root rows, a ⚠ File row, the "no net change" message row, the Clear Selection button) and **multi-selected Commit rows**.
- [ ] **Step 3: Run `npm run test:unit`.** The denylist check passes.
- [ ] **Step 4: Commit** `docs: Combined Changes in the README and the UI Map`.
