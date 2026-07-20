#!/usr/bin/env bash
set -euo pipefail

# ─── SnowLuma Docker Entrypoint ──────────────────────────────────────────
# Starts: Xvfb → fluxbox → QQ → x11vnc → SnowLuma
# SnowLuma runs in the foreground (receives SIGTERM for graceful shutdown).
# ─────────────────────────────────────────────────────────────────────────

export DISPLAY=:0
export HOME=/home/snowluma

# Ensure runtime directories exist (VOLUME mounts may reset ownership)
mkdir -p /tmp/.X11-unix "$HOME/.config" /app/config /app/data /app/logs
chmod 1777 /tmp/.X11-unix 2>/dev/null || true

RESOLUTION="${SNOWLUMA_RESOLUTION:-1280x720x24}"

echo "[entrypoint] Starting Xvfb on :0 ($RESOLUTION)..."
Xvfb :0 -screen 0 "$RESOLUTION" -ac -nolisten tcp -nolisten unix &
XVFB_PID=$!

sleep 1

echo "[entrypoint] Starting fluxbox window manager..."
fluxbox >/dev/null 2>&1 &
FLUXBOX_PID=$!

sleep 0.5

# Find QQ binary — different versions install to different paths
QQ_BIN=""
for p in /opt/QQ/qq /usr/share/qq/qq /usr/bin/qq /opt/QQ/qq-linux; do
  if [ -x "$p" ]; then QQ_BIN="$p"; break; fi
done

if [ -n "$QQ_BIN" ]; then
  echo "[entrypoint] Starting QQ: $QQ_BIN"
  "$QQ_BIN" --no-sandbox --disable-gpu-sandbox >/dev/null 2>&1 &
  QQ_PID=$!
else
  echo "[entrypoint] WARNING: QQ binary not found — VNC will show empty desktop"
  QQ_PID=""
fi

sleep 3

echo "[entrypoint] Starting x11vnc on 127.0.0.1:5900 (no password)..."
x11vnc \
  -display :0 \
  -rfbport 5900 \
  -listen localhost \
  -nopw \
  -forever \
  -shared \
  -noxdamage \
  -threads \
  -bg \
  -o /app/logs/x11vnc.log
VNC_PID=$!

echo "[entrypoint] Starting SnowLuma on port ${SNOWLUMA_WEBUI_PORT:-7860}..."

cleanup() {
  echo "[entrypoint] Shutting down..."
  [ -n "$QQ_PID" ] && kill "$QQ_PID" 2>/dev/null || true
  kill "$VNC_PID" 2>/dev/null || true
  kill "$FLUXBOX_PID" 2>/dev/null || true
  kill "$XVFB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec node /app/index.mjs
