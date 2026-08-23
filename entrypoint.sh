#!/usr/bin/env bash
set -euo pipefail

# ─── Stealth Entrypoint ──────────────────────────────────────────────────
# The X server + window manager are disguised as ordinary system services.
# VNC is deliberately NOT auto-started here: it is downloaded on demand by
# the WebUI (「启动VNC」→ /api/vnc/start) into a hidden runtime dir and fully
# removed on 「终止VNC」, so a stopped/idle container looks like a plain app
# with zero scannable VNC residue.
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
if [ -d /data/qq ] && [ -n "$(ls -A /data/qq 2>/dev/null || true)" ]; then
  echo "[Entrypoint] /data/qq persisted ($(find /data/qq -mindepth 1 | wc -l) entries)"
else
  echo "[Entrypoint] /data/qq is empty — QQ has not written login data there yet"
fi

# ─── Persist machine-id (stable device identity for QQ NT) ───────────────
# QQ NT (Electron) binds the login session to a "device" fingerprint. On a
# recreated container the machine-id is regenerated, so QQ sees a brand-new
# device and forces a re-login even though ~/.config/QQ survived on /data.
# NOTE: /etc/machine-id and /var/lib/dbus/machine-id are BOTH read by
# different libs (systemd vs glib/dbus). QQ NT's Chromium often reads the
# dbus one, so we pin BOTH to the same persisted value.
DATA_SYSTEM_DIR=/data/system
MACHINE_ID_PIN="$DATA_SYSTEM_DIR/machine-id"
MACHINE_ID_FILES=("/etc/machine-id" "/var/lib/dbus/machine-id")

restore_machine_id() {
  local id="$1"
  for f in "${MACHINE_ID_FILES[@]}"; do
    printf '%s\n' "$id" | sudo tee "$f" >/dev/null 2>&1 || true
  done
}

if [ -s "$MACHINE_ID_PIN" ]; then
  # Restore the previously-pinned id on a recreated container.
  PINNED_ID="$(tr -d '[:space:]' < "$MACHINE_ID_PIN")"
  CURRENT_ID="$(tr -d '[:space:]' < /etc/machine-id 2>/dev/null || true)"
  if [ "$CURRENT_ID" != "$PINNED_ID" ]; then
    restore_machine_id "$PINNED_ID"
    echo "[Entrypoint] restored machine-id $PINNED_ID (was ${CURRENT_ID:-<none>})"
  else
    DBUS_ID="$(tr -d '[:space:]' < /var/lib/dbus/machine-id 2>/dev/null || true)"
    if [ "$DBUS_ID" != "$PINNED_ID" ]; then
      printf '%s\n' "$PINNED_ID" | sudo tee /var/lib/dbus/machine-id >/dev/null 2>&1 || true
      echo "[Entrypoint] synced dbus machine-id $PINNED_ID"
    else
      echo "[Entrypoint] machine-id already stable: $PINNED_ID"
    fi
  fi
elif [ -s /etc/machine-id ]; then
  # First boot with an existing id: pin it so it survives recreation.
  mkdir -p "$DATA_SYSTEM_DIR" 2>/dev/null || true
  PINNED_ID="$(tr -d '[:space:]' < /etc/machine-id)"
  cp /etc/machine-id "$MACHINE_ID_PIN" 2>/dev/null || true
  printf '%s\n' "$PINNED_ID" | sudo tee /var/lib/dbus/machine-id >/dev/null 2>&1 || true
  echo "[Entrypoint] pinned machine-id $PINNED_ID (synced to dbus)"
else
  # No id anywhere (rare in containers): mint a stable one.
  mkdir -p "$DATA_SYSTEM_DIR" 2>/dev/null || true
  NEW_ID="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
  if [ -n "$NEW_ID" ]; then
    restore_machine_id "$NEW_ID"
    printf '%s\n' "$NEW_ID" > "$MACHINE_ID_PIN" 2>/dev/null || true
    echo "[Entrypoint] minted machine-id $NEW_ID"
  fi
fi

# ─── Persist MAC address (stable device identity for QQ NT) ──────────────
# Linux QQ derives its device code from ALL local NIC MAC addresses. Every
# time a Docker container is recreated (e.g. deploying a new image), eth0
# gets a fresh random MAC, so QQ sees a "new device" and forces a re-login
# even though /data survived. We persist the first-seen MAC under /data and
# restore it on every boot, so the identity never changes across recreations.
# Needs NET_ADMIN: docker run --cap-add=NET_ADMIN (or compose cap_add).
MAC_PIN="$DATA_SYSTEM_DIR/eth0-mac"
ETH0_IF="eth0"
if [ -r /sys/class/net/$ETH0_IF/address ]; then
  CURRENT_MAC="$(cat /sys/class/net/$ETH0_IF/address 2>/dev/null || true)"
  if [ -s "$MAC_PIN" ]; then
    PINNED_MAC="$(tr -d '[:space:]' < "$MAC_PIN")"
    if [ -n "$PINNED_MAC" ] && [ "$CURRENT_MAC" != "$PINNED_MAC" ]; then
      if ip link set dev "$ETH0_IF" address "$PINNED_MAC" 2>/dev/null; then
        ip neigh flush dev "$ETH0_IF" 2>/dev/null || true
        echo "[Entrypoint] restored eth0 MAC $PINNED_MAC (was $CURRENT_MAC)"
      else
        echo "[Entrypoint] WARN: cannot restore eth0 MAC $PINNED_MAC (needs NET_ADMIN)."
        echo "[Entrypoint]         -> add --cap-add=NET_ADMIN to docker run, or pin via --mac-address 02:42:ac:11:00:02"
      fi
    fi
  else
    if [ -n "$CURRENT_MAC" ]; then
      printf '%s\n' "$CURRENT_MAC" > "$MAC_PIN" 2>/dev/null || true
      echo "[Entrypoint] pinned eth0 MAC $CURRENT_MAC"
    fi
  fi
fi

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

# ─── SnowLuma (foreground) ───────────────────────────────────────────────
# NOTE: VNC is intentionally NOT started here. It is provisioned on demand
# by the WebUI (startVnc downloads x11vnc+noVNC, stopVnc kills + removes).
cleanup() {
  [ -n "${QQ_PID:-}" ] && kill "$QQ_PID" 2>/dev/null || true
  [ -n "${FLUXBOX_PID:-}" ] && kill "$FLUXBOX_PID" 2>/dev/null || true
  [ -n "${XVFB_PID:-}" ] && kill "$XVFB_PID" 2>/dev/null || true
  [ -n "${NGINX_PID:-}" ] && kill "$NGINX_PID" 2>/dev/null || true
  wait 2>/dev/null || true
}
trap cleanup EXIT INT TERM

exec node /app/index.mjs
