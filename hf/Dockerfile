# Hugging Face Docker Space — SnowLuma + nginx 反代
# 基于 ghcr.io 镜像，加一层 nginx 把 OneBot 的 3000/3001 端口
# 也通过 7860 暴露出来（HF 只允许暴露一个端口）

FROM ghcr.io/cheymin/snowluma:latest

USER root

# 安装 nginx
RUN apt-get update && apt-get install -y --no-install-recommends nginx \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /var/log/nginx /var/lib/nginx /tmp/nginx \
    && chown -R snowluma:snowluma /var/log/nginx /var/lib/nginx /tmp/nginx

# SnowLuma 内部用 5099，nginx 占 7860 对外
ENV SNOWLUMA_WEBUI_PORT=5099

COPY nginx.conf /etc/nginx/nginx.conf
COPY entrypoint.sh /hf-entrypoint.sh
RUN chmod +x /hf-entrypoint.sh

USER snowluma

ENTRYPOINT ["/hf-entrypoint.sh"]
