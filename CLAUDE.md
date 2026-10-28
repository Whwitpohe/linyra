# CLAUDE.md — Linyra Developer Guide

## What This Project Does

Linyra is a **multi-repository Git client for VS Code, modelled on the Log of the Git tool
window in JetBrains IDEs (WebStorm, IntelliJ IDEA)**: one merged, filterable log across every
repository in the workspace, a branches panel beside it, the selected commit's details and
changed files beside that, and the everyday repository work reachable from the row it
applies to. Click a commit to see its changed files; click a file to open it in VS Code's
native diff editor.

Every other VS Code git extension gives you a repository **picker** — one repo's history at
a time. The merged log stays the core: each feature works across all ticked repositories at
once, and every action runs in the repository of the row it was started from. A row's color
band names its repository, as the root column does in the JetBrains Log.

**In scope** — the parts of the WebStorm Log, across repositories:

- **Log:** merged commits with a real graph; filters for text or hash (match case, regular
  expression), branch or tag, author, date, path and repository; date or topological order;
  history folding; Highlight My Commits, Highlight Current Branch, a hash column. One header
  row holds the switch, the filters and the actions.
- **Repo List:** one tree — each repository opens onto its Local, Remote and Tags groups, with
  favorites; checkout, new branch, rename, delete, merge, rebase, push, pull, compare, worktree;
  tags check out detached, push and delete.
- **Commit rows:** cherry-pick, revert, reset current branch to here, checkout revision,
  new branch or tag from a commit; on HEAD, Undo Commit and Edit Commit Message (subject).
  Each runs in the commit's own repository, through VS Code's Git where its API has the
  operation, and asks before moving a branch or HEAD (and warns when the commit is pushed).
- **Across repositories:** Branches Across Repositories… (check out, create or merge one name
  in every ticked repository), Push… (every repository's outgoing commits in one dialog) and
  Update Project (Fetch All, then merge or rebase each onto its upstream — never autostash).
- **Commit details:** full message and references, changed-files tree, native diffs,
  Combined Changes of several commits, file history, blame.
- **Working tree:** uncommitted work per repository; stage, unstage, discard, commit.
- **Sync:** Fetch All, Pull, Pull All Behind, ahead/behind badges; Compare Branches.

**Non-goals:** a background index or cache (constraint 1); interactive rebase, hunk staging,
a merge or conflict editor, or anything else VS Code's own Source Control and merge editor
already do — Linyra hands off to them; hosting integrations (pull requests, issues, CI).
Linyra writes to a repository only when the user asks (a menu item, a button, a confirmed
prompt such as writing a commit-graph).

**Current status: Linyra, independently maintained from Polylog in the Whwitpohe fork.**

Publishing identity: `whwitpohe.linyra`; product name: **Linyra**. Preserve upstream copyright
and license notices. Public settings use only `linyra.*`. Do not migrate, read or register
legacy `polylog.*` settings. Commands, views, contexts, URI schemes and private state keys
use Linyra identifiers; never register upstream aliases. Earlier Linyra private Memento
keys are migrated inside this extension's own storage only. See `docs/PUBLISHING.md`
for the fork publishing and migration procedure. The original v1 design is
`docs/superpowers/specs/2026-09-23-polylog-design.md`. Read it before writing any code; this
file records the standing rules, not the design. The scope above (2026-10-28) supersedes that
spec's non-goals; its architecture and constraints still hold.

---

## Standing Constraints

These five override convenience, a smaller diff, and any tool's suggestion.

### 1. No index, no cache, no database

Measured on a 68-repository, 16,314-commit workspace: the full `git log` fan-out is **25 ms**
(16-way parallel; 330 ms even serial), and a whole-history `--grep` across all 68 is 640 ms.
A background index would add a native dependency, a sync subsystem and staleness bugs to
improve on 25 ms.

**Corollary: push every filter down into `git log` flags** (`--grep`, `--since`, `--until`,
repo subset). Git does the searching; JavaScript only merges already-filtered streams. Any
change that starts filtering in JavaScript has thrown the architecture away — reject it.

### 2. All color and type come from VS Code theme variables

No hard-coded hex. No bundled webfont. No assumption of light or dark. Use
`--vscode-editor-background`, `--vscode-foreground`, `--vscode-descriptionForeground`,
`--vscode-list-*`, `--vscode-focusBorder`, `--vscode-charts-*`, `--vscode-font-family`.

It must render correctly in light, dark **and high-contrast**. This is the single most
common way an extension webview looks broken, and it is why the design tooling below is
scoped to structure rather than palette.

### 3. Neutral fixtures — no employer or internal names, anywhere

Linyra's subject matter is multi-repo workspaces, and it was designed against a private
employer monorepo. Every fixture, screenshot, test name, doc example and changelog entry
will be tempted toward those real names.

No employer name, no internal repository, service, branch, ticket or module names — in test
fixtures, design docs, CHANGELOG, README, or any screenshot or recording.

Canonical placeholders: `acme-web`, `acme-api`, `acme-libs`, `origin/release-1.4`, authors
`dana` / `rin`.

**CI fails on a denylist grep.** The precedent is direct: in a sibling project an employer
org name and internal module paths reached *both marketplaces inside a shipped VSIX* before
being caught and scrubbed in a follow-up release. A CI check is cheaper than a scrub release.

This fork uses the repository-local identity
`Whwitpohe <7278281+Whwitpohe@users.noreply.github.com>`, overriding the machine's global
identity. Historical upstream authorship is unchanged. Never commit here with a work email.

### 4. Never block the extension host

The host is one thread shared with every other extension. All spawns async. Filter input
debounced 250 ms — without it, typing a six-character term launches 408 child processes.
In-flight spawns are killed when the filter changes, not awaited.

### 5. Do not publish on your own

Do not bump the version, tag, or run `vsce publish` / `ovsx publish` unless the maintainer
explicitly asks. Land the change and leave `package.json` version and CHANGELOG alone; the
maintainer decides when to release.

---

## Design Tooling — Impeccable

[Impeccable](https://github.com/pbakaus/impeccable) (Apache-2.0, zero deps) is installed
project-scoped, **not committed** (gitignored, so the Apache-2.0 payload stays out of this
MIT repo). Reinstall with:

```bash
npx impeccable install --providers=claude --scope=project
```

**In scope:** `layout`, `shape`, `clarify`, `distill`, `critique`, `audit`, `harden`,
`adapt`, `optimize`, and all detector rules (contrast, focus states, gray-on-color,
nested cards).

**Out of scope:** `colorize`, `typeset`, `bolder`, `delight`, `overdrive`. These exist to
give a product a distinctive visual voice; a VS Code panel needs the opposite. Constraint 2
overrides any impeccable suggestion that conflicts with it.

### Standalone browser harness

The webview is built so its HTML/CSS/JS also render in a plain browser, via a dev harness
supplying mock commits and a shim defining the `--vscode-*` variables for dark, light and
high-contrast.

Three payoffs: design iteration in a browser reload instead of an extension-host restart,
impeccable's live iteration and detectors work against the real markup, and theme
correctness becomes testable rather than hoped for. Dev-only; excluded from the VSIX.

---

## Conventions

Inherited from the sibling extension in this workspace, which is the reference for house
style:

- **TypeScript, bundled with esbuild.** No framework in the webview.
- **Unit tests are plain `assert` + `console.log("ok - …")`**, bundled per-file by esbuild
  and run with node by `scripts/run-unit.mjs`, which finds every `src/**/*.test.ts` itself:
  a new test file needs no registration.
- **Integration tests** use `@vscode/test-electron`, live under `src/integration/` as
  `*.itest.ts` so typecheck and lint cover them, and isolate `$HOME`. The suites share one
  workspace: `index.ts` fixes their order, shared helpers live in `helpers.ts`, and a new
  suite must also be added to the `build:itest` script.
- **Pure modules carry the logic.** `mergeStream`, `filterModel` and the parsers import no
  `vscode` — that is where the tests are. Modules that touch VS Code stay thin.
- **CI** runs lint, typecheck, compile and tests on Linux/macOS/Windows.
- **`.vscodeignore`** excludes `docs/`, `.claude/`, `CLAUDE.md`, the dev harness, and CI
  config. `CHANGELOG.md` ships intentionally — the registries render it.
- **README images must use absolute `raw.githubusercontent.com` URLs.** Both marketplaces
  render the README on their own domain and will not resolve relative paths.

## Subagent / Background-Task Git Safety

Subagents run in the same working directory with no worktree isolation, so a stray
`checkout`/`reset` can land a commit as a dangling commit on the wrong base — branch HEAD
unmoved, tree clean, work recoverable only by `git cherry-pick <sha>`.

When dispatching a subagent that commits: instruct it to run only `git add <files>` +
`git commit` on the current branch, never `checkout/switch/reset/rebase/stash/branch`, and
to confirm `git branch --show-current` first. After it returns, verify HEAD actually
advanced before trusting the work.
