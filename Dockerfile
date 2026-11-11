# Warrant: one image that serves the API, the PayPal simulator and the built web app on one port.
#
#   docker build -t warrant .
#   docker run --rm -p 8787:8787 -e NODE_ENV=development -e WEB_ORIGIN=http://localhost:8787 warrant
#
# That runs the zero-config demo on http://localhost:8787 (fixtures mode, built-in PayPal simulator, embedded database,
# development signing keys). The image itself defaults to NODE_ENV=production, in which the server refuses to start
# without DATABASE_URL, PUBLIC_BASE_URL and the three signing keys (docs/setup.md), so a deployment cannot quietly run on
# development keys.

FROM node:24-slim

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable

WORKDIR /app

# Dependencies first, so this layer is reused when only source files change. The package.json files are copied to
# the same paths as in the repository because pnpm resolves the workspace from them.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/warrant/package.json packages/warrant/package.json
COPY packages/paypal/package.json packages/paypal/package.json
COPY packages/catalog/package.json packages/catalog/package.json
COPY packages/mcp/package.json packages/mcp/package.json
COPY sim/package.json sim/package.json
COPY e2e/package.json e2e/package.json
RUN pnpm install --frozen-lockfile --filter "@warrant/server..." --filter "@warrant/web..."

COPY apps apps
COPY packages packages
RUN pnpm --filter @warrant/web run build && pnpm --filter @warrant/server run build

ENV NODE_ENV=production
ENV PORT=8787
ENV HOST=0.0.0.0
# A bounded heap keeps the process inside small instances (the embedded database lives outside it).
ENV NODE_OPTIONS=--max-old-space-size=384
EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

# The server is bundled to plain JavaScript at build time (apps/server/build.mjs) and runs from apps/server, serving ../web/dist.
WORKDIR /app/apps/server
CMD ["node", "dist/main.js"]
