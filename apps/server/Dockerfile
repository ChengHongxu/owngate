# syntax=docker/dockerfile:1
# webridge-server 多阶段构建
# runner 阶段保持精简，只含编译产物与生产依赖（含 better-sqlite3 原生模块）

# ─── builder ────────────────────────────────────────────────────────────────
FROM node:24-slim AS builder

# 启用 corepack 并准备 pnpm（与 root package.json 的 packageManager 字段一致）
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate

# better-sqlite3 / argon2 编译需要 native 构建工具
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 make g++ libsqlite3-dev \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /repo

# 先复制 workspace 描述文件，最大化层缓存
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/
COPY apps/browser/package.json apps/browser/tsconfig.json ./apps/browser/
COPY apps/cli/package.json apps/cli/tsconfig.json ./apps/cli/
COPY packages/core/package.json packages/core/tsconfig.json ./packages/core/
COPY packages/db/package.json packages/db/tsconfig.json ./packages/db/
COPY packages/vault/package.json packages/vault/tsconfig.json ./packages/vault/
COPY packages/schema-meta/package.json packages/schema-meta/tsconfig.json ./packages/schema-meta/
COPY packages/connector-runtime/package.json packages/connector-runtime/tsconfig.json ./packages/connector-runtime/
COPY packages/browser-runtime/package.json packages/browser-runtime/tsconfig.json ./packages/browser-runtime/

RUN pnpm install --frozen-lockfile

# 复制全部源码并构建所有包
COPY . .
RUN pnpm -r build

# 重新安装生产依赖到独立的 production node_modules
RUN pnpm install --frozen-lockfile --prod \
 && find node_modules -name "*.ts" -type f -delete 2>/dev/null || true

# ─── runner ────────────────────────────────────────────────────────────────
FROM node:24-slim AS runner

# 运行时仅需要 libsqlite3 共享库（better-sqlite3 .node 已在 builder 编译）
RUN apt-get update \
 && apt-get install -y --no-install-recommends libsqlite3-0 ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 复制生产依赖与编译产物
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/apps/server/dist ./apps/server/dist
COPY --from=builder /repo/apps/server/package.json ./apps/server/package.json
COPY --from=builder /repo/packages/core/dist ./packages/core/dist
COPY --from=builder /repo/packages/core/package.json ./packages/core/package.json
COPY --from=builder /repo/packages/db/dist ./packages/db/dist
COPY --from=builder /repo/packages/db/package.json ./packages/db/package.json
COPY --from=builder /repo/packages/vault/dist ./packages/vault/dist
COPY --from=builder /repo/packages/vault/package.json ./packages/vault/package.json
COPY --from=builder /repo/packages/schema-meta/dist ./packages/schema-meta/dist
COPY --from=builder /repo/packages/schema-meta/package.json ./packages/schema-meta/package.json
COPY --from=builder /repo/packages/connector-runtime/dist ./packages/connector-runtime/dist
COPY --from=builder /repo/packages/connector-runtime/package.json ./packages/connector-runtime/package.json

ENV NODE_ENV=production

USER 1000:1000
EXPOSE 3000
CMD ["node", "apps/server/dist/main.js"]
