import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DestinationStream } from 'pino';
import pino from 'pino';
import { pinoHttp } from 'pino-http';

/**
 * Redaction paths to guarantee plaintext journal content, passwords, tokens,
 * cookies, and secrets never appear in logs (AGENTS.md Rule 1 & Rule 3).
 */
export const REDACT_PATHS = [
  'req.headers.cookie',
  'req.headers.authorization',
  'req.headers["x-csrf-token"]',
  'res.headers["set-cookie"]',
  'res.headers["x-csrf-token"]',
  'req.body',
  'req.body.content',
  'req.body.summary_md',
  'req.body.summaryMd',
  'req.body.password',
  'req.body.token',
  'req.body.turnstileToken',
  'requestPayload.body',
  'requestPayload.body.*',
  'body',
  'body.content',
  'body.password',
  'body.token',
  'body.turnstileToken',
  'content',
  'content_enc',
  'summary',
  'summary_md',
  'summaryMd',
  'summary_enc',
  'password',
  'password_hash',
  'passwordHash',
  'token',
  'token_hash',
  'tokenHash',
  'sessionToken',
  'rawToken',
  'csrfToken',
  '*.content',
  '*.summary_md',
  '*.summaryMd',
  '*.password',
  '*.token',
  '*.tokenHash',
  '*.passwordHash',
];

export interface CreateLoggerOptions {
  level?: string;
  stream?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions = {}) {
  return pino(
    {
      level: options.level ?? (process.env.NODE_ENV === 'test' ? 'info' : 'info'),
      redact: {
        paths: REDACT_PATHS,
        censor: '[REDACTED]',
      },
    },
    options.stream,
  );
}

export function createHttpLogger(logger = createLogger()) {
  return pinoHttp({
    logger,
    serializers: {
      // Explicitly serialize only safe request metadata; never attach request bodies
      req(req: IncomingMessage & { id?: unknown; remoteAddress?: string }) {
        const headers = req.headers ?? {};
        return {
          id: req.id,
          method: req.method,
          url: req.url,
          remoteAddress: req.remoteAddress,
          headers: {
            host: headers.host,
            'user-agent': headers['user-agent'],
            cookie: headers.cookie,
            authorization: headers.authorization,
          },
        };
      },
      res(res: ServerResponse) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  });
}
