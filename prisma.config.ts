import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'apps/api/prisma/schema.prisma',
  migrations: {
    path: 'apps/api/prisma/migrations',
    seed: 'npm run db:seed --workspace @flowboard/api',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
