#!/usr/bin/env sh
# LowPingNews installer. Portable across Linux, macOS, BSD, Termux and WSL.
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
SRC="$HERE/news"
[ -f "$SRC" ] || { echo "install: $SRC not found"; exit 1; }

PY="$(command -v python3 || command -v python || true)"
[ -n "$PY" ] || { echo "install: python3 not found (Termux: pkg install python)"; exit 1; }
"$PY" -c 'import sys; raise SystemExit(0 if sys.version_info[:2] >= (3,5) else 1)' \
  || { echo "install: python 3.5+ required, found $("$PY" -V 2>&1)"; exit 1; }

# Pick the first writable bin dir rather than assuming $PREFIX exists.
for d in "${PREFIX:+$PREFIX/bin}" "$HOME/.local/bin" /usr/local/bin "$HOME/bin"; do
  [ -n "$d" ] || continue
  mkdir -p "$d" 2>/dev/null || continue
  [ -w "$d" ] || continue
  DEST="$d"; break
done
[ -n "${DEST:-}" ] || { echo "install: no writable bin directory found"; exit 1; }

"$PY" -c "import ast,sys;ast.parse(open(sys.argv[1],encoding='utf-8').read())" "$SRC"

# Rewrite the shebang in python: sed -i is incompatible between GNU and BSD.
"$PY" - "$SRC" "$DEST/news.new" "$PY" <<'PYEOF'
import io, sys
src, dst, py = sys.argv[1], sys.argv[2], sys.argv[3]
lines = io.open(src, encoding="utf-8").read().splitlines(True)
if lines and lines[0].startswith("#!"):
    lines[0] = "#!%s\n" % py
io.open(dst, "w", encoding="utf-8", newline="\n").write("".join(lines))
PYEOF
chmod +x "$DEST/news.new"
mv "$DEST/news.new" "$DEST/news"

if [ -f "$HERE/lowpingnews" ]; then
  sh -n "$HERE/lowpingnews" || { echo "install: lowpingnews has a syntax error"; exit 1; }
  cp "$HERE/lowpingnews" "$DEST/lowpingnews.new"
  chmod +x "$DEST/lowpingnews.new"
  mv "$DEST/lowpingnews.new" "$DEST/lowpingnews"   # rename: safe while running
  ln -sf "$DEST/lowpingnews" "$DEST/lpn" 2>/dev/null || true
fi

echo "installed $("$DEST/news" --version) -> $DEST/lowpingnews"
case ":$PATH:" in
  *":$DEST:"*) echo "next: lowpingnews --check     (lpn is a short alias)" ;;
  *) echo "NOTE: $DEST is not on your PATH. Add it:"
     echo "  export PATH=\"$DEST:\$PATH\"" ;;
esac
