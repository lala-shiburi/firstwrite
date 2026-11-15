import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { loadConfig } from '../config.js';
import { createDbPool } from './index.js';
import { createLogger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export async function runMigrations(connectionString: string) {
  const logger = createLogger();
  const { pool, db } = createDbPool(connectionString);

  try {
    const migrationsFolder = path.resolve(__dirname, '../../drizzle');
    logger.info({ migrationsFolder }, 'Running database migrations...');
    await migrate(db, { migrationsFolder });
    logger.info('Database migrations completed successfully.');
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  runMigrations(config.DATABASE_URL).catch((err: unknown) => {
    console.error('Migration failed:', err);
    process.exit(1);
  });
}
