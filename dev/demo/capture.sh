#!/usr/bin/env bash
# Captures the README screenshots and demo GIF from a real VS Code, on a virtual
# display, against the seeded demo workspace (dev/demo/seed.mjs). Linux-only, dev-only.
#
#   npm run compile && npx @vscode/vsce package -o /tmp/linyra.vsix
#   dev/demo/capture.sh /tmp/linyra.vsix          # → dev/demo/out/*.png, demo.gif
#
# Needs Xvfb, xdotool, ImageMagick (import) and ffmpeg. Uses the VS Code that the
# integration tests download into .vscode-test/, with a throwaway profile and HOME:
# no account, no other extensions, no real paths or names on screen. Coordinates
# assume the fixed 1440×900 display and Dark Modern theme below; if VS Code's layout changes, re-check them
# against the step screenshots in dev/demo/out/.
set -euo pipefail

VSIX=${1:?usage: capture.sh <linyra.vsix>}
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
OUT=$ROOT/dev/demo/out
WS=/tmp/linyra-demo
PROFILE=/tmp/linyra-shoot
CODE=$(ls -d "$ROOT"/.vscode-test/vscode-linux-x64-*/ | sort -V | tail -1)
export DISPLAY=:99
mkdir -p "$OUT"

node "$ROOT/dev/demo/seed.mjs" "$WS"
rm -rf "$PROFILE" && mkdir -p "$PROFILE/user/User"
settings() { # $1 = theme
  cat > "$PROFILE/user/User/settings.json" <<EOF
{
  "workbench.colorTheme": "$1",
  "workbench.startupEditor": "none",
  "window.titleBarStyle": "custom",
  "window.commandCenter": false,
  "workbench.layoutControl.enabled": false,
  "chat.commandCenter.enabled": false,
  "chat.disableAIFeatures": true,
  "workbench.secondarySideBar.defaultVisibility": "hidden",
  "workbench.tips.enabled": false,
  "workbench.welcomePage.walkthroughs.openOnInstall": false,
  "update.mode": "none",
  "telemetry.telemetryLevel": "off",
  "security.workspace.trust.enabled": false,
  "extensions.ignoreRecommendations": true,
  "git.openRepositoryInParentFolders": "never",
  "window.restoreWindows": "none",
  "workbench.enableExperiments": false
}
EOF
}
settings "Default Dark Modern"
export HOME=$WS/.home GIT_CONFIG_NOSYSTEM=1
"$CODE/bin/code" --user-data-dir "$PROFILE/user" --extensions-dir "$PROFILE/ext" --install-extension "$VSIX" >/dev/null 2>&1

Xvfb :99 -screen 0 1440x900x24 -nolisten tcp >/dev/null 2>&1 &
XVFB=$!
CODEPID=
trap 'kill $CODEPID $XVFB 2>/dev/null || true' EXIT
sleep 1
"$CODE/code" --no-sandbox --user-data-dir "$PROFILE/user" --extensions-dir "$PROFILE/ext" \
  --disable-workspace-trust "$WS/acme.code-workspace" >"$PROFILE/code.log" 2>&1 &
CODEPID=$!
for _ in $(seq 60); do WIN=$(xdotool search --name "Visual Studio Code" 2>/dev/null | head -1) && [ -n "$WIN" ] && break; sleep 0.5; done
sleep 4
xdotool windowmove "$WIN" 0 0 windowsize "$WIN" 1440 900
sleep 1

shot() { xdotool mousemove 1439 899; sleep 0.4; import -window root "$OUT/$1.png"; }
cmd() { xdotool key --clearmodifiers ctrl+shift+p; sleep 0.7; xdotool type --delay 12 "$1"; sleep 0.7; xdotool key Return; sleep 1.2; }
click() { xdotool mousemove "$1" "$2" click "${3:-1}"; sleep "${4:-1}"; }
typein() { click "$1" "$2" 1 0.3; xdotool key ctrl+a BackSpace; [ -n "$3" ] && xdotool type --delay 55 "$3"; sleep 1.5; }
theme() { settings "$1"; sleep 2.5; }

cmd "View: Close Primary Side Bar"
cmd "Linyra: Open Merged Log"
sleep 3
# Panel sash up to y=390: the Log gets half the window, the diff the other half. A fresh
# profile's panel height varies, so find its top edge: the first pixel down column 300 that
# is not the (dark theme's) empty editor background.
import -window root "$PROFILE/layout.png"
TOP=$(convert "$PROFILE/layout.png" -crop 1x800+300+60 txt:- | awk -F'[,: ]+' 'NR>1 && $0 !~ /#1F1F1F/ {print $2 + 60; exit}')
xdotool mousemove 740 $((TOP + 1)) sleep 0.3 mousedown 1 sleep 0.2 mousemove 740 500 sleep 0.2 mousemove 740 390 sleep 0.3 mouseup 1
sleep 1
ROW0=544   # first Log row (below the Commits | Uncommitted switch); rows are 25px apart
SEARCH="330 512"; BRANCH="797 512"
FILE_PAYMENTSTEP="1140 574"   # in Changes, for the acme-web ACME-142 commit

# 1. The merged log, with a commit's diff open above it.
click 500 $ROW0
click $FILE_PAYMENTSTEP 1 2.5
shot 01-merged-log

# 2. One search across every repository.
ffmpeg -loglevel error -y -f x11grab -framerate 15 -video_size 1440x900 -i :99 "$PROFILE/search.mp4" &
FF=$!
sleep 1
typein $SEARCH "ACME-142"
sleep 1
# Enter opens the selected commit's first changed file.
click 500 $((ROW0 + 50)) 1 1.2     # acme-api's side of the ticket
xdotool key Return; sleep 2
click 500 $((ROW0 + 75)) 1 1.2     # acme-libs
xdotool key Return; sleep 2
click 500 $ROW0 1 1.5              # back to acme-web
click $FILE_PAYMENTSTEP 1 2.5
kill -INT $FF; wait $FF || true
shot 02-search

# 3. File History of the diff on screen (the same command as a Changes file's right-click).
cmd "Linyra: File History"
sleep 1.5
typein 330 547 ""                  # in history mode the filters sit under the mode bar and the switch
shot 03-file-history
click 305 470 1 1.5                # close history: "All commits" (the × moves with the path)

# 4. A release branch in every repository that has it.
typein $SEARCH ""
typein $BRANCH "origin/release-1.4"
xdotool key Tab Down Down Down; sleep 2   # date range → All time
click 500 $ROW0 1 1
xdotool key Return; sleep 2
shot 04-branch
typein $BRANCH ""
xdotool key Tab Up Up Up; sleep 2        # date range → Last 24 hours

# 5–7. The same view in light and both high-contrast themes.
click 500 $ROW0
click $FILE_PAYMENTSTEP 1 2
theme "Default Light Modern"; shot 05-light
theme "Default High Contrast"; shot 06-high-contrast
theme "Default High Contrast Light"; shot 07-high-contrast-light
theme "Default Dark Modern"

# GIF: crop to the window, 1200px wide, one palette from every frame (never stats_mode=diff:
# on hard cuts it leaves stale pixels). dither=none is smallest and crispest on flat UI.
ffmpeg -loglevel error -y -i "$PROFILE/search.mp4" -vf "fps=10,scale=1200:-1:flags=lanczos,palettegen=stats_mode=full" "$PROFILE/palette.png"
ffmpeg -loglevel error -y -i "$PROFILE/search.mp4" -i "$PROFILE/palette.png" \
  -lavfi "fps=10,scale=1200:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=none" "$OUT/demo.gif"
ls -la "$OUT"
