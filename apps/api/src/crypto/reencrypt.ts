import 'dotenv/config';
import { and, asc, eq, gt, ne } from 'drizzle-orm';
import { loadConfig } from '../config.js';
import { createDbPool, type Database } from '../db/index.js';
import { entries, weeklySummaries } from '../db/schema.js';
import { createLogger } from '../logger.js';
import { buildEntryAad, buildSummaryAad, decrypt, encrypt, type Keyring } from './encryption.js';

export interface EntryRotationRow {
  id: bigint;
  userId: bigint;
  entryDate: string;
  contentEnc: string;
  keyVersion: number;
}

export interface SummaryRotationRow {
  id: bigint;
  userId: bigint;
  weekStart: string;
  summaryEnc: string | null;
  themesEnc: string | null;
  keyVersion: number;
}

/**
 * Storage adapter interface for batch key rotation.
 * Allows running against either a real PostgreSQL Drizzle database or an in-memory store in unit tests.
 */
export interface ReencryptStorageAdapter {
  fetchEntriesBatch(
    targetVersion: number,
    afterId: bigint,
    batchSize: number,
  ): Promise<EntryRotationRow[]>;
  updateEntry(row: {
    id: bigint;
    expectedOldKeyVersion: number;
    contentEnc: string;
    keyVersion: number;
  }): Promise<boolean>;

  fetchSummariesBatch(
    targetVersion: number,
    afterId: bigint,
    batchSize: number,
  ): Promise<SummaryRotationRow[]>;
  updateSummary(row: {
    id: bigint;
    expectedOldKeyVersion: number;
    summaryEnc: string | null;
    themesEnc: string | null;
    keyVersion: number;
  }): Promise<boolean>;
}

export function createDrizzleReencryptAdapter(db: Database): ReencryptStorageAdapter {
  return {
    async fetchEntriesBatch(targetVersion, afterId, batchSize) {
      return db
        .select({
          id: entries.id,
          userId: entries.userId,
          entryDate: entries.entryDate,
          contentEnc: entries.contentEnc,
          keyVersion: entries.keyVersion,
        })
        .from(entries)
        .where(and(ne(entries.keyVersion, targetVersion), gt(entries.id, afterId)))
        .orderBy(asc(entries.id))
        .limit(batchSize);
    },

    async updateEntry({ id, expectedOldKeyVersion, contentEnc, keyVersion }) {
      const updated = await db
        .update(entries)
        .set({
          contentEnc,
          keyVersion,
        })
        .where(and(eq(entries.id, id), eq(entries.keyVersion, expectedOldKeyVersion)))
        .returning({ id: entries.id });
      return updated.length > 0;
    },

    async fetchSummariesBatch(targetVersion, afterId, batchSize) {
      return db
        .select({
          id: weeklySummaries.id,
          userId: weeklySummaries.userId,
          weekStart: weeklySummaries.weekStart,
          summaryEnc: weeklySummaries.summaryEnc,
          themesEnc: weeklySummaries.themesEnc,
          keyVersion: weeklySummaries.keyVersion,
        })
        .from(weeklySummaries)
        .where(and(ne(weeklySummaries.keyVersion, targetVersion), gt(weeklySummaries.id, afterId)))
        .orderBy(asc(weeklySummaries.id))
        .limit(batchSize);
    },

    async updateSummary({ id, expectedOldKeyVersion, summaryEnc, themesEnc, keyVersion }) {
      const updated = await db
        .update(weeklySummaries)
        .set({
          summaryEnc,
          themesEnc,
          keyVersion,
        })
        .where(
          and(eq(weeklySummaries.id, id), eq(weeklySummaries.keyVersion, expectedOldKeyVersion)),
        )
        .returning({ id: weeklySummaries.id });
      return updated.length > 0;
    },
  };
}

export interface ReencryptOptions {
  keyring: Keyring;
  storage: ReencryptStorageAdapter;
  batchSize?: number;
  /**
   * Optional starting cursor IDs for resuming from a specific checkpoint,
   * though the query `key_version != currentVersion` is already inherently resumable.
   */
  startAfterEntryId?: bigint;
  startAfterSummaryId?: bigint;
  /**
   * Optional max batches to process (useful for testing incremental resumability).
   */
  maxBatches?: number;
  /**
   * Whether rows use row-bound AAD (`buildEntryAad` / `buildSummaryAad`). Defaults to true.
   */
  useRowAad?: boolean;
}

export interface ReencryptResult {
  entriesMigrated: number;
  summariesMigrated: number;
  lastEntryId: bigint;
  lastSummaryId: bigint;
  targetKeyVersion: number;
}

/**
 * Re-encrypts `entries` and `weekly_summaries` rows from older key versions to
 * `keyring.currentVersion` in batches. Safely resumable: if interrupted mid-run,
 * re-running picks up only the remaining rows whose `key_version != currentVersion`.
 */
export async function reencryptAll({
  keyring,
  storage,
  batchSize = 100,
  startAfterEntryId = 0n,
  startAfterSummaryId = 0n,
  maxBatches,
  useRowAad = true,
}: ReencryptOptions): Promise<ReencryptResult> {
  const targetVersion = keyring.currentVersion;
  let entriesMigrated = 0;
  let summariesMigrated = 0;
  let lastEntryId = startAfterEntryId;
  let lastSummaryId = startAfterSummaryId;
  let batchesProcessed = 0;

  // 1. Migrate entries in batches
  while (maxBatches === undefined || batchesProcessed < maxBatches) {
    const batch = await storage.fetchEntriesBatch(targetVersion, lastEntryId, batchSize);
    if (batch.length === 0) {
      break;
    }
    batchesProcessed += 1;

    for (const row of batch) {
      const aad = useRowAad ? buildEntryAad(row.userId, row.entryDate) : undefined;
      const plaintext = decrypt(row.contentEnc, row.keyVersion, keyring, {
        associatedData: aad,
      });
      const reencrypted = encrypt(plaintext, keyring, {
        associatedData: aad,
      });

      const didUpdate = await storage.updateEntry({
        id: row.id,
        expectedOldKeyVersion: row.keyVersion,
        contentEnc: reencrypted.ciphertext,
        keyVersion: reencrypted.keyVersion,
      });

      if (didUpdate) {
        entriesMigrated += 1;
      }
      lastEntryId = row.id;
    }
  }

  // 2. Migrate weekly_summaries in batches
  while (maxBatches === undefined || batchesProcessed < maxBatches) {
    const batch = await storage.fetchSummariesBatch(targetVersion, lastSummaryId, batchSize);
    if (batch.length === 0) {
      break;
    }
    batchesProcessed += 1;

    for (const row of batch) {
      let newSummaryEnc: string | null = null;
      let newThemesEnc: string | null = null;

      if (row.summaryEnc !== null) {
        const summaryAad = useRowAad
          ? buildSummaryAad(row.userId, row.weekStart, 'summary')
          : undefined;
        const plainSummary = decrypt(row.summaryEnc, row.keyVersion, keyring, {
          associatedData: summaryAad,
        });
        newSummaryEnc = encrypt(plainSummary, keyring, {
          associatedData: summaryAad,
        }).ciphertext;
      }

      if (row.themesEnc !== null) {
        const themesAad = useRowAad
          ? buildSummaryAad(row.userId, row.weekStart, 'themes')
          : undefined;
        const plainThemes = decrypt(row.themesEnc, row.keyVersion, keyring, {
          associatedData: themesAad,
        });
        newThemesEnc = encrypt(plainThemes, keyring, {
          associatedData: themesAad,
        }).ciphertext;
      }

      const didUpdate = await storage.updateSummary({
        id: row.id,
        expectedOldKeyVersion: row.keyVersion,
        summaryEnc: newSummaryEnc,
        themesEnc: newThemesEnc,
        keyVersion: targetVersion,
      });

      if (didUpdate) {
        summariesMigrated += 1;
      }
      lastSummaryId = row.id;
    }
  }

  return {
    entriesMigrated,
    summariesMigrated,
    lastEntryId,
    lastSummaryId,
    targetKeyVersion: targetVersion,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();
  const logger = createLogger();
  const { pool, db } = createDbPool(config.DATABASE_URL);

  reencryptAll({
    keyring: config.keyring,
    storage: createDrizzleReencryptAdapter(db),
  })
    .then((result) => {
      logger.info(
        {
          entriesMigrated: result.entriesMigrated,
          summariesMigrated: result.summariesMigrated,
          targetKeyVersion: result.targetKeyVersion,
        },
        'Key rotation re-encryption completed successfully.',
      );
    })
    .catch((err: unknown) => {
      const safeName = err instanceof Error ? err.name : 'Error';
      const safeMessage = err instanceof Error ? err.message : 'Re-encryption failed';
      logger.error({ err: { name: safeName, message: safeMessage } }, 'Re-encryption failed');
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
