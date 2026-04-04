FROM node:20 AS base
RUN npm install -g pnpm@9.15.0
WORKDIR /app

# Install dependencies
FROM base AS deps
# Build tools needed for native modules (@xenova/transformers / onnxruntime)
RUN apt-get update && apt-get install -y build-essential python3 && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/server/package.json ./packages/server/package.json
RUN pnpm install --frozen-lockfile --filter @retaindb/server...

# Build
FROM deps AS builder
COPY packages/server ./packages/server
RUN pnpm --filter @retaindb/server run build
RUN pnpm --filter @retaindb/server exec prisma generate

# Runtime
FROM node:20-slim AS runner
# openssl for Prisma, libstdc++/libgomp for onnxruntime native bindings
RUN apt-get update && apt-get install -y openssl libstdc++6 libgomp1 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=builder /app/packages/server/dist ./dist
COPY --from=builder /app/packages/server/prisma ./prisma
COPY --from=builder /app/node_modules ./node_modules

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000

CMD ["sh", "-c", "npx prisma migrate deploy --schema=./prisma/schema.prisma && node dist/index.js"]
