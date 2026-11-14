# syntax=docker/dockerfile:1.7
# Pinned 2026-09-01 — update via: docker buildx imagetools inspect node:24-alpine
ARG NODE_VERSION=24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf

FROM node:${NODE_VERSION} AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml .npmrc ./
COPY apps/api/package.json apps/api/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/testing/package.json packages/testing/package.json
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps ./apps
COPY --from=deps /app/packages ./packages
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json turbo.json .npmrc ./
COPY eslint.config.mjs prettier.config.mjs ./
COPY scripts/build-runtime.mjs scripts/build-runtime.mjs
COPY apps/worker ./apps/worker
COPY packages ./packages
RUN pnpm --filter @platform/worker build
# pnpm deploy --prod resolves the isolated-linker node_modules graph that the
# old image broke by copying only apps/worker/node_modules.
RUN node scripts/build-runtime.mjs --filter @platform/worker --target /out

FROM node:${NODE_VERSION} AS runner
ARG COMMIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.revision=$COMMIT_SHA \
      org.opencontainers.image.created=$BUILD_DATE \
      org.opencontainers.image.version=$COMMIT_SHA \
      org.opencontainers.image.source="https://github.com/multi-tenant-platform"
ENV COMMIT_SHA=$COMMIT_SHA
ENV BUILD_DATE=$BUILD_DATE
RUN apk add --no-cache tini \
    && addgroup -S appgroup \
    && adduser -S appuser -G appgroup
WORKDIR /app
ENV NODE_ENV=production
ENV WORKER_HEALTH_HOST=0.0.0.0
ENV WORKER_HEALTH_PORT=4010
ENV WORKER_READY_FILE=/tmp/platform-worker-ready
COPY --from=build /out ./
USER appuser
EXPOSE 4010
STOPSIGNAL SIGTERM
# Readiness reports Redis, consumers, relay, scheduler, lag and DLQ.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4010/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main.js"]
