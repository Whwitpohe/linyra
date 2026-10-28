---
name: release
description: Cut and publish a Linyra release to the VS Code Marketplace and Open VSX. Use when the maintainer asks to "make a release", "publish", "ship", "cut a version", "release vX.Y.Z", or "push a new version to the marketplace". Handles the semver bump, CHANGELOG, the full test and check suite, bundle, commit, tag, push, and one GitHub Release whose workflows publish the same .vsix to the Marketplace and Open VSX with trusted publishing (no token; the signed-in publisher page is the fallback), pausing for confirmation before the irreversible publish. Only when the maintainer asks: CLAUDE.md constraint 5 forbids releasing on your own.
---

# Release Linyra

Linyra is an independently maintained fork of Polylog (`publisher: whwitpohe`,
`name: linyra`, so the ID is `whwitpohe.linyra`). See `docs/PUBLISHING.md` for the
publisher setup and migration procedure. Never publish under the upstream author's identity.
A release means:
1. Bump the version and record it in the CHANGELOG.
2. Verify that everything builds and every check passes.
3. Commit, tag and push to GitHub.
4. Publish **one** `.vsix`, built once, everywhere, by publishing a **GitHub Release** with the
   VSIX and `SHA256SUMS.txt` (step 10). The Release starts two workflows, neither with a token:
   - `.github/workflows/publish-marketplace.yml` publishes it to the **VS Code Marketplace**
     with Marketplace Trusted Publishing (GitHub OIDC; the publisher's policy
     `linyra-github-releases` trusts this repository and this workflow file) — step 11;
   - `.github/workflows/publish-open-vsx.yml` publishes it to **[Open VSX](https://open-vsx.org)**
     (the registry of Cursor, VSCodium and Windsurf) once the namespace is verified — step 12.

   If the Marketplace workflow fails, upload the same VSIX on the publisher page in the
   signed-in browser instead (step 11's fallback; that is how 1.4.x and 1.5.0 went out).

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

Nothing needs installing on this machine:

| Tool | How | Used for |
|---|---|---|
| `vsce` | `npx vsce …` (a dev dependency) | `ls`, `package`, and `show` to watch the Marketplace version |
| Browser (Claude in Chrome) | already signed in to GitHub and to the Marketplace publisher | the Marketplace upload, the GitHub Release, re-running a CI job |
| GitHub's public API | `curl https://api.github.com/repos/Whwitpohe/linyra/…` | CI status, release assets and digests |

`gh` and `ovsx` are not installed and not needed. Pushes go through Git Credential Manager.
Never pull a token out of a credential store, an environment variable or a token file
(Codex's sessions mention an encrypted `.publish-secrets` directory): handling credentials is
the maintainer's, and the web upload needs none.

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

Linyra's checks are more than `npm test`. Run all of them:

```bash
npm test                                             # unit tests (plain assert + "ok - …")
npm run lint && npm run typecheck                    # 0 errors (warnings are the tests' console.log)
npm run check:theme && npm run check:design          # constraint 2: only --vscode-* colors
npm run check:denylist                               # constraint 3: needs .denylist or LINYRA_DENYLIST
xvfb-run -a npm run test:integration                 # real VS Code, stable
LINYRA_VSCODE_VERSION=1.85.0 xvfb-run -a npm run test:integration   # the engines floor
```

- **Denylist:** `check:denylist` refuses to pass with an empty list. Locally it reads the gitignored `.denylist`. **Never** write its entries into a committed file, this skill or a commit message.
- If anything fails, stop and fix it. Never publish on red.
- CI on `main` must also be green. Its `package` job scans the built VSIX for denylist names:

```bash
curl -s "https://api.github.com/repos/Whwitpohe/linyra/actions/runs?branch=main&per_page=1" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d).workflow_runs[0];console.log(r.head_sha.slice(0,7),r.status,r.conclusion)})"
```

- A job that failed in `npm ci` with `ECONNRESET` is the runner's network, not the code (CI
  retries `npm ci` three times since 1.5.0). If it still fails, open the run in the browser →
  **Re-run jobs → Re-run failed jobs**. Read a failing job's log in the browser; the public API
  gives only the failed step's name.

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

### 5. Publishing access, before committing

- **Marketplace:** the Trusted Publishing policy `linyra-github-releases` should read *Active* on
  https://marketplace.visualstudio.com/manage/publishers/whwitpohe/trustedpublishing (the page
  redirects through a sign-in check, `_MsalSignedInFps`, first). The same signed-in page is the
  fallback upload. If it asks to sign in instead, stop: signing in is the maintainer's.
- **GitHub:** https://github.com/Whwitpohe/linyra/releases/new opens the new-release form when
  the browser is signed in.
- **Open VSX:** check whether the namespace is verified (until it is, step 12 only waits):

```bash
curl -s https://open-vsx.org/api/whwitpohe | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log('verified:',JSON.parse(d).verified))"
```

`vsce verify-pat whwitpohe` failing (TF400813) does **not** block a release: the token stored
for the CLI expired, and the web upload does not use it.

### — PAUSE HERE —

Summarize:
- the version and the CHANGELOG section;
- that the suite and bundle are green, and the browser reaches both publishing pages;
- the package contents, from `vsce ls`: 19 files (`package.json`, the English/Chinese
  manifest catalogs, the Chinese runtime catalog, English/Chinese READMEs, LICENSE, CHANGELOG,
  `ThirdPartyNotices.txt`, the three allowlisted icons, and seven production JS/CSS
  bundles for extension, Log, Compare and Changes). `vsce package` reports 21 because
  it adds `[Content_Types].xml` and `extension.vsixmanifest`.

Then ask for explicit confirmation. Neither registry has an undo.

### 6. Commit only the release files

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -F - <<'EOF'
release: vX.Y.Z — <one-line summary>

EOF
git status --short          # untracked strays must still be untracked
```

Never `git add -A` or `git add .`. The commit must use the repo's **local** identity (`Whwitpohe <7278281+Whwitpohe@users.noreply.github.com>`), never a work email. Check with `git log -1 --format='%an <%ae>'`.

### 7. Annotated tag

```bash
git tag -a vX.Y.Z -m "release: vX.Y.Z — <same summary>"
```

### 8. Push commit and tag BEFORE publishing

```bash
git push origin main && git push origin vX.Y.Z
```

In auto mode the classifier may refuse pushing a release tag as a public action. Do not work
around it: say so, and push once the maintainer has approved it in chat.

The VSIX ships no README images (`.vscodeignore` is an allowlist). Both registries fetch them from GitHub, so publishing before the push shows broken images. Check every image the README links (they live in a versioned `media/vX.Y.Z/` folder):

```bash
for u in $(grep -o 'raw.githubusercontent.com/Whwitpohe/linyra/main/media/[^)" ]*' README.md | sort -u); do
  printf "%s %s\n" "$(curl -s -o /dev/null -w '%{http_code}' "https://$u")" "${u##*/}"
done   # expect 200 on every line
```

### 9. Package once

```bash
npx vsce package --out whwitpohe.linyra-X.Y.Z.vsix     # runs vscode:prepublish; *.vsix is gitignored
sha256sum whwitpohe.linyra-X.Y.Z.vsix | sed 's/ \*/  /' > SHA256SUMS.txt   # "<sha256>  <file>", as earlier releases
```

- **Expected package: 21 files, about 300 KB, as `vsce package` counts them**
  (19 allowlisted files plus two manifests). Inspect the allowlist and actual archive;
  source, development dependencies, screenshots and source maps must not ship.
- Keep `SHA256SUMS.txt` outside the repository (the scratchpad), or delete it after step 10.

### 10. GitHub Release

Every release since 1.4.2 has one, and both stores are fed from it. In the signed-in browser:

1. Open https://github.com/Whwitpohe/linyra/releases/new?tag=vX.Y.Z (the tag is preselected).
2. Title `Linyra X.Y.Z`; description `— YYYY-MM-DD`, a blank line, then the CHANGELOG section
   (fill both with the browser's form input).
3. Attach `whwitpohe.linyra-X.Y.Z.vsix` and `SHA256SUMS.txt` to the *Attach binaries* file
   input; wait until the upload finishes. GitHub saves the form as a draft meanwhile.
4. Keep **Set as the latest release**, then **Publish release**.
5. Check that GitHub's digest of the asset is the tested package's SHA-256:

```bash
curl -s https://api.github.com/repos/Whwitpohe/linyra/releases/tags/vX.Y.Z \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d);console.log(r.name,'draft:',r.draft);for(const a of r.assets)console.log(a.name,a.digest)})"
```

### 11. Marketplace

Publishing the Release starts **Publish to the VS Code Marketplace**. It checks the release and
the release commit's green `main` CI, verifies the VSIX against GitHub's digest and
`SHA256SUMS.txt`, then runs `vsce publish --oidc --skip-duplicate` on that file. Watch it, then
poll the Marketplace (its scan took about 5 minutes for 1.5.0):

```bash
curl -s "https://api.github.com/repos/Whwitpohe/linyra/actions/workflows/publish-marketplace.yml/runs?per_page=1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d).workflow_runs[0];console.log(r.id,r.status,r.conclusion)})"
for i in $(seq 1 40); do
  v=$(npx vsce show whwitpohe.linyra 2>/dev/null | grep -E "^\s+Version:" | awk '{print $2}')
  echo "t+$((i*30))s marketplace=$v"; [ "$v" = "X.Y.Z" ] && echo LIVE && break; sleep 30
done
```

- The policy lives on https://marketplace.visualstudio.com/manage/publishers/whwitpohe/trustedpublishing.
  Renaming the workflow file or the repository breaks it: update the policy too.
- A run for a version already on the Marketplace authenticates, then skips: re-running it, or
  Actions → *Publish to the VS Code Marketplace* → *Run workflow* with a tag, is safe.
- If the release commit's own `main` CI failed (a network error), re-run its failed jobs, then
  run this workflow by hand with the tag.

**Fallback, only if that workflow failed:** upload on the publisher page, in the signed-in browser:

1. Open https://marketplace.visualstudio.com/manage/publishers/whwitpohe. Screenshots of this
   page may time out; work from `read_page` / `find`.
2. On the Linyra row: **More Actions…** → **Update**.
3. Attach `whwitpohe.linyra-X.Y.Z.vsix` to the dialog's file input with the browser's file
   upload (never click the file input: that opens a native picker). Check the dialog shows the
   file name.
4. Click **Upload**. The row then reads `<old> Verifying X.Y.Z`: Microsoft scans the package.
5. Poll until the Marketplace serves it, as above.

A version number can never be uploaded twice; a rejected scan means a new patch version.

### 12. Open VSX

Publishing the Release starts **Publish to Open VSX**. It uploads only when the `whwitpohe`
namespace is verified **and** the release commit has a green `main` CI run; otherwise its
`publish` job is skipped and the run still reads "success". Check what it did:

```bash
curl -s "https://api.github.com/repos/Whwitpohe/linyra/actions/workflows/publish-open-vsx.yml/runs?per_page=1" | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{const r=JSON.parse(d).workflow_runs[0];console.log(r.id,r.status,r.conclusion)})"
curl -s https://api.github.com/repos/Whwitpohe/linyra/actions/runs/<run id>/jobs | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{for(const j of JSON.parse(d).jobs)console.log(j.name,j.conclusion)})"
```

- **As of 1.5.0 the namespace is not verified** (claim:
  https://github.com/EclipseFdn/open-vsx.org/issues/14842), so Open VSX waits. No token
  changes that; say so instead of reporting it as published.
- Once it is verified, the namespace owner adds the Trusted Publisher binding described in
  `docs/PUBLISHING.md`. Then sync any released tag from Actions → *Publish to Open VSX* →
  *Run workflow* with the tag (for example `v1.5.0`). Re-running is safe: it skips published versions.
- If the release commit's own `main` CI failed (a network error), re-run its failed jobs first.

## After publishing

- Link the listings:
  - https://marketplace.visualstudio.com/items?itemName=whwitpohe.linyra
  - https://github.com/Whwitpohe/linyra/releases/tag/vX.Y.Z
  - https://open-vsx.org/extension/whwitpohe/linyra (only once step 12 really uploaded)
- Keep the tested `.vsix` and its checksum available for the maintainer; both are
  ignored build artifacts and must not be committed. Install it locally if asked:
  `code --install-extension whwitpohe.linyra-X.Y.Z.vsix --force`.

## What NOT to do

- Don't release unless the maintainer asked (constraint 5).
- Don't publish on a failing test, check or bundle, or a red CI.
- Don't `git add -A`.
- Don't commit with a work email.
- Don't write denylist entries or any token anywhere committed.
- Don't read, decrypt or use a stored token, and don't sign in for the maintainer.
- Don't build a second package: the Marketplace, the Release and Open VSX get the same file.
- Don't report Open VSX as published while its `publish` job is skipped.
- Don't skip the pause.
