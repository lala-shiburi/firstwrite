import {
  summaryWeekStartParamSchema,
  type WeeklySummariesListResponse,
  type WeeklySummaryItem,
} from '@firstwrite/shared';
import type { NextFunction, Request, Response, Router } from 'express';
import express from 'express';
import { AppError } from '../app.js';
import type { AppConfig } from '../config.js';
import { buildSummaryAad, decrypt } from '../crypto/index.js';
import type { SummariesRepository, WeeklySummaryRecord } from './repository.js';

export interface SummariesRouterOptions {
  config: AppConfig;
  repo: SummariesRepository;
  requireAuth: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  requireCsrf: (req: Request, res: Response, next: NextFunction) => void;
}

export function createSummariesRouter({
  config,
  repo,
  requireAuth,
  requireCsrf,
}: SummariesRouterOptions): Router {
  const router = express.Router();

  function decryptSummaryRecord(record: WeeklySummaryRecord): WeeklySummaryItem {
    let summaryMd: string | null = null;
    let themes: string[] | null = null;

    if (record.summaryEnc) {
      const sumAad = buildSummaryAad(record.userId, record.weekStart, 'summary');
      summaryMd = decrypt(record.summaryEnc, record.keyVersion, config.keyring, {
        associatedData: sumAad,
      });
    }

    if (record.themesEnc) {
      const themesAad = buildSummaryAad(record.userId, record.weekStart, 'themes');
      const themesJson = decrypt(record.themesEnc, record.keyVersion, config.keyring, {
        associatedData: themesAad,
      });
      try {
        const parsed = JSON.parse(themesJson) as unknown;
        if (Array.isArray(parsed)) {
          themes = parsed.map((t) => String(t));
        }
      } catch {
        themes = null;
      }
    }

    return {
      weekStart: record.weekStart,
      weekEnd: record.weekEnd,
      status: record.status,
      summaryMd,
      themes,
      skipReason: record.skipReason,
      createdAt: record.createdAt.toISOString(),
      deliveredAt: record.deliveredAt ? record.deliveredAt.toISOString() : null,
    };
  }

  // ───────────── GET /api/summaries (List user's weekly summaries) ─────────────
  router.get('/api/summaries', requireAuth, async (req: Request, res: Response) => {
    const { user } = req.auth!;
    const rows = await repo.listSummariesForUser(user.id);
    const items: WeeklySummaryItem[] = rows.map(decryptSummaryRecord);
    const payload: WeeklySummariesListResponse = { summaries: items };
    res.status(200).json(payload);
  });

  // ───────────── GET /api/summaries/:weekStart (Get single weekly summary) ─────────────
  router.get('/api/summaries/:weekStart', requireAuth, async (req: Request, res: Response) => {
    const { user } = req.auth!;
    const { weekStart } = summaryWeekStartParamSchema.parse(req.params);

    const record = await repo.findSummaryByUserAndWeek(user.id, weekStart);
    if (!record) {
      throw new AppError(404, 'SUMMARY_NOT_FOUND', 'No weekly summary found for this week');
    }

    res.status(200).json(decryptSummaryRecord(record));
  });

  // ───────────── DELETE /api/summaries/:weekStart (Delete a weekly summary) ─────────────
  router.delete(
    '/api/summaries/:weekStart',
    requireAuth,
    requireCsrf,
    async (req: Request, res: Response) => {
      const { user } = req.auth!;
      const { weekStart } = summaryWeekStartParamSchema.parse(req.params);

      const deleted = await repo.deleteSummaryByUserAndWeek(user.id, weekStart);
      if (!deleted) {
        throw new AppError(404, 'SUMMARY_NOT_FOUND', 'No weekly summary found for this week');
      }

      res.status(200).json({ status: 'ok' });
    },
  );

  return router;
}
