# syntax=docker/dockerfile:1
# webridge-browser worker
# 基于官方 Playwright 镜像（已含浏览器与依赖），仅添加 Xvfb 启动包装。
# 注意：不使用 xvfb-run —— 在 Docker/WSL2 下会死锁，改为手动启动 Xvfb。

FROM mcr.microsoft.com/playwright:v1.64.1-noble

# xdpyinfo 由 x11-utils 提供，Xvfb 启动包装用它确认显示已就绪
RUN apt-get update \
 && apt-get install -y --no-install-recommends x11-utils xvfb \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制依赖描述，利用层缓存
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/browser/package.json apps/browser/tsconfig.json ./apps/browser/
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/browser-runtime/package.json packages/browser-runtime/tsconfig.json ./packages/browser-runtime/

# 启用 pnpm
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate \
 && pnpm install --frozen-lockfile

# 复制源码并构建
COPY . .
RUN pnpm --filter @webridge/browser build

ENV NODE_ENV=production
EXPOSE 4000

# 手动启动 Xvfb，再运行 worker。
# $DISPLAY 默认 :99；Xvfb 监听同套接字，等待就绪后启动 node。
CMD ["sh", "-c", "Xvfb :99 -screen 0 1280x720x24 -nolisten tcp & DISPLAY=:99 xdpyinfo -display :99 >/dev/null 2>&1 && exec node apps/browser/dist/main.js"]
