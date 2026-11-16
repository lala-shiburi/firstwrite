import { Duplex, Writable } from 'node:stream';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { MAX_ENTRY_CHARACTERS } from '@firstwrite/shared';
import type { Express } from 'express';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { InMemoryAuthRepository, SESSION_COOKIE_NAME } from '../auth/index.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import { InMemoryEntriesRepository } from './index.js';

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
  body: Record<string, unknown>;
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
      const rawText = Buffer.concat(responseChunks).toString('utf8');
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

function extractRawSessionCookie(res: InjectResponse): string {
  const setCookie = res.headers['set-cookie'];
  const headerStr = Array.isArray(setCookie) ? setCookie.join('; ') : String(setCookie ?? '');
  const match = new RegExp(`${SESSION_COOKIE_NAME}=([^;]+)`).exec(headerStr);
  return match?.[1] ? decodeURIComponent(match[1]) : '';
}

function createEntriesTestHarness(initialIsoTime = '2026-11-15T23:30:00.000Z') {
  let currentTime = new Date(initialIsoTime);
  const logChunks: string[] = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logChunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  const logger = createLogger({ level: 'debug', stream: logStream });
  const authRepo = new InMemoryAuthRepository();
  const entriesRepo = new InMemoryEntriesRepository();

  const app = createApp({
    config: testConfig,
    logger,
    authOptions: {
      repo: authRepo,
      now: () => new Date(currentTime),
    },
    entriesRepo,
  });

  async function registerAndLogin(email: string, timezone = 'UTC') {
    const res = await injectRequest(app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        email,
        password: 'correct-horse-battery-staple',
        timezone,
      },
    });
    expect(res.status).toBe(201);
    const cookie = extractRawSessionCookie(res);
    const csrf = String(res.body.csrfToken);
    return {
      cookieHeader: `${SESSION_COOKIE_NAME}=${cookie}`,
      csrfToken: csrf,
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
        'X-CSRF-Token': csrf,
      },
    };
  }

  return {
    app,
    authRepo,
    entriesRepo,
    registerAndLogin,
    getLogs: () => logChunks.join(''),
    advanceTimeMs: (ms: number) => {
      currentTime = new Date(currentTime.getTime() + ms);
    },
  };
}

describe('Brief 4: Entries API', () => {
  it('upserts idempotently, encrypts content at rest with AES-256-GCM, computes word_count, and updates updated_at', async () => {
    const h = createEntriesTestHarness('2026-11-15T08:00:00.000Z');
    const alice = await h.registerAndLogin('alice@example.com', 'UTC');

    const text1 = 'Morning pages first draft with seven words.';
    const put1 = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-11-15',
      headers: alice.headers,
      body: { content: text1 },
    });

    expect(put1.status).toBe(200);
    expect(put1.body.entryDate).toBe('2026-11-15');
    expect(put1.body.content).toBe(text1);
    expect(put1.body.wordCount).toBe(7);
    const createdAt1 = String(put1.body.createdAt);
    const updatedAt1 = String(put1.body.updatedAt);

    // Verify stored row in repository is encrypted (contentEnc != plaintext)
    const rawStored = await h.entriesRepo.findByUserAndDate(1n, '2026-11-15');
    expect(rawStored).not.toBeNull();
    expect(rawStored!.contentEnc).not.toContain('Morning pages');
    expect(rawStored!.wordCount).toBe(7);

    // Advance time and PUT again on the same date -> idempotent upsert (still 1 row for that date)
    h.advanceTimeMs(5000);
    const text2 = 'Morning pages revised draft with nine total words now.';
    const put2 = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-11-15',
      headers: alice.headers,
      body: { content: text2, expectedUpdatedAt: updatedAt1 },
    });

    expect(put2.status).toBe(200);
    expect(put2.body.content).toBe(text2);
    expect(put2.body.wordCount).toBe(9);
    expect(put2.body.createdAt).toBe(createdAt1);
    expect(put2.body.updatedAt).not.toBe(updatedAt1);
    expect(h.entriesRepo.entries.size).toBe(1);

    // Plaintext content never appears in logs
    expect(h.getLogs()).not.toContain('Morning pages first draft');
    expect(h.getLogs()).not.toContain('Morning pages revised draft');
  });

  it('validates date format and rejects dates more than one day in the future relative to the user local timezone', async () => {
    // Server UTC time is 2026-11-15T23:30:00Z.
    // For a user in 'Africa/Johannesburg' (UTC+2), their local date is already 2026-11-16!
    // For a user in 'America/New_York' (UTC-5), their local date is still 2026-11-15.
    const h = createEntriesTestHarness('2026-11-15T23:30:00.000Z');
    const joburgUser = await h.registerAndLogin('joburg@example.com', 'Africa/Johannesburg');
    const nyUser = await h.registerAndLogin('ny@example.com', 'America/New_York');

    // 1. Invalid calendar date (e.g. Feb 30 or malformed format) -> 400 VALIDATION_ERROR
    const invalidCalendarRes = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-02-30',
      headers: joburgUser.headers,
      body: { content: 'Invalid calendar day' },
    });
    expect(invalidCalendarRes.status).toBe(400);

    // 2. Johannesburg user's local today is 2026-11-16, so 2026-11-17 (+1 day) is allowed,
    //    while 2026-11-18 (+2 days) is rejected.
    const joburgPlus1 = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-11-17',
      headers: joburgUser.headers,
      body: { content: 'Allowed +1 day in Joburg' },
    });
    expect(joburgPlus1.status).toBe(200);

    const joburgPlus2 = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-11-18',
      headers: joburgUser.headers,
      body: { content: 'Too far in future for Joburg' },
    });
    expect(joburgPlus2.status).toBe(400);
    expect((joburgPlus2.body.error as { code: string }).code).toBe('FUTURE_DATE_NOT_ALLOWED');

    // 3. New York user's local today is 2026-11-15, so 2026-11-17 (+2 days for NY!) is rejected
    const nyPlus2 = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-11-17',
      headers: nyUser.headers,
      body: { content: 'Too far in future for New York' },
    });
    expect(nyPlus2.status).toBe(400);
    expect((nyPlus2.body.error as { code: string }).code).toBe('FUTURE_DATE_NOT_ALLOWED');
  });

  it('enforces owner-only access (a user cannot read, overwrite, or delete another user entry by guessing dates)', async () => {
    const h = createEntriesTestHarness('2026-11-15T09:00:00.000Z');
    const alice = await h.registerAndLogin('alice@example.com', 'UTC');
    const bob = await h.registerAndLogin('bob@example.com', 'UTC');

    await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-11-15',
      headers: alice.headers,
      body: { content: 'Alice private morning thoughts' },
    });

    // Bob requesting 2026-11-15 gets 404 ENTRY_NOT_FOUND
    const bobGet = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/entries/2026-11-15',
      headers: bob.headers,
    });
    expect(bobGet.status).toBe(404);

    // Bob listing entries sees 0 entries
    const bobList = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/entries?from=2026-11-01&to=2026-11-30',
      headers: bob.headers,
    });
    expect(bobList.status).toBe(200);
    expect((bobList.body.entries as unknown[]).length).toBe(0);

    // Bob attempting to delete 2026-11-15 gets 404 and Alice's entry remains intact
    const bobDelete = await injectRequest(h.app, {
      method: 'DELETE',
      url: '/api/entries/2026-11-15',
      headers: bob.headers,
    });
    expect(bobDelete.status).toBe(404);

    // Alice still reads her decrypted entry
    const aliceGet = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/entries/2026-11-15',
      headers: alice.headers,
    });
    expect(aliceGet.status).toBe(200);
    expect(aliceGet.body.content).toBe('Alice private morning thoughts');

    // Alice list endpoint returns metadata only (no plaintext content field)
    const aliceList = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/entries?from=2026-11-01&to=2026-11-30',
      headers: alice.headers,
    });
    expect(aliceList.status).toBe(200);
    const items = aliceList.body.entries as Array<Record<string, unknown>>;
    expect(items.length).toBe(1);
    expect(items[0]?.entryDate).toBe('2026-11-15');
    expect(items[0]?.wordCount).toBe(4);
    expect(items[0]?.content).toBeUndefined();
  });

  it('guards against lost updates between two simulated devices using updated_at optimistic locking and returns the server version on conflict', async () => {
    const h = createEntriesTestHarness('2026-11-15T10:00:00.000Z');
    const user = await h.registerAndLogin('multidevice@example.com', 'UTC');

    // Device A creates initial entry
    const initialSave = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-11-15',
      headers: user.headers,
      body: {
        content: 'Paragraph 1 from Device A.',
        expectedUpdatedAt: null,
      },
    });
    expect(initialSave.status).toBe(200);
    const version1UpdatedAt = String(initialSave.body.updatedAt);

    // Device B loads the entry (sees version1UpdatedAt)
    const deviceBLoad = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/entries/2026-11-15',
      headers: user.headers,
    });
    expect(deviceBLoad.status).toBe(200);
    expect(deviceBLoad.body.updatedAt).toBe(version1UpdatedAt);

    // Device A saves a new revision 10 seconds later
    h.advanceTimeMs(10_000);
    const deviceASave2 = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-11-15',
      headers: user.headers,
      body: {
        content: 'Paragraph 1 from Device A.\nParagraph 2 added on Device A.',
        expectedUpdatedAt: version1UpdatedAt,
      },
    });
    expect(deviceASave2.status).toBe(200);
    const version2UpdatedAt = String(deviceASave2.body.updatedAt);

    // Device B (still holding stale version1UpdatedAt) tries to save its own edits -> 409 ENTRY_CONFLICT
    h.advanceTimeMs(5_000);
    const deviceBConflict = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-11-15',
      headers: user.headers,
      body: {
        content: 'Paragraph 1 from Device A.\nParagraph 2 added on Device B.',
        expectedUpdatedAt: version1UpdatedAt,
      },
    });

    expect(deviceBConflict.status).toBe(409);
    const errorObj = deviceBConflict.body.error as {
      code: string;
      details: { serverEntry: { content: string; updatedAt: string } };
    };
    expect(errorObj.code).toBe('ENTRY_CONFLICT');
    expect(errorObj.details.serverEntry.content).toBe(
      'Paragraph 1 from Device A.\nParagraph 2 added on Device A.',
    );
    expect(errorObj.details.serverEntry.updatedAt).toBe(version2UpdatedAt);

    // Verify Device A's writing was NOT overwritten in the database
    const verifyGet = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/entries/2026-11-15',
      headers: user.headers,
    });
    expect(verifyGet.body.content).toBe(
      'Paragraph 1 from Device A.\nParagraph 2 added on Device A.',
    );

    // Device B merges both versions and saves with version2UpdatedAt -> 200 OK
    const mergedContent =
      'Paragraph 1 from Device A.\nParagraph 2 added on Device A.\nParagraph 2 added on Device B.';
    const deviceBMergedSave = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-11-15',
      headers: user.headers,
      body: {
        content: mergedContent,
        expectedUpdatedAt: version2UpdatedAt,
      },
    });
    expect(deviceBMergedSave.status).toBe(200);
    expect(deviceBMergedSave.body.content).toBe(mergedContent);
  });

  it('enforces the generous maximum entry size and returns a clear 413 ENTRY_TOO_LARGE error beyond it', async () => {
    const h = createEntriesTestHarness('2026-11-15T10:00:00.000Z');
    const user = await h.registerAndLogin('maxsize@example.com', 'UTC');

    const oversized = 'a'.repeat(MAX_ENTRY_CHARACTERS + 1);
    const res = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-11-15',
      headers: user.headers,
      body: { content: oversized },
    });

    expect(res.status).toBe(413);
    expect((res.body.error as { code: string }).code).toBe('ENTRY_TOO_LARGE');
  });
});
