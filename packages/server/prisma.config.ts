import { defineConfig } from 'prisma/config'

export default defineConfig({
  schemas: ['./prisma/schema.prisma'],
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
})
