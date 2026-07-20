#!/usr/bin/env bash
set -euo pipefail

# ─── SnowLuma Docker Entrypoint ──────────────────────────────────────────
# Starts: Xvfb → fluxbox → QQ → x11vnc → SnowLuma
# All services run in the background except SnowLuma (foreground, receives
# signals for graceful shutdown).
# ─────────────────────────────────────────────────────────────────────────

export DISPLAY=:0
export HOME=/home/snowluma

mkdir -p "$HOME/.config" /app/config /app/data /app/logs

# Resolution for the virtual framebuffer
RESOLUTION="${SNOWLUMA_RESOLUTION:-1280x720x24}"

echo "[entrypoint] Starting Xvfb on :0 ($RESOLUTION)..."
Xvfb :0 -screen 0 "$RESOLUTION" -ac -nolisten tcp &
XVFB_PID=$!

# Give Xvfb a moment to initialize
sleep 1

echo "[entrypoint] Starting fluxbox window manager..."
fluxbox >/dev/null 2>&1 &
FLUXBOX_PID=$!

sleep 0.5

echo "[entrypoint] Starting QQ desktop client..."
# QQ needs --no-sandbox when running in containers
/opt/QQ/qq --no-sandbox --disable-gpu-sandbox >/dev/null 2>&1 &
QQ_PID=$!

# Wait for QQ to start before launching VNC
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

# Cleanup function — kill all child processes on exit
cleanup() {
  echo "[entrypoint] Shutting down..."
  kill "$QQ_PID" 2>/dev/null || true
  kill "$VNC_PID" 2>/dev/null || true
  kill "$FLUXBOX_PID" 2>/dev/null || true
  kill "$XVFB_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# Run SnowLuma in the foreground so it receives SIGTERM
exec node /app/index.mjs
