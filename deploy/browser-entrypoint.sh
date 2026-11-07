#!/bin/sh
# owngate-browser 容器入口
# 手动启动 Xvfb 并轮询就绪后再启动 worker。
# 不用 xvfb-run：在 Docker/WSL2 下它会等不来自就绪信号而死锁（M0 实测）。

set -e

DISPLAY_NUM="${XVFB_DISPLAY:-:99}"
SCREEN="${XVFB_SCREEN:-1280x800x24}"

Xvfb "$DISPLAY_NUM" -screen 0 "$SCREEN" -nolisten tcp &
XVFB_PID=$!

# 轮询 X server 就绪，最多 10 秒
i=0
until DISPLAY="$DISPLAY_NUM" xdpyinfo >/dev/null 2>&1; do
  i=$((i + 1))
  if [ "$i" -gt 20 ]; then
    echo "[browser] Xvfb failed to start on $DISPLAY_NUM after 10s" >&2
    kill "$XVFB_PID" 2>/dev/null || true
    exit 1
  fi
  sleep 0.5
done

echo "[browser] Xvfb ready on $DISPLAY_NUM"

export DISPLAY="$DISPLAY_NUM"
exec node apps/browser/dist/main.js
