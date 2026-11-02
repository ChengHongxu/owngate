#!/bin/sh
# Manually start Xvfb and poll for readiness, then run node
# Avoids xvfb-run's lock-file deadlock in Docker/WSL2

Xvfb :99 -screen 0 1280x960x24 -nolisten tcp &
XVFB_PID=$!

# Poll until X server accepts connections (max 10s)
i=0
until DISPLAY=:99 xdpyinfo >/dev/null 2>&1; do
  i=$((i+1))
  if [ $i -gt 20 ]; then
    echo "Xvfb failed to start after 10s"
    kill $XVFB_PID 2>/dev/null
    exit 1
  fi
  sleep 0.5
done
echo "Xvfb ready on :99"

export DISPLAY=:99
node "$@"
STATUS=$?

kill $XVFB_PID 2>/dev/null
exit $STATUS
