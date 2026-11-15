import type {
  AuthUser,
  DeleteAccountRequest,
  LoginRequest,
  RegisterRequest,
  RequestResetRequest,
  ResetPasswordRequest,
  SessionItem,
  UpdateSettingsRequest,
  UserSettings,
  VerifyEmailRequest,
} from '@firstwrite/shared';
import {
  deleteAccountRequestSchema,
  loginRequestSchema,
  registerRequestSchema,
  requestResetSchema,
  resetPasswordRequestSchema,
  sessionIdParamSchema,
  updateSettingsRequestSchema,
  verifyEmailRequestSchema,
} from '@firstwrite/shared';
import type { NextFunction, Request, Response, Router } from 'express';
import express from 'express';
import { AppError } from '../app.js';
import type { AppConfig } from '../config.js';
import {
  deriveCsrfToken,
  generateOpaqueToken,
  hashOpaqueToken,
  hashPassword,
  verifyCsrfToken,
  verifyPassword,
} from './crypto.js';
import {
  buildPasswordResetEmail,
  buildVerificationEmail,
  ConsoleEmailProvider,
  type EmailProvider,
} from './email.js';
import { AuthRateLimiter, DEFAULT_AUTH_RATE_POLICIES } from './rate-limit.js';
import type {
  AccountJobScheduler,
  AuthRepository,
  SessionRecord,
  TurnstileVerifier,
  UserRecord,
} from './repository.js';

export const SESSION_COOKIE_NAME = 'mp_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days sliding expiry
export const EMAIL_VERIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
export const PASSWORD_RESET_TTL_MS = 60 * 60 * 1000; // 1 hour
export const ACCOUNT_DELETION_GRACE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

// Pre-computed dummy Argon2id hash used to equalize timing when a login targets a non-existent email
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=1024,t=1,p=1$c2VlZGVkc2FsdDEyMzQ1Ng$R29vZFBhc3N3b3JkSGFzaFBsYWNlaG9sZGVyMTIzNDU2';

export class InMemoryAccountJobScheduler implements AccountJobScheduler {
  public readonly scheduledDeletions = new Map<string, Date>();
  private readonly repo?: AuthRepository;

  constructor(repo?: AuthRepository) {
    this.repo = repo;
  }

  public async enqueueHardDelete(userId: bigint, runAt: Date): Promise<void> {
    this.scheduledDeletions.set(userId.toString(), new Date(runAt));
  }

  public async cancelHardDelete(userId: bigint): Promise<void> {
    this.scheduledDeletions.delete(userId.toString());
  }

  /**
   * Executes due hard-delete jobs as of `now` (used by background worker / tests).
   */
  public async runDueJobs(now: Date): Promise<number> {
    if (!this.repo) return 0;
    let deletedCount = 0;
    for (const [userIdStr, runAt] of this.scheduledDeletions.entries()) {
      if (runAt.getTime() <= now.getTime()) {
        const userId = BigInt(userIdStr);
        const user = await this.repo.findUserById(userId);
        // Only hard-delete if user is still marked deleted_at
        if (user && user.deletedAt !== null) {
          await this.repo.hardDeleteUser(userId);
          deletedCount += 1;
        }
        this.scheduledDeletions.delete(userIdStr);
      }
    }
    return deletedCount;
  }
}

export class DefaultTurnstileVerifier implements TurnstileVerifier {
  private readonly secretKey: string | undefined;

  constructor(secretKey?: string) {
    this.secretKey = secretKey;
  }

  public async verify(token: string | undefined, remoteIp: string | undefined): Promise<boolean> {
    if (!token || token.trim().length === 0) {
      return false;
    }
    if (!this.secretKey) {
      return false;
    }

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: this.secretKey,
        response: token,
        remoteip: remoteIp,
      }),
    });

    if (!res.ok) return false;
    const data = (await res.json()) as { success?: boolean };
    return data.success === true;
  }
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!cookieHeader) return result;

  for (const part of cookieHeader.split(';')) {
    const eqIdx = part.indexOf('=');
    if (eqIdx === -1) continue;
    const key = part.slice(0, eqIdx).trim();
    const val = part.slice(eqIdx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

export function formatSessionCookie(rawToken: string, expiresAt: Date): string {
  const maxAgeSec = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
  return [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(rawToken)}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Expires=${expiresAt.toUTCString()}`,
    `Max-Age=${maxAgeSec}`,
  ].join('; ');
}

export function formatClearSessionCookie(): string {
  return [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    'Max-Age=0',
  ].join('; ');
}

export function serializeAuthUser(user: UserRecord): AuthUser {
  const emailVerified = user.emailVerifiedAt !== null;
  const deletionHardDeleteAt = user.deletedAt
    ? new Date(user.deletedAt.getTime() + ACCOUNT_DELETION_GRACE_MS).toISOString()
    : null;

  return {
    id: user.id.toString(),
    email: user.email,
    timezone: user.timezone,
    emailVerified,
    emailVerifiedAt: user.emailVerifiedAt ? user.emailVerifiedAt.toISOString() : null,
    aiConsentAt: user.aiConsentAt ? user.aiConsentAt.toISOString() : null,
    deletionScheduledAt: user.deletedAt ? user.deletedAt.toISOString() : null,
    deletionHardDeleteAt,
    requiresVerificationBanner: !emailVerified,
  };
}

export interface AuthServiceOptions {
  config: AppConfig;
  repo: AuthRepository;
  emailProvider?: EmailProvider;
  rateLimiter?: AuthRateLimiter;
  jobScheduler?: AccountJobScheduler;
  turnstileVerifier?: TurnstileVerifier;
  now?: () => Date;
}

export interface AuthenticatedContext {
  user: UserRecord;
  session: SessionRecord;
  csrfToken: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      auth?: AuthenticatedContext;
    }
  }
}

export function createAuthRouter(options: AuthServiceOptions): {
  router: Router;
  requireAuth: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  requireCsrf: (req: Request, res: Response, next: NextFunction) => void;
} {
  const {
    config,
    repo,
    emailProvider = new ConsoleEmailProvider(),
    rateLimiter = new AuthRateLimiter(options.now),
    jobScheduler = new InMemoryAccountJobScheduler(repo),
    turnstileVerifier = new DefaultTurnstileVerifier(config.TURNSTILE_SECRET_KEY),
    now = () => new Date(),
  } = options;

  const router = express.Router();

  async function issueSession(
    req: Request,
    res: Response,
    userId: bigint,
    currentTime: Date,
  ): Promise<{ session: SessionRecord; csrfToken: string }> {
    const { rawToken, tokenHash } = generateOpaqueToken(32);
    const expiresAt = new Date(currentTime.getTime() + SESSION_TTL_MS);
    const userAgent =
      typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null;
    const ip = req.ip ?? null;

    const session = await repo.createSession({
      userId,
      tokenHash,
      userAgent,
      ip,
      createdAt: currentTime,
      expiresAt,
    });

    const csrfToken = deriveCsrfToken(tokenHash, config.SESSION_SECRET);
    res.setHeader('Set-Cookie', formatSessionCookie(rawToken, expiresAt));
    res.setHeader('X-CSRF-Token', csrfToken);

    return { session, csrfToken };
  }

  async function issueVerificationEmail(user: UserRecord, currentTime: Date): Promise<void> {
    const { rawToken, tokenHash } = generateOpaqueToken(32);
    const expiresAt = new Date(currentTime.getTime() + EMAIL_VERIFY_TTL_MS);

    await repo.createEmailToken({
      userId: user.id,
      type: 'verify',
      tokenHash,
      createdAt: currentTime,
      expiresAt,
    });

    const emailMessage = buildVerificationEmail({
      to: user.email,
      appBaseUrl: config.APP_BASE_URL,
      rawToken,
    });
    await emailProvider.send(emailMessage);
  }

  /**
   * Resolves the current session from the `mp_session` cookie, enforces that the user exists
   * and is not in a pending/completed deletion state, and applies sliding session expiry.
   */
  const requireAuth = async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const cookies = parseCookies(req.headers.cookie);
    const rawSessionToken = cookies[SESSION_COOKIE_NAME];
    if (!rawSessionToken) {
      throw new AppError(401, 'UNAUTHORIZED', 'Authentication required');
    }

    const currentTime = now();
    const tokenHash = hashOpaqueToken(rawSessionToken);
    const session = await repo.findActiveSessionByHash(tokenHash, currentTime);
    if (!session) {
      res.setHeader('Set-Cookie', formatClearSessionCookie());
      throw new AppError(401, 'UNAUTHORIZED', 'Session expired or invalid');
    }

    const user = await repo.findUserById(session.userId);
    if (!user || user.deletedAt !== null) {
      await repo.revokeSessionByHash(tokenHash);
      res.setHeader('Set-Cookie', formatClearSessionCookie());
      throw new AppError(401, 'UNAUTHORIZED', 'Account is not active');
    }

    // Sliding expiry: extend session expiration on authenticated activity
    const newExpiresAt = new Date(currentTime.getTime() + SESSION_TTL_MS);
    await repo.updateSessionExpiry(session.id, newExpiresAt);
    session.expiresAt = newExpiresAt;
    res.setHeader('Set-Cookie', formatSessionCookie(rawSessionToken, newExpiresAt));

    const csrfToken = deriveCsrfToken(tokenHash, config.SESSION_SECRET);
    res.setHeader('X-CSRF-Token', csrfToken);

    req.auth = { user, session, csrfToken };
    next();
  };

  /**
   * Enforces CSRF protection for state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`).
   * Requires a valid `X-CSRF-Token` header bound to the active session's `tokenHash` (or anonymous CSRF token).
   * Cross-Origin `Origin` headers are also checked against `config.APP_BASE_URL`.
   */
  const requireCsrf = (req: Request, _res: Response, next: NextFunction): void => {
    const method = req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      next();
      return;
    }

    const allowedOrigin = new URL(config.APP_BASE_URL).origin;
    const originHeader = req.headers.origin;
    if (originHeader && originHeader !== allowedOrigin) {
      throw new AppError(403, 'CSRF_INVALID', 'Cross-origin state-changing request rejected');
    }

    const headerToken =
      typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : undefined;

    const cookies = parseCookies(req.headers.cookie);
    const rawSessionToken = cookies[SESSION_COOKIE_NAME];
    const bindingKey = rawSessionToken ? hashOpaqueToken(rawSessionToken) : 'anonymous';

    if (!verifyCsrfToken(headerToken, bindingKey, config.SESSION_SECRET)) {
      throw new AppError(403, 'CSRF_INVALID', 'Missing or invalid CSRF token');
    }

    next();
  };

  // ───────────── GET /api/auth/csrf (Bootstrap CSRF token for anonymous or authenticated clients) ─────────────
  router.get('/api/auth/csrf', (req: Request, res: Response) => {
    const cookies = parseCookies(req.headers.cookie);
    const rawSessionToken = cookies[SESSION_COOKIE_NAME];
    const bindingKey = rawSessionToken ? hashOpaqueToken(rawSessionToken) : 'anonymous';
    const csrfToken = deriveCsrfToken(bindingKey, config.SESSION_SECRET);
    res.setHeader('X-CSRF-Token', csrfToken);
    res.status(200).json({ csrfToken });
  });

  // ───────────── POST /api/auth/register ─────────────
  router.post('/api/auth/register', async (req: Request, res: Response) => {
    const ipKey = `register:ip:${req.ip ?? 'unknown'}`;
    rateLimiter.consume(ipKey, DEFAULT_AUTH_RATE_POLICIES.registerIp);

    const parsed: RegisterRequest = registerRequestSchema.parse(req.body);
    const normalizedEmail = parsed.email.trim().toLowerCase();
    const accountKey = `register:acct:${normalizedEmail}`;
    rateLimiter.consume(accountKey, DEFAULT_AUTH_RATE_POLICIES.registerAccount);

    if (config.TURNSTILE_ENABLED) {
      const ok = await turnstileVerifier.verify(parsed.turnstileToken, req.ip);
      if (!ok) {
        throw new AppError(400, 'TURNSTILE_FAILED', 'Bot verification challenge failed');
      }
    }

    const existing = await repo.findUserByEmail(normalizedEmail);
    if (existing) {
      throw new AppError(
        409,
        'EMAIL_ALREADY_REGISTERED',
        'An account with this email already exists',
      );
    }

    const currentTime = now();
    const passwordHash = await hashPassword(parsed.password);
    const user = await repo.createUser({
      email: normalizedEmail,
      passwordHash,
      timezone: parsed.timezone,
      now: currentTime,
    });

    await repo.updateUserLastLogin(user.id, currentTime);
    await issueVerificationEmail(user, currentTime);
    const { csrfToken } = await issueSession(req, res, user.id, currentTime);

    res.status(201).json({
      user: serializeAuthUser(user),
      csrfToken,
    });
  });

  // ───────────── POST /api/auth/login ─────────────
  router.post('/api/auth/login', async (req: Request, res: Response) => {
    const ipKey = `login:ip:${req.ip ?? 'unknown'}`;
    rateLimiter.consume(ipKey, DEFAULT_AUTH_RATE_POLICIES.loginIp);

    const parsed: LoginRequest = loginRequestSchema.parse(req.body);
    const normalizedEmail = parsed.email.trim().toLowerCase();
    const accountKey = `login:acct:${normalizedEmail}`;
    rateLimiter.consume(accountKey, DEFAULT_AUTH_RATE_POLICIES.loginAccount);

    const user = await repo.findUserByEmail(normalizedEmail);
    if (!user) {
      await verifyPassword(parsed.password, DUMMY_PASSWORD_HASH);
      rateLimiter.recordFailure(ipKey, DEFAULT_AUTH_RATE_POLICIES.loginIp);
      rateLimiter.recordFailure(accountKey, DEFAULT_AUTH_RATE_POLICIES.loginAccount);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const passwordValid = await verifyPassword(parsed.password, user.passwordHash);
    if (!passwordValid) {
      rateLimiter.recordFailure(ipKey, DEFAULT_AUTH_RATE_POLICIES.loginIp);
      rateLimiter.recordFailure(accountKey, DEFAULT_AUTH_RATE_POLICIES.loginAccount);
      throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const currentTime = now();

    // Check if account is in the 14-day deletion grace period
    if (user.deletedAt !== null) {
      const hardDeleteAt = new Date(user.deletedAt.getTime() + ACCOUNT_DELETION_GRACE_MS);
      if (currentTime.getTime() >= hardDeleteAt.getTime()) {
        await repo.hardDeleteUser(user.id);
        throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
      }

      if (!parsed.cancelDeletion) {
        res.status(403).json({
          error: {
            code: 'ACCOUNT_DELETION_PENDING',
            message:
              'Your account is scheduled for deletion. Log in with cancelDeletion: true to restore your account.',
            details: {
              deletionScheduledAt: user.deletedAt.toISOString(),
              deletionHardDeleteAt: hardDeleteAt.toISOString(),
              canCancelDeletion: true,
            },
          },
        });
        return;
      }

      // User chose to cancel deletion during the grace period
      await repo.updateUserDeletedAt(user.id, null);
      await jobScheduler.cancelHardDelete(user.id);
      user.deletedAt = null;
    }

    rateLimiter.recordSuccess(ipKey);
    rateLimiter.recordSuccess(accountKey);

    await repo.updateUserLastLogin(user.id, currentTime);
    user.lastLoginAt = currentTime;

    const { csrfToken } = await issueSession(req, res, user.id, currentTime);

    res.status(200).json({
      user: serializeAuthUser(user),
      csrfToken,
    });
  });

  // ───────────── POST /api/auth/logout ─────────────
  router.post('/api/auth/logout', requireAuth, requireCsrf, async (req: Request, res: Response) => {
    const { session } = req.auth!;
    await repo.revokeSessionByHash(session.tokenHash);
    res.setHeader('Set-Cookie', formatClearSessionCookie());
    res.status(200).json({ status: 'ok' });
  });

  // ───────────── GET /api/auth/me ─────────────
  router.get('/api/auth/me', requireAuth, async (req: Request, res: Response) => {
    const { user, csrfToken } = req.auth!;
    res.status(200).json({
      user: serializeAuthUser(user),
      csrfToken,
    });
  });

  // ───────────── POST /api/auth/verify-email ─────────────
  router.post('/api/auth/verify-email', async (req: Request, res: Response) => {
    const ipKey = `verify:ip:${req.ip ?? 'unknown'}`;
    rateLimiter.consume(ipKey, DEFAULT_AUTH_RATE_POLICIES.verifyIp);

    const parsed: VerifyEmailRequest = verifyEmailRequestSchema.parse(req.body);
    const currentTime = now();
    const tokenHash = hashOpaqueToken(parsed.token);

    const tokenRecord = await repo.consumeEmailToken('verify', tokenHash, currentTime);
    if (!tokenRecord) {
      rateLimiter.recordFailure(ipKey, DEFAULT_AUTH_RATE_POLICIES.verifyIp);
      throw new AppError(
        400,
        'INVALID_OR_EXPIRED_TOKEN',
        'Verification token is invalid, expired, or has already been used',
      );
    }

    rateLimiter.recordSuccess(ipKey);
    await repo.updateUserVerified(tokenRecord.userId, currentTime);
    const updatedUser = await repo.findUserById(tokenRecord.userId);

    res.status(200).json({
      status: 'ok',
      user: updatedUser ? serializeAuthUser(updatedUser) : null,
    });
  });

  // ───────────── POST /api/auth/request-reset ─────────────
  const RESET_RESPONSE_BODY = {
    status: 'ok',
    message:
      'If an account exists for that email address, password reset instructions have been sent.',
  };

  router.post('/api/auth/request-reset', async (req: Request, res: Response) => {
    const ipKey = `reset:ip:${req.ip ?? 'unknown'}`;
    rateLimiter.consume(ipKey, DEFAULT_AUTH_RATE_POLICIES.requestResetIp);

    const parsed: RequestResetRequest = requestResetSchema.parse(req.body);
    const normalizedEmail = parsed.email.trim().toLowerCase();
    const accountKey = `reset:acct:${normalizedEmail}`;
    rateLimiter.consume(accountKey, DEFAULT_AUTH_RATE_POLICIES.requestResetAccount);

    const currentTime = now();
    const user = await repo.findUserByEmail(normalizedEmail);

    // Always generate a token hash even if the user does not exist, and return the exact same
    // 200 status and JSON payload to prevent account enumeration.
    const { rawToken, tokenHash } = generateOpaqueToken(32);

    if (user && user.deletedAt === null) {
      const expiresAt = new Date(currentTime.getTime() + PASSWORD_RESET_TTL_MS);
      await repo.createEmailToken({
        userId: user.id,
        type: 'reset',
        tokenHash,
        createdAt: currentTime,
        expiresAt,
      });

      const emailMessage = buildPasswordResetEmail({
        to: user.email,
        appBaseUrl: config.APP_BASE_URL,
        rawToken,
      });
      await emailProvider.send(emailMessage);
    }

    res.status(200).json(RESET_RESPONSE_BODY);
  });

  // ───────────── POST /api/auth/reset-password ─────────────
  router.post('/api/auth/reset-password', async (req: Request, res: Response) => {
    const ipKey = `verify:ip:${req.ip ?? 'unknown'}`;
    rateLimiter.consume(ipKey, DEFAULT_AUTH_RATE_POLICIES.verifyIp);

    const parsed: ResetPasswordRequest = resetPasswordRequestSchema.parse(req.body);
    const currentTime = now();
    const tokenHash = hashOpaqueToken(parsed.token);

    const tokenRecord = await repo.consumeEmailToken('reset', tokenHash, currentTime);
    if (!tokenRecord) {
      rateLimiter.recordFailure(ipKey, DEFAULT_AUTH_RATE_POLICIES.verifyIp);
      throw new AppError(
        400,
        'INVALID_OR_EXPIRED_TOKEN',
        'Password reset token is invalid, expired, or has already been used',
      );
    }

    const passwordHash = await hashPassword(parsed.password);
    await repo.updateUserPassword(tokenRecord.userId, passwordHash);

    // Critical requirement: Successful reset invalidates all existing sessions
    await repo.revokeAllUserSessions(tokenRecord.userId);
    res.setHeader('Set-Cookie', formatClearSessionCookie());

    res.status(200).json({ status: 'ok' });
  });

  // ───────────── Active Sessions Management ─────────────

  router.get('/api/auth/sessions', requireAuth, async (req: Request, res: Response) => {
    const { user, session: currentSession } = req.auth!;
    const activeSessions = await repo.listActiveSessionsForUser(user.id, now());

    const items: SessionItem[] = activeSessions.map((s) => ({
      id: s.id.toString(),
      userAgent: s.userAgent,
      ip: s.ip,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      current: s.id === currentSession.id,
    }));

    res.status(200).json({ sessions: items });
  });

  router.delete(
    '/api/auth/sessions/:id',
    requireAuth,
    requireCsrf,
    async (req: Request, res: Response) => {
      const { user, session: currentSession } = req.auth!;
      const { id } = sessionIdParamSchema.parse(req.params);
      const targetId = BigInt(id);

      const revoked = await repo.revokeSessionById(user.id, targetId);
      if (!revoked) {
        throw new AppError(404, 'SESSION_NOT_FOUND', 'Session not found');
      }

      if (targetId === currentSession.id) {
        res.setHeader('Set-Cookie', formatClearSessionCookie());
      }

      res.status(200).json({ status: 'ok' });
    },
  );

  router.post(
    '/api/auth/logout-all',
    requireAuth,
    requireCsrf,
    async (req: Request, res: Response) => {
      const { user } = req.auth!;
      await repo.revokeAllUserSessions(user.id);
      res.setHeader('Set-Cookie', formatClearSessionCookie());
      res.status(200).json({ status: 'ok' });
    },
  );

  // ───────────── Settings (Timezone & AI Summary Verification Gate) ─────────────

  router.get('/api/settings', requireAuth, async (req: Request, res: Response) => {
    const { user } = req.auth!;
    const settings = await repo.getSettings(user.id);

    const payload: UserSettings = {
      timezone: user.timezone,
      reminderEnabled: settings.reminderEnabled,
      reminderTime: settings.reminderTime,
      weeklySummaryEnabled: settings.weeklySummaryEnabled,
      summaryDeliveryTime: settings.summaryDeliveryTime,
      dailyWordGoal: settings.dailyWordGoal,
      aiConsentAt: user.aiConsentAt ? user.aiConsentAt.toISOString() : null,
    };

    res.status(200).json(payload);
  });

  router.put('/api/settings', requireAuth, requireCsrf, async (req: Request, res: Response) => {
    const { user } = req.auth!;
    const parsed: UpdateSettingsRequest = updateSettingsRequestSchema.parse(req.body);
    const currentTime = now();

    // Unverified users cannot enable AI summaries (Brief 3 requirement)
    if (
      (parsed.weeklySummaryEnabled === true || parsed.aiConsent === true) &&
      user.emailVerifiedAt === null
    ) {
      throw new AppError(
        403,
        'EMAIL_NOT_VERIFIED',
        'Please verify your email address before enabling weekly AI summaries',
      );
    }

    let nextAiConsentAt: Date | null | undefined = undefined;
    let nextWeeklySummaryEnabled = parsed.weeklySummaryEnabled;

    if (parsed.aiConsent === true) {
      nextAiConsentAt = user.aiConsentAt ?? currentTime;
    } else if (parsed.aiConsent === false) {
      nextAiConsentAt = null;
      nextWeeklySummaryEnabled = false;
    }

    const effectiveConsent = nextAiConsentAt !== undefined ? nextAiConsentAt : user.aiConsentAt;
    if (nextWeeklySummaryEnabled === true && effectiveConsent === null) {
      throw new AppError(
        400,
        'AI_CONSENT_REQUIRED',
        'Explicit AI consent is required to enable weekly summaries',
      );
    }

    const { user: updatedUser, settings: updatedSettings } = await repo.updateSettings(user.id, {
      timezone: parsed.timezone,
      reminderEnabled: parsed.reminderEnabled,
      reminderTime: parsed.reminderTime,
      weeklySummaryEnabled: nextWeeklySummaryEnabled,
      summaryDeliveryTime: parsed.summaryDeliveryTime,
      dailyWordGoal: parsed.dailyWordGoal,
      aiConsentAt: nextAiConsentAt,
    });

    const payload: UserSettings = {
      timezone: updatedUser.timezone,
      reminderEnabled: updatedSettings.reminderEnabled,
      reminderTime: updatedSettings.reminderTime,
      weeklySummaryEnabled: updatedSettings.weeklySummaryEnabled,
      summaryDeliveryTime: updatedSettings.summaryDeliveryTime,
      dailyWordGoal: updatedSettings.dailyWordGoal,
      aiConsentAt: updatedUser.aiConsentAt ? updatedUser.aiConsentAt.toISOString() : null,
    };

    res.status(200).json(payload);
  });

  // ───────────── Account Deletion (14-Day Grace Period + Hard-Delete Job) ─────────────

  router.delete('/api/account', requireAuth, requireCsrf, async (req: Request, res: Response) => {
    const { user } = req.auth!;
    const parsed: DeleteAccountRequest = deleteAccountRequestSchema.parse(req.body);

    const passwordValid = await verifyPassword(parsed.password, user.passwordHash);
    if (!passwordValid) {
      throw new AppError(401, 'INVALID_PASSWORD', 'Password re-entry did not match');
    }

    const currentTime = now();
    const hardDeleteAt = new Date(currentTime.getTime() + ACCOUNT_DELETION_GRACE_MS);

    await repo.updateUserDeletedAt(user.id, currentTime);
    await repo.revokeAllUserSessions(user.id);
    await jobScheduler.enqueueHardDelete(user.id, hardDeleteAt);

    res.setHeader('Set-Cookie', formatClearSessionCookie());
    res.status(200).json({
      status: 'ok',
      deletionScheduledAt: currentTime.toISOString(),
      deletionHardDeleteAt: hardDeleteAt.toISOString(),
    });
  });

  return { router, requireAuth, requireCsrf };
}
