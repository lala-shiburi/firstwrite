import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

const { Pool } = pg;

export function createDbPool(connectionString: string) {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });
  return { pool, db };
}

export async function waitForDatabase(pool: pg.Pool, attempts = 10, delayMs = 1000): Promise<void> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch {
      if (attempt === attempts) {
        throw new Error(`Database connection failed after ${attempts} attempts`);
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export type Database = ReturnType<typeof createDbPool>['db'];
