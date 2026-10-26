// Prisma 7 reads connection settings from here, not from schema.prisma.
// Prisma no longer loads .env on its own, so dotenv is imported explicitly.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    // Optional for `prisma generate`/`validate`; required for migrate/db commands.
    url: process.env['DATABASE_URL'],
  },
});
