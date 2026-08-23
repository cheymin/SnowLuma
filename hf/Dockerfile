# Hugging Face Space — SnowLuma
# 主镜像（ghcr.io/cheymin/snowluma:latest）已内置 nginx + QQ + SnowLuma，
# 且镜像/空闲容器内零 VNC 残留（x11vnc + noVNC 在「启动VNC」时按需下载、
# 「终止VNC」时彻底删除）。
# 此文件仅用于 HF Space 部署：开启 HF 模式后，主 entrypoint 会自动启动
# nginx（监听 7860，反代 SnowLuma / OneBot HTTP / OneBot WS / VNC）。
FROM ghcr.io/cheymin/snowluma:latest
ENV SNOWLUMA_HF_MODE=1
