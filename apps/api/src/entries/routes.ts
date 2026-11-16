import {
  addDaysToLocalDate,
  countWords,
  entriesListQuerySchema,
  entryDateParamSchema,
  getUserLocalDate,
  MAX_ENTRY_CHARACTERS,
  upsertEntryRequestSchema,
  type EntriesListResponse,
  type EntryDetail,
} from '@firstwrite/shared';
import type { NextFunction, Request, Response, Router } from 'express';
import express from 'express';
import { AppError } from '../app.js';
import type { AppConfig } from '../config.js';
import { buildEntryAad, decrypt, encrypt } from '../crypto/index.js';
import type { EntriesRepository, EntryRecord } from './repository.js';

export interface EntriesRouterOptions {
  config: AppConfig;
  repo: EntriesRepository;
  requireAuth: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  requireCsrf: (req: Request, res: Response, next: NextFunction) => void;
  now?: () => Date;
}

export function createEntriesRouter({
  config,
  repo,
  requireAuth,
  requireCsrf,
  now = () => new Date(),
}: EntriesRouterOptions): Router {
  const router = express.Router();

  function decryptEntryRecord(record: EntryRecord): EntryDetail {
    const aad = buildEntryAad(record.userId, record.entryDate);
    const plaintext = decrypt(record.contentEnc, record.keyVersion, config.keyring, {
      associatedData: aad,
    });

    return {
      entryDate: record.entryDate,
      content: plaintext,
      wordCount: record.wordCount,
      createdAt: record.createdAt.toISOString(),
      updatedAt: record.updatedAt.toISOString(),
    };
  }

  // ───────────── GET /api/entries?from=&to= (Metadata list only — no decryption) ─────────────
  router.get('/api/entries', requireAuth, async (req: Request, res: Response) => {
    const { user } = req.auth!;
    const query = entriesListQuerySchema.parse(req.query);

    const rows = await repo.listSummariesByUser({
      userId: user.id,
      from: query.from,
      to: query.to,
    });

    let totalWords = 0;
    const summaries = rows.map((r) => {
      totalWords += r.wordCount;
      return {
        entryDate: r.entryDate,
        wordCount: r.wordCount,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });

    const payload: EntriesListResponse = {
      entries: summaries,
      meta: {
        totalEntries: summaries.length,
        totalWords,
      },
    };

    res.status(200).json(payload);
  });

  // ───────────── GET /api/entries/:date (Decrypted entry for authenticated owner only) ─────────────
  router.get('/api/entries/:date', requireAuth, async (req: Request, res: Response) => {
    const { user } = req.auth!;
    const { date } = entryDateParamSchema.parse(req.params);

    const record = await repo.findByUserAndDate(user.id, date);
    if (!record) {
      throw new AppError(404, 'ENTRY_NOT_FOUND', 'No journal entry found for this date');
    }

    res.status(200).json(decryptEntryRecord(record));
  });

  // ───────────── PUT /api/entries/:date (Idempotent upsert with optimistic conflict check) ─────────────
  router.put(
    '/api/entries/:date',
    requireAuth,
    requireCsrf,
    async (req: Request, res: Response) => {
      const { user } = req.auth!;
      const { date } = entryDateParamSchema.parse(req.params);

      // Explicitly check generous entry size limit with a dedicated 413 ENTRY_TOO_LARGE error
      const rawContent = (req.body as { content?: unknown } | undefined)?.content;
      if (typeof rawContent === 'string' && rawContent.length > MAX_ENTRY_CHARACTERS) {
        throw new AppError(
          413,
          'ENTRY_TOO_LARGE',
          `Journal entry exceeds maximum allowed size of ${MAX_ENTRY_CHARACTERS.toLocaleString()} characters`,
        );
      }

      const body = upsertEntryRequestSchema.parse(req.body);
      const currentTime = now();

      // Compute user-local calendar date from users.timezone (AGENTS.md Rule 2)
      const userLocalToday = getUserLocalDate(currentTime, user.timezone);
      const maxAllowedDate = addDaysToLocalDate(userLocalToday, 1);

      if (date > maxAllowedDate) {
        throw new AppError(
          400,
          'FUTURE_DATE_NOT_ALLOWED',
          `Cannot write an entry more than one day in the future (your local date is ${userLocalToday})`,
        );
      }

      const wordCount = countWords(body.content);
      const aad = buildEntryAad(user.id, date);
      const { ciphertext, keyVersion } = encrypt(body.content, config.keyring, {
        associatedData: aad,
      });

      const outcome = await repo.upsertEntry({
        userId: user.id,
        entryDate: date,
        contentEnc: ciphertext,
        keyVersion,
        wordCount,
        now: currentTime,
        expectedUpdatedAt: body.expectedUpdatedAt,
      });

      if (outcome.status === 'conflict') {
        const serverEntry = decryptEntryRecord(outcome.serverRecord);
        res.status(409).json({
          error: {
            code: 'ENTRY_CONFLICT',
            message:
              'This entry was modified on another device. Review and merge the server version before saving.',
            details: {
              serverEntry,
            },
          },
        });
        return;
      }

      res.status(200).json({
        entryDate: outcome.record.entryDate,
        content: body.content,
        wordCount: outcome.record.wordCount,
        createdAt: outcome.record.createdAt.toISOString(),
        updatedAt: outcome.record.updatedAt.toISOString(),
      });
    },
  );

  // ───────────── DELETE /api/entries/:date ─────────────
  router.delete(
    '/api/entries/:date',
    requireAuth,
    requireCsrf,
    async (req: Request, res: Response) => {
      const { user } = req.auth!;
      const { date } = entryDateParamSchema.parse(req.params);

      const deleted = await repo.deleteByUserAndDate(user.id, date);
      if (!deleted) {
        throw new AppError(404, 'ENTRY_NOT_FOUND', 'No journal entry found for this date');
      }

      res.status(200).json({ status: 'ok' });
    },
  );

  return router;
}
