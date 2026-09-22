import { defineConfig } from 'drizzle-kit';

// Dev lokal: SQLite. Setelah 100% selesai, ganti ke drizzle.pg.config.ts
// (dialect postgresql + db/schema.pg.ts + Supabase connection string).
export default defineConfig({
  dialect: 'sqlite',
  schema: './db/schema.sqlite.ts',
  out: './drizzle',
  dbCredentials: { url: './dev.db' },
});
