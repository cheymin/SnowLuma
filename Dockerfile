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

# ─── Stage 2: Runtime (Ubuntu + Xvfb + QQ + x11vnc) ──────────────────────
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive \
    DISPLAY=:0 \
    SNOWLUMA_WEBUI_PORT=7860 \
    SNOWLUMA_HOOK_AUTOLOAD=1 \
    HOME=/home/snowluma

# Install Xvfb, x11vnc, window manager, fonts, and QQ runtime deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    fluxbox \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libnss3 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libgbm1 \
    libasound2 \
    libxshmfence1 \
    libxss1 \
    libgtk-3-0 \
    libdrm2 \
    libnotify4 \
    libxtst6 \
    libxkbcommon0 \
    libxcb-damage0 \
    libxcb-xfixes0 \
    libxcb-shape0 \
    libxcb-util1 \
    libxcb-image0 \
    libxcb-cursor0 \
    libxcb-keysyms1 \
    libxcb-render-util0 \
    libxcb-icccm4 \
    libxdamage1 \
    libxrandr2 \
    libxcomposite1 \
    libxcursor1 \
    libxi6 \
    libxtst6 \
    ca-certificates \
    wget \
    xz-utils \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# Install Node.js 22 (for running SnowLuma)
RUN wget -qO- https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install QQ Linux client
ARG TARGETARCH
RUN case "$TARGETARCH" in \
    "amd64") QQ_ARCH=amd64 ;; \
    "arm64") QQ_ARCH=arm64 ;; \
    *)       QQ_ARCH=amd64 ;; \
    esac \
    && wget -q "https://dldir1.qq.com/qqfile/qq/QQNT/Linux/QQ_3.2.15_${QQ_ARCH}_01.deb" -O /tmp/qq.deb \
    && dpkg -i /tmp/qq.deb || apt-get -f install -y \
    && rm /tmp/qq.deb \
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
RUN chmod +x /entrypoint.sh

EXPOSE 7860

USER snowluma
WORKDIR /app

ENTRYPOINT ["/entrypoint.sh"]
