# syntax=docker/dockerfile:1
FROM node:22-slim AS builder

WORKDIR /app

# Install build tools and pnpm
RUN apt-get update && apt-get install -y --no-install-recommends \
    git python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm install -g pnpm@10.28.0

# Copy workspace manifests and source
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY packages ./packages
RUN pnpm install --frozen-lockfile

# Copy all source code and build
COPY . .

ARG TARGETPLATFORM
RUN case "$TARGETPLATFORM" in \
    "linux/amd64") export SNOWLUMA_TARGET=linux-x64 ;; \
    "linux/arm64") export SNOWLUMA_TARGET=linux-arm64 ;; \
    *) export SNOWLUMA_TARGET=linux-x64 ;; \
    esac \
    && echo "Building for $SNOWLUMA_TARGET" \
    && SNOWLUMA_TARGET=$SNOWLUMA_TARGET pnpm build:all

# Install production dependencies into dist
WORKDIR /app/dist
RUN npm install --omit=dev

# Runtime stage
FROM node:22-slim

WORKDIR /app

# Copy built application
COPY --from=builder /app/dist /app

EXPOSE 5099

CMD ["node", "index.mjs"]
