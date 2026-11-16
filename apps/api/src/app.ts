import type { NextFunction, Request, Response } from 'express';
import { ZodError } from 'zod';
import { healthResponseSchema } from '@firstwrite/shared';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { createAuthRouter, InMemoryAuthRepository, type AuthServiceOptions } from './auth/index.js';
import type { AppConfig } from './config.js';
import {
  createEntriesRouter,
  InMemoryEntriesRepository,
  type EntriesRepository,
} from './entries/index.js';
import { createHttpLogger, createLogger } from './logger.js';

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;

  constructor(statusCode: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

export interface CreateAppOptions {
  config: AppConfig;
  logger?: Logger;
  authOptions?: Omit<AuthServiceOptions, 'config'>;
  entriesRepo?: EntriesRepository;
  registerRoutes?: (app: express.Express) => void;
}

export function createApp({
  config,
  logger = createLogger(),
  authOptions,
  entriesRepo,
  registerRoutes,
}: CreateAppOptions) {
  const app = express();

  // Configure trust proxy for running behind Traefik so req.ip reflects true client IP
  app.set('trust proxy', config.TRUST_PROXY);

  // Security headers
  app.use(helmet());

  // Same-origin CORS policy (allows configured APP_BASE_URL and requests with no Origin header)
  const allowedOrigin = new URL(config.APP_BASE_URL).origin;
  app.use(
    cors({
      origin(requestOrigin, callback) {
        if (!requestOrigin || requestOrigin === allowedOrigin) {
          callback(null, true);
        } else {
          callback(new AppError(403, 'CORS_NOT_ALLOWED', 'Cross-origin request not allowed'));
        }
      },
      credentials: true,
    }),
  );

  // Body parsing with generous limit for journal entries
  app.use(express.json({ limit: '512kb' }));

  // Structured HTTP logging with redaction
  app.use(createHttpLogger(logger));

  // Log request body through the redacting logger when present so redaction rules
  // are actively enforced on every route (req.body is censored by REDACT_PATHS).
  app.use((req, _res, next) => {
    if (req.log && req.body && Object.keys(req.body as object).length > 0) {
      req.log.info({ requestPayload: { body: req.body } }, 'Incoming request payload');
    }
    next();
  });

  // Health check endpoint (both /health and /api/health supported)
  const healthHandler = (_req: Request, res: Response) => {
    const payload = healthResponseSchema.parse({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
    res.status(200).json(payload);
  };

  app.get('/health', healthHandler);
  app.get('/api/health', healthHandler);

  // Allow tests or feature modules to mount additional routes before the 404 handler
  if (registerRoutes) {
    registerRoutes(app);
  }

  // Mount authentication, session, settings, and account deletion routes (Brief 3)
  const {
    router: authRouter,
    requireAuth,
    requireCsrf,
  } = createAuthRouter({
    config,
    repo: authOptions?.repo ?? new InMemoryAuthRepository(),
    emailProvider: authOptions?.emailProvider,
    rateLimiter: authOptions?.rateLimiter,
    jobScheduler: authOptions?.jobScheduler,
    turnstileVerifier: authOptions?.turnstileVerifier,
    now: authOptions?.now,
  });
  app.use(authRouter);

  // Mount entries routes (Brief 4)
  const entriesRouter = createEntriesRouter({
    config,
    repo: entriesRepo ?? new InMemoryEntriesRepository(),
    requireAuth,
    requireCsrf,
    now: authOptions?.now,
  });
  app.use(entriesRouter);

  // 404 handler for unknown routes
  app.use((_req: Request, _res: Response, next: NextFunction) => {
    next(new AppError(404, 'NOT_FOUND', 'The requested resource was not found'));
  });

  function isZodError(err: unknown): err is ZodError {
    return (
      err instanceof ZodError ||
      (typeof err === 'object' &&
        err !== null &&
        ((err as { name?: unknown }).name === 'ZodError' ||
          Array.isArray((err as { issues?: unknown }).issues)))
    );
  }

  // Centralized error-handling middleware (Express 5 automatically forwards rejected promises here)
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (isZodError(err)) {
      res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: err.issues.map((issue) => ({
            path: issue.path.join('.'),
            message: issue.message,
          })),
        },
      });
      return;
    }

    if (err instanceof AppError) {
      if (err.statusCode >= 500) {
        (req.log ?? logger).error(
          { err: { name: err.name, code: err.code, message: err.message } },
          'Application error',
        );
      }
      res.status(err.statusCode).json({
        error: {
          code: err.code,
          message: err.message,
          ...(err.details !== undefined ? { details: err.details } : {}),
        },
      });
      return;
    }

    // Never log full error objects that might contain user input/bodies; log only safe metadata
    const safeMessage = err instanceof Error ? err.message : 'Unexpected error';
    const safeName = err instanceof Error ? err.name : 'Error';
    (req.log ?? logger).error({ err: { name: safeName, message: safeMessage } }, 'Unhandled error');

    res.status(500).json({
      error: {
        code: 'INTERNAL_SERVER_ERROR',
        message: 'An unexpected error occurred',
      },
    });
  });

  return app;
}
