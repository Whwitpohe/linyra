---
name: release
description: Cut and publish a Polylog release to the VS Code Marketplace and Open VSX. Use when the maintainer asks to "make a release", "publish", "ship", "cut a version", "release vX.Y.Z", or "push a new version to the marketplace". Handles the semver bump, CHANGELOG, the full test and check suite, bundle, commit, tag, push, and publishing one .vsix to both registries (vsce + ovsx), pausing for confirmation before the irreversible publish. Only when the maintainer asks: CLAUDE.md constraint 5 forbids releasing on your own.
---

# Release Polylog

Polylog is a VS Code extension (`publisher: lntvan166`, `name: polylog-git`, so the ID is `lntvan166.polylog-git`; plain `polylog` is taken on the Marketplace by another publisher). A release means:
1. Bump the version and record it in the CHANGELOG.
2. Verify that everything builds and every check passes.
3. Commit, tag and push to GitHub.
4. Publish **one** `.vsix` to **two** registries:
   - the VS Code Marketplace, with `vsce`;
   - [Open VSX](https://open-vsx.org), with `ovsx`. This is the registry Cursor, VSCodium and Windsurf use. Without it, the extension does not reach or auto-update in those editors.

**CLAUDE.md constraint 5:** never bump, tag or publish unless the maintainer explicitly asks for a release. This skill is that explicit path, not a licence to release after landing a change.

Publishing is **irreversible on both registries**. You cannot unpublish or re-push a version number. So the flow front-loads every check that can fail, and **pauses for the maintainer's go-ahead** before committing, tagging and publishing.

> The zsh line `compdef:153: _comps: assignment to invalid subscript range` is harmless shell-init noise on this machine. Ignore it in command output.

## Before you start

```bash
git branch --show-current                        # expect: main (merge the PR first)
node -p "require('./package.json').version"       # current version
git tag --sort=-v:refname | head -5               # recent tags
git status --short                                # expect only untracked .impeccable/
```

Untracked files (`.impeccable/`, a local `.denylist`, stray notes) must **never** enter the release commit (step 6).

## Tooling

Check each tool, and install only what is missing. Say what you are about to install first, because it changes the maintainer's system.

| Tool | Check | Install if missing |
|---|---|---|
| `vsce` | `vsce --version` | `npm install -g @vscode/vsce` |
| `ovsx` | `ovsx --version` | `npm install -g ovsx` (the package is `ovsx`, not `@vscode/ovsx`) |
| `gh` | `gh --version` | Needed only for the optional GitHub Release |

## Pick the version (semver)

| Bump | When | Example |
|---|---|---|
| patch | Bug fix, UX or wording tweak, docs, internal change | `0.1.0 → 0.1.1` |
| minor | New feature or setting, or a backward-compatible behavior change | `0.1.1 → 0.2.0` |
| major | A breaking change, or the maintainer declaring 1.0 | `0.x → 1.0.0` |

If it is ambiguous, state your reasoning and pick the lower bump. The maintainer confirms the version at the pause.

## Steps

Do steps 1–5 first; they are all reversible. Then **stop and ask before step 6.**

### 1. Full suite: green baseline

Polylog's checks are more than `npm test`. Run all of them:

```bash
npm test                                             # unit tests (plain assert + "ok - …")
npm run lint && npm run typecheck                    # 0 errors (warnings are the tests' console.log)
npm run check:theme && npm run check:design          # constraint 2: only --vscode-* colors
npm run check:denylist                               # constraint 3: needs .denylist or POLYLOG_DENYLIST
xvfb-run -a npm run test:integration                 # real VS Code, stable
POLYLOG_VSCODE_VERSION=1.85.0 xvfb-run -a npm run test:integration   # the engines floor
```

- **Denylist:** `check:denylist` refuses to pass with an empty list. Locally it reads the gitignored `.denylist`. **Never** write its entries into a committed file, this skill or a commit message.
- If anything fails, stop and fix it. Never publish on red.
- CI on `main` must also be green (`gh run list --branch main --limit 1`). Its `package` job scans the built VSIX for denylist names.

### 2. Bump the version

```bash
npm version <new-version> --no-git-tag-version
```

This bumps `package.json` and `package-lock.json` without npm's own commit or tag. Include both files in the commit.

### 3. CHANGELOG

`CHANGELOG.md` follows Keep a Changelog. Rename `## [Unreleased]` to `## [X.Y.Z] — YYYY-MM-DD` (today), or add a new section above the previous one.
- Use the `### Added / ### Changed / ### Fixed / ### Performance / ### Notes` headings that apply.
- Each bullet leads with a **bold plain-English summary of what the user sees**, then the mechanism and the why.
- Keep neutral names only (`acme-*`, `dana`/`rin`); `check:denylist` also scans this file.

### 4. Production bundle

```bash
npm run bundle          # what vscode:prepublish runs (plus check:denylist)
```

Confirm that `out/extension.js`, `out/webview.js`, `out/webview.css`, `out/compare.js` and `out/compare.css` exist.

### 5. Publish auth, before committing

```bash
vsce verify-pat lntvan166
```

- **Marketplace:** if this fails, the PAT has expired. The maintainer refreshes it in Azure DevOps (Marketplace → Manage scope) and runs `! vsce login lntvan166`.
- **Open VSX** has no `verify-pat`; the token is only checked at publish time. Prerequisites:
  - the Eclipse Foundation **Publisher Agreement** is signed on open-vsx.org (log in with GitHub → user settings);
  - the namespace `lntvan166` exists. `ovsx create-namespace lntvan166 -p <token>` says "already exists" if it does.
- **The Open VSX token is a secret:** pass it as `-p <token>` or `OVSX_PAT`. Never write it into a file or this skill. If the maintainer hasn't given it, ask them to run the Open VSX publish themselves via `! ovsx publish … -p <token>`.

### — PAUSE HERE —

Summarize:
- the version and the CHANGELOG section;
- that the suite, bundle and auth are green;
- the package contents, from `vsce ls`: 13 files (`package.json`, README, LICENSE, CHANGELOG, `ThirdPartyNotices.txt`, `media/polylog.svg`, `media/icon.png`, `media/compare.svg`, `out/extension.js`, `out/webview.js`, `out/webview.css`, `out/compare.js`, `out/compare.css`). `vsce package` reports 15, because it adds `[Content_Types].xml` and `extension.vsixmanifest`.

Then ask for explicit confirmation. Neither registry has an undo.

### 6. Commit only the release files

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -F - <<'EOF'
release: vX.Y.Z — <one-line summary>

Co-Authored-By: <the model that did the work> <noreply@anthropic.com>
EOF
git status --short          # untracked strays must still be untracked
```

Never `git add -A` or `git add .`. The commit must use the repo's **local** identity (`lntvan166 <lntvan166@gmail.com>`), never a work email. Check with `git log -1 --format='%an <%ae>'`.

### 7. Annotated tag

```bash
git tag -a vX.Y.Z -m "release: vX.Y.Z — <same summary>"
```

### 8. Push commit and tag BEFORE publishing

```bash
git push origin main && git push origin vX.Y.Z
```

The VSIX ships no README images (`.vscodeignore` is an allowlist). Both registries fetch them from GitHub, so publishing before the push shows broken images. Check that they resolve:

```bash
for u in demo.gif screenshot-log.png screenshot-file-history.png screenshot-branch.png screenshot-themes.png; do
  printf "%-30s %s\n" "$u" "$(curl -s -o /dev/null -w '%{http_code}' https://raw.githubusercontent.com/lntvan166/polylog/main/media/$u)"
done   # expect 200 on every line
```

### 9. Package once, publish the same file to both

```bash
vsce package                                        # → polylog-git-X.Y.Z.vsix, runs vscode:prepublish
vsce publish --packagePath polylog-git-X.Y.Z.vsix      # VS Code Marketplace
ovsx publish polylog-git-X.Y.Z.vsix -p <token>         # Open VSX (or OVSX_PAT)
```

- **Expected package: 15 files, about 135 KB, as `vsce package` counts them** (13 from the allowlist plus two manifests; v1.2.0 was 133 KB). Hundreds of KB means media or `node_modules` crept in; fix `.vscodeignore` first.
- Both registries index **after** the CLI reports success: Open VSX in about 1–2 minutes, the Marketplace in about 3–5. Poll rather than reading once:

```bash
for i in $(seq 1 25); do
  o=$(curl -s https://open-vsx.org/api/lntvan166/polylog-git | python3 -c "import sys,json;print(json.load(sys.stdin).get('version','?'))" 2>/dev/null)
  m=$(vsce show lntvan166.polylog-git 2>/dev/null | grep "^  Version:" | awk '{print $2}')
  echo "t+$((i*20))s  openvsx=$o  marketplace=$m"
  [ "$o" = "X.Y.Z" ] && [ "$m" = "X.Y.Z" ] && echo "BOTH LIVE" && break
  sleep 20
done
```

- **"Already published" on Open VSX is a success:** the version is live, and neither registry lets you overwrite it.

### 10. (Optional) GitHub Release

This flow is tags only. Only if the maintainer asks:

```bash
gh release create vX.Y.Z --title "vX.Y.Z" --notes "<the CHANGELOG section>"
```

## After publishing

- Link both listings:
  - https://marketplace.visualstudio.com/items?itemName=lntvan166.polylog-git
  - https://open-vsx.org/extension/lntvan166/polylog-git
- Delete the local `.vsix`; it is a build artifact (`*.vsix` is gitignored).

## What NOT to do

- Don't release unless the maintainer asked (constraint 5).
- Don't publish on a failing test, check or bundle, or a red CI.
- Don't `git add -A`.
- Don't commit with a work email.
- Don't write denylist entries or the Open VSX token anywhere committed.
- Don't let `vsce` and `ovsx` each build their own package.
- Don't treat Open VSX "already published" as a failure.
- Don't skip the pause.
