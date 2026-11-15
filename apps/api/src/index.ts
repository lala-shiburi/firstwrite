import 'dotenv/config';
import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const config = loadConfig();
const logger = createLogger();
const app = createApp({ config, logger });

const server = app.listen(config.PORT, () => {
  logger.info(
    { port: config.PORT, env: config.NODE_ENV, appBaseUrl: config.APP_BASE_URL },
    'Morning Pages API listening',
  );
});

const shutdown = (signal: string) => {
  logger.info({ signal }, 'Shutting down API server...');
  server.close(() => {
    logger.info('API server stopped.');
    process.exit(0);
  });
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
