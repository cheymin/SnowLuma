# Hugging Face Space — SnowLuma
# 主镜像已内置 nginx + x11vnc + QQ + SnowLuma。
# 只需开启 HF 模式，entrypoint 会自动启动 nginx（监听 7860，
# 反代 SnowLuma / OneBot HTTP / OneBot WS）。
FROM ghcr.io/cheymin/snowluma:latest
ENV SNOWLUMA_HF_MODE=1
