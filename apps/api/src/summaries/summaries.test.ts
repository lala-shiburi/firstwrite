import { Duplex, Writable } from 'node:stream';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Express } from 'express';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import {
  ConsoleEmailProvider,
  InMemoryAuthRepository,
  SESSION_COOKIE_NAME,
} from '../auth/index.js';
import { loadConfig, type AppConfig } from '../config.js';
import { InMemoryEntriesRepository } from '../entries/index.js';
import { createLogger } from '../logger.js';
import { InMemoryPushRepository, type WebPushClient } from '../push/index.js';
import {
  InMemorySummariesRepository,
  InMemoryWeeklySummaryJobQueue,
  runWeeklySummarySchedulerTick,
  type LlmProvider,
  type LlmProviderRequest,
  type LlmProviderResponse,
} from './index.js';

const baseTestConfig = loadConfig({
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
  LLM_MODEL: 'claude-haiku-5-5',
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

function createSummariesHarness(configOverrides: Partial<AppConfig> = {}) {
  // Sunday 2026-11-15T18:05:00Z
  const currentTime = new Date('2026-11-15T18:05:00.000Z');
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
  const emailProvider = new ConsoleEmailProvider();
  const pushRepo = new InMemoryPushRepository();

  const summariesRepo = new InMemorySummariesRepository({
    getUsersAndSettings() {
      const list = [];
      for (const user of authRepo.users.values()) {
        const s = authRepo.settings.get(user.id);
        list.push({
          userId: user.id,
          email: user.email,
          timezone: user.timezone,
          deletedAt: user.deletedAt,
          aiConsentAt: user.aiConsentAt,
          weeklySummaryEnabled: s?.weeklySummaryEnabled ?? false,
          summaryDeliveryTime: s?.summaryDeliveryTime ?? '18:00',
        });
      }
      return list;
    },
    getEntries: () => entriesRepo.entries.values(),
  });

  const queue = new InMemoryWeeklySummaryJobQueue();
  const outboundLlmRequests: LlmProviderRequest[] = [];
  const outboundPushPayloads: Array<{ endpoint: string; payload: string }> = [];

  let llmBehavior: (req: LlmProviderRequest, callIndex: number) => LlmProviderResponse = (req) => ({
    rawText: JSON.stringify({
      summary_md:
        'You wrote thoughtfully about morning routines and creative momentum. What would make next week feel steady?',
      themes: ['momentum', 'morning routine'],
      distress_flag: false,
    }),
    model: req.model,
    inputTokens: 450,
    outputTokens: 120,
  });

  const mockLlmProvider: LlmProvider = {
    name: 'mock-anthropic',
    async generateWeeklySummary(request) {
      const idx = outboundLlmRequests.length;
      outboundLlmRequests.push(request);
      return llmBehavior(request, idx);
    },
  };

  const pushClient: WebPushClient = {
    async sendNotification(subscription, payload) {
      outboundPushPayloads.push({ endpoint: subscription.endpoint, payload });
    },
  };

  const config: AppConfig = { ...baseTestConfig, ...configOverrides };
  const app = createApp({
    config,
    logger,
    authOptions: {
      repo: authRepo,
      emailProvider,
      now: () => new Date(currentTime),
    },
    entriesRepo,
    pushRepo,
    summariesRepo,
  });

  async function createVerifiedUser(params: {
    email: string;
    timezone?: string;
    consentAndEnable?: boolean;
    deliveryTime?: string;
    entries?: Array<{ date: string; content: string }>;
  }) {
    const reg = await injectRequest(app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        email: params.email,
        password: 'correct-horse-battery-staple',
        timezone: params.timezone ?? 'UTC',
      },
    });
    const cookie = extractRawSessionCookie(reg);
    const csrf = String(reg.body.csrfToken);
    const headers = {
      Cookie: `${SESSION_COOKIE_NAME}=${cookie}`,
      'X-CSRF-Token': csrf,
    };

    const userRecord = await authRepo.findUserByEmail(params.email);
    await authRepo.updateUserVerified(userRecord!.id, currentTime);

    if (params.consentAndEnable) {
      const putSettings = await injectRequest(app, {
        method: 'PUT',
        url: '/api/settings',
        headers,
        body: {
          aiConsent: true,
          weeklySummaryEnabled: true,
          summaryDeliveryTime: params.deliveryTime ?? '18:00',
        },
      });
      expect(putSettings.status).toBe(200);
    }

    await injectRequest(app, {
      method: 'POST',
      url: '/api/push/subscribe',
      headers,
      body: {
        endpoint: `https://push.example.com/sub/${params.email}`,
        keys: { p256dh: 'p256dh-key', auth: 'auth-key' },
      },
    });

    for (const entry of params.entries ?? []) {
      const putEntry = await injectRequest(app, {
        method: 'PUT',
        url: `/api/entries/${entry.date}`,
        headers,
        body: { content: entry.content },
      });
      expect(putEntry.status).toBe(200);
    }

    // Clear initial registration email so tests can inspect summary-ready emails cleanly
    emailProvider.sentMessages.length = 0;

    return {
      userId: userRecord!.id,
      headers,
    };
  }

  return {
    app,
    config,
    logger,
    authRepo,
    entriesRepo,
    summariesRepo,
    pushRepo,
    emailProvider,
    queue,
    mockLlmProvider,
    pushClient,
    outboundLlmRequests,
    outboundPushPayloads,
    createVerifiedUser,
    setLlmBehavior: (fn: (req: LlmProviderRequest, callIndex: number) => LlmProviderResponse) => {
      llmBehavior = fn;
    },
    getLogs: () => logChunks.join(''),
    getClock: () => new Date(currentTime),
  };
}

describe('Brief 8: Weekly Summary Pipeline', () => {
  it('guarantees idempotency (running the scheduler twice yields one summary) and never sends entries for users without explicit consent', async () => {
    const h = createSummariesHarness();

    // User 1: Consented and enabled, with 3 entries in week 2026-11-09..2026-11-15
    const consentingUser = await h.createVerifiedUser({
      email: 'consented@example.com',
      consentAndEnable: true,
      entries: [
        { date: '2026-11-09', content: 'Monday entry for consenting user.' },
        { date: '2026-11-11', content: 'Wednesday entry for consenting user.' },
        { date: '2026-11-14', content: 'Saturday entry for consenting user.' },
      ],
    });

    // User 2: Has NOT consented (`ai_consent_at` is null, `weekly_summary_enabled` is false)
    await h.createVerifiedUser({
      email: 'no-consent@example.com',
      consentAndEnable: false,
      entries: [
        { date: '2026-11-10', content: 'PRIVATE_UNCONSENTED_TEXT_NEVER_SEND_TO_LLM_9981' },
        { date: '2026-11-12', content: 'ANOTHER_UNCONSENTED_ENTRY_8872' },
      ],
    });

    // Run hourly scheduler TWICE on Sunday at 18:05 UTC
    const tick1 = await runWeeklySummarySchedulerTick({
      now: h.getClock(),
      repo: h.summariesRepo,
      queue: h.queue,
    });
    const tick2 = await runWeeklySummarySchedulerTick({
      now: h.getClock(),
      repo: h.summariesRepo,
      queue: h.queue,
    });

    expect(tick1.pendingInserted).toBe(1);
    expect(tick1.jobsEnqueued).toBe(1);
    expect(tick2.pendingInserted).toBe(0);
    expect(tick2.jobsEnqueued).toBe(0);

    // Drain worker queue
    const drainRes = await h.queue.drainSummaryJobs({
      config: h.config,
      summariesRepo: h.summariesRepo,
      llmProvider: h.mockLlmProvider,
      pushRepo: h.pushRepo,
      pushClient: h.pushClient,
      emailProvider: h.emailProvider,
      logger: h.logger,
    });

    expect(drainRes.done).toBe(1);
    expect(h.outboundLlmRequests.length).toBe(1);

    // Non-consenting user's entries were NEVER sent to the LLM provider
    const llmPromptSent = h.outboundLlmRequests[0]!.userPrompt;
    expect(llmPromptSent).toContain('Monday entry for consenting user.');
    expect(llmPromptSent).not.toContain('PRIVATE_UNCONSENTED_TEXT_NEVER_SEND_TO_LLM_9981');

    // Verify GET /api/summaries and DELETE /api/summaries/:weekStart for the owner
    const listRes = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/summaries',
      headers: consentingUser.headers,
    });
    expect(listRes.status).toBe(200);
    const summaries = listRes.body.summaries as Array<Record<string, unknown>>;
    expect(summaries.length).toBe(1);
    expect(summaries[0]?.weekStart).toBe('2026-11-09');
    expect(summaries[0]?.status).toBe('done');
    expect(summaries[0]?.summaryMd).toContain('You wrote thoughtfully');
  });

  it('skips generation with status "skipped" and reason "too_few_entries" when fewer than 2 entries exist for the week', async () => {
    const h = createSummariesHarness();

    const quietUser = await h.createVerifiedUser({
      email: 'quiet@example.com',
      consentAndEnable: true,
      entries: [{ date: '2026-11-10', content: 'Only one entry written this week.' }],
    });

    await runWeeklySummarySchedulerTick({
      now: h.getClock(),
      repo: h.summariesRepo,
      queue: h.queue,
    });

    const drainRes = await h.queue.drainSummaryJobs({
      config: h.config,
      summariesRepo: h.summariesRepo,
      llmProvider: h.mockLlmProvider,
      logger: h.logger,
    });

    expect(drainRes.skipped).toBe(1);
    expect(h.outboundLlmRequests.length).toBe(0);

    const stored = await h.summariesRepo.findSummaryByUserAndWeek(quietUser.userId, '2026-11-09');
    expect(stored?.status).toBe('skipped');
    expect(stored?.skipReason).toBe('too_few_entries');
  });

  it('retries once when the model returns malformed output and marks status "failed" if the retry is also invalid', async () => {
    const h = createSummariesHarness();

    const user1 = await h.createVerifiedUser({
      email: 'retry-succeeds@example.com',
      consentAndEnable: true,
      entries: [
        { date: '2026-11-09', content: 'Day one.' },
        { date: '2026-11-10', content: 'Day two.' },
      ],
    });

    // First call returns invalid JSON, second call (retry) returns valid JSON -> status 'done'
    h.setLlmBehavior((req, callIdx) => {
      if (callIdx === 0) {
        return {
          rawText: 'Not valid JSON at all!',
          model: req.model,
          inputTokens: 100,
          outputTokens: 20,
        };
      }
      return {
        rawText: JSON.stringify({
          summary_md: 'Recovered on retry with valid structured JSON.',
          themes: ['resilience'],
          distress_flag: false,
        }),
        model: req.model,
        inputTokens: 110,
        outputTokens: 30,
      };
    });

    await runWeeklySummarySchedulerTick({
      now: h.getClock(),
      repo: h.summariesRepo,
      queue: h.queue,
    });
    const drain1 = await h.queue.drainSummaryJobs({
      config: h.config,
      summariesRepo: h.summariesRepo,
      llmProvider: h.mockLlmProvider,
      logger: h.logger,
    });
    expect(drain1.done).toBe(1);
    expect(h.outboundLlmRequests.length).toBe(2);
    const row1 = await h.summariesRepo.findSummaryByUserAndWeek(user1.userId, '2026-11-09');
    expect(row1?.status).toBe('done');
    expect(row1?.inputTokens).toBe(210);

    // Now test when BOTH initial call and retry return malformed JSON -> status 'failed'
    const user2 = await h.createVerifiedUser({
      email: 'retry-fails@example.com',
      consentAndEnable: true,
      entries: [
        { date: '2026-11-09', content: 'Day one.' },
        { date: '2026-11-10', content: 'Day two.' },
      ],
    });

    h.outboundLlmRequests.length = 0;
    h.setLlmBehavior((req) => ({
      rawText: '{"broken_schema": true}',
      model: req.model,
      inputTokens: 100,
      outputTokens: 20,
    }));

    await runWeeklySummarySchedulerTick({
      now: h.getClock(),
      repo: h.summariesRepo,
      queue: h.queue,
    });
    const drain2 = await h.queue.drainSummaryJobs({
      config: h.config,
      summariesRepo: h.summariesRepo,
      llmProvider: h.mockLlmProvider,
      logger: h.logger,
    });
    expect(drain2.failed).toBe(1);
    expect(h.outboundLlmRequests.length).toBe(2); // Initial attempt + 1 retry
    const row2 = await h.summariesRepo.findSummaryByUserAndWeek(user2.userId, '2026-11-09');
    expect(row2?.status).toBe('failed');
  });

  it('aborts before the LLM API call if the user withdraws consent mid-run', async () => {
    const h = createSummariesHarness();

    const user = await h.createVerifiedUser({
      email: 'withdraw-midrun@example.com',
      consentAndEnable: true,
      entries: [
        { date: '2026-11-09', content: 'Entry A that must not be sent after withdrawal.' },
        { date: '2026-11-10', content: 'Entry B that must not be sent after withdrawal.' },
      ],
    });

    // Scheduler enqueues the job while user has consent
    const tick = await runWeeklySummarySchedulerTick({
      now: h.getClock(),
      repo: h.summariesRepo,
      queue: h.queue,
    });
    expect(tick.jobsEnqueued).toBe(1);

    // Mid-run (after entries are loaded in the worker, right before the LLM API call), user withdraws consent
    const drainRes = await h.queue.drainSummaryJobs({
      config: h.config,
      summariesRepo: h.summariesRepo,
      llmProvider: h.mockLlmProvider,
      logger: h.logger,
      async onBeforeLlmCall() {
        const res = await injectRequest(h.app, {
          method: 'PUT',
          url: '/api/settings',
          headers: user.headers,
          body: { aiConsent: false },
        });
        expect(res.status).toBe(200);
      },
    });

    expect(drainRes.abortedByConsentWithdrawal).toBe(1);
    expect(h.outboundLlmRequests.length).toBe(0);
    expect(await h.summariesRepo.findSummaryByUserAndWeek(user.userId, '2026-11-09')).toBeNull();
  });

  it('pauses summary generation and alerts the operator when the monthly spend ceiling is reached', async () => {
    // Configure a $1.00 monthly spend ceiling
    const h = createSummariesHarness({ LLM_MONTHLY_SPEND_LIMIT_USD: 1.0 });

    const user1 = await h.createVerifiedUser({
      email: 'user1@example.com',
      consentAndEnable: true,
      entries: [
        { date: '2026-11-09', content: 'User 1 Monday.' },
        { date: '2026-11-10', content: 'User 1 Tuesday.' },
      ],
    });

    await h.createVerifiedUser({
      email: 'user2@example.com',
      consentAndEnable: true,
      entries: [
        { date: '2026-11-09', content: 'User 2 Monday.' },
        { date: '2026-11-10', content: 'User 2 Tuesday.' },
      ],
    });

    // First run uses 1,000,000 input tokens ($1.00) + 100,000 output tokens ($0.50) = $1.50 total (> $1.00 ceiling)
    h.setLlmBehavior((req) => ({
      rawText: JSON.stringify({
        summary_md: 'First user summary completes.',
        themes: ['budget'],
        distress_flag: false,
      }),
      model: req.model,
      inputTokens: 1_000_000,
      outputTokens: 100_000,
    }));

    await runWeeklySummarySchedulerTick({
      now: h.getClock(),
      repo: h.summariesRepo,
      queue: h.queue,
    });
    expect(h.queue.enqueuedJobs.length).toBe(2);

    const operatorAlerts: Array<{ code: string; spentUsd: number; limitUsd: number }> = [];
    const drainRes = await h.queue.drainSummaryJobs({
      config: h.config,
      summariesRepo: h.summariesRepo,
      llmProvider: h.mockLlmProvider,
      logger: h.logger,
      onOperatorAlert: (alert) => operatorAlerts.push(alert),
    });

    // User 1 succeeded; User 2 was paused because the monthly spend ceiling was reached
    expect(drainRes.done).toBe(1);
    expect(drainRes.pausedBySpendCeiling).toBe(1);
    expect(h.outboundLlmRequests.length).toBe(1);
    expect(operatorAlerts.length).toBe(1);
    expect(operatorAlerts[0]?.code).toBe('LLM_SPEND_CEILING_REACHED');
    expect(
      (await h.summariesRepo.findSummaryByUserAndWeek(user1.userId, '2026-11-09'))?.status,
    ).toBe('done');
  });

  it('asserts that the outbound LLM provider request is the ONLY place plaintext entry text leaves the system (never in job payloads, logs, push notifications, emails, or DB columns)', async () => {
    const h = createSummariesHarness();

    const canaryMonday = 'CANARY_PLAINTEXT_JOURNAL_MONDAY_SECRET_449102';
    const canaryWednesday = 'CANARY_PLAINTEXT_JOURNAL_WEDNESDAY_SECRET_773819';
    const canarySummaryText = 'CANARY_GENERATED_SUMMARY_MARKDOWN_SECRET_661209';

    h.setLlmBehavior((req) => ({
      rawText: JSON.stringify({
        summary_md: canarySummaryText,
        themes: ['canary-theme'],
        distress_flag: false,
      }),
      model: req.model,
      inputTokens: 320,
      outputTokens: 90,
    }));

    const user = await h.createVerifiedUser({
      email: 'canary@example.com',
      consentAndEnable: true,
      entries: [
        { date: '2026-11-09', content: canaryMonday },
        { date: '2026-11-11', content: canaryWednesday },
      ],
    });

    await runWeeklySummarySchedulerTick({
      now: h.getClock(),
      repo: h.summariesRepo,
      queue: h.queue,
    });

    // 1. Check job payload before draining: contains ONLY userId and weekStart, never entry text
    expect(h.queue.enqueuedJobs.length).toBe(1);
    const serializedJobPayload = JSON.stringify(h.queue.enqueuedJobs[0]);
    expect(h.queue.enqueuedJobs[0]).toEqual({
      userId: user.userId.toString(),
      weekStart: '2026-11-09',
    });
    expect(serializedJobPayload).not.toContain(canaryMonday);
    expect(serializedJobPayload).not.toContain(canaryWednesday);

    // Run worker
    await h.queue.drainSummaryJobs({
      config: h.config,
      summariesRepo: h.summariesRepo,
      llmProvider: h.mockLlmProvider,
      pushRepo: h.pushRepo,
      pushClient: h.pushClient,
      emailProvider: h.emailProvider,
      logger: h.logger,
    });

    // 2. Outbound LLM provider request DOES contain the entry text
    expect(h.outboundLlmRequests.length).toBe(1);
    expect(h.outboundLlmRequests[0]!.userPrompt).toContain(canaryMonday);
    expect(h.outboundLlmRequests[0]!.userPrompt).toContain(canaryWednesday);

    // 3. Application logs contain token totals, never entry text or summary text
    const allLogs = h.getLogs();
    expect(allLogs).toContain('"inputTokens":320');
    expect(allLogs).toContain('"outputTokens":90');
    expect(allLogs).not.toContain(canaryMonday);
    expect(allLogs).not.toContain(canaryWednesday);
    expect(allLogs).not.toContain(canarySummaryText);

    // 4. Outbound push notifications are generic ("Your week in review is ready") and contain zero entry/summary text
    expect(h.outboundPushPayloads.length).toBe(1);
    const pushStr = h.outboundPushPayloads[0]!.payload;
    expect(pushStr).toContain('Your week in review is ready');
    expect(pushStr).not.toContain(canaryMonday);
    expect(pushStr).not.toContain(canaryWednesday);
    expect(pushStr).not.toContain(canarySummaryText);

    // 5. Outbound emails link to the in-app page and contain zero entry/summary text
    expect(h.emailProvider.sentMessages.length).toBe(1);
    const emailStr = JSON.stringify(h.emailProvider.sentMessages[0]);
    expect(emailStr).toContain('Your week in review is ready');
    expect(emailStr).not.toContain(canaryMonday);
    expect(emailStr).not.toContain(canaryWednesday);
    expect(emailStr).not.toContain(canarySummaryText);

    // 6. Database row stores encrypted ciphertext (summaryEnc / themesEnc), never plaintext
    const storedSummary = await h.summariesRepo.findSummaryByUserAndWeek(user.userId, '2026-11-09');
    expect(storedSummary?.summaryEnc).not.toContain(canarySummaryText);
    expect(storedSummary?.themesEnc).not.toContain('canary-theme');
  });
});
