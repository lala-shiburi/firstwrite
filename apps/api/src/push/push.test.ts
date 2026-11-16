import { Duplex, Writable } from 'node:stream';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Express } from 'express';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { InMemoryAuthRepository, SESSION_COOKIE_NAME } from '../auth/index.js';
import { loadConfig } from '../config.js';
import { InMemoryEntriesRepository } from '../entries/index.js';
import { createLogger } from '../logger.js';
import {
  GENERIC_REMINDER_MESSAGES,
  InMemoryPushRepository,
  InMemoryReminderJobQueue,
  runReminderSchedulerTick,
  type WebPushClient,
} from './index.js';

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

function createPushTestHarness(initialIsoTime = '2026-11-15T05:00:00.000Z') {
  let currentTime = new Date(initialIsoTime);
  const logStream = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  const logger = createLogger({ level: 'info', stream: logStream });
  const authRepo = new InMemoryAuthRepository();
  const entriesRepo = new InMemoryEntriesRepository();
  const pushRepo = new InMemoryPushRepository({
    getUsersAndSettings() {
      const list = [];
      for (const user of authRepo.users.values()) {
        const s = authRepo.settings.get(user.id);
        list.push({
          userId: user.id,
          timezone: user.timezone,
          deletedAt: user.deletedAt,
          reminderEnabled: s?.reminderEnabled ?? false,
          reminderTime: s?.reminderTime ?? '07:00',
        });
      }
      return list;
    },
    getEntryWordCount(userId, localDate) {
      for (const entry of entriesRepo.entries.values()) {
        if (entry.userId === userId && entry.entryDate === localDate) {
          return entry.wordCount;
        }
      }
      return null;
    },
  });

  const queue = new InMemoryReminderJobQueue();

  const deliveredNotifications: Array<{
    endpoint: string;
    payload: { title: string; body: string; url: string; tag: string };
  }> = [];

  const endpointFailures = new Map<string, { statusCode: number; remainingFailures: number }>();

  const pushClient: WebPushClient = {
    async sendNotification(subscription, rawPayload) {
      const failureRule = endpointFailures.get(subscription.endpoint);
      if (failureRule && failureRule.remainingFailures > 0) {
        failureRule.remainingFailures -= 1;
        const err = new Error(`Push failure ${failureRule.statusCode}`) as Error & {
          statusCode: number;
        };
        err.statusCode = failureRule.statusCode;
        throw err;
      }

      deliveredNotifications.push({
        endpoint: subscription.endpoint,
        payload: JSON.parse(rawPayload) as {
          title: string;
          body: string;
          url: string;
          tag: string;
        },
      });
    },
  };

  const app = createApp({
    config: testConfig,
    logger,
    authOptions: {
      repo: authRepo,
      now: () => new Date(currentTime),
    },
    entriesRepo,
    pushRepo,
  });

  async function createUserWithReminder(params: {
    email: string;
    timezone: string;
    reminderTime: string;
    endpoints?: string[];
  }) {
    const reg = await injectRequest(app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        email: params.email,
        password: 'correct-horse-battery-staple',
        timezone: params.timezone,
      },
    });
    const cookie = extractRawSessionCookie(reg);
    const csrf = String(reg.body.csrfToken);
    const headers = {
      Cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
      'X-CSRF-Token': csrf,
    };

    const setRes = await injectRequest(app, {
      method: 'PUT',
      url: '/api/settings',
      headers,
      body: {
        reminderEnabled: true,
        reminderTime: params.reminderTime,
      },
    });
    expect(setRes.status).toBe(200);

    for (const endpoint of params.endpoints ?? ['https://push.example.com/sub/' + params.email]) {
      const subRes = await injectRequest(app, {
        method: 'POST',
        url: '/api/push/subscribe',
        headers,
        body: {
          endpoint,
          keys: {
            p256dh:
              'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM',
            auth: 'tBHItJI5svbpez7KI4CCXg',
          },
        },
      });
      expect(subRes.status).toBe(201);
    }

    const userRecord = await authRepo.findUserByEmail(params.email);
    return {
      userId: userRecord!.id,
      headers,
    };
  }

  return {
    app,
    authRepo,
    entriesRepo,
    pushRepo,
    queue,
    pushClient,
    deliveredNotifications,
    endpointFailures,
    createUserWithReminder,
    setClock: (isoTime: string) => {
      currentTime = new Date(isoTime);
    },
    getClock: () => new Date(currentTime),
  };
}

describe('Brief 6: Daily Reminders and Push Notifications', () => {
  it('supports multiple device subscriptions per user and allows unsubscribing a device', async () => {
    const h = createPushTestHarness('2026-11-15T06:00:00.000Z');
    const user = await h.createUserWithReminder({
      email: 'devices@example.com',
      timezone: 'UTC',
      reminderTime: '07:00',
      endpoints: [
        'https://push.example.com/device-phone',
        'https://push.example.com/device-laptop',
      ],
    });

    const listRes = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/push/subscriptions',
      headers: user.headers,
    });
    expect(listRes.status).toBe(200);
    expect((listRes.body.subscriptions as unknown[]).length).toBe(2);

    // Unsubscribe phone endpoint
    const unsubRes = await injectRequest(h.app, {
      method: 'DELETE',
      url: '/api/push/subscribe',
      headers: user.headers,
      body: {
        endpoint: 'https://push.example.com/device-phone',
      },
    });
    expect(unsubRes.status).toBe(200);

    const listAfter = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/push/subscriptions',
      headers: user.headers,
    });
    expect((listAfter.body.subscriptions as unknown[]).length).toBe(1);
  });

  it('fires reminders at the exact local time across 3+ timezones including a half-hour offset (Asia/Kolkata) and across a DST transition (America/New_York)', async () => {
    const h = createPushTestHarness('2026-03-07T00:00:00.000Z');

    // 1. Africa/Johannesburg (UTC+2, no DST): 07:00 local = 05:00 UTC
    await h.createUserWithReminder({
      email: 'joburg@example.com',
      timezone: 'Africa/Johannesburg',
      reminderTime: '07:00',
      endpoints: ['https://push.example.com/joburg'],
    });

    // 2. Asia/Kolkata (UTC+05:30 half-hour offset): 07:00 local = 01:30 UTC
    await h.createUserWithReminder({
      email: 'kolkata@example.com',
      timezone: 'Asia/Kolkata',
      reminderTime: '07:00',
      endpoints: ['https://push.example.com/kolkata'],
    });

    // 3. America/New_York (DST change on Sunday 2026-03-08):
    //    - On Saturday 2026-03-07 (EST, UTC-5): 07:00 local = 12:00 UTC
    //    - On Monday   2026-03-09 (EDT, UTC-4): 07:00 local = 11:00 UTC
    await h.createUserWithReminder({
      email: 'newyork@example.com',
      timezone: 'America/New_York',
      reminderTime: '07:00',
      endpoints: ['https://push.example.com/newyork'],
    });

    // Tick A: 2026-03-07T01:30:00Z -> 07:00 in Asia/Kolkata (half-hour offset)
    h.setClock('2026-03-07T01:30:00.000Z');
    const tickKolkata = await runReminderSchedulerTick({
      now: h.getClock(),
      repo: h.pushRepo,
      queue: h.queue,
      batchSize: 1, // Exercise batch pagination across multiple users
      hasAlreadyBeenReminded: (uid, date) => h.queue.hasBeenReminded(uid, date),
    });
    // Scheduler enqueues the send job and does NOT send inline
    expect(tickKolkata.jobsEnqueued).toBe(1);
    expect(h.deliveredNotifications.length).toBe(0);

    await h.queue.drainSendJobs({
      repo: h.pushRepo,
      pushClient: h.pushClient,
      retryOptions: { sleep: async () => {} },
    });
    expect(h.deliveredNotifications.length).toBe(1);
    expect(h.deliveredNotifications[0]?.endpoint).toBe('https://push.example.com/kolkata');

    // Tick B: 2026-03-07T05:00:00Z -> 07:00 in Africa/Johannesburg
    h.setClock('2026-03-07T05:00:00.000Z');
    const tickJoburg = await runReminderSchedulerTick({
      now: h.getClock(),
      repo: h.pushRepo,
      queue: h.queue,
      hasAlreadyBeenReminded: (uid, date) => h.queue.hasBeenReminded(uid, date),
    });
    expect(tickJoburg.jobsEnqueued).toBe(1);
    await h.queue.drainSendJobs({
      repo: h.pushRepo,
      pushClient: h.pushClient,
      retryOptions: { sleep: async () => {} },
    });
    expect(h.deliveredNotifications.length).toBe(2);
    expect(h.deliveredNotifications[1]?.endpoint).toBe('https://push.example.com/joburg');

    // Tick C (Before US DST spring-forward): Saturday 2026-03-07T12:00:00Z -> 07:00 EST in New York
    h.setClock('2026-03-07T12:00:00.000Z');
    const tickNyBeforeDst = await runReminderSchedulerTick({
      now: h.getClock(),
      repo: h.pushRepo,
      queue: h.queue,
      hasAlreadyBeenReminded: (uid, date) => h.queue.hasBeenReminded(uid, date),
    });
    expect(tickNyBeforeDst.jobsEnqueued).toBe(1);
    await h.queue.drainSendJobs({
      repo: h.pushRepo,
      pushClient: h.pushClient,
      retryOptions: { sleep: async () => {} },
    });
    expect(h.deliveredNotifications.length).toBe(3);
    expect(h.deliveredNotifications[2]?.endpoint).toBe('https://push.example.com/newyork');

    // Tick D (After US DST spring-forward): Monday 2026-03-09
    // At 11:00 UTC (which is now 07:00 EDT in New York!), New York fires; at 12:00 UTC (08:00 EDT) it does NOT fire.
    h.setClock('2026-03-09T11:00:00.000Z');
    const tickNyAfterDst = await runReminderSchedulerTick({
      now: h.getClock(),
      repo: h.pushRepo,
      queue: h.queue,
      hasAlreadyBeenReminded: (uid, date) => h.queue.hasBeenReminded(uid, date),
    });
    expect(tickNyAfterDst.jobsEnqueued).toBe(1);
    await h.queue.drainSendJobs({
      repo: h.pushRepo,
      pushClient: h.pushClient,
      retryOptions: { sleep: async () => {} },
    });
    expect(h.deliveredNotifications.length).toBe(4);
    expect(h.deliveredNotifications[3]?.endpoint).toBe('https://push.example.com/newyork');

    h.setClock('2026-03-09T12:00:00.000Z');
    const tickNyOldUtcHour = await runReminderSchedulerTick({
      now: h.getClock(),
      repo: h.pushRepo,
      queue: h.queue,
      hasAlreadyBeenReminded: (uid, date) => h.queue.hasBeenReminded(uid, date),
    });
    expect(tickNyOldUtcHour.jobsEnqueued).toBe(0);
  });

  it('does NOT send a reminder if an entry already exists for today (user-local date) and never sends duplicate reminders if the job runs twice in the same minute', async () => {
    const h = createPushTestHarness('2026-11-15T06:50:00.000Z');

    const writer = await h.createUserWithReminder({
      email: 'already-wrote@example.com',
      timezone: 'UTC',
      reminderTime: '07:00',
      endpoints: ['https://push.example.com/already-wrote'],
    });

    await h.createUserWithReminder({
      email: 'has-not-written@example.com',
      timezone: 'UTC',
      reminderTime: '07:00',
      endpoints: ['https://push.example.com/has-not-written'],
    });

    // Writer saves an entry at 06:50 before the 07:00 reminder
    const putEntry = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/entries/2026-11-15',
      headers: writer.headers,
      body: { content: 'Wrote my morning pages early today!' },
    });
    expect(putEntry.status).toBe(200);

    // Advance clock to 07:00 UTC and run the scheduler TWICE in the same minute
    h.setClock('2026-11-15T07:00:10.000Z');
    const firstRun = await runReminderSchedulerTick({
      now: h.getClock(),
      repo: h.pushRepo,
      queue: h.queue,
      hasAlreadyBeenReminded: (uid, date) => h.queue.hasBeenReminded(uid, date),
    });

    h.setClock('2026-11-15T07:00:45.000Z');
    const secondRunSameMinute = await runReminderSchedulerTick({
      now: h.getClock(),
      repo: h.pushRepo,
      queue: h.queue,
      hasAlreadyBeenReminded: (uid, date) => h.queue.hasBeenReminded(uid, date),
    });

    expect(firstRun.jobsEnqueued).toBe(1);
    expect(secondRunSameMinute.jobsEnqueued).toBe(0);

    await h.queue.drainSendJobs({
      repo: h.pushRepo,
      pushClient: h.pushClient,
      retryOptions: { sleep: async () => {} },
    });

    // Even if the scheduler runs a third time after jobs drained in the same minute, no duplicate is sent
    const thirdRunAfterDrain = await runReminderSchedulerTick({
      now: h.getClock(),
      repo: h.pushRepo,
      queue: h.queue,
      hasAlreadyBeenReminded: (uid, date) => h.queue.hasBeenReminded(uid, date),
    });
    expect(thirdRunAfterDrain.jobsEnqueued).toBe(0);

    expect(h.deliveredNotifications.length).toBe(1);
    expect(h.deliveredNotifications[0]?.endpoint).toBe('https://push.example.com/has-not-written');

    // Verify notification payload is strictly generic (matches GENERIC_REMINDER_MESSAGES, opens '/')
    const deliveredPayload = h.deliveredNotifications[0]!.payload;
    expect(deliveredPayload.url).toBe('/');
    expect(
      GENERIC_REMINDER_MESSAGES.some(
        (m) => m.title === deliveredPayload.title && m.body === deliveredPayload.body,
      ),
    ).toBe(true);
    expect(deliveredPayload.body).not.toContain('Wrote my morning pages');
  });

  it('retries transient push failures with exponential backoff and cleans up dead subscriptions returning 404 or 410', async () => {
    const h = createPushTestHarness('2026-11-15T07:00:00.000Z');

    const user = await h.createUserWithReminder({
      email: 'cleanup@example.com',
      timezone: 'UTC',
      reminderTime: '07:00',
      endpoints: [
        'https://push.example.com/dead-410',
        'https://push.example.com/dead-404',
        'https://push.example.com/flaky-then-ok',
      ],
    });

    h.endpointFailures.set('https://push.example.com/dead-410', {
      statusCode: 410,
      remainingFailures: 99,
    });
    h.endpointFailures.set('https://push.example.com/dead-404', {
      statusCode: 404,
      remainingFailures: 99,
    });
    h.endpointFailures.set('https://push.example.com/flaky-then-ok', {
      statusCode: 503,
      remainingFailures: 2, // Fails twice with 503, succeeds on 3rd attempt
    });

    const backoffDelays: number[] = [];
    await runReminderSchedulerTick({
      now: h.getClock(),
      repo: h.pushRepo,
      queue: h.queue,
    });

    const summary = await h.queue.drainSendJobs({
      repo: h.pushRepo,
      pushClient: h.pushClient,
      retryOptions: {
        maxRetries: 3,
        baseBackoffMs: 100,
        sleep: async (ms) => {
          backoffDelays.push(ms);
        },
      },
    });

    expect(summary.notificationsDelivered).toBe(1);
    expect(summary.deadSubscriptionsRemoved).toBe(2);
    expect(backoffDelays).toEqual([100, 200]); // Exponential backoff for the 2 transient 503 failures

    // Dead 404 and 410 subscriptions were deleted from storage; only flaky-then-ok remains
    const remainingSubs = await h.pushRepo.listSubscriptionsForUser(user.userId);
    expect(remainingSubs.length).toBe(1);
    expect(remainingSubs[0]?.endpoint).toBe('https://push.example.com/flaky-then-ok');
  });
});
