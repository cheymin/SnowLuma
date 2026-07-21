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

# ─── Privilege setup for hook injection ──────────────────────────────────
# SnowLuma injects QQ via ptrace / manual map. Docker's default YAMA
# ptrace_scope=1 blocks inter-process ptrace for non-parents. We loosen it
# so the SnowLuma node process can attach to the QQ process (both run as
# snowluma). This is safe in a single-purpose container where every process
# is ours.
if [ -w /proc/sys/kernel/yama/ptrace_scope ]; then
  echo "[entrypoint] Setting ptrace_scope=0 for hook injection..."
  echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope >/dev/null
elif command -v sudo >/dev/null 2>&1; then
  echo "[entrypoint] Setting ptrace_scope=0 via sudo..."
  echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope >/dev/null || true
fi

# ─── Hugging Face Space mode (single-port nginx reverse-proxy) ───────────
if [ "${SNOWLUMA_HF_MODE:-}" = "1" ]; then
  echo "[entrypoint] HF mode: nginx will listen on 7860, SnowLuma on 5099 internally"
  export SNOWLUMA_WEBUI_PORT=5099
  mkdir -p /tmp/nginx
  nginx -c /etc/nginx/nginx.conf &
  NGINX_PID=$!
  sleep 1
fi

# ─── Xvfb ────────────────────────────────────────────────────────────────
echo "[entrypoint] Starting Xvfb on :0 ($RESOLUTION)..."
Xvfb :0 -screen 0 "$RESOLUTION" -ac -nolisten tcp -nolisten unix &
XVFB_PID=$!
sleep 1

# ─── Window manager ──────────────────────────────────────────────────────
echo "[entrypoint] Starting fluxbox window manager..."
fluxbox >/app/logs/fluxbox.log 2>&1 &
FLUXBOX_PID=$!
sleep 0.5

# ─── QQ NT ───────────────────────────────────────────────────────────────
# Find QQ binary — different versions install to different paths
QQ_BIN=""
for p in /opt/QQ/qq /usr/share/qq/qq /usr/bin/qq /opt/QQ/qq-linux; do
  if [ -x "$p" ]; then QQ_BIN="$p"; break; fi
done

if [ -n "$QQ_BIN" ]; then
  echo "[entrypoint] Starting QQ: $QQ_BIN"
  # --no-sandbox           : required for rootless containers
  # --disable-gpu-sandbox  : skip GPU sandbox (no real GPU in container)
  # --disable-dev-shm-usage: use /tmp instead of /dev/shm (Docker default
  #                          shm is only 64 MB, Electron crashes without this)
  # --disable-gpu          : no GPU acceleration inside Docker
  "$QQ_BIN" \
    --no-sandbox \
    --disable-gpu-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    >/app/logs/qq.log 2>&1 &
  QQ_PID=$!

  # Quick health-check: if QQ exits within 5s something is wrong (missing libs,
  # bad display, etc.). Log the failure so operators can inspect /app/logs/qq.log.
  sleep 3
  if ! kill -0 "$QQ_PID" 2>/dev/null; then
    echo "[entrypoint] WARNING: QQ exited quickly — check /app/logs/qq.log"
    QQ_PID=""
  else
    echo "[entrypoint] QQ running (PID $QQ_PID)"
  fi
else
  echo "[entrypoint] WARNING: QQ binary not found — VNC will show empty desktop"
  QQ_PID=""
fi

# ─── x11vnc ──────────────────────────────────────────────────────────────
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
  -o /app/logs/x11vnc.log &
VNC_PID=$!
sleep 1

# Verify x11vnc is actually listening
if ! kill -0 "$VNC_PID" 2>/dev/null; then
  echo "[entrypoint] WARNING: x11vnc failed to start — check /app/logs/x11vnc.log"
fi

# ─── SnowLuma (foreground) ───────────────────────────────────────────────
echo "[entrypoint] Starting SnowLuma on port ${SNOWLUMA_WEBUI_PORT:-7860}..."

cleanup() {
  echo "[entrypoint] Shutting down..."
  [ -n "${QQ_PID:-}" ] && kill "$QQ_PID" 2>/dev/null || true
  [ -n "${VNC_PID:-}" ] && kill "$VNC_PID" 2>/dev/null || true
  [ -n "${FLUXBOX_PID:-}" ] && kill "$FLUXBOX_PID" 2>/dev/null || true
  [ -n "${XVFB_PID:-}" ] && kill "$XVFB_PID" 2>/dev/null || true
  [ -n "${NGINX_PID:-}" ] && kill "$NGINX_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec node /app/index.mjs
