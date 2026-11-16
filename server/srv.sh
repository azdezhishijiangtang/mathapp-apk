#!/bin/bash
# 用 pidfile 管理服务，避免 pkill/grep 匹配到自身命令行把自己杀掉
cd /root/workspace/mathapp || exit 1
PIDF=/tmp/mathapp.pid

case "$1" in
  start)
    if [ -f "$PIDF" ] && kill -0 "$(cat $PIDF)" 2>/dev/null; then echo "already running $(cat $PIDF)"; exit 0; fi
    MATHAPP_QUIET=1 nohup python3 server.py 8080 >/tmp/mathapp.log 2>&1 &
    echo $! > "$PIDF"
    for i in $(seq 1 40); do
      if python3 -c "import urllib.request;urllib.request.urlopen('http://127.0.0.1:8080/api/health',timeout=2)" 2>/dev/null; then
        echo "started $(cat $PIDF) (ready after ${i}s)"; exit 0
      fi
      sleep 1
    done
    echo "started $(cat $PIDF) 但 40 秒内未就绪，看 /tmp/mathapp.log"; exit 1
    ;;
  stop)
    if [ -f "$PIDF" ]; then
      P=$(cat "$PIDF")
      kill "$P" 2>/dev/null && echo "killed $P"
      rm -f "$PIDF"
    else
      echo "no pidfile"
    fi
    ;;
  restart)
    "$0" stop; sleep 1; "$0" start
    ;;
  *)
    echo "usage: srv.sh start|stop|restart"; exit 2
    ;;
esac
