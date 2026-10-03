FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/bridge/package.json ./apps/bridge/
COPY apps/mini-app/package.json ./apps/mini-app/
RUN npm ci
COPY apps ./apps
RUN npm run check && npm test && npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production BRIDGE_HOST=127.0.0.1 BRIDGE_DATABASE_PATH=/app/data/bridge.sqlite
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps ./apps
RUN mkdir -p /app/data && chown node:node /app/data
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:'+(process.env.BRIDGE_PORT||8787)+'/api/v1/system/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/bridge/dist/server.js"]
