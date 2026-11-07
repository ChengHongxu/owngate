# syntax=docker/dockerfile:1
# owngate-browser worker
# 基于官方 Playwright 镜像（已含浏览器与依赖），仅添加 Xvfb 启动包装。
# 注意：不使用 xvfb-run —— 在 Docker/WSL2 下会死锁，改为手动启动 Xvfb。

FROM mcr.microsoft.com/playwright:v1.64.1-noble

# xdpyinfo 由 x11-utils 提供，Xvfb 启动包装用它确认显示已就绪
RUN apt-get update \
 && apt-get install -y --no-install-recommends x11-utils xvfb \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Playwright 镜像的 Node 没有 corepack，直接 npm 全局安装 pnpm
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH

# 整个工作区一起复制：pnpm 的 workspace 结构必须与 pnpm-workspace.yaml 一致，
# 只复制部分包会让 --frozen-lockfile 与后续 build 的依赖状态检查失败。
COPY . .
RUN npm install -g pnpm@11.15.1 \
 && pnpm install --frozen-lockfile --filter @owngate/browser... \
 && pnpm --filter @owngate/core --filter @owngate/browser-runtime build \
 && pnpm --filter @owngate/browser build

# 根文件系统在 Compose 中只读，Chromium 的 crashpad/config/cache 必须走 tmpfs。
ENV NODE_ENV=production \
    XDG_CONFIG_HOME=/tmp/owngate-config \
    XDG_CACHE_HOME=/tmp/owngate-cache
EXPOSE 4000

# 手动启动 Xvfb 并轮询就绪（xvfb-run 在 Docker/WSL2 下会死锁，见 deploy/browser-entrypoint.sh）
COPY deploy/browser-entrypoint.sh /usr/local/bin/browser-entrypoint.sh
RUN chmod +x /usr/local/bin/browser-entrypoint.sh

# ── Chromium 沙箱（设计 §4.4.1 / §12.2：禁止 --no-sandbox）───────────────
# Playwright 的 Chromium 以 root 运行时会自动加 --no-sandbox。
# 因此必须是非 root 用户：setuid sandbox helper 需要 setuid root 位，
# 浏览器进程本身以 pwuser(1000) 运行。宿主机不支持 user namespace 时，
# 这条 + compose 的 cap_add: SYS_ADMIN 是官方推荐组合。
RUN set -eu; \
    chown root:root /ms-playwright/chromium-*/chrome-linux*/chrome_sandbox; \
    chmod 4755 /ms-playwright/chromium-*/chrome-linux*/chrome_sandbox; \
    mkdir -p /profiles && chown -R 1000:1000 /profiles

USER 1000:1000

CMD ["/usr/local/bin/browser-entrypoint.sh"]
