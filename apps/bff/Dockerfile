# Build context is the repo root (see infra/docker-compose.yml).
FROM node:26-slim
RUN npm install -g pnpm@12.18.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @poc/bff... && pnpm --filter @poc/bff build
WORKDIR /repo/apps/bff
ENV NODE_ENV=production
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--disable-warning=DEP0205", "--import", "./dist/core/telemetry.js", "dist/server.js"]
