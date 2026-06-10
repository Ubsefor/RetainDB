# RetainDB Local — Dockerfile

FROM node:20-slim AS builder
RUN npm install -g pnpm@9.15.0
WORKDIR /app

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./
COPY packages/local/package.json ./packages/local/package.json

RUN pnpm install --frozen-lockfile --filter @retaindb/local...

COPY packages/local/ ./packages/local/

RUN pnpm --filter @retaindb/local build

FROM node:20-slim AS deploy
RUN npm install -g pnpm@9.15.0
WORKDIR /app

COPY --from=builder /app /app

RUN pnpm deploy --filter @retaindb/local /deploy

FROM node:20-slim
WORKDIR /app

RUN apt-get -qq update -y -o Dpkg::Use-Pty=0 && \
    apt-get -qq install -y --no-install-recommends -o Dpkg::Use-Pty=0 curl && \
    apt-get -qq clean -y && \
    apt-get -qq autoclean -y && \
    apt-get -qq autoremove -y && \
    rm -rf /var/lib/apt/lists/* /var/cache/apt/*

COPY --from=deploy /deploy ./

ENV NODE_ENV=production

EXPOSE 3111 3113

CMD ["node", "dist/cli.js"]
