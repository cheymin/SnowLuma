# syntax=docker/dockerfile:1

# ─── Stage 1: Build SnowLuma ──────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@10.28.0

# Copy workspace manifests first for cache-friendly install
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile

# Copy the rest of the source and build
COPY . .

ARG TARGETPLATFORM
RUN case "$TARGETPLATFORM" in \
    "linux/amd64")  export SNOWLUMA_TARGET=linux-x64 ;; \
    "linux/arm64")  export SNOWLUMA_TARGET=linux-arm64 ;; \
    *)              export SNOWLUMA_TARGET=linux-x64 ;; \
    esac \
    && echo "Building for $SNOWLUMA_TARGET" \
    && SNOWLUMA_TARGET=$SNOWLUMA_TARGET pnpm build:all

# Production deps into dist/
WORKDIR /app/dist
RUN npm install --omit=dev

# ─── Stage 2: Runtime (Ubuntu + Xvfb + QQ NT + x11vnc) ───────────────────
# QQ NT 3.2.31 deb is fetched at build time from AUR's "beta" CDN path,
# which is not subject to the Tencent CDN sign/timestamp restriction that
# blocks the canonical /release/ path from overseas runners.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:0 \
    SNOWLUMA_WEBUI_PORT=7860 \
    SNOWLUMA_HOOK_AUTOLOAD=1 \
    HOME=/home/snowluma

# X11/VNC stack + fluxbox + fonts + QQ NT runtime deps.
# QQ NT is an Electron app; beyond the .deb's declared Depends we also need
# the Mesa/GBM/DRI stack and ALSA stubs or Chromium exits on startup inside
# a headless Docker container.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb x11vnc fluxbox \
    fonts-noto-cjk fonts-noto-color-emoji \
    sudo wget ca-certificates \
    libgtk-3-0 libnotify4 libnss3 libxss1 libxtst6 xdg-utils \
    libatspi2.0-0 libuuid1 libsecret-1-0 \
    libappindicator3-1 \
    libgbm1 libdrm2 libegl1 libgles2 \
    libxcomposite1 libxdamage1 libxrandr2 libxkbcommon0 \
    libasound2 dbus nginx \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/log/nginx /var/lib/nginx /tmp/nginx \
    && chown -R snowluma:snowluma /var/log/nginx /var/lib/nginx /tmp/nginx

# Install Node.js 22
RUN wget -qO- https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install QQ NT 3.2.31 — AUR beta CDN path, no sign required.
ARG TARGETARCH
RUN case "$TARGETARCH" in \
      amd64) DEB_URL="https://qqdl.gtimg.cn/qqfile/QQNT/9.9.32/beta/c390e792/linuxqq_3.2.31-51102_amd64.deb" ;; \
      arm64) DEB_URL="https://qqdl.gtimg.cn/qqfile/QQNT/9.9.32/beta/c390e792/linuxqq_3.2.31-51102_arm64.deb" ;; \
      *) echo "unsupported TARGETARCH: $TARGETARCH" && exit 1 ;; \
    esac \
    && wget -q -O /tmp/qq.deb "$DEB_URL" \
    && dpkg -i /tmp/qq.deb \
    && rm -f /tmp/qq.deb \
    && apt-get -f install -y \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user (QQ refuses to run as root)
RUN useradd -m -s /bin/bash snowluma \
    && echo "snowluma ALL=(ALL) NOPASSWD: ALL" >> /etc/sudoers

# Pre-create directories with correct ownership (VOLUME mounts would
# otherwise default to root, causing Permission Denied for snowluma user)
RUN mkdir -p /tmp/.X11-unix \
    && chmod 1777 /tmp/.X11-unix \
    && mkdir -p /app/config /app/data /app/logs /home/snowluma/.config \
    && chown -R snowluma:snowluma /app/config /app/data /app/logs /home/snowluma

# Copy built SnowLuma
COPY --from=builder --chown=snowluma:snowluma /app/dist /app
COPY --chown=snowluma:snowluma entrypoint.sh /entrypoint.sh
COPY --chown=snowluma:snowluma hf/nginx.conf /etc/nginx/nginx.conf
RUN chmod +x /entrypoint.sh

EXPOSE 7860

USER snowluma
WORKDIR /app

ENTRYPOINT ["/entrypoint.sh"]
