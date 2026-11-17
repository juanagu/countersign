# Build context is the repo root (see infra/docker-compose.yml).
FROM node:26-slim
RUN npm install -g pnpm@12.18.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @poc/mcp-accounts... && pnpm --filter @poc/mcp-accounts... build
WORKDIR /repo/services/mcp-accounts
ENV NODE_ENV=production
USER node
EXPOSE 8101
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8101/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "@poc/mcp-kit/telemetry", "dist/server.js"]
