#!/bin/bash
# 把 ../mathapp/web 同步进 www/（Capacitor 的资源根）
set -e
SRC=$(cd "$(dirname "$0")/../mathapp/web" && pwd)
DST=$(cd "$(dirname "$0")" && pwd)/www
rm -rf "$DST"; mkdir -p "$DST/static"
cp "$SRC/index.html" "$DST/index.html"
cp "$SRC/manifest.webmanifest" "$DST/manifest.webmanifest" 2>/dev/null || true
cp "$SRC/sw.js" "$DST/sw.js" 2>/dev/null || true
for x in "$SRC"/*; do
  b=$(basename "$x")
  case "$b" in index.html|manifest.webmanifest|sw.js) ;; *) cp -a "$x" "$DST/static/" ;; esac
done
echo "www: $(du -sh "$DST" | cut -f1)"
