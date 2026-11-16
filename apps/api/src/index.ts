import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
dotenv.config();

import { createApp } from './app.js';
import { createDrizzleAuthRepository } from './auth/index.js';
import { loadConfig } from './config.js';
import { createDbPool } from './db/index.js';
import { createDrizzleEntriesRepository } from './entries/index.js';
import { createDrizzleExportRepository } from './export/index.js';
import { createLogger } from './logger.js';
import { createDrizzlePushRepository } from './push/index.js';

const config = loadConfig();
const logger = createLogger();
const { pool, db } = createDbPool(config.DATABASE_URL);
const authRepo = createDrizzleAuthRepository(db);
const entriesRepo = createDrizzleEntriesRepository(db);
const pushRepo = createDrizzlePushRepository(db);
const exportRepo = createDrizzleExportRepository(db);
const app = createApp({
  config,
  logger,
  authOptions: {
    repo: authRepo,
  },
  entriesRepo,
  pushRepo,
  exportRepo,
});

const server = app.listen(config.PORT, () => {
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
