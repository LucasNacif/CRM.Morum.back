import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

/**
 * Las migraciones usan conexión directa. El pooler de Neon (host con "-pooler") reutiliza
 * conexiones y no libera el candado que toma Prisma al migrar, lo que traba los despliegues
 * siguientes. La app sigue usando el pooler (DATABASE_URL tal cual).
 */
function migrationUrl() {
  if (process.env.DIRECT_DATABASE_URL) return process.env.DIRECT_DATABASE_URL;
  return env('DATABASE_URL').replace('-pooler.', '.');
}

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: migrationUrl(),
  },
});
