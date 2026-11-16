import { and, asc, eq, gt, isNull } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { entries, pushSubscriptions, userSettings, users } from '../db/schema.js';

export interface PushSubscriptionRecord {
  id: bigint;
  userId: bigint;
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent: string | null;
  createdAt: Date;
}

export interface ReminderCandidateUser {
  userId: bigint;
  timezone: string;
  reminderTime: string;
}

export interface PushRepository {
  upsertSubscription(params: {
    userId: bigint;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string | null;
    now: Date;
  }): Promise<PushSubscriptionRecord>;

  deleteSubscriptionByEndpoint(userId: bigint, endpoint: string): Promise<boolean>;
  deleteSubscriptionById(id: bigint): Promise<void>;
  listSubscriptionsForUser(userId: bigint): Promise<PushSubscriptionRecord[]>;

  /**
   * Fetches a batch of active users (`deleted_at IS NULL`) who have `reminder_enabled = true`,
   * ordered by `user_id` for cursor-based batch pagination (`user_id > afterUserId`).
   */
  fetchReminderEnabledUsersBatch(
    afterUserId: bigint,
    batchSize: number,
  ): Promise<ReminderCandidateUser[]>;

  /**
   * Checks whether the user has an entry on `localDate` with at least `minWordCount` words
   * (default `1` word: any non-empty entry counts as having written today).
   */
  hasEntryForLocalDate(userId: bigint, localDate: string, minWordCount?: number): Promise<boolean>;
}

/**
 * In-memory `PushRepository` for deterministic unit and integration testing.
 * Can optionally be wired to an `InMemoryAuthRepository` and `InMemoryEntriesRepository`.
 */
export class InMemoryPushRepository implements PushRepository {
  public readonly subscriptions = new Map<bigint, PushSubscriptionRecord>();
  private nextId = 1n;

  private readonly getUsersAndSettings?: () => Array<{
    userId: bigint;
    timezone: string;
    deletedAt: Date | null;
    reminderEnabled: boolean;
    reminderTime: string;
  }>;
  private readonly getEntryWordCount?: (userId: bigint, localDate: string) => number | null;

  constructor(options?: {
    getUsersAndSettings?: () => Array<{
      userId: bigint;
      timezone: string;
      deletedAt: Date | null;
      reminderEnabled: boolean;
      reminderTime: string;
    }>;
    getEntryWordCount?: (userId: bigint, localDate: string) => number | null;
  }) {
    this.getUsersAndSettings = options?.getUsersAndSettings;
    this.getEntryWordCount = options?.getEntryWordCount;
  }

  public async upsertSubscription(params: {
    userId: bigint;
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent: string | null;
    now: Date;
  }): Promise<PushSubscriptionRecord> {
    for (const [id, existing] of this.subscriptions.entries()) {
      if (existing.endpoint === params.endpoint) {
        const updated: PushSubscriptionRecord = {
          id,
          userId: params.userId,
          endpoint: params.endpoint,
          p256dh: params.p256dh,
          auth: params.auth,
          userAgent: params.userAgent,
          createdAt: new Date(params.now),
        };
        this.subscriptions.set(id, updated);
        return { ...updated };
      }
    }

    const id = this.nextId++;
    const record: PushSubscriptionRecord = {
      id,
      userId: params.userId,
      endpoint: params.endpoint,
      p256dh: params.p256dh,
      auth: params.auth,
      userAgent: params.userAgent,
      createdAt: new Date(params.now),
    };
    this.subscriptions.set(id, record);
    return { ...record };
  }

  public async deleteSubscriptionByEndpoint(userId: bigint, endpoint: string): Promise<boolean> {
    for (const [id, sub] of this.subscriptions.entries()) {
      if (sub.userId === userId && sub.endpoint === endpoint) {
        this.subscriptions.delete(id);
        return true;
      }
    }
    return false;
  }

  public async deleteSubscriptionById(id: bigint): Promise<void> {
    this.subscriptions.delete(id);
  }

  public async listSubscriptionsForUser(userId: bigint): Promise<PushSubscriptionRecord[]> {
    const result: PushSubscriptionRecord[] = [];
    for (const sub of this.subscriptions.values()) {
      if (sub.userId === userId) {
        result.push({ ...sub });
      }
    }
    return result.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  public async fetchReminderEnabledUsersBatch(
    afterUserId: bigint,
    batchSize: number,
  ): Promise<ReminderCandidateUser[]> {
    if (!this.getUsersAndSettings) return [];
    const all = this.getUsersAndSettings()
      .filter((u) => u.deletedAt === null && u.reminderEnabled && u.userId > afterUserId)
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
      .slice(0, batchSize);

    return all.map((u) => ({
      userId: u.userId,
      timezone: u.timezone,
      reminderTime: u.reminderTime,
    }));
  }

  public async hasEntryForLocalDate(
    userId: bigint,
    localDate: string,
    minWordCount = 1,
  ): Promise<boolean> {
    if (!this.getEntryWordCount) return false;
    const wc = this.getEntryWordCount(userId, localDate);
    return wc !== null && wc >= minWordCount;
  }
}

/**
 * PostgreSQL Drizzle `PushRepository` implementation using `settings_reminder_idx`,
 * `push_subs_user_idx`, and `entries_user_date_idx` from `schema.sql`.
 */
export function createDrizzlePushRepository(db: Database): PushRepository {
  return {
    async upsertSubscription({ userId, endpoint, p256dh, auth, userAgent, now }) {
      const rows = await db
        .insert(pushSubscriptions)
        .values({
          userId,
          endpoint,
          p256dh,
          auth,
          userAgent,
          createdAt: now,
        })
        .onConflictDoUpdate({
          target: pushSubscriptions.endpoint,
          set: {
            userId,
            p256dh,
            auth,
            userAgent,
            createdAt: now,
          },
        })
        .returning();
      return rows[0]!;
    },

    async deleteSubscriptionByEndpoint(userId, endpoint) {
      const deleted = await db
        .delete(pushSubscriptions)
        .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, endpoint)))
        .returning({ id: pushSubscriptions.id });
      return deleted.length > 0;
    },

    async deleteSubscriptionById(id) {
      await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, id));
    },

    async listSubscriptionsForUser(userId) {
      return db
        .select()
        .from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId))
        .orderBy(asc(pushSubscriptions.id));
    },

    async fetchReminderEnabledUsersBatch(afterUserId, batchSize) {
      return db
        .select({
          userId: userSettings.userId,
          timezone: users.timezone,
          reminderTime: userSettings.reminderTime,
        })
        .from(userSettings)
        .innerJoin(users, eq(userSettings.userId, users.id))
        .where(
          and(
            eq(userSettings.reminderEnabled, true),
            isNull(users.deletedAt),
            gt(userSettings.userId, afterUserId),
          ),
        )
        .orderBy(asc(userSettings.userId))
        .limit(batchSize);
    },

    async hasEntryForLocalDate(userId, localDate, minWordCount = 1) {
      const rows = await db
        .select({ wordCount: entries.wordCount })
        .from(entries)
        .where(and(eq(entries.userId, userId), eq(entries.entryDate, localDate)))
        .limit(1);
      const row = rows[0];
      return Boolean(row && row.wordCount >= minWordCount);
    },
  };
}
