import { and, desc, eq, gte, lte } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { entries } from '../db/schema.js';

export interface EntryRecord {
  id: bigint;
  userId: bigint;
  entryDate: string;
  contentEnc: string;
  keyVersion: number;
  wordCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface EntrySummaryRecord {
  id: bigint;
  userId: bigint;
  entryDate: string;
  wordCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export type UpsertEntryOutcome =
  | { status: 'saved'; record: EntryRecord; created: boolean }
  | { status: 'conflict'; serverRecord: EntryRecord };

export interface EntriesRepository {
  findByUserAndDate(userId: bigint, entryDate: string): Promise<EntryRecord | null>;
  listSummariesByUser(params: {
    userId: bigint;
    from?: string;
    to?: string;
  }): Promise<EntrySummaryRecord[]>;
  upsertEntry(params: {
    userId: bigint;
    entryDate: string;
    contentEnc: string;
    keyVersion: number;
    wordCount: number;
    now: Date;
    expectedUpdatedAt?: string | null;
  }): Promise<UpsertEntryOutcome>;
  deleteByUserAndDate(userId: bigint, entryDate: string): Promise<boolean>;
}

/**
 * In-memory `EntriesRepository` implementation for deterministic unit and integration testing.
 */
export class InMemoryEntriesRepository implements EntriesRepository {
  public readonly entries = new Map<bigint, EntryRecord>();
  private nextId = 1n;

  public async findByUserAndDate(userId: bigint, entryDate: string): Promise<EntryRecord | null> {
    for (const r of this.entries.values()) {
      if (r.userId === userId && r.entryDate === entryDate) {
        return {
          ...r,
          createdAt: new Date(r.createdAt),
          updatedAt: new Date(r.updatedAt),
        };
      }
    }
    return null;
  }

  public async listSummariesByUser(params: {
    userId: bigint;
    from?: string;
    to?: string;
  }): Promise<EntrySummaryRecord[]> {
    const results: EntrySummaryRecord[] = [];
    for (const r of this.entries.values()) {
      if (r.userId !== params.userId) continue;
      if (params.from && r.entryDate < params.from) continue;
      if (params.to && r.entryDate > params.to) continue;
      results.push({
        id: r.id,
        userId: r.userId,
        entryDate: r.entryDate,
        wordCount: r.wordCount,
        createdAt: new Date(r.createdAt),
        updatedAt: new Date(r.updatedAt),
      });
    }
    return results.sort((a, b) =>
      a.entryDate > b.entryDate ? -1 : a.entryDate < b.entryDate ? 1 : 0,
    );
  }

  public async upsertEntry(params: {
    userId: bigint;
    entryDate: string;
    contentEnc: string;
    keyVersion: number;
    wordCount: number;
    now: Date;
    expectedUpdatedAt?: string | null;
  }): Promise<UpsertEntryOutcome> {
    const existing = await this.findByUserAndDate(params.userId, params.entryDate);

    if (!existing) {
      // If client explicitly expected a specific existing updatedAt on a non-existent row,
      // allow insert because no newer server version exists.
      const id = this.nextId++;
      const createdRecord: EntryRecord = {
        id,
        userId: params.userId,
        entryDate: params.entryDate,
        contentEnc: params.contentEnc,
        keyVersion: params.keyVersion,
        wordCount: params.wordCount,
        createdAt: new Date(params.now),
        updatedAt: new Date(params.now),
      };
      this.entries.set(id, createdRecord);
      return {
        status: 'saved',
        record: { ...createdRecord },
        created: true,
      };
    }

    // Optimistic concurrency check:
    // - If expectedUpdatedAt === null, the client thought it was creating a brand-new entry,
    //   but a server row already exists (created by another device) -> conflict!
    // - If expectedUpdatedAt is an ISO string that does not match existing.updatedAt -> conflict!
    if (params.expectedUpdatedAt === null) {
      return { status: 'conflict', serverRecord: existing };
    }
    if (
      typeof params.expectedUpdatedAt === 'string' &&
      existing.updatedAt.toISOString() !== new Date(params.expectedUpdatedAt).toISOString()
    ) {
      return { status: 'conflict', serverRecord: existing };
    }

    const updatedRecord: EntryRecord = {
      ...existing,
      contentEnc: params.contentEnc,
      keyVersion: params.keyVersion,
      wordCount: params.wordCount,
      updatedAt: new Date(params.now),
    };
    this.entries.set(existing.id, updatedRecord);

    return {
      status: 'saved',
      record: { ...updatedRecord },
      created: false,
    };
  }

  public async deleteByUserAndDate(userId: bigint, entryDate: string): Promise<boolean> {
    for (const [id, r] of this.entries.entries()) {
      if (r.userId === userId && r.entryDate === entryDate) {
        this.entries.delete(id);
        return true;
      }
    }
    return false;
  }
}

/**
 * PostgreSQL Drizzle `EntriesRepository` implementation matching `schema.sql`.
 */
export function createDrizzleEntriesRepository(db: Database): EntriesRepository {
  return {
    async findByUserAndDate(userId, entryDate) {
      const rows = await db
        .select()
        .from(entries)
        .where(and(eq(entries.userId, userId), eq(entries.entryDate, entryDate)))
        .limit(1);
      return rows[0] ?? null;
    },

    async listSummariesByUser({ userId, from, to }) {
      const conditions = [eq(entries.userId, userId)];
      if (from) conditions.push(gte(entries.entryDate, from));
      if (to) conditions.push(lte(entries.entryDate, to));

      // Select ONLY metadata columns — never select or decrypt content_enc for list views
      return db
        .select({
          id: entries.id,
          userId: entries.userId,
          entryDate: entries.entryDate,
          wordCount: entries.wordCount,
          createdAt: entries.createdAt,
          updatedAt: entries.updatedAt,
        })
        .from(entries)
        .where(and(...conditions))
        .orderBy(desc(entries.entryDate));
    },

    async upsertEntry({
      userId,
      entryDate,
      contentEnc,
      keyVersion,
      wordCount,
      now,
      expectedUpdatedAt,
    }) {
      const existing = await this.findByUserAndDate(userId, entryDate);

      if (!existing) {
        const inserted = await db
          .insert(entries)
          .values({
            userId,
            entryDate,
            contentEnc,
            keyVersion,
            wordCount,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning();

        if (inserted[0]) {
          return { status: 'saved', record: inserted[0], created: true };
        }

        // Concurrent insert happened between findByUserAndDate and insert
        const current = await this.findByUserAndDate(userId, entryDate);
        if (current) {
          return { status: 'conflict', serverRecord: current };
        }
        throw new Error('Failed to upsert entry');
      }

      if (expectedUpdatedAt === null) {
        return { status: 'conflict', serverRecord: existing };
      }

      if (
        typeof expectedUpdatedAt === 'string' &&
        existing.updatedAt.toISOString() !== new Date(expectedUpdatedAt).toISOString()
      ) {
        return { status: 'conflict', serverRecord: existing };
      }

      const whereConditions = [eq(entries.id, existing.id)];
      if (typeof expectedUpdatedAt === 'string') {
        whereConditions.push(eq(entries.updatedAt, new Date(expectedUpdatedAt)));
      }

      const updated = await db
        .update(entries)
        .set({
          contentEnc,
          keyVersion,
          wordCount,
          updatedAt: now,
        })
        .where(and(...whereConditions))
        .returning();

      if (updated[0]) {
        return { status: 'saved', record: updated[0], created: false };
      }

      const latest = await this.findByUserAndDate(userId, entryDate);
      if (latest) {
        return { status: 'conflict', serverRecord: latest };
      }
      throw new Error('Entry disappeared during update');
    },

    async deleteByUserAndDate(userId, entryDate) {
      const deleted = await db
        .delete(entries)
        .where(and(eq(entries.userId, userId), eq(entries.entryDate, entryDate)))
        .returning({ id: entries.id });
      return deleted.length > 0;
    },
  };
}
