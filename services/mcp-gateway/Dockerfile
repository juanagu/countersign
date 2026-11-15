# Build context is the repo root (see infra/docker-compose.yml).
FROM node:22-slim
RUN npm install -g pnpm@12.18.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @poc/mcp-gateway... && pnpm --filter @poc/mcp-gateway... build
WORKDIR /repo/services/mcp-gateway
ENV NODE_ENV=production
USER node
EXPOSE 8100
HEALTHCHECK --interval=10s --timeout=3s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:8100/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "@poc/mcp-kit/telemetry", "dist/server.js"]
