# Re-recording Linyra's documentation

The current workflow captures the **real VS Code workbench and production webviews**.
It uses isolated repositories, Git configuration, editor profile and extensions directory.
It does not inject replacement HTML, CSS, commit data or product strings into screenshots.
Everything under `dev/demo/` is excluded from the installed extension.

## Prerequisites

- Node.js, Git, the project's development dependencies, and FFmpeg on `PATH`.
- Playwright and Sharp available to the capture script. Set
  `LINYRA_CAPTURE_NODE_MODULES` to a tools directory's `node_modules` if they are already
  installed outside this repository; do not add them to the extension's runtime dependencies.
- A visible desktop. The capture window maximizes to the current display's working area.
  Close notifications before recording and inspect the result before publishing.

For example, install optional tools in a temporary directory on Windows if needed:

```powershell
$demoTools = Join-Path ([IO.Path]::GetTempPath()) 'linyra-capture-tools'
npm install --prefix $demoTools --no-save --no-package-lock playwright sharp
$env:LINYRA_CAPTURE_NODE_MODULES = Join-Path $demoTools 'node_modules'
```

## Build and capture

From the repository root:

```powershell
npm run compile
npx esbuild dev/demo/captureHost.ts --bundle --platform=node --format=cjs --external:vscode --outfile=out/demo/captureHost.js
$demoWorkspace = Join-Path ([IO.Path]::GetTempPath()) 'linyra-demo-v141'
node dev/demo/seed.mjs $demoWorkspace
$env:LINYRA_DEMO_DIR = $demoWorkspace
node dev/demo/capture.mjs
```

`seed.mjs` creates six neutral repositories with 208 real commits, parallel branch
histories, merges, release-branch divergence and uncommitted review examples. It only
resets a named `linyra-demo*` / `polylog-demo*` directory inside the system temporary
folder; an existing directory must also have the seeder's marker. Do not point it at a
real workspace.

`capture.mjs` downloads the stable VS Code test host if needed. Set
`LINYRA_CAPTURE_CODE` to an existing test host executable to reuse it. The default local
debug port is 9337; `LINYRA_CAPTURE_PORT` can select another. The development-only
control bridge uses a unique `.capture/run-*` directory inside the demo workspace and
accepts a small command allowlist. It is not part of the production extension.

The script opens a native diff above Linyra and gives the bottom panel roughly 46% of
the window. It captures the native Electron surface: a CSS-pixel screenshot clip at
fractional editor zoom otherwise truncates the right and bottom edges. Focused figures
are crops of the same real surface, without stretching. The theme comparison preserves
aspect ratios. The GIF uses complete frames at 1920px width and eight frames per second.

Outputs go to ignored `dev/demo/out/`:

- `demo.gif`: search a ticket across four repositories and review web/API diffs.
- `screenshot-log.png`, `screenshot-search.png`: complete working layout.
- `screenshot-details.png`: readable commit details and real reference icons.
- `screenshot-branches.png`, `screenshot-sort.png`, `screenshot-branch-sidebar.png`.
- `screenshot-file-search.png`, `screenshot-file-history.png`, `screenshot-uncommitted.png`.
- `screenshot-compare.png`, `screenshot-compare-commits.png`.
- Individual light/dark/high-contrast images and `screenshot-themes.png`.
- `recording.json`: capture dimensions, locale, example repositories and frame count.

For the focused 1.4.2 feature recordings, run `node dev/demo/capture.mjs --features`.
Set `LINYRA_CAPTURE_OUTPUT` to a separate output directory if keeping both runs.
The four GIFs show branch/author checklists, sorting and graph folding; commit references,
containing branches, real divider dragging and file filtering; old-commit hash lookup;
and comparison modes, commit expansion, repository switching, swapping and divider dragging.
`features.json` records the frame counts and native crop regions. The smaller crops retain
the actual UI pixels and avoid shrinking a whole editor around the feature being explained.
`node dev/demo/capture.mjs --settings` separately captures the native Settings editor,
filtered to Linyra's six registered settings, using the same isolated profile.

The recording reads existing fixture changes but never stages, discards or commits them.
The ordinary input path is used for message search, commit selection and branch checkboxes;
the existing development test seam sets up view/layout state. The bridge shuts down the
throwaway editor when finished. `--prototype` leaves that host open for layout inspection;
send its bridge a `finish` operation when done.

## Review and publish media

Inspect every selected figure at full resolution. Check that:

- the right edge and bottom footer are present;
- the editor and panel have useful proportions without a large empty panel;
- the selected row agrees with the diff and details;
- branch checkboxes show an actual multiple selection;
- Compare has its picker closed and shows divergent content on both sides;
- no personal workspace, private branch, credential, notification or absolute home path
  appears in the image;
- every theme is readable and no image is stretched.

Copy only reviewed assets to a versioned directory such as `media/v1.4.1/`. Keep raw
frames, profiles and logs out of Git. README images must use absolute
`https://raw.githubusercontent.com/Whwitpohe/linyra/main/media/v1.4.1/...` addresses.
Push them before updating the Marketplace and verify the URLs return successful responses.
The older `capture.sh` is the historical Linux/Xvfb workflow with fixed coordinates;
it was not used to make the 1.4.1 assets.
