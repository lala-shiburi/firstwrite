import { Duplex, Writable } from 'node:stream';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import type { Express } from 'express';
import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';
import {
  ACCOUNT_DELETION_GRACE_MS,
  ConsoleEmailProvider,
  EMAIL_VERIFY_TTL_MS,
  hashOpaqueToken,
  InMemoryAccountJobScheduler,
  InMemoryAuthRepository,
  PASSWORD_RESET_TTL_MS,
  SESSION_COOKIE_NAME,
  type TurnstileVerifier,
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

function extractTokenFromEmail(text: string): string {
  const match = /[?&]token=([^\s&"]+)/.exec(text);
  if (!match?.[1]) {
    throw new Error(`No token found in email text:\n${text}`);
  }
  return decodeURIComponent(match[1]);
}

function createTestHarness(configOverrides: Partial<typeof baseTestConfig> = {}) {
  let currentTime = new Date('2026-11-15T07:00:00.000Z');
  const logChunks: string[] = [];
  const logStream = new Writable({
    write(chunk, _enc, cb) {
      logChunks.push(chunk.toString('utf8'));
      cb();
    },
  });
  const logger = createLogger({ level: 'debug', stream: logStream });
  const repo = new InMemoryAuthRepository();
  const emailProvider = new ConsoleEmailProvider();
  const jobScheduler = new InMemoryAccountJobScheduler(repo);

  let turnstileAccept = true;
  const turnstileVerifier: TurnstileVerifier = {
    async verify(token) {
      return turnstileAccept && Boolean(token && token === 'valid-turnstile-token');
    },
  };

  const config = { ...baseTestConfig, ...configOverrides };
  const app = createApp({
    config,
    logger,
    authOptions: {
      repo,
      emailProvider,
      jobScheduler,
      turnstileVerifier,
      now: () => new Date(currentTime),
    },
  });

  return {
    app,
    repo,
    emailProvider,
    jobScheduler,
    getLogs: () => logChunks.join(''),
    getTime: () => new Date(currentTime),
    advanceTimeMs: (ms: number) => {
      currentTime = new Date(currentTime.getTime() + ms);
    },
    setTurnstileAccept: (accept: boolean) => {
      turnstileAccept = accept;
    },
  };
}

describe('Brief 3: Authentication and Accounts', () => {
  it('stores the forwarded real client IP in sessions and rate-limits by that IP', async () => {
    const h = createTestHarness();
    const remoteProxyAddress = '172.18.0.5';
    const clientIp = '203.0.113.42';

    const registration = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/register',
      remoteAddress: remoteProxyAddress,
      headers: { 'X-Forwarded-For': clientIp },
      body: {
        email: 'ip-check@example.com',
        password: 'correct-horse-battery-staple',
        timezone: 'UTC',
      },
    });
    expect(registration.status).toBe(201);
    expect(Array.from(h.repo.sessions.values())[0]?.ip).toBe(clientIp);

    for (let attempt = 0; attempt < 20; attempt += 1) {
      await injectRequest(h.app, {
        method: 'POST',
        url: '/api/auth/login',
        remoteAddress: remoteProxyAddress,
        headers: { 'X-Forwarded-For': clientIp },
        body: {
          email: `unknown-${attempt}@example.com`,
          password: 'not-the-password',
        },
      });
    }

    const sameClient = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: remoteProxyAddress,
      headers: { 'X-Forwarded-For': clientIp },
      body: { email: 'another-unknown@example.com', password: 'not-the-password' },
    });
    const differentClient = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/login',
      remoteAddress: remoteProxyAddress,
      headers: { 'X-Forwarded-For': '198.51.100.15' },
      body: { email: 'another-unknown@example.com', password: 'not-the-password' },
    });

    expect(sameClient.status).toBe(429);
    expect(differentClient.status).toBe(401);
  });

  it('registers with Argon2id password hash, captures timezone, hashes session & verify tokens, and restricts AI summaries until verified', async () => {
    const h = createTestHarness();

    // Rejects common/breached or short passwords
    const weakRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        email: 'writer@example.com',
        password: 'password123',
        timezone: 'Africa/Johannesburg',
      },
    });
    expect(weakRes.status).toBe(400);

    // Valid registration
    const regRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        email: 'Writer@Example.com',
        password: 'correct-horse-battery-staple',
        timezone: 'Africa/Johannesburg',
      },
    });

    expect(regRes.status).toBe(201);
    const userPayload = regRes.body.user as Record<string, unknown>;
    expect(userPayload.email).toBe('writer@example.com');
    expect(userPayload.timezone).toBe('Africa/Johannesburg');
    expect(userPayload.emailVerified).toBe(false);
    expect(userPayload.requiresVerificationBanner).toBe(true);

    // Verify cookie flags: HttpOnly, Secure, SameSite=Lax
    const setCookieHeader = String(regRes.headers['set-cookie']);
    expect(setCookieHeader).toContain('HttpOnly');
    expect(setCookieHeader).toContain('Secure');
    expect(setCookieHeader).toContain('SameSite=Lax');

    const rawSessionToken = extractRawSessionCookie(regRes);
    const csrfToken = String(regRes.body.csrfToken);
    expect(rawSessionToken.length).toBeGreaterThan(20);

    // Database stores argon2id password hash and hashed session/email tokens — never raw values
    const storedUser = await h.repo.findUserByEmail('writer@example.com');
    expect(storedUser).not.toBeNull();
    expect(storedUser!.passwordHash.startsWith('$argon2id$v=19$')).toBe(true);
    expect(storedUser!.passwordHash).not.toContain('correct-horse-battery-staple');

    const sessionRecord = Array.from(h.repo.sessions.values())[0]!;
    expect(sessionRecord.tokenHash).toBe(hashOpaqueToken(rawSessionToken));
    expect(sessionRecord.tokenHash).not.toBe(rawSessionToken);

    expect(h.emailProvider.sentMessages.length).toBe(1);
    const rawVerifyToken = extractTokenFromEmail(h.emailProvider.sentMessages[0]!.text);
    const emailTokenRecord = Array.from(h.repo.emailTokens.values())[0]!;
    expect(emailTokenRecord.tokenHash).toBe(hashOpaqueToken(rawVerifyToken));
    expect(emailTokenRecord.tokenHash).not.toBe(rawVerifyToken);

    // Unverified user can log in and read settings, but cannot enable weekly AI summaries
    const enableAiUnverified = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/settings',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${rawSessionToken}`,
        'X-CSRF-Token': csrfToken,
      },
      body: {
        aiConsent: true,
        weeklySummaryEnabled: true,
      },
    });
    expect(enableAiUnverified.status).toBe(403);
    expect((enableAiUnverified.body.error as { code: string }).code).toBe('EMAIL_NOT_VERIFIED');

    // Timezone is editable in settings even before email verification
    const updateTzRes = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/settings',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${rawSessionToken}`,
        'X-CSRF-Token': csrfToken,
      },
      body: {
        timezone: 'Europe/London',
      },
    });
    expect(updateTzRes.status).toBe(200);
    expect(updateTzRes.body.timezone).toBe('Europe/London');

    // Verify email with token
    const verifyRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/verify-email',
      body: { token: rawVerifyToken },
    });
    expect(verifyRes.status).toBe(200);
    expect((verifyRes.body.user as Record<string, unknown>).emailVerified).toBe(true);
    expect((verifyRes.body.user as Record<string, unknown>).requiresVerificationBanner).toBe(false);

    // Now verified user can consent and enable weekly AI summaries
    const enableAiVerified = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/settings',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${rawSessionToken}`,
        'X-CSRF-Token': csrfToken,
      },
      body: {
        aiConsent: true,
        weeklySummaryEnabled: true,
      },
    });
    expect(enableAiVerified.status).toBe(200);
    expect(enableAiVerified.body.weeklySummaryEnabled).toBe(true);
    expect(typeof enableAiVerified.body.aiConsentAt).toBe('string');
  });

  it('rejects expired tokens (24h verify, 1h reset) and rejects single-use token reuse', async () => {
    const h = createTestHarness();

    await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        email: 'tokens@example.com',
        password: 'correct-horse-battery-staple',
        timezone: 'UTC',
      },
    });

    const rawVerifyToken = extractTokenFromEmail(h.emailProvider.sentMessages[0]!.text);

    // 1. First use of verification token succeeds
    const firstVerify = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/verify-email',
      body: { token: rawVerifyToken },
    });
    expect(firstVerify.status).toBe(200);

    // 2. Reusing the same verification token is rejected
    const secondVerify = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/verify-email',
      body: { token: rawVerifyToken },
    });
    expect(secondVerify.status).toBe(400);
    expect((secondVerify.body.error as { code: string }).code).toBe('INVALID_OR_EXPIRED_TOKEN');

    // 3. Register a second user and advance clock past 24 hours -> verify token expires
    await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        email: 'expired-verify@example.com',
        password: 'correct-horse-battery-staple',
        timezone: 'UTC',
      },
    });
    const expiredVerifyToken = extractTokenFromEmail(h.emailProvider.sentMessages[1]!.text);
    h.advanceTimeMs(EMAIL_VERIFY_TTL_MS + 1000);

    const expiredVerifyRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/verify-email',
      body: { token: expiredVerifyToken },
    });
    expect(expiredVerifyRes.status).toBe(400);
    expect((expiredVerifyRes.body.error as { code: string }).code).toBe('INVALID_OR_EXPIRED_TOKEN');

    // 4. Request password reset and advance clock past 1 hour -> reset token expires
    await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/request-reset',
      body: { email: 'tokens@example.com' },
    });
    const expiredResetToken = extractTokenFromEmail(h.emailProvider.sentMessages[2]!.text);
    h.advanceTimeMs(PASSWORD_RESET_TTL_MS + 1000);

    const expiredResetRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/reset-password',
      body: {
        token: expiredResetToken,
        password: 'new-correct-horse-battery-staple',
      },
    });
    expect(expiredResetRes.status).toBe(400);
    expect((expiredResetRes.body.error as { code: string }).code).toBe('INVALID_OR_EXPIRED_TOKEN');
  });

  it('prevents account enumeration on request-reset and revokes all existing sessions after password reset', async () => {
    const h = createTestHarness();

    // Register user (creates session 1)
    const regRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        email: 'reset-user@example.com',
        password: 'correct-horse-battery-staple',
        timezone: 'UTC',
      },
    });
    const sessionCookie1 = extractRawSessionCookie(regRes);

    // Log in from a second device (creates session 2)
    const loginRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: {
        email: 'reset-user@example.com',
        password: 'correct-horse-battery-staple',
      },
    });
    const sessionCookie2 = extractRawSessionCookie(loginRes);

    // Request password reset for existing user vs non-existent user: responses must be identical
    const existingResetRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/request-reset',
      body: { email: 'reset-user@example.com' },
    });
    const unknownResetRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/request-reset',
      body: { email: 'nobody-here@example.com' },
    });

    expect(existingResetRes.status).toBe(200);
    expect(unknownResetRes.status).toBe(200);
    expect(existingResetRes.body).toEqual(unknownResetRes.body);
    // Only 2 emails sent total (1 registration verify + 1 reset for existing user)
    expect(h.emailProvider.sentMessages.length).toBe(2);

    const rawResetToken = extractTokenFromEmail(h.emailProvider.sentMessages[1]!.text);

    // Execute password reset
    const performResetRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/reset-password',
      body: {
        token: rawResetToken,
        password: 'brand-new-strong-passphrase-2026',
      },
    });
    expect(performResetRes.status).toBe(200);

    // Reusing reset token is rejected
    const reuseResetRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/reset-password',
      body: {
        token: rawResetToken,
        password: 'another-strong-passphrase-2026',
      },
    });
    expect(reuseResetRes.status).toBe(400);

    // Both previously active sessions are immediately invalidated
    const checkSession1 = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie1}` },
    });
    const checkSession2 = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie2}` },
    });
    expect(checkSession1.status).toBe(401);
    expect(checkSession2.status).toBe(401);

    // Old password no longer works; new password succeeds
    const oldLogin = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: {
        email: 'reset-user@example.com',
        password: 'correct-horse-battery-staple',
      },
    });
    expect(oldLogin.status).toBe(401);

    const newLogin = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: {
        email: 'reset-user@example.com',
        password: 'brand-new-strong-passphrase-2026',
      },
    });
    expect(newLogin.status).toBe(200);
  });

  it('supports sliding session expiry, listing active sessions, revoking one session, and logging out everywhere', async () => {
    const h = createTestHarness();

    const regRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/register',
      headers: { 'User-Agent': 'Desktop Safari' },
      body: {
        email: 'sessions@example.com',
        password: 'correct-horse-battery-staple',
        timezone: 'UTC',
      },
    });
    const token1 = extractRawSessionCookie(regRes);
    const csrf1 = String(regRes.body.csrfToken);

    const login2 = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'User-Agent': 'Mobile Chrome' },
      body: {
        email: 'sessions@example.com',
        password: 'correct-horse-battery-staple',
      },
    });
    const token2 = extractRawSessionCookie(login2);
    const csrf2 = String(login2.body.csrfToken);

    // Advance 5 days and call /api/auth/me with token1 -> sliding expiry extends session 1
    const initialExpiry = h.repo.sessions.get(1n)!.expiresAt.getTime();
    h.advanceTimeMs(5 * 24 * 60 * 60 * 1000);

    const meRes = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token1}` },
    });
    expect(meRes.status).toBe(200);
    const extendedExpiry = h.repo.sessions.get(1n)!.expiresAt.getTime();
    expect(extendedExpiry).toBeGreaterThan(initialExpiry);

    // List active sessions
    const listRes = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/auth/sessions',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token1}` },
    });
    expect(listRes.status).toBe(200);
    const sessionsList = listRes.body.sessions as Array<{ id: string; current: boolean }>;
    expect(sessionsList.length).toBe(2);

    const otherSession = sessionsList.find((s) => !s.current)!;

    // Revoke session 2 from session 1
    const revokeRes = await injectRequest(h.app, {
      method: 'DELETE',
      url: `/api/auth/sessions/${otherSession.id}`,
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${token1}`,
        'X-CSRF-Token': csrf1,
      },
    });
    expect(revokeRes.status).toBe(200);

    // Session 2 is now unauthorized
    const me2Res = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token2}`, 'X-CSRF-Token': csrf2 },
    });
    expect(me2Res.status).toBe(401);

    // Log out everywhere revokes remaining sessions
    const logoutAllRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/logout-all',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${token1}`,
        'X-CSRF-Token': csrf1,
      },
    });
    expect(logoutAllRes.status).toBe(200);

    const me1AfterLogoutAll = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${token1}` },
    });
    expect(me1AfterLogoutAll.status).toBe(401);
  });

  it('enforces lockout and exponential backoff after repeated login failures', async () => {
    const h = createTestHarness();

    await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        email: 'lockout@example.com',
        password: 'correct-horse-battery-staple',
        timezone: 'UTC',
      },
    });

    // 5 consecutive failed logins trigger account lockout
    for (let i = 0; i < 5; i++) {
      const failRes = await injectRequest(h.app, {
        method: 'POST',
        url: '/api/auth/login',
        body: {
          email: 'lockout@example.com',
          password: 'wrong-password-attempt',
        },
      });
      expect(failRes.status).toBe(401);
    }

    // 6th attempt (even with the correct password!) is blocked with 429 ACCOUNT_LOCKED
    const lockedRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: {
        email: 'lockout@example.com',
        password: 'correct-horse-battery-staple',
      },
    });
    expect(lockedRes.status).toBe(429);
    expect((lockedRes.body.error as { code: string }).code).toBe('ACCOUNT_LOCKED');

    // Advance past 5-minute base lockout window -> login with valid password succeeds
    h.advanceTimeMs(5 * 60 * 1000 + 1000);

    const unlockedRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: {
        email: 'lockout@example.com',
        password: 'correct-horse-battery-staple',
      },
    });
    expect(unlockedRes.status).toBe(200);
  });

  it('rejects state-changing requests without a valid CSRF token or with a forged CSRF token', async () => {
    const h = createTestHarness();

    const regRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        email: 'csrf@example.com',
        password: 'correct-horse-battery-staple',
        timezone: 'UTC',
      },
    });
    const sessionCookie = extractRawSessionCookie(regRes);
    const validCsrf = String(regRes.body.csrfToken);

    // 1. Missing X-CSRF-Token header -> 403 CSRF_INVALID
    const missingCsrfRes = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/settings',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
      },
      body: { dailyWordGoal: 1000 },
    });
    expect(missingCsrfRes.status).toBe(403);
    expect((missingCsrfRes.body.error as { code: string }).code).toBe('CSRF_INVALID');

    // 2. Forged X-CSRF-Token header -> 403 CSRF_INVALID
    const forgedCsrfRes = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/settings',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
        'X-CSRF-Token': 'forged-csrf-token-value',
      },
      body: { dailyWordGoal: 1000 },
    });
    expect(forgedCsrfRes.status).toBe(403);
    expect((forgedCsrfRes.body.error as { code: string }).code).toBe('CSRF_INVALID');

    // 3. Valid X-CSRF-Token header -> 200 OK
    const validCsrfRes = await injectRequest(h.app, {
      method: 'PUT',
      url: '/api/settings',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
        'X-CSRF-Token': validCsrf,
      },
      body: { dailyWordGoal: 1000 },
    });
    expect(validCsrfRes.status).toBe(200);
    expect(validCsrfRes.body.dailyWordGoal).toBe(1000);
  });

  it('implements the 14-day account deletion grace-period flow, cancellation on login, and hard-delete after 14 days', async () => {
    const h = createTestHarness();

    const regRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        email: 'delete-me@example.com',
        password: 'correct-horse-battery-staple',
        timezone: 'UTC',
      },
    });
    const sessionCookie = extractRawSessionCookie(regRes);
    const csrfToken = String(regRes.body.csrfToken);

    // 1. Delete account requires password re-entry (wrong password rejected)
    const wrongPwDelete = await injectRequest(h.app, {
      method: 'DELETE',
      url: '/api/account',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
        'X-CSRF-Token': csrfToken,
      },
      body: { password: 'wrong-password' },
    });
    expect(wrongPwDelete.status).toBe(401);

    // 2. Correct password marks deleted_at, revokes sessions, and enqueues 14-day hard-delete job
    const deleteRes = await injectRequest(h.app, {
      method: 'DELETE',
      url: '/api/account',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}`,
        'X-CSRF-Token': csrfToken,
      },
      body: { password: 'correct-horse-battery-staple' },
    });
    expect(deleteRes.status).toBe(200);
    expect(h.jobScheduler.scheduledDeletions.size).toBe(1);

    // Existing session is immediately revoked
    const meAfterDelete = await injectRequest(h.app, {
      method: 'GET',
      url: '/api/auth/me',
      headers: { Cookie: `${SESSION_COOKIE_NAME}=${sessionCookie}` },
    });
    expect(meAfterDelete.status).toBe(401);

    // 3. Logging in during the 14-day grace period without cancelDeletion offers to cancel deletion
    h.advanceTimeMs(2 * 24 * 60 * 60 * 1000); // 2 days later
    const gracePromptLogin = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: {
        email: 'delete-me@example.com',
        password: 'correct-horse-battery-staple',
      },
    });
    expect(gracePromptLogin.status).toBe(403);
    expect((gracePromptLogin.body.error as { code: string }).code).toBe('ACCOUNT_DELETION_PENDING');

    // 4. Logging in with cancelDeletion: true restores the account and cancels the hard-delete job
    const restoreLogin = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/login',
      body: {
        email: 'delete-me@example.com',
        password: 'correct-horse-battery-staple',
        cancelDeletion: true,
      },
    });
    expect(restoreLogin.status).toBe(200);
    expect(h.jobScheduler.scheduledDeletions.size).toBe(0);

    const restoredSession = extractRawSessionCookie(restoreLogin);
    const restoredCsrf = String(restoreLogin.body.csrfToken);

    // 5. Request deletion again and advance past the 14-day grace period -> hard-delete job removes user
    await injectRequest(h.app, {
      method: 'DELETE',
      url: '/api/account',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${restoredSession}`,
        'X-CSRF-Token': restoredCsrf,
      },
      body: { password: 'correct-horse-battery-staple' },
    });

    h.advanceTimeMs(ACCOUNT_DELETION_GRACE_MS + 1000);
    const deletedRows = await h.jobScheduler.runDueJobs(h.getTime());
    expect(deletedRows).toBe(1);
    expect(await h.repo.findUserByEmail('delete-me@example.com')).toBeNull();
  });

  it('enforces Cloudflare Turnstile on registration when TURNSTILE_ENABLED is true', async () => {
    const h = createTestHarness({ TURNSTILE_ENABLED: true });

    const missingTokenRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        email: 'bot@example.com',
        password: 'correct-horse-battery-staple',
        timezone: 'UTC',
      },
    });
    expect(missingTokenRes.status).toBe(400);
    expect((missingTokenRes.body.error as { code: string }).code).toBe('TURNSTILE_FAILED');

    const validTokenRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        email: 'human@example.com',
        password: 'correct-horse-battery-staple',
        timezone: 'UTC',
        turnstileToken: 'valid-turnstile-token',
      },
    });
    expect(validTokenRes.status).toBe(201);
  });

  it('guarantees passwords, email tokens, and session identifiers never appear in logs', async () => {
    const h = createTestHarness();
    const secretPassword = 'NEVER_LOG_PASSWORD_SECRET_9918273';

    const regRes = await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/register',
      body: {
        email: 'privacy@example.com',
        password: secretPassword,
        timezone: 'UTC',
      },
    });

    const rawSessionCookie = extractRawSessionCookie(regRes);
    const rawVerifyToken = extractTokenFromEmail(h.emailProvider.sentMessages[0]!.text);

    await injectRequest(h.app, {
      method: 'POST',
      url: '/api/auth/verify-email',
      body: { token: rawVerifyToken },
    });

    await injectRequest(h.app, {
      method: 'GET',
      url: '/api/auth/me',
      headers: {
        Cookie: `${SESSION_COOKIE_NAME}=${rawSessionCookie}`,
      },
    });

    const logs = h.getLogs();
    expect(logs.length).toBeGreaterThan(0);
    expect(logs).not.toContain(secretPassword);
    expect(logs).not.toContain(rawSessionCookie);
    expect(logs).not.toContain(rawVerifyToken);
  });
});
