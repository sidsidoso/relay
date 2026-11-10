FROM node:24-slim AS deps
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w apps/api --include-workspace-root=false --omit=dev

FROM node:24-slim
WORKDIR /app
COPY --from=deps /app/node_modules node_modules
COPY package.json tsconfig.base.json ./
COPY apps/api apps/api
RUN mkdir -p /data && chown node:node /data
WORKDIR /app/apps/api
ENV RELAY_DB=/data/relay.db PORT=3000
EXPOSE 3000
USER node
CMD ["/app/node_modules/.bin/tsx", "src/main.ts"]
