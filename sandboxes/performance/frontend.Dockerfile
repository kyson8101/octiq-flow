# syntax=docker/dockerfile:1
FROM node:22-alpine AS builder
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN --mount=type=secret,id=nuget_token,required=true \
    printf '@pandaworks-sw:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' "$(cat /run/secrets/nuget_token)" > /tmp/sandbox.npmrc \
    && NPM_CONFIG_USERCONFIG=/tmp/sandbox.npmrc pnpm install --frozen-lockfile \
    && rm /tmp/sandbox.npmrc
COPY . .
RUN pnpm build
FROM nginx:1.27-alpine
COPY --from=builder /app/dist /usr/share/nginx/html/performanceV2
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/docker-entrypoint.sh /docker-entrypoint.d/40-env-config.sh
RUN chmod +x /docker-entrypoint.d/40-env-config.sh
COPY --from=sandbox-kit frontend-origin.sh /docker-entrypoint.d/50-sandbox-origin.sh
RUN chmod +x /docker-entrypoint.d/50-sandbox-origin.sh
