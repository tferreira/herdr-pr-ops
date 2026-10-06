#!/bin/sh
# Regenerate the README images from the demo board (fake data, no GitHub).
# Needs Google Chrome, ffmpeg, and MesloLGM Nerd Font 3.5 or later for the
# icons: installed, or a .ttf file given as NERD_FONT=/path/to/font.ttf.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/assets"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
CHROME=${CHROME:-"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"}
SIZE=150x36

shot() { # <ansi> <png> <scale>
  node "$ROOT/tools/ansi2html.js" "$1" > "$1.html"
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor="$3" \
    --window-size=1300,820 --screenshot="$2" "file://$1.html" 2>/dev/null
}

mkdir -p "$OUT"
cd "$ROOT"

SNAP_FX=1 node bin/dashboard.js --demo --snapshot $SIZE mine > "$TMP/mine.ans"
shot "$TMP/mine.ans" "$OUT/board.png" 2

SNAP_FX=1 node bin/dashboard.js --demo --snapshot $SIZE review > "$TMP/review.ans"
shot "$TMP/review.ans" "$OUT/review.png" 2

SNAP_FX=1 node bin/dashboard.js --demo --snapshot $SIZE review "PROJ-123" > "$TMP/task.ans"
shot "$TMP/task.ans" "$OUT/task.png" 2

node bin/dashboard.js --demo --setup --snapshot $SIZE mine > "$TMP/setup.ans"
shot "$TMP/setup.ans" "$OUT/setup.png" 2

# GitHub social preview (Settings > Social preview), 1280x640.
SNAP_FX=1 node bin/dashboard.js --demo --snapshot 132x31 mine > "$TMP/social.ans"
node "$ROOT/tools/ansi2html.js" "$TMP/social.ans" > "$TMP/social.html"
"$CHROME" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1280,640 --screenshot="$OUT/social-preview.png" "file://$TMP/social.html" 2>/dev/null

# Animated: 45 frames, 100 ms apart.
SNAP_FRAMES=45 SNAP_DT=100 node bin/dashboard.js --demo --snapshot $SIZE mine > "$TMP/frames.ans"
node -e '
const fs = require("fs");
const frames = fs.readFileSync(process.argv[1], "utf8").split("\f");
frames.forEach((f, i) => fs.writeFileSync(`${process.argv[2]}/f${String(i).padStart(3, "0")}.ans`, f));
' "$TMP/frames.ans" "$TMP"
for f in "$TMP"/f*.ans; do shot "$f" "${f%.ans}.png" 1; done
ffmpeg -loglevel error -y -framerate 10 -i "$TMP/f%03d.png" \
  -vf "scale=1100:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle" \
  "$OUT/demo.gif"

ls -lh "$OUT"
