#!/bin/bash
# 造「引擎包」：一个最小 Ubuntu arm64 rootfs + python3 + 七引擎 + 我们的 server.py
# 必须在 arm64 Linux 上跑（GitHub Actions: runs-on ubuntu-24.04-arm）
# 产物：rootfs.tar.gz（约 280 MB），导入 APK 后解压到 filesDir/rootfs
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
APP=$(cd "$HERE/../.." && pwd)/mathapp        # mathapp 目录（engine.py 等）
OUT=${1:-$HERE/rootfs.tar.gz}
SUITE=${SUITE:-noble}
MIRROR=${MIRROR:-http://ports.ubuntu.com/ubuntu-ports}
ROOT=$HERE/rootfs

[ "$(uname -m)" = "aarch64" ] || { echo "必须在 arm64 上构建（当前 $(uname -m)）"; exit 1; }
[ -f "$APP/engine.py" ] || { echo "找不到 $APP/engine.py"; exit 1; }

sudo rm -rf "$ROOT"
sudo mkdir -p "$ROOT"
sudo debootstrap --arch=arm64 --variant=minbase --include=ca-certificates,curl \
  "$SUITE" "$ROOT" "$MIRROR"

sudo mount --bind /dev "$ROOT/dev"
sudo mount --bind /proc "$ROOT/proc"
sudo mount --bind /sys "$ROOT/sys"
trap 'sudo umount -lf "$ROOT/dev" "$ROOT/proc" "$ROOT/sys" 2>/dev/null || true' EXIT

sudo tee "$ROOT/etc/resolv.conf" >/dev/null <<'EOF'
nameserver 8.8.8.8
nameserver 1.1.1.1
EOF

sudo chroot "$ROOT" /bin/bash -euo pipefail <<'INNER'
export DEBIAN_FRONTEND=noninteractive LANG=C.UTF-8
apt-get update -qq
apt-get install -y -qq --no-install-recommends \
  python3 python3-pip pari-gp libgmp10 tzdata >/dev/null
ln -sf /usr/bin/python3 /usr/local/bin/python3
python3 -m pip install --no-cache-dir --break-system-packages \
  sympy==1.14.0 z3-solver==5.4.1.0 python-flint==0.9.0 numpy==2.5.4 \
  ortools==9.15.6755 cvc5==1.4.2 2>&1 | tail -3
mkdir -p /opt/mathapp
python3 - <<'PY'
import sympy, z3, flint, numpy
print("sympy", sympy.__version__, "numpy", numpy.__version__)
PY
apt-get clean
rm -rf /var/lib/apt/lists/* /root/.cache
INNER

sudo mkdir -p "$ROOT/opt/mathapp"
sudo cp -a "$APP/engine.py" "$APP/enginex.py" "$APP/geom_worker.py" \
           "$APP/server.py" "$APP/srv.sh" "$APP/web" "$ROOT/opt/mathapp/"
sudo chroot "$ROOT" mkdir -p /tmp /root /dev/shm

sudo tar --numeric-owner -czf "$OUT" -C "$ROOT" .
sha256sum "$OUT" | tee "$OUT.sha256"
echo "引擎包：$OUT  $(du -h "$OUT" | cut -f1)"
