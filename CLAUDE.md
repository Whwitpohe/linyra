# CLAUDE.md — Polylog Developer Guide

## What This Project Does

Polylog is a VS Code extension that shows **one merged, filterable git log across every
repository in the workspace**. Click a commit to see its changed files; click a file to open
it in the native diff editor.

Every other VS Code git extension gives you a repository **picker** — one repo's history at
a time. Merging the log is the core of the product; the panel also gives a cross-repository
view of uncommitted work and a comparison of two branches across repositories. Anything else
is a non-goal.

**Current status: 1.4.0 release candidate in the Whwitpohe fork.** The original v1 design is
`docs/superpowers/specs/2026-09-23-polylog-design.md`. Read it before writing any code; this
file records the standing rules, not the design.

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

Polylog's subject matter is multi-repo workspaces, and it was designed against a private
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
  and run with node. Each new `src/*.test.ts` must be appended to the `test:unit` script in
  `package.json` or it silently never runs.
- **Integration tests** use `@vscode/test-electron`, live under `src/` as `*.itest.ts` so
  typecheck and lint cover them, and isolate `$HOME`.
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
