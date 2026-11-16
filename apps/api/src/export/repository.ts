import { and, asc, eq, gt } from 'drizzle-orm';
import type { Database } from '../db/index.js';
import { entries, weeklySummaries } from '../db/schema.js';
import type { EntryRecord } from '../entries/index.js';

export interface WeeklySummaryExportRow {
  id: bigint;
  userId: bigint;
  weekStart: string;
  weekEnd: string;
  status: 'pending' | 'done' | 'skipped' | 'failed';
  summaryEnc: string | null;
  themesEnc: string | null;
  keyVersion: number;
  createdAt: Date;
  deliveredAt: Date | null;
}

export interface ExportRepository {
  /**
   * Fetches a batch of encrypted entries for `userId` ordered chronologically (`entry_date ASC, id ASC`)
   * using cursor pagination (`entry_date > afterEntryDate`) so memory stays flat across years of entries.
   */
  fetchEntriesBatch(params: {
    userId: bigint;
    afterEntryDate: string | null;
    batchSize: number;
  }): Promise<EntryRecord[]>;

  /**
   * Fetches a batch of completed (`status = 'done'`) encrypted weekly summaries for `userId`
   * ordered chronologically (`week_start ASC`) using cursor pagination (`week_start > afterWeekStart`).
   */
  fetchDoneSummariesBatch(params: {
    userId: bigint;
    afterWeekStart: string | null;
    batchSize: number;
  }): Promise<WeeklySummaryExportRow[]>;
}

export class InMemoryExportRepository implements ExportRepository {
  public readonly summaries = new Map<bigint, WeeklySummaryExportRow>();
  private nextSummaryId = 1n;
  private readonly getEntries: () => Iterable<EntryRecord>;

  constructor(getEntries: () => Iterable<EntryRecord>) {
    this.getEntries = getEntries;
  }

  public addSummary(row: Omit<WeeklySummaryExportRow, 'id'>): WeeklySummaryExportRow {
    const id = this.nextSummaryId++;
    const record: WeeklySummaryExportRow = { id, ...row };
    this.summaries.set(id, record);
    return { ...record };
  }

  public async fetchEntriesBatch(params: {
    userId: bigint;
    afterEntryDate: string | null;
    batchSize: number;
  }): Promise<EntryRecord[]> {
    const matching: EntryRecord[] = [];
    for (const r of this.getEntries()) {
      if (r.userId !== params.userId) continue;
      if (params.afterEntryDate !== null && r.entryDate <= params.afterEntryDate) continue;
      matching.push({ ...r });
    }
    return matching
      .sort((a, b) => (a.entryDate < b.entryDate ? -1 : a.entryDate > b.entryDate ? 1 : 0))
      .slice(0, params.batchSize);
  }

  public async fetchDoneSummariesBatch(params: {
    userId: bigint;
    afterWeekStart: string | null;
    batchSize: number;
  }): Promise<WeeklySummaryExportRow[]> {
    const matching: WeeklySummaryExportRow[] = [];
    for (const s of this.summaries.values()) {
      if (s.userId !== params.userId || s.status !== 'done') continue;
      if (params.afterWeekStart !== null && s.weekStart <= params.afterWeekStart) continue;
      matching.push({ ...s });
    }
    return matching
      .sort((a, b) => (a.weekStart < b.weekStart ? -1 : a.weekStart > b.weekStart ? 1 : 0))
      .slice(0, params.batchSize);
  }
}

export function createDrizzleExportRepository(db: Database): ExportRepository {
  return {
    async fetchEntriesBatch({ userId, afterEntryDate, batchSize }) {
      const conditions = [eq(entries.userId, userId)];
      if (afterEntryDate !== null) {
        conditions.push(gt(entries.entryDate, afterEntryDate));
      }
      return db
        .select()
        .from(entries)
        .where(and(...conditions))
        .orderBy(asc(entries.entryDate))
        .limit(batchSize);
    },

    async fetchDoneSummariesBatch({ userId, afterWeekStart, batchSize }) {
      const conditions = [eq(weeklySummaries.userId, userId), eq(weeklySummaries.status, 'done')];
      if (afterWeekStart !== null) {
        conditions.push(gt(weeklySummaries.weekStart, afterWeekStart));
      }
      return db
        .select({
          id: weeklySummaries.id,
          userId: weeklySummaries.userId,
          weekStart: weeklySummaries.weekStart,
          weekEnd: weeklySummaries.weekEnd,
          status: weeklySummaries.status,
          summaryEnc: weeklySummaries.summaryEnc,
          themesEnc: weeklySummaries.themesEnc,
          keyVersion: weeklySummaries.keyVersion,
          createdAt: weeklySummaries.createdAt,
          deliveredAt: weeklySummaries.deliveredAt,
        })
        .from(weeklySummaries)
        .where(and(...conditions))
        .orderBy(asc(weeklySummaries.weekStart))
        .limit(batchSize);
    },
  };
}
