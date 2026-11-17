# Build context is the repo root (see infra/docker-compose.yml).
FROM node:26-slim AS build
RUN npm install -g pnpm@12.18.0
WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter @poc/web... && pnpm --filter @poc/web build

FROM nginx:1.29-alpine
COPY apps/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 5173
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD wget -qO- http://127.0.0.1:5173/health || exit 1
