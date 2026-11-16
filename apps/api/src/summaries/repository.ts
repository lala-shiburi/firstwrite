import { and, asc, desc, eq, gte, isNotNull, isNull, lte, sql } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { entries, userSettings, users, weeklySummaries } from '../db/schema.js';
import type { EntryRecord } from '../entries/index.js';

export interface WeeklySummaryRecord {
  id: bigint;
  userId: bigint;
  weekStart: string;
  weekEnd: string;
  status: 'pending' | 'done' | 'skipped' | 'failed';
  summaryEnc: string | null;
  keyVersion: number;
  themesEnc: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  skipReason: string | null;
  createdAt: Date;
  deliveredAt: Date | null;
}

export interface SummaryCandidateUser {
  userId: bigint;
  email: string;
  timezone: string;
  aiConsentAt: Date;
  weeklySummaryEnabled: boolean;
  summaryDeliveryTime: string;
}

export interface SummariesRepository {
  /**
   * Fetches a batch of active users (`deleted_at IS NULL`) who have BOTH `users.ai_consent_at IS NOT NULL`
   * AND `user_settings.weekly_summary_enabled = true` (AGENTS.md Rule 5), ordered by `user_id`
   * for cursor-paginated batch processing.
   */
  fetchSummaryEligibleUsersBatch(
    afterUserId: bigint,
    batchSize: number,
  ): Promise<SummaryCandidateUser[]>;

  /**
   * Re-reads the user's current consent and enabled flags from storage immediately before calling the LLM
   * so mid-run consent withdrawal aborts cleanly.
   */
  checkUserConsentActive(userId: bigint): Promise<{
    consentedAndEnabled: boolean;
    email: string | null;
    timezone?: string;
  }>;

  findSummaryByUserAndWeek(userId: bigint, weekStart: string): Promise<WeeklySummaryRecord | null>;

  /**
   * Atomically inserts a `pending` row for `(userId, weekStart)`.
   * Returns `true` if inserted, or `false` if a row for `(userId, weekStart)` already exists.
   */
  insertPendingSummaryIfAbsent(params: {
    userId: bigint;
    weekStart: string;
    weekEnd: string;
    now: Date;
  }): Promise<boolean>;

  markSummarySkipped(params: {
    userId: bigint;
    weekStart: string;
    skipReason: string;
  }): Promise<void>;

  markSummaryFailed(params: {
    userId: bigint;
    weekStart: string;
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
  }): Promise<void>;

  markSummaryDone(params: {
    userId: bigint;
    weekStart: string;
    summaryEnc: string;
    themesEnc: string;
    keyVersion: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    deliveredAt: Date;
  }): Promise<void>;

  /**
   * Loads the user's encrypted entries for `[weekStart, weekEnd]` ordered chronologically (`entry_date ASC`).
   */
  fetchWeekEntriesForUser(
    userId: bigint,
    weekStart: string,
    weekEnd: string,
  ): Promise<EntryRecord[]>;

  /**
   * Computes total recorded `input_tokens` and `output_tokens` across all `weekly_summaries` rows
   * created since `monthStartUtc` for monthly spend ceiling enforcement.
   */
  getMonthlyTokenUsage(monthStartUtc: Date): Promise<{
    inputTokens: number;
    outputTokens: number;
  }>;

  listSummariesForUser(userId: bigint): Promise<WeeklySummaryRecord[]>;

  deleteSummaryByUserAndWeek(userId: bigint, weekStart: string): Promise<boolean>;
}

export class InMemorySummariesRepository implements SummariesRepository {
  public readonly summaries = new Map<bigint, WeeklySummaryRecord>();
  private nextId = 1n;

  private readonly getUsersAndSettings?: () => Array<{
    userId: bigint;
    email: string;
    timezone: string;
    deletedAt: Date | null;
    aiConsentAt: Date | null;
    weeklySummaryEnabled: boolean;
    summaryDeliveryTime: string;
  }>;
  private readonly getEntries?: () => Iterable<EntryRecord>;

  constructor(options?: {
    getUsersAndSettings?: () => Array<{
      userId: bigint;
      email: string;
      timezone: string;
      deletedAt: Date | null;
      aiConsentAt: Date | null;
      weeklySummaryEnabled: boolean;
      summaryDeliveryTime: string;
    }>;
    getEntries?: () => Iterable<EntryRecord>;
  }) {
    this.getUsersAndSettings = options?.getUsersAndSettings;
    this.getEntries = options?.getEntries;
  }

  public async fetchSummaryEligibleUsersBatch(
    afterUserId: bigint,
    batchSize: number,
  ): Promise<SummaryCandidateUser[]> {
    if (!this.getUsersAndSettings) return [];
    return this.getUsersAndSettings()
      .filter(
        (u) =>
          u.deletedAt === null &&
          u.aiConsentAt !== null &&
          u.weeklySummaryEnabled &&
          u.userId > afterUserId,
      )
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
      .slice(0, batchSize)
      .map((u) => ({
        userId: u.userId,
        email: u.email,
        timezone: u.timezone,
        aiConsentAt: new Date(u.aiConsentAt!),
        weeklySummaryEnabled: u.weeklySummaryEnabled,
        summaryDeliveryTime: u.summaryDeliveryTime,
      }));
  }

  public async checkUserConsentActive(userId: bigint): Promise<{
    consentedAndEnabled: boolean;
    email: string | null;
    timezone?: string;
  }> {
    if (!this.getUsersAndSettings) {
      return { consentedAndEnabled: false, email: null, timezone: 'UTC' };
    }
    const found = this.getUsersAndSettings().find((u) => u.userId === userId);
    if (!found || found.deletedAt !== null) {
      return { consentedAndEnabled: false, email: null, timezone: 'UTC' };
    }
    return {
      consentedAndEnabled: Boolean(found.aiConsentAt !== null && found.weeklySummaryEnabled),
      email: found.email,
      timezone: found.timezone,
    };
  }

  public async findSummaryByUserAndWeek(
    userId: bigint,
    weekStart: string,
  ): Promise<WeeklySummaryRecord | null> {
    for (const s of this.summaries.values()) {
      if (s.userId === userId && s.weekStart === weekStart) {
        return { ...s };
      }
    }
    return null;
  }

  public async insertPendingSummaryIfAbsent(params: {
    userId: bigint;
    weekStart: string;
    weekEnd: string;
    now: Date;
  }): Promise<boolean> {
    const existing = await this.findSummaryByUserAndWeek(params.userId, params.weekStart);
    if (existing) {
      return false;
    }

    const id = this.nextId++;
    const record: WeeklySummaryRecord = {
      id,
      userId: params.userId,
      weekStart: params.weekStart,
      weekEnd: params.weekEnd,
      status: 'pending',
      summaryEnc: null,
      keyVersion: 1,
      themesEnc: null,
      model: null,
      inputTokens: null,
      outputTokens: null,
      skipReason: null,
      createdAt: new Date(params.now),
      deliveredAt: null,
    };
    this.summaries.set(id, record);
    return true;
  }

  public async markSummarySkipped(params: {
    userId: bigint;
    weekStart: string;
    skipReason: string;
  }): Promise<void> {
    for (const s of this.summaries.values()) {
      if (s.userId === params.userId && s.weekStart === params.weekStart) {
        s.status = 'skipped';
        s.skipReason = params.skipReason;
        return;
      }
    }
  }

  public async markSummaryFailed(params: {
    userId: bigint;
    weekStart: string;
    model?: string | null;
    inputTokens?: number | null;
    outputTokens?: number | null;
  }): Promise<void> {
    for (const s of this.summaries.values()) {
      if (s.userId === params.userId && s.weekStart === params.weekStart) {
        s.status = 'failed';
        if (params.model !== undefined) s.model = params.model;
        if (params.inputTokens !== undefined) s.inputTokens = params.inputTokens;
        if (params.outputTokens !== undefined) s.outputTokens = params.outputTokens;
        return;
      }
    }
  }

  public async markSummaryDone(params: {
    userId: bigint;
    weekStart: string;
    summaryEnc: string;
    themesEnc: string;
    keyVersion: number;
    model: string;
    inputTokens: number;
    outputTokens: number;
    deliveredAt: Date;
  }): Promise<void> {
    for (const s of this.summaries.values()) {
      if (s.userId === params.userId && s.weekStart === params.weekStart) {
        s.status = 'done';
        s.summaryEnc = params.summaryEnc;
        s.themesEnc = params.themesEnc;
        s.keyVersion = params.keyVersion;
        s.model = params.model;
        s.inputTokens = params.inputTokens;
        s.outputTokens = params.outputTokens;
        s.skipReason = null;
        s.deliveredAt = new Date(params.deliveredAt);
        return;
      }
    }
  }

  public async fetchWeekEntriesForUser(
    userId: bigint,
    weekStart: string,
    weekEnd: string,
  ): Promise<EntryRecord[]> {
    if (!this.getEntries) return [];
    const list: EntryRecord[] = [];
    for (const e of this.getEntries()) {
      if (e.userId === userId && e.entryDate >= weekStart && e.entryDate <= weekEnd) {
        list.push({ ...e });
      }
    }
    return list.sort((a, b) =>
      a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0,
    );
  }

  public async getMonthlyTokenUsage(monthStartUtc: Date): Promise<{
    inputTokens: number;
    outputTokens: number;
  }> {
    let inputTokens = 0;
    let outputTokens = 0;
    for (const s of this.summaries.values()) {
      if (s.createdAt.getTime() >= monthStartUtc.getTime()) {
        inputTokens += s.inputTokens ?? 0;
        outputTokens += s.outputTokens ?? 0;
      }
    }
    return { inputTokens, outputTokens };
  }

  public async listSummariesForUser(userId: bigint): Promise<WeeklySummaryRecord[]> {
    const list: WeeklySummaryRecord[] = [];
    for (const s of this.summaries.values()) {
      if (s.userId === userId) {
        list.push({ ...s });
      }
    }
    return list.sort((a, b) =>
      a.weekStart > b.weekStart ? -1 : a.weekStart < b.weekStart ? 1 : 0,
    );
  }

  public async deleteSummaryByUserAndWeek(userId: bigint, weekStart: string): Promise<boolean> {
    for (const [id, s] of this.summaries.entries()) {
      if (s.userId === userId && s.weekStart === weekStart) {
        this.summaries.delete(id);
        return true;
      }
    }
    return false;
  }
}

export function createDrizzleSummariesRepository(db: Database): SummariesRepository {
  return {
    async fetchSummaryEligibleUsersBatch(afterUserId, batchSize) {
      const rows = await db
        .select({
          userId: userSettings.userId,
          email: users.email,
          timezone: users.timezone,
          aiConsentAt: users.aiConsentAt,
          weeklySummaryEnabled: userSettings.weeklySummaryEnabled,
          summaryDeliveryTime: userSettings.summaryDeliveryTime,
        })
        .from(userSettings)
        .innerJoin(users, eq(userSettings.userId, users.id))
        .where(
          and(
            eq(userSettings.weeklySummaryEnabled, true),
            isNotNull(users.aiConsentAt),
            isNull(users.deletedAt),
            sql`${userSettings.userId} > ${afterUserId}`,
          ),
        )
        .orderBy(asc(userSettings.userId))
        .limit(batchSize);

      return rows.map((r) => ({
        userId: r.userId,
        email: r.email,
        timezone: r.timezone,
        aiConsentAt: r.aiConsentAt!,
        weeklySummaryEnabled: r.weeklySummaryEnabled,
        summaryDeliveryTime: r.summaryDeliveryTime,
      }));
    },

    async checkUserConsentActive(userId) {
      const rows = await db
        .select({
          email: users.email,
          timezone: users.timezone,
          deletedAt: users.deletedAt,
          aiConsentAt: users.aiConsentAt,
          weeklySummaryEnabled: userSettings.weeklySummaryEnabled,
        })
        .from(users)
        .innerJoin(userSettings, eq(users.id, userSettings.userId))
        .where(eq(users.id, userId))
        .limit(1);

      const row = rows[0];
      if (!row || row.deletedAt !== null) {
        return { consentedAndEnabled: false, email: null, timezone: 'UTC' };
      }
      return {
        consentedAndEnabled: Boolean(row.aiConsentAt !== null && row.weeklySummaryEnabled),
        email: row.email,
        timezone: row.timezone,
      };
    },

    async findSummaryByUserAndWeek(userId, weekStart) {
      const rows = await db
        .select()
        .from(weeklySummaries)
        .where(and(eq(weeklySummaries.userId, userId), eq(weeklySummaries.weekStart, weekStart)))
        .limit(1);
      return rows[0] ?? null;
    },

    async insertPendingSummaryIfAbsent({ userId, weekStart, weekEnd, now }) {
      const inserted = await db
        .insert(weeklySummaries)
        .values({
          userId,
          weekStart,
          weekEnd,
          status: 'pending',
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: weeklySummaries.id });
      return inserted.length > 0;
    },

    async markSummarySkipped({ userId, weekStart, skipReason }) {
      await db
        .update(weeklySummaries)
        .set({
          status: 'skipped',
          skipReason,
        })
        .where(and(eq(weeklySummaries.userId, userId), eq(weeklySummaries.weekStart, weekStart)));
    },

    async markSummaryFailed({ userId, weekStart, model, inputTokens, outputTokens }) {
      await db
        .update(weeklySummaries)
        .set({
          status: 'failed',
          ...(model !== undefined ? { model } : {}),
          ...(inputTokens !== undefined ? { inputTokens } : {}),
          ...(outputTokens !== undefined ? { outputTokens } : {}),
        })
        .where(and(eq(weeklySummaries.userId, userId), eq(weeklySummaries.weekStart, weekStart)));
    },

    async markSummaryDone({
      userId,
      weekStart,
      summaryEnc,
      themesEnc,
      keyVersion,
      model,
      inputTokens,
      outputTokens,
      deliveredAt,
    }) {
      await db
        .update(weeklySummaries)
        .set({
          status: 'done',
          summaryEnc,
          themesEnc,
          keyVersion,
          model,
          inputTokens,
          outputTokens,
          skipReason: null,
          deliveredAt,
        })
        .where(and(eq(weeklySummaries.userId, userId), eq(weeklySummaries.weekStart, weekStart)));
    },

    async fetchWeekEntriesForUser(userId, weekStart, weekEnd) {
      return db
        .select()
        .from(entries)
        .where(
          and(
            eq(entries.userId, userId),
            gte(entries.entryDate, weekStart),
            lte(entries.entryDate, weekEnd),
          ),
        )
        .orderBy(asc(entries.entryDate));
    },

    async getMonthlyTokenUsage(monthStartUtc) {
      const rows = await db
        .select({
          inputTokens: sql<number>`coalesce(sum(${weeklySummaries.inputTokens}), 0)::int`,
          outputTokens: sql<number>`coalesce(sum(${weeklySummaries.outputTokens}), 0)::int`,
        })
        .from(weeklySummaries)
        .where(gte(weeklySummaries.createdAt, monthStartUtc));

      return {
        inputTokens: rows[0]?.inputTokens ?? 0,
        outputTokens: rows[0]?.outputTokens ?? 0,
      };
    },

    async listSummariesForUser(userId) {
      return db
        .select()
        .from(weeklySummaries)
        .where(eq(weeklySummaries.userId, userId))
        .orderBy(desc(weeklySummaries.weekStart));
    },

    async deleteSummaryByUserAndWeek(userId, weekStart) {
      const deleted = await db
        .delete(weeklySummaries)
        .where(and(eq(weeklySummaries.userId, userId), eq(weeklySummaries.weekStart, weekStart)))
        .returning({ id: weeklySummaries.id });
      return deleted.length > 0;
    },
  };
}
