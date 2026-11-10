FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
RUN npm ci -w apps/api --include-workspace-root=false
COPY apps/api apps/api
WORKDIR /app/apps/api
ENV RELAY_DB=/data/relay.db PORT=3000
EXPOSE 3000
CMD ["npx", "tsx", "src/main.ts"]
