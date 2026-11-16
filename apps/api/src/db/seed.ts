import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { eq } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { createDbPool } from './index.js';
import { users, userSettings } from './schema.js';
import { createLogger } from '../logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../../.env') });
dotenv.config();

export async function runSeed(connectionString: string) {
  const logger = createLogger();
  const { pool, db } = createDbPool(connectionString);

  try {
    const devEmail = 'dev@example.com';
    logger.info('Seeding local development database...');

    const existing = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, devEmail))
      .limit(1);

    let userId: bigint;

    if (existing.length > 0 && existing[0]) {
      userId = existing[0].id;
      logger.info({ userId: userId.toString() }, 'Seed user already exists, skipping insert.');
    } else {
      const inserted = await db
        .insert(users)
        .values({
          email: devEmail,
          // Placeholder argon2id hash for local seed user (Brief 3 implements real auth)
          passwordHash:
            '$argon2id$v=19$m=65536,t=3,p=4$c2VlZGVkc2FsdDEyMzQ1Ng$R29vZFBhc3N3b3JkSGFzaFBsYWNlaG9sZGVyMTIzNDU2',
          timezone: 'Africa/Johannesburg',
          emailVerifiedAt: new Date(),
        })
        .returning({ id: users.id });

      const row = inserted[0];
      if (!row) {
        throw new Error('Failed to insert seed user');
      }
      userId = row.id;

      await db
        .insert(userSettings)
        .values({
          userId,
          reminderEnabled: true,
          reminderTime: '07:00',
          weeklySummaryEnabled: false,
          summaryDeliveryTime: '18:00',
          dailyWordGoal: 750,
        })
        .onConflictDoNothing();

      logger.info({ userId: userId.toString() }, 'Inserted local development seed user.');
    }
  } finally {
    await pool.end();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  runSeed(config.DATABASE_URL).catch((err: unknown) => {
    console.error('Seed failed:', err);
    process.exit(1);
  });
}
