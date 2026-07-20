#!/bin/bash
set -e

# Hugging Face Space 启动脚本
# 1. 启动 nginx（监听 7860，反代 SnowLuma + OneBot）
# 2. 启动原始 entrypoint（Xvfb → QQ → x11vnc → SnowLuma）

mkdir -p /var/log/nginx /var/lib/nginx /tmp/nginx

echo "[hf] Starting nginx on port 7860..."
nginx -c /etc/nginx/nginx.conf

echo "[hf] Starting SnowLuma stack (Xvfb → QQ → x11vnc → SnowLuma)..."
exec /entrypoint.sh
