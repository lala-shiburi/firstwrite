import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

import { createApp } from './app.js';
import { createDrizzleAuthRepository } from './auth/index.js';
import { loadConfig } from './config.js';
import { createDbPool, waitForDatabase } from './db/index.js';
import { createDrizzleEntriesRepository } from './entries/index.js';
import { createDrizzleExportRepository } from './export/index.js';
import { createLogger } from './logger.js';
import { initializeMonitoring } from './monitoring.js';
import { createDrizzlePushRepository } from './push/index.js';
import { createDrizzleSummariesRepository } from './summaries/index.js';

const config = loadConfig();
const logger = createLogger();
initializeMonitoring(config.SENTRY_DSN);
const { pool, db } = createDbPool(config.DATABASE_URL);
try {
  await waitForDatabase(pool);
} catch {
  logger.fatal('Database connection failed after retrying startup connections.');
  await pool.end();
  process.exit(1);
}
const authRepo = createDrizzleAuthRepository(db);
const entriesRepo = createDrizzleEntriesRepository(db);
const pushRepo = createDrizzlePushRepository(db);
const exportRepo = createDrizzleExportRepository(db);
const summariesRepo = createDrizzleSummariesRepository(db);
const app = createApp({
  config,
  logger,
  authOptions: {
    repo: authRepo,
  },
  entriesRepo,
  pushRepo,
  exportRepo,
  summariesRepo,
});

const server = app.listen(config.PORT, config.HOST, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV, appBaseUrl: config.APP_BASE_URL },
    'Morning Pages API listening',
  );
});

const shutdown = (signal: string) => {
  logger.info({ signal }, 'Shutting down API server...');
  server.close(() => {
    void pool.end().finally(() => {
      logger.info('API server stopped.');
      process.exit(0);
    });
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
