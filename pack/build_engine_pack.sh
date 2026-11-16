#!/bin/bash
# 造「引擎包」：最小 Ubuntu arm64 rootfs + python3 + 七引擎 + server.py
# 必须在 arm64 Linux 上跑（CI: runs-on ubuntu-24.04-arm）
# 产物：rootfs.tar.gz（约 250-300 MB），导入 APK 后解压到 filesDir/rootfs
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/.." && pwd)
SRV="$REPO/server"                 # engine.py / server.py 等
WEB="$REPO/www"                    # index.html + static/
OUT=${1:-$HERE/rootfs.tar.gz}
SUITE=${SUITE:-noble}
MIRROR=${MIRROR:-http://ports.ubuntu.com/ubuntu-ports}
ROOT=$HERE/rootfs

[ "$(uname -m)" = "aarch64" ] || { echo "必须在 arm64 上构建（当前 $(uname -m)）"; exit 1; }
[ -f "$SRV/engine.py" ] || { echo "找不到 $SRV/engine.py"; exit 1; }
[ -f "$WEB/index.html" ] || { echo "找不到 $WEB/index.html"; exit 1; }

sudo rm -rf "$ROOT"; sudo mkdir -p "$ROOT"
sudo debootstrap --arch=arm64 --variant=minbase --components=main,universe \
  --include=ca-certificates "$SUITE" "$ROOT" "$MIRROR"

sudo mount --bind /dev "$ROOT/dev"
sudo mount --bind /proc "$ROOT/proc"
sudo mount --bind /sys "$ROOT/sys"
trap 'sudo umount -lf "$ROOT/dev" "$ROOT/proc" "$ROOT/sys" 2>/dev/null || true' EXIT

printf 'nameserver 8.8.8.8\nnameserver 1.1.1.1\n' | sudo tee "$ROOT/etc/resolv.conf" >/dev/null
# minbase 的 sources 常常只有 main，pari-gp / python3-pip 在 universe
sudo tee "$ROOT/etc/apt/sources.list" >/dev/null <<SLIST
deb $MIRROR $SUITE main universe
deb $MIRROR $SUITE-updates main universe
SLIST

sudo chroot "$ROOT" /bin/bash -euo pipefail <<'INNER'
export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
apt-get update -qq
apt-get install -y -qq --no-install-recommends python3 python3-pip pari-gp libgmp10 tzdata ca-certificates >/dev/null
ln -sf /usr/bin/python3 /usr/local/bin/python3
python3 -m pip install --no-cache-dir --break-system-packages \
  sympy==1.14.0 z3-solver==5.4.1.0 python-flint==0.9.0 numpy==2.5.4 \
  ortools==9.15.6755 cvc5==1.4.2 2>&1 | tail -4
python3 - <<'PY'
import sympy, z3, flint, numpy, ortools, cvc5
print("deps ok:", sympy.__version__, numpy.__version__)
PY
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.cache
INNER

# 组装 /opt/mathapp：server 的 py 文件 + web（index.html 在根，资产在 web/ 下）
sudo mkdir -p "$ROOT/opt/mathapp/web"
sudo cp -a "$SRV"/engine.py "$SRV"/enginex.py "$SRV"/geom_worker.py "$SRV"/server.py "$SRV"/srv.sh "$ROOT/opt/mathapp/"
sudo cp -a "$WEB"/index.html "$ROOT/opt/mathapp/web/"
sudo cp -a "$WEB"/manifest.webmanifest "$WEB"/sw.js "$ROOT/opt/mathapp/web/" 2>/dev/null || true
sudo cp -a "$WEB"/static/. "$ROOT/opt/mathapp/web/"
sudo rm -rf "$ROOT/opt/mathapp/web/sw.js"    # APK 里不需要 service worker
sudo chroot "$ROOT" mkdir -p /tmp /root /dev/shm

sudo tar --numeric-owner -czf "$OUT" -C "$ROOT" .
sha256sum "$OUT" | tee "$OUT.sha256"
echo "引擎包：$OUT  $(du -h "$OUT" | cut -f1)"
