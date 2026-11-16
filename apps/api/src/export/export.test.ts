import { Duplex, Writable } from 'node:stream';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { addDaysToLocalDate, countWords } from '@firstwrite/shared';
import type { Express } from 'express';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { InMemoryAuthRepository, SESSION_COOKIE_NAME } from '../auth/index.js';
import { loadConfig } from '../config.js';
import { buildEntryAad, buildSummaryAad, encrypt } from '../crypto/index.js';
import { InMemoryEntriesRepository } from '../entries/index.js';
import { createLogger } from '../logger.js';
import { InMemoryExportRepository, parseZipBuffer } from './index.js';

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
}

interface InjectResponse {
  status: number;
  headers: Record<string, string | string[] | number | undefined>;
  bodyBuffer: Buffer;
  text: string;
}

function injectRequest(app: Express, options: InjectOptions): Promise<InjectResponse> {
  return new Promise((resolve, reject) => {
    const socket = new Duplex({
      read() {},
      write(_chunk, _encoding, callback) {
        callback();
      },
    }) as unknown as Socket;

    Object.defineProperty(socket, 'remoteAddress', {
      value: '127.0.0.1',
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
      const fullBuffer = Buffer.concat(responseChunks);
      const headerSep = Buffer.from('\r\n\r\n');
      const sepIdx = fullBuffer.indexOf(headerSep);
      const bodyBuffer = sepIdx !== -1 ? fullBuffer.subarray(sepIdx + 4) : fullBuffer;

      resolve({
        status: res.statusCode,
        headers: res.getHeaders(),
        bodyBuffer,
        text: bodyBuffer.toString('utf8'),
      });
      return result;
    }) as typeof res.end;

    res.on('error', reject);
    app(req, res);
  });
}

function extractRawSessionCookie(res: InjectResponse): string {
  const setCookie = res.headers['set-cookie'];
  const headerStr = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie ?? '');
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(headerStr);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

/**
 * Simulates an Obsidian/YAML-frontmatter Markdown importer:
 * Verifies the file starts with `---\n...\n---\n`, parses the YAML frontmatter key/value pairs,
 * and returns the body markdown that follows.
 */
function parseObsidianMarkdownFile(rawMarkdown: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  expect(rawMarkdown.startsWith('---\n')).toBe(true);
  const closingIdx = rawMarkdown.indexOf('\n---\n', 4);
  expect(closingIdx).toBeGreaterThan(4);

  const fmBlock = rawMarkdown.slice(4, closingIdx);
  const frontmatter: Record<string, string> = {};
  for (const line of fmBlock.split('\n')) {
    const colonIdx = line.indexOf(':');
    expect(colonIdx).toBeGreaterThan(0);
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();
    frontmatter[key] = val;
  }

  const body = rawMarkdown.slice(closingIdx + 5);
  return { frontmatter, body };
}

function createExportTestHarness(batchSize = 100) {
  const currentTime = new Date('2026-11-15T12:00:00.000Z');
  const logChunks: string[] = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logChunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  const logger = createLogger({ level: 'info', stream: logStream });
  const authRepo = new InMemoryAuthRepository();
  const entriesRepo = new InMemoryEntriesRepository();
  const exportRepo = new InMemoryExportRepository(() => entriesRepo.entries.values());

  const app = createApp({
    config: testConfig,
    logger,
    authOptions: {
      repo: authRepo,
      now: () => new Date(currentTime),
    },
    entriesRepo,
    exportRepo,
    exportBatchSize: batchSize,
  });

  async function registerUser(email: string, timezone = 'UTC') {
    const reg = await injectRequest(app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        email,
        password: 'correct-horse-battery-staple',
        timezone,
      },
    });
    const parsed = JSON.parse(reg.text) as { csrfToken: string };
    const cookie = extractRawSessionCookie(reg);
    const user = await authRepo.findUserByEmail(email);
    return {
      userId: user!.id,
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
        'X-CSRF-Token': parsed.csrfToken,
      },
    };
  }

  return {
    app,
    authRepo,
    entriesRepo,
    exportRepo,
    registerUser,
    getLogs: () => logChunks.join(''),
  };
}

describe('Brief 7: Markdown Export and Account Data Features', () => {
  it('streams a valid ZIP archive with frontmatter-like text, emoji, very long text, weekly summaries (weekly/2026-W46.md), and README.md that re-imports cleanly into Obsidian', async () => {
    const h = createExportTestHarness(2);
    const alice = await h.registerUser('alice@example.com', 'UTC');
    const bob = await h.registerUser('bob@example.com', 'UTC');

    // 1. Entry containing YAML frontmatter-like text (`---` at the start and middle)
    const frontmatterLikeContent = [
      '---',
      'fake_frontmatter: true',
      'title: "Tricky: Entry --- with colons & quotes"',
      '---',
      '',
      'Actual journal paragraph after fake frontmatter block.',
    ].join('\n');

    // 2. Entry containing emoji, CJK, RTL scripts, and special characters
    const emojiContent =
      'Morning coffee ☕️🌅! Writing with emoji 🚀✨, 日本語, العربية, and special chars: `~@#$%^&*()[]{}|;:\'",.<>?/\\';

    // 3. Very long entry (~50,000 characters)
    const veryLongContent = 'Stream of consciousness morning writing word. '.repeat(1100).trim();

    for (const [date, text] of [
      ['2026-11-10', frontmatterLikeContent],
      ['2026-11-11', emojiContent],
      ['2026-11-12', veryLongContent],
    ] as const) {
      const putRes = await injectRequest(h.app, {
        method: 'PUT',
        url: `/api/entries/${date}`,
        headers: alice.headers,
        body: { content: text },
      });
      expect(putRes.status).toBe(200);
    }

    // Add an entry for Bob to verify owner-only isolation in export
    await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-11-10',
      headers: bob.headers,
      body: { content: 'Bob secret entry that must never appear in Alice export' },
    });

    // Add a completed weekly summary for Alice (Monday 2026-11-09 .. Sunday 2026-11-15 -> ISO week 2026-W46)
    const sumEnc = encrypt(
      'Your week focused on steady reflection and creative clarity.',
      testConfig.keyring,
      {
        associatedData: buildSummaryAad(alice.userId, '2026-11-09', 'summary'),
      },
    );
    const thmEnc = encrypt(JSON.stringify(['clarity', 'morning routine']), testConfig.keyring, {
      associatedData: buildSummaryAad(alice.userId, '2026-11-09', 'themes'),
    });
    h.exportRepo.addSummary({
      userId: alice.userId,
      weekStart: '2026-11-09',
      weekEnd: '2026-11-15',
      status: 'done',
      summaryEnc: sumEnc.ciphertext,
      themesEnc: thmEnc.ciphertext,
      keyVersion: sumEnc.keyVersion,
      createdAt: new Date('2026-11-15T18:00:00.000Z'),
      deliveredAt: new Date('2026-11-15T18:00:05.000Z'),
    });

    const zipRes = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/export?format=zip',
      headers: alice.headers,
    });

    expect(zipRes.status).toBe(200);
    expect(zipRes.headers['content-type']).toBe('application/zip');
    expect(String(zipRes.headers['content-disposition'])).toContain(
      'attachment; filename="morning-pages-export-2026-11-15.zip"',
    );

    const zipEntries = parseZipBuffer(zipRes.bodyBuffer);
    const fileMap = new Map(zipEntries.map((e) => [e.filename, e.content]));

    expect(fileMap.has('README.md')).toBe(true);
    expect(fileMap.has('2026-11-10.md')).toBe(true);
    expect(fileMap.has('2026-11-11.md')).toBe(true);
    expect(fileMap.has('2026-11-12.md')).toBe(true);
    expect(fileMap.has('weekly/2026-W46.md')).toBe(true);

    // Re-import every exported Markdown file through the Obsidian frontmatter parser
    const parsedNov10 = parseObsidianMarkdownFile(fileMap.get('2026-11-10.md')!);
    expect(parsedNov10.frontmatter.date).toBe('2026-11-10');
    expect(parsedNov10.frontmatter.words).toBe(String(countWords(frontmatterLikeContent)));
    expect(parsedNov10.body.trim()).toBe(frontmatterLikeContent);

    const parsedNov11 = parseObsidianMarkdownFile(fileMap.get('2026-11-11.md')!);
    expect(parsedNov11.frontmatter.date).toBe('2026-11-11');
    expect(parsedNov11.body.trim()).toBe(emojiContent);

    const parsedNov12 = parseObsidianMarkdownFile(fileMap.get('2026-11-12.md')!);
    expect(parsedNov12.frontmatter.date).toBe('2026-11-12');
    expect(parsedNov12.body.trim()).toBe(veryLongContent);

    const parsedSummary = parseObsidianMarkdownFile(fileMap.get('weekly/2026-W46.md')!);
    expect(parsedSummary.frontmatter.week).toBe('"2026-W46"');
    expect(parsedSummary.frontmatter.week_start).toBe('2026-11-09');
    expect(parsedSummary.body.trim()).toBe(
      'Your week focused on steady reflection and creative clarity.',
    );

    // Verify Bob's entry is completely absent
    for (const content of fileMap.values()) {
      expect(content).not.toContain('Bob secret entry');
    }

    // Verify audit log recorded metadata only (userId, format, counts) and zero plaintext content
    const logs = h.getLogs();
    expect(logs).toContain('"audit":"account_export"');
    expect(logs).toContain('"entryCount":3');
    expect(logs).toContain('"summaryCount":1');
    expect(logs).not.toContain('Actual journal paragraph');
    expect(logs).not.toContain('Morning coffee');
    expect(logs).not.toContain('creative clarity');
  });

  it('exports format=md as a single combined Markdown file ordered chronologically by date', async () => {
    const h = createExportTestHarness(2);
    const user = await h.registerUser('combined@example.com', 'UTC');

    await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-11-14',
      headers: user.headers,
      body: { content: 'Second entry chronologically.' },
    });
    await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-11-10',
      headers: user.headers,
      body: { content: 'First entry chronologically.' },
    });

    const mdRes = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/export?format=md',
      headers: user.headers,
    });

    expect(mdRes.status).toBe(200);
    expect(String(mdRes.headers['content-type'])).toContain('text/markdown');
    expect(String(mdRes.headers['content-disposition'])).toContain(
      'attachment; filename="morning-pages-export-2026-11-15.md"',
    );

    const firstIdx = mdRes.text.indexOf('## 2026-11-10');
    const secondIdx = mdRes.text.indexOf('## 2026-11-14');
    expect(firstIdx).toBeGreaterThan(-1);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(mdRes.text).toContain('First entry chronologically.');
    expect(mdRes.text).toContain('Second entry chronologically.');
  });

  it('streams and decrypts thousands of entries (2,000 entries = ~5.5 years) in batches with bounded memory', async () => {
    const h = createExportTestHarness(100);
    const user = await h.registerUser('years@example.com', 'UTC');

    const totalEntries = 2000;
    const startDate = '2020-01-01';

    // Directly populate 2,000 encrypted entries into the repository
    const fixedTime = new Date('2026-11-15T12:00:00.000Z');
    for (let i = 0; i < totalEntries; i++) {
      const entryDate = addDaysToLocalDate(startDate, i);
      const plaintext = `Day ${i + 1} journal entry (${entryDate}): writing three pages of morning thoughts to clear the mind.`;
      const aad = buildEntryAad(user.userId, entryDate);
      const encrypted = encrypt(plaintext, testConfig.keyring, { associatedData: aad });

      const id = BigInt(i + 1);
      h.entriesRepo.entries.set(id, {
        id,
        userId: user.userId,
        entryDate,
        contentEnc: encrypted.ciphertext,
        keyVersion: encrypted.keyVersion,
        wordCount: countWords(plaintext),
        createdAt: fixedTime,
        updatedAt: fixedTime,
      });
    }

    const heapBefore = process.memoryUsage().heapUsed;

    const zipRes = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/export?format=zip',
      headers: user.headers,
    });

    const heapAfter = process.memoryUsage().heapUsed;
    const heapDeltaMb = (heapAfter - heapBefore) / (1024 * 1024);

    expect(zipRes.status).toBe(200);
    // Memory stays bounded well under 64 MB while streaming 2,000 decrypted entries
    expect(heapDeltaMb).toBeLessThan(64);

    const parsedZip = parseZipBuffer(zipRes.bodyBuffer);
    // 2,000 entry files + 1 README.md = 2,001 files in the streamed ZIP
    expect(parsedZip.length).toBe(totalEntries + 1);
  });

  it('enforces authentication and rate limits exports per user (429 RATE_LIMITED after exceeding hourly allowance)', async () => {
    const h = createExportTestHarness();
    const user = await h.registerUser('ratelimit@example.com', 'UTC');

    // Unauthenticated request rejected with 401
    const unauthRes = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/export?format=zip',
    });
    expect(unauthRes.status).toBe(401);

    // 5 exports within the hour succeed
    for (let i = 0; i < 5; i++) {
      const okRes = await injectRequest(h.app, {
        method: 'GET',
        url: '/api/export?format=md',
        headers: user.headers,
      });
      expect(okRes.status).toBe(200);
    }

    // 6th export within the hour is rate-limited with 429
    const limitedRes = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/export?format=md',
      headers: user.headers,
    });
    expect(limitedRes.status).toBe(429);
    const errBody = JSON.parse(limitedRes.text) as { error: { code: string } };
    expect(errBody.error.code).toBe('RATE_LIMITED');
  });
});
