# syntax=docker/dockerfile:1
FROM node:24-slim AS builder
ENV PNPM_HOME=/usr/local/share/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@11.15.1 --activate \
 && apt-get update && apt-get install -y --no-install-recommends python3 make g++ libsqlite3-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile \
 && pnpm --filter @owngate/runtime-http... build \
 && CI=true pnpm install --frozen-lockfile --prod --offline

FROM node:24-slim AS runner
WORKDIR /app
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages/runtime-http/node_modules ./packages/runtime-http/node_modules
COPY --from=builder /repo/packages/runtime-http/dist ./packages/runtime-http/dist
COPY --from=builder /repo/packages/runtime-http/package.json ./packages/runtime-http/package.json
COPY --from=builder /repo/packages/core/node_modules ./packages/core/node_modules
COPY --from=builder /repo/packages/core/dist ./packages/core/dist
COPY --from=builder /repo/packages/core/package.json ./packages/core/package.json
COPY --from=builder /repo/packages/connector-runtime/node_modules ./packages/connector-runtime/node_modules
COPY --from=builder /repo/packages/connector-runtime/dist ./packages/connector-runtime/dist
COPY --from=builder /repo/packages/connector-runtime/package.json ./packages/connector-runtime/package.json
COPY --from=builder /repo/packages/schema-meta/node_modules ./packages/schema-meta/node_modules
COPY --from=builder /repo/packages/schema-meta/dist ./packages/schema-meta/dist
COPY --from=builder /repo/packages/schema-meta/package.json ./packages/schema-meta/package.json
COPY --from=builder /repo/connectors ./connectors
ENV NODE_ENV=production
# The control process reads its 0600 secret, then launches each connector as
# nobody with an empty environment. Children cannot read the control secret.
USER 0:0
EXPOSE 5000
CMD ["node", "packages/runtime-http/dist/main.js"]
