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
# 基于 NapCat base 镜像 — 已预装 QQ NT + 所有运行时依赖
# 腾讯 CDN 限制海外下载，所以直接复用 NapCat 已构建好的 base
FROM mlikiowa/napcat-docker:base

ENV DISPLAY=:0 \
    SNOWLUMA_WEBUI_PORT=7860 \
    SNOWLUMA_HOOK_AUTOLOAD=1 \
    HOME=/home/snowluma

# 安装额外依赖：fluxbox（窗口管理器）、字体
RUN apt-get update && apt-get install -y --no-install-recommends \
    fluxbox \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    sudo \
    && rm -rf /var/lib/apt/lists/*

# 安装 Node.js 22（NapCat base 可能自带较低版本）
RUN wget -qO- https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
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
