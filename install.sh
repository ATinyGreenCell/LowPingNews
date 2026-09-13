#!/usr/bin/env sh
# LowPingNews installer. Termux: sh install.sh
set -e
DEST="${PREFIX:-/usr/local}/bin"
SRC="$(cd "$(dirname "$0")" && pwd)/news"
PY="$(command -v python3 || command -v python)"
[ -n "$PY" ] || { echo "install: python3 not found (pkg install python)"; exit 1; }
"$PY" -c "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read())" "$SRC"
mkdir -p "$DEST"
cp "$SRC" "$DEST/news"
chmod +x "$DEST/news"
sed -i "1s|.*|#!$PY|" "$DEST/news"
LPN_SRC="$(dirname "$SRC")/lowpingnews"
if [ -f "$LPN_SRC" ]; then
  sh -n "$LPN_SRC" || { echo "install: lowpingnews has a syntax error"; exit 1; }
  cp "$LPN_SRC" "$DEST/lowpingnews.new"
  chmod +x "$DEST/lowpingnews.new"
  mv "$DEST/lowpingnews.new" "$DEST/lowpingnews"   # rename: safe while running
  ln -sf "$DEST/lowpingnews" "$DEST/lpn"
fi
echo "installed $("$DEST/news" --version) -> $DEST/news"
echo "next: news --check    (dev loop: lowpingnews help)"
