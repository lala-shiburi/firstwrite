import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { emailTokens, sessions, userSettings, users } from '../db/schema.js';

export interface UserRecord {
  id: bigint;
  email: string;
  passwordHash: string;
  timezone: string;
  emailVerifiedAt: Date | null;
  aiConsentAt: Date | null;
  createdAt: Date;
  lastLoginAt: Date | null;
  deletedAt: Date | null;
}

export interface SessionRecord {
  id: bigint;
  userId: bigint;
  tokenHash: string;
  userAgent: string | null;
  ip: string | null;
  createdAt: Date;
  expiresAt: Date;
}

export interface EmailTokenRecord {
  id: bigint;
  userId: bigint;
  type: 'verify' | 'reset';
  tokenHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  createdAt: Date;
}

export interface UserSettingsRecord {
  userId: bigint;
  reminderEnabled: boolean;
  reminderTime: string;
  weeklySummaryEnabled: boolean;
  summaryDeliveryTime: string;
  dailyWordGoal: number;
}

export interface HardDeleteJobPayload {
  userId: string;
  scheduledFor: string;
}

export interface AccountJobScheduler {
  enqueueHardDelete(userId: bigint, runAt: Date): Promise<void>;
  cancelHardDelete(userId: bigint): Promise<void>;
}

export interface TurnstileVerifier {
  verify(token: string | undefined, remoteIp: string | undefined): Promise<boolean>;
}

export interface AuthRepository {
  findUserByEmail(email: string): Promise<UserRecord | null>;
  findUserById(id: bigint): Promise<UserRecord | null>;
  createUser(params: {
    email: string;
    passwordHash: string;
    timezone: string;
    now: Date;
  }): Promise<UserRecord>;
  updateUserVerified(userId: bigint, verifiedAt: Date): Promise<void>;
  updateUserPassword(userId: bigint, passwordHash: string): Promise<void>;
  updateUserLastLogin(userId: bigint, lastLoginAt: Date): Promise<void>;
  updateUserDeletedAt(userId: bigint, deletedAt: Date | null): Promise<void>;
  hardDeleteUser(userId: bigint): Promise<void>;

  getSettings(userId: bigint): Promise<UserSettingsRecord>;
  updateSettings(
    userId: bigint,
    patch: {
      timezone?: string;
      reminderEnabled?: boolean;
      reminderTime?: string;
      weeklySummaryEnabled?: boolean;
      summaryDeliveryTime?: string;
      dailyWordGoal?: number;
      aiConsentAt?: Date | null;
    },
  ): Promise<{ user: UserRecord; settings: UserSettingsRecord }>;

  createSession(params: {
    userId: bigint;
    tokenHash: string;
    userAgent: string | null;
    ip: string | null;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<SessionRecord>;
  findActiveSessionByHash(tokenHash: string, now: Date): Promise<SessionRecord | null>;
  updateSessionExpiry(sessionId: bigint, expiresAt: Date): Promise<void>;
  listActiveSessionsForUser(userId: bigint, now: Date): Promise<SessionRecord[]>;
  revokeSessionById(userId: bigint, sessionId: bigint): Promise<boolean>;
  revokeSessionByHash(tokenHash: string): Promise<void>;
  revokeAllUserSessions(userId: bigint): Promise<void>;

  createEmailToken(params: {
    userId: bigint;
    type: 'verify' | 'reset';
    tokenHash: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<EmailTokenRecord>;
  consumeEmailToken(
    type: 'verify' | 'reset',
    tokenHash: string,
    now: Date,
  ): Promise<EmailTokenRecord | null>;
}

/**
 * In-memory `AuthRepository` implementation for fast, deterministic unit and integration testing.
 */
export class InMemoryAuthRepository implements AuthRepository {
  public readonly users = new Map<bigint, UserRecord>();
  public readonly settings = new Map<bigint, UserSettingsRecord>();
  public readonly sessions = new Map<bigint, SessionRecord>();
  public readonly emailTokens = new Map<bigint, EmailTokenRecord>();

  private nextUserId = 1n;
  private nextSessionId = 1n;
  private nextTokenId = 1n;

  public async findUserByEmail(email: string): Promise<UserRecord | null> {
    const normalized = email.trim().toLowerCase();
    for (const u of this.users.values()) {
      if (u.email.toLowerCase() === normalized) {
        return { ...u };
      }
    }
    return null;
  }

  public async findUserById(id: bigint): Promise<UserRecord | null> {
    const u = this.users.get(id);
    return u ? { ...u } : null;
  }

  public async createUser(params: {
    email: string;
    passwordHash: string;
    timezone: string;
    now: Date;
  }): Promise<UserRecord> {
    const existing = await this.findUserByEmail(params.email);
    if (existing) {
      throw new Error('DUPLICATE_EMAIL');
    }

    const id = this.nextUserId++;
    const user: UserRecord = {
      id,
      email: params.email.trim(),
      passwordHash: params.passwordHash,
      timezone: params.timezone,
      emailVerifiedAt: null,
      aiConsentAt: null,
      createdAt: new Date(params.now),
      lastLoginAt: null,
      deletedAt: null,
    };
    this.users.set(id, user);

    this.settings.set(id, {
      userId: id,
      reminderEnabled: false,
      reminderTime: '07:00',
      weeklySummaryEnabled: false,
      summaryDeliveryTime: '18:00',
      dailyWordGoal: 750,
    });

    return { ...user };
  }

  public async updateUserVerified(userId: bigint, verifiedAt: Date): Promise<void> {
    const u = this.users.get(userId);
    if (u) {
      u.emailVerifiedAt = new Date(verifiedAt);
    }
  }

  public async updateUserPassword(userId: bigint, passwordHash: string): Promise<void> {
    const u = this.users.get(userId);
    if (u) {
      u.passwordHash = passwordHash;
    }
  }

  public async updateUserLastLogin(userId: bigint, lastLoginAt: Date): Promise<void> {
    const u = this.users.get(userId);
    if (u) {
      u.lastLoginAt = new Date(lastLoginAt);
    }
  }

  public async updateUserDeletedAt(userId: bigint, deletedAt: Date | null): Promise<void> {
    const u = this.users.get(userId);
    if (u) {
      u.deletedAt = deletedAt ? new Date(deletedAt) : null;
    }
  }

  public async hardDeleteUser(userId: bigint): Promise<void> {
    this.users.delete(userId);
    this.settings.delete(userId);
    for (const [sid, s] of this.sessions.entries()) {
      if (s.userId === userId) this.sessions.delete(sid);
    }
    for (const [tid, t] of this.emailTokens.entries()) {
      if (t.userId === userId) this.emailTokens.delete(tid);
    }
  }

  public async getSettings(userId: bigint): Promise<UserSettingsRecord> {
    let s = this.settings.get(userId);
    if (!s) {
      s = {
        userId,
        reminderEnabled: false,
        reminderTime: '07:00',
        weeklySummaryEnabled: false,
        summaryDeliveryTime: '18:00',
        dailyWordGoal: 750,
      };
      this.settings.set(userId, s);
    }
    return { ...s };
  }

  public async updateSettings(
    userId: bigint,
    patch: {
      timezone?: string;
      reminderEnabled?: boolean;
      reminderTime?: string;
      weeklySummaryEnabled?: boolean;
      summaryDeliveryTime?: string;
      dailyWordGoal?: number;
      aiConsentAt?: Date | null;
    },
  ): Promise<{ user: UserRecord; settings: UserSettingsRecord }> {
    const u = this.users.get(userId);
    if (!u) {
      throw new Error('USER_NOT_FOUND');
    }
    const s = await this.getSettings(userId);

    if (patch.timezone !== undefined) u.timezone = patch.timezone;
    if (patch.aiConsentAt !== undefined) u.aiConsentAt = patch.aiConsentAt;
    if (patch.reminderEnabled !== undefined) s.reminderEnabled = patch.reminderEnabled;
    if (patch.reminderTime !== undefined) s.reminderTime = patch.reminderTime;
    if (patch.weeklySummaryEnabled !== undefined) {
      s.weeklySummaryEnabled = patch.weeklySummaryEnabled;
    }
    if (patch.summaryDeliveryTime !== undefined) {
      s.summaryDeliveryTime = patch.summaryDeliveryTime;
    }
    if (patch.dailyWordGoal !== undefined) s.dailyWordGoal = patch.dailyWordGoal;

    this.settings.set(userId, s);
    return { user: { ...u }, settings: { ...s } };
  }

  public async createSession(params: {
    userId: bigint;
    tokenHash: string;
    userAgent: string | null;
    ip: string | null;
    createdAt: Date;
    expiresAt: Date;
  }): Promise<SessionRecord> {
    const id = this.nextSessionId++;
    const record: SessionRecord = {
      id,
      userId: params.userId,
      tokenHash: params.tokenHash,
      userAgent: params.userAgent,
      ip: params.ip,
      createdAt: new Date(params.createdAt),
      expiresAt: new Date(params.expiresAt),
    };
    this.sessions.set(id, record);
    return { ...record };
  }

  public async findActiveSessionByHash(
    tokenHash: string,
    now: Date,
  ): Promise<SessionRecord | null> {
    for (const s of this.sessions.values()) {
      if (s.tokenHash === tokenHash && s.expiresAt.getTime() > now.getTime()) {
        return { ...s };
      }
    }
    return null;
  }

  public async updateSessionExpiry(sessionId: bigint, expiresAt: Date): Promise<void> {
    const s = this.sessions.get(sessionId);
    if (s) {
      s.expiresAt = new Date(expiresAt);
    }
  }

  public async listActiveSessionsForUser(userId: bigint, now: Date): Promise<SessionRecord[]> {
    const list: SessionRecord[] = [];
    for (const s of this.sessions.values()) {
      if (s.userId === userId && s.expiresAt.getTime() > now.getTime()) {
        list.push({ ...s });
      }
    }
    return list.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  public async revokeSessionById(userId: bigint, sessionId: bigint): Promise<boolean> {
    const s = this.sessions.get(sessionId);
    if (!s || s.userId !== userId) {
      return false;
    }
    this.sessions.delete(sessionId);
    return true;
  }

  public async revokeSessionByHash(tokenHash: string): Promise<void> {
    for (const [id, s] of this.sessions.entries()) {
      if (s.tokenHash === tokenHash) {
        this.sessions.delete(id);
      }
    }
  }

  public async revokeAllUserSessions(userId: bigint): Promise<void> {
    for (const [id, s] of this.sessions.entries()) {
      if (s.userId === userId) {
        this.sessions.delete(id);
      }
    }
  }

  public async createEmailToken(params: {
    userId: bigint;
    type: 'verify' | 'reset';
    tokenHash: string;
    expiresAt: Date;
    createdAt: Date;
  }): Promise<EmailTokenRecord> {
    const id = this.nextTokenId++;
    const record: EmailTokenRecord = {
      id,
      userId: params.userId,
      type: params.type,
      tokenHash: params.tokenHash,
      expiresAt: new Date(params.expiresAt),
      usedAt: null,
      createdAt: new Date(params.createdAt),
    };
    this.emailTokens.set(id, record);
    return { ...record };
  }

  public async consumeEmailToken(
    type: 'verify' | 'reset',
    tokenHash: string,
    now: Date,
  ): Promise<EmailTokenRecord | null> {
    for (const t of this.emailTokens.values()) {
      if (
        t.type === type &&
        t.tokenHash === tokenHash &&
        t.usedAt === null &&
        t.expiresAt.getTime() > now.getTime()
      ) {
        t.usedAt = new Date(now);
        return { ...t };
      }
    }
    return null;
  }
}

/**
 * PostgreSQL Drizzle `AuthRepository` implementation matching `schema.sql`.
 */
export function createDrizzleAuthRepository(db: Database): AuthRepository {
  return {
    async findUserByEmail(email) {
      const rows = await db.select().from(users).where(eq(users.email, email.trim())).limit(1);
      return rows[0] ?? null;
    },

    async findUserById(id) {
      const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
      return rows[0] ?? null;
    },

    async createUser({ email, passwordHash, timezone, now }) {
      const inserted = await db
        .insert(users)
        .values({
          email: email.trim(),
          passwordHash,
          timezone,
          createdAt: now,
        })
        .returning();
      const user = inserted[0];
      if (!user) {
        throw new Error('Failed to insert user');
      }

      await db
        .insert(userSettings)
        .values({
          userId: user.id,
          reminderEnabled: false,
          reminderTime: '07:00',
          weeklySummaryEnabled: false,
          summaryDeliveryTime: '18:00',
          dailyWordGoal: 750,
        })
        .onConflictDoNothing();

      return user;
    },

    async updateUserVerified(userId, verifiedAt) {
      await db.update(users).set({ emailVerifiedAt: verifiedAt }).where(eq(users.id, userId));
    },

    async updateUserPassword(userId, passwordHash) {
      await db.update(users).set({ passwordHash }).where(eq(users.id, userId));
    },

    async updateUserLastLogin(userId, lastLoginAt) {
      await db.update(users).set({ lastLoginAt }).where(eq(users.id, userId));
    },

    async updateUserDeletedAt(userId, deletedAt) {
      await db.update(users).set({ deletedAt }).where(eq(users.id, userId));
    },

    async hardDeleteUser(userId) {
      await db.delete(users).where(eq(users.id, userId));
    },

    async getSettings(userId) {
      const rows = await db
        .select()
        .from(userSettings)
        .where(eq(userSettings.userId, userId))
        .limit(1);
      if (rows[0]) {
        return rows[0];
      }
      const inserted = await db.insert(userSettings).values({ userId }).returning();
      return inserted[0]!;
    },

    async updateSettings(userId, patch) {
      if (patch.timezone !== undefined || patch.aiConsentAt !== undefined) {
        await db
          .update(users)
          .set({
            ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
            ...(patch.aiConsentAt !== undefined ? { aiConsentAt: patch.aiConsentAt } : {}),
          })
          .where(eq(users.id, userId));
      }

      const settingsPatch: Partial<typeof userSettings.$inferInsert> = {};
      if (patch.reminderEnabled !== undefined) {
        settingsPatch.reminderEnabled = patch.reminderEnabled;
      }
      if (patch.reminderTime !== undefined) settingsPatch.reminderTime = patch.reminderTime;
      if (patch.weeklySummaryEnabled !== undefined) {
        settingsPatch.weeklySummaryEnabled = patch.weeklySummaryEnabled;
      }
      if (patch.summaryDeliveryTime !== undefined) {
        settingsPatch.summaryDeliveryTime = patch.summaryDeliveryTime;
      }
      if (patch.dailyWordGoal !== undefined) settingsPatch.dailyWordGoal = patch.dailyWordGoal;

      if (Object.keys(settingsPatch).length > 0) {
        await db.update(userSettings).set(settingsPatch).where(eq(userSettings.userId, userId));
      }

      const user = await this.findUserById(userId);
      if (!user) {
        throw new Error('USER_NOT_FOUND');
      }
      const settings = await this.getSettings(userId);
      return { user, settings };
    },

    async createSession(params) {
      const inserted = await db.insert(sessions).values(params).returning();
      return inserted[0]!;
    },

    async findActiveSessionByHash(tokenHash, now) {
      const rows = await db
        .select()
        .from(sessions)
        .where(and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)))
        .limit(1);
      return rows[0] ?? null;
    },

    async updateSessionExpiry(sessionId, expiresAt) {
      await db.update(sessions).set({ expiresAt }).where(eq(sessions.id, sessionId));
    },

    async listActiveSessionsForUser(userId, now) {
      return db
        .select()
        .from(sessions)
        .where(and(eq(sessions.userId, userId), gt(sessions.expiresAt, now)));
    },

    async revokeSessionById(userId, sessionId) {
      const deleted = await db
        .delete(sessions)
        .where(and(eq(sessions.id, sessionId), eq(sessions.userId, userId)))
        .returning({ id: sessions.id });
      return deleted.length > 0;
    },

    async revokeSessionByHash(tokenHash) {
      await db.delete(sessions).where(eq(sessions.tokenHash, tokenHash));
    },

    async revokeAllUserSessions(userId) {
      await db.delete(sessions).where(eq(sessions.userId, userId));
    },

    async createEmailToken(params) {
      const inserted = await db.insert(emailTokens).values(params).returning();
      return inserted[0]!;
    },

    async consumeEmailToken(type, tokenHash, now) {
      const updated = await db
        .update(emailTokens)
        .set({ usedAt: now })
        .where(
          and(
            eq(emailTokens.type, type),
            eq(emailTokens.tokenHash, tokenHash),
            isNull(emailTokens.usedAt),
            gt(emailTokens.expiresAt, now),
          ),
        )
        .returning();
      return updated[0] ?? null;
    },
  };
}
