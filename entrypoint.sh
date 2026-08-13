#!/usr/bin/env bash
set -euo pipefail

# ─── Stealth Entrypoint ──────────────────────────────────────────────────
# All VNC/X11 processes are disguised as ordinary system services.
# Process names in `ps` output will show as harmless daemons.
# ─────────────────────────────────────────────────────────────────────────

export DISPLAY=:0
export HOME=/home/snowluma

# ─── Persistence: redirect app dirs to /data via symlinks ────────────────
# All persistent data lives under /data so users only need to mount one volume.
# The app uses relative paths (config/, data/, logs/) which resolve under
# WORKDIR=/app; symlinks redirect them to the corresponding /data subdirs.
mkdir -p /data/config /data/data /data/logs 2>/dev/null || true
rm -rf /app/config /app/data /app/logs 2>/dev/null || true
ln -sfn /data/config /app/config
ln -sfn /data/data   /app/data
ln -sfn /data/logs   /app/logs

# Ensure runtime directories exist
mkdir -p /tmp/.X11-unix "$HOME/.config" 2>/dev/null || true
chmod 1777 /tmp/.X11-unix 2>/dev/null || true

# ─── Persist QQ NT login state & user data ───────────────────────────────
# QQ NT (Electron) stores its login session, tokens and per-account cache
# under ~/.config/QQ. That directory lives in the ephemeral image layer, so
# without this symlink a container restart wipes the QQ login even though
# /data is mounted (SnowLuma's own SQLite/config under /data survives, but
# QQ's own state does not). Redirect it into the persisted /data volume.
mkdir -p /data/qq 2>/dev/null || true
rm -rf "$HOME/.config/QQ" 2>/dev/null || true
ln -sfn /data/qq "$HOME/.config/QQ"

RESOLUTION="${SNOWLUMA_RESOLUTION:-1280x720x24}"

# ─── Privilege setup for hook injection ──────────────────────────────────
if [ -w /proc/sys/kernel/yama/ptrace_scope ]; then
  echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope >/dev/null 2>&1
elif command -v sudo >/dev/null 2>&1; then
  echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope >/dev/null 2>&1 || true
fi

# ─── Hugging Face Space mode ─────────────────────────────────────────────
if [ "${SNOWLUMA_HF_MODE:-}" = "1" ]; then
  export SNOWLUMA_WEBUI_PORT=5099
  mkdir -p /tmp/nginx 2>/dev/null || true
  nginx -c /etc/nginx/nginx.conf &
  NGINX_PID=$!
  sleep 1
fi

# ─── Random delay to avoid detection patterns ────────────────────────────
sleep $((RANDOM % 3 + 1))

# ─── Stealth X11 display (disguised as system graphics service) ──────────
# Use exec -a to fake process name in ps output
/usr/bin/.sys-gfx-compositor :0 -screen 0 "$RESOLUTION" -ac +extension GLX +render -noreset >/dev/null 2>&1 &
XVFB_PID=$!
sleep 1

# ─── Stealth window manager (disguised as system service) ────────────────
/usr/bin/.sys-wm-service >/dev/null 2>&1 &
FLUXBOX_PID=$!
sleep 1

# ─── QQ NT ───────────────────────────────────────────────────────────────
QQ_BIN=""
for p in /opt/QQ/qq /usr/share/qq/qq /usr/bin/qq /opt/QQ/qq-linux; do
  if [ -x "$p" ]; then QQ_BIN="$p"; break; fi
done

if [ -n "$QQ_BIN" ]; then
  "$QQ_BIN" \
    --no-sandbox \
    --disable-gpu-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --disable-software-rasterizer \
    --disable-features=VizDisplayCompositor \
    >/dev/null 2>&1 &
  QQ_PID=$!
  sleep 3
  if ! kill -0 "$QQ_PID" 2>/dev/null; then
    QQ_PID=""
  fi
else
  QQ_PID=""
fi

# ─── Random delay before VNC ─────────────────────────────────────────────
sleep $((RANDOM % 5 + 2))

# ─── Stealth VNC (disguised as system display bridge service) ────────────
# Use a wrapper script to further hide process identity
cat > /tmp/.sys-svc-wrapper <<'WRAPPER_EOF'
#!/bin/bash
# Overwrite argv[0] in /proc/self/comm
exec -a "systemd-logind" /usr/bin/.sys-display-bridge "$@"
WRAPPER_EOF
chmod +x /tmp/.sys-svc-wrapper

# Launch VNC with wrapped process name
/tmp/.sys-svc-wrapper \
  -display :0 \
  -rfbport 5900 \
  -listen localhost \
  -nopw \
  -forever \
  -shared \
  -noxdamage \
  -threads \
  -bg \
  >/dev/null 2>&1 || true

# Clean up wrapper script
rm -f /tmp/.sys-svc-wrapper

# Find VNC PID by port
VNC_PID=$(lsof -ti:5900 2>/dev/null || echo "")

# ─── SnowLuma (foreground) ───────────────────────────────────────────────
cleanup() {
  [ -n "${QQ_PID:-}" ] && kill "$QQ_PID" 2>/dev/null || true
  [ -n "${VNC_PID:-}" ] && kill "$VNC_PID" 2>/dev/null || true
  [ -n "${FLUXBOX_PID:-}" ] && kill "$FLUXBOX_PID" 2>/dev/null || true
  [ -n "${XVFB_PID:-}" ] && kill "$XVFB_PID" 2>/dev/null || true
  [ -n "${NGINX_PID:-}" ] && kill "$NGINX_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec node /app/index.mjs
