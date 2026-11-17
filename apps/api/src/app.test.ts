import { Duplex, Writable } from 'node:stream';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Express } from 'express';
import { describe, expect, it } from 'vitest';
import { AppError, createApp } from './app.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const testConfig = loadConfig({
  NODE_ENV: 'test',
  PORT: '3000',
  APP_BASE_URL: 'http://localhost:5173',
  TRUST_PROXY: '1',
  DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/firstwrite',
  ENCRYPTION_KEY_CURRENT_VERSION: '1',
  ENCRYPTION_KEY_V1: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  SESSION_SECRET: '0123456789abcdef0123456789abcdef-session-secret',
  VAPID_PUBLIC_KEY:
    'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U',
  VAPID_PRIVATE_KEY: 'UUxI4O8-FbRouAevSmBQ6o18hgE4nSG3qwvJTfKc-ls',
  VAPID_SUBJECT: 'mailto:support@example.com',
  EMAIL_PROVIDER: 'console',
  EMAIL_PROVIDER_API_KEY: 'test-email-key',
  EMAIL_FROM: 'Morning Pages <noreply@example.com>',
  LLM_PROVIDER: 'anthropic',
  LLM_API_KEY: 'test-llm-key',
  LLM_MODEL: 'claude-haiku-4-5',
  LLM_MONTHLY_SPEND_LIMIT_USD: '50',
});

interface InjectOptions {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  remoteAddress?: string;
}

interface InjectResponse {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: Record<string, unknown>;
  text: string;
}

/**
 * Dispatches an HTTP request directly through the Express application pipeline
 * using an in-memory socket stream (requires no TCP port binding).
 */
function injectRequest(app: Express, options: InjectOptions): Promise<InjectResponse> {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    }) as unknown as Socket;

    Object.defineProperty(socket, 'remoteAddress', {
      value: options.remoteAddress ?? '127.0.0.1',
      configurable: true,
    });

    const req = new IncomingMessage(socket);
    req.method = options.method.toUpperCase();
    req.url = options.url;

    const normalizedHeaders: Record<string, string> = {
      host: 'localhost:3000',
    };
    if (options.headers) {
      for (const [k, v] of Object.entries(options.headers)) {
        normalizedHeaders[k.toLowerCase()] = v;
      }
    }
    req.headers = normalizedHeaders;

    if (options.body !== undefined) {
      (req as IncomingMessage & { body?: unknown }).body =
        typeof options.body === 'string' ? JSON.parse(options.body) : options.body;
    }
    req.push(null);

    const res = new ServerResponse(req);
    res.assignSocket(socket);

    const responseChunks: Buffer[] = [];
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);

    res.write = ((chunk: unknown, encodingOrCb?: unknown, cb?: unknown) => {
      if (chunk) {
        responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return origWrite(chunk as never, encodingOrCb as never, cb as never);
    }) as typeof res.write;

    res.end = ((chunk?: unknown, encodingOrCb?: unknown, cb?: unknown) => {
      if (chunk && typeof chunk !== 'function') {
        responseChunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      const result = origEnd(chunk as never, encodingOrCb as never, cb as never);
      const rawText = Buffer.concat(responseChunks).toString('utf8');
      // Strip raw HTTP response headers if present in socket buffer
      const bodyStart = rawText.indexOf('\r\n\r\n');
      const text = bodyStart !== -1 ? rawText.slice(bodyStart + 4) : rawText;

      let parsedBody: Record<string, unknown> = {};
      if (text.trim().startsWith('{')) {
        try {
          parsedBody = JSON.parse(text) as Record<string, unknown>;
        } catch {
          parsedBody = {};
        }
      }

      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        body: parsedBody,
        text,
      });
      return result;
    }) as typeof res.end;

    res.on('error', reject);

    app(req, res);
  });
}

function createLogCollector() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  const logger = createLogger({ level: 'debug', stream });
  return {
    logger,
    getOutput: () => chunks.join(''),
    getLines: () =>
      chunks
        .join('')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('Express API bootstrap & security rules', () => {
  it('responds 200 OK on /health and /api/health with security headers', async () => {
    const { logger } = createLogCollector();
    const app = createApp({ config: testConfig, logger });

    const res = await injectRequest(app, { method: 'GET', url: '/api/health' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(typeof res.body.timestamp).toBe('string');
    // Helmet headers present
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  it('does NOT emit the request body or plaintext journal content when logging requests to an entry endpoint', async () => {
    const collector = createLogCollector();
    const app = createApp({ config: testConfig, logger: collector.logger });

    const secretJournalEntry =
      'SUPER_SECRET_MORNING_PAGES_PLAINTEXT_994812_NEVER_LOG_THIS_SENTENCE';

    await injectRequest(app, {
      method: 'PUT',
      url: '/api/entries/2026-11-15',
      headers: {
        Cookie: 'session=RAW_SESSION_TOKEN_SECRET_VALUE_8871',
      },
      body: { content: secretJournalEntry },
    });

    const rawLogs = collector.getOutput();
    const logLines = collector.getLines();

    // Ensure the request was actually logged by pino-http
    expect(logLines.length).toBeGreaterThan(0);
    expect(rawLogs).toContain('/api/entries/2026-11-15');

    // Critical acceptance criterion: entry request body and raw cookies must NEVER appear in logs
    expect(rawLogs).not.toContain(secretJournalEntry);
    expect(rawLogs).not.toContain('RAW_SESSION_TOKEN_SECRET_VALUE_8871');
  });

  it('does NOT emit passwords or tokens when logging requests to auth endpoints', async () => {
    const collector = createLogCollector();
    const app = createApp({ config: testConfig, logger: collector.logger });

    const secretPassword = 'MY_ULTRA_SECRET_PASSWORD_774123!';

    await injectRequest(app, {
      method: 'POST',
      url: '/api/auth/login',
      body: {
        email: 'writer@example.com',
        password: secretPassword,
      },
    });

    const rawLogs = collector.getOutput();
    expect(rawLogs).toContain('/api/auth/login');
    expect(rawLogs).not.toContain(secretPassword);
  });

  it('does not log exception messages that could contain journal text', async () => {
    const collector = createLogCollector();
    const journalText = 'JOURNAL_TEXT_MUST_NOT_LEAK_FROM_EXCEPTION';
    const app = createApp({
      config: testConfig,
      logger: collector.logger,
      registerRoutes(expressApp) {
        expressApp.get('/api/test-sensitive-error', () => {
          throw new Error(journalText);
        });
      },
    });

    const response = await injectRequest(app, {
      method: 'GET',
      url: '/api/test-sensitive-error',
    });

    expect(response.status).toBe(500);
    expect(collector.getOutput()).not.toContain(journalText);
  });

  it('catches async errors in centralized error-handling middleware and formats Zod validation errors', async () => {
    const collector = createLogCollector();
    const app = createApp({
      config: testConfig,
      logger: collector.logger,
      registerRoutes(expressApp) {
        expressApp.get('/api/test-async-error', async () => {
          await Promise.resolve();
          throw new AppError(422, 'CUSTOM_ASYNC_ERROR', 'Async failure handled cleanly');
        });
      },
    });

    const asyncRes = await injectRequest(app, {
      method: 'GET',
      url: '/api/test-async-error',
    });
    expect(asyncRes.status).toBe(422);
    expect(asyncRes.body).toEqual({
      error: {
        code: 'CUSTOM_ASYNC_ERROR',
        message: 'Async failure handled cleanly',
      },
    });

    // Invalid payload triggers ZodError -> 400 VALIDATION_ERROR
    const invalidRegisterRes = await injectRequest(app, {
      method: 'POST',
      url: '/api/auth/register',
      body: { email: 'not-an-email', password: 'short' },
    });
    expect(invalidRegisterRes.status).toBe(400);
    expect((invalidRegisterRes.body.error as { code: string }).code).toBe('VALIDATION_ERROR');
  });

  it('honors trust proxy for X-Forwarded-For behind Traefik and enforces same-origin CORS', async () => {
    const { logger } = createLogCollector();
    const app = createApp({
      config: testConfig,
      logger,
      registerRoutes(expressApp) {
        expressApp.get('/api/test-ip', (req, res) => {
          res.json({ ip: req.ip });
        });
      },
    });

    const ipRes = await injectRequest(app, {
      method: 'GET',
      url: '/api/test-ip',
      headers: {
        'X-Forwarded-For': '203.0.113.42',
      },
    });
    expect(ipRes.status).toBe(200);
    expect(ipRes.body.ip).toBe('203.0.113.42');

    // Allowed origin (matches APP_BASE_URL)
    const allowedCors = await injectRequest(app, {
      method: 'GET',
      url: '/api/health',
      headers: {
        Origin: 'http://localhost:5173',
      },
    });
    expect(allowedCors.status).toBe(200);
    expect(allowedCors.headers['access-control-allow-origin']).toBe('http://localhost:5173');

    // Disallowed cross-origin
    const deniedCors = await injectRequest(app, {
      method: 'GET',
      url: '/api/health',
      headers: {
        Origin: 'https://evil.example.com',
      },
    });
    expect(deniedCors.status).toBe(403);
  });

  it('keeps initial Drizzle SQL migration synchronized with root schema.sql', () => {
    const rootSchemaPath = path.resolve(__dirname, '../../../schema.sql');
    const migrationSqlPath = path.resolve(__dirname, '../drizzle/0000_initial_schema.sql');

    const rootSchema = fs.readFileSync(rootSchemaPath, 'utf8').trim();
    const migrationSchema = fs.readFileSync(migrationSqlPath, 'utf8').trim();

    expect(migrationSchema).toBe(rootSchema);
  });
});
