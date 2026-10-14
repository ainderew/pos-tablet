# Server image: Next.js standalone build of apps/server (built from the repo root as context)
FROM node:22-alpine AS build
RUN npm install -g pnpm@9.15.9
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@pos/server..."
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION NEXT_TELEMETRY_DISABLED=1
RUN pnpm --filter @pos/server build

FROM node:22-alpine
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 HOSTNAME=0.0.0.0 PORT=3000
WORKDIR /app
COPY --from=build --chown=node:node /repo/apps/server/.next/standalone ./
COPY --from=build --chown=node:node /repo/apps/server/.next/static ./apps/server/.next/static
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "apps/server/server.js"]
