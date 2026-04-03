FROM node:20-slim AS base
RUN npm install -g pnpm@9.15.0
WORKDIR /app

# Install dependencies
FROM base AS deps
COPY package.json pnpm-workspace.yaml ./
COPY packages/server/package.json ./packages/server/package.json
RUN pnpm install --frozen-lockfile --filter @retaindb/server...

# Build
FROM deps AS builder
COPY packages/server ./packages/server
RUN pnpm --filter @retaindb/server run build
RUN pnpm --filter @retaindb/server exec prisma generate

# Runtime
FROM node:20-slim AS runner
RUN apt-get update && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=builder /app/packages/server/dist ./dist
COPY --from=builder /app/packages/server/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

# Run migrations then start
CMD ["sh", "-c", "npx prisma migrate deploy --schema=./prisma/schema.prisma && node dist/index.js"]
