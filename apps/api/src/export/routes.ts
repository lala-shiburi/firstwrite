import { exportQuerySchema, getUserLocalDate } from '@firstwrite/shared';
import type { NextFunction, Request, Response, Router } from 'express';
import express from 'express';
import type { Logger } from 'pino';
import { AuthRateLimiter, type RateLimitPolicy } from '../auth/index.js';
import type { AppConfig } from '../config.js';
import { buildEntryAad, buildSummaryAad, decrypt } from '../crypto/index.js';
import { createLogger } from '../logger.js';
import {
  buildExportReadmeMarkdown,
  formatEntryMarkdownFile,
  formatIsoWeekId,
  formatWeeklySummaryMarkdownFile,
} from './markdown.js';
import type { ExportRepository } from './repository.js';
import { ZipStreamWriter } from './zip.js';

export const DEFAULT_EXPORT_RATE_POLICY: RateLimitPolicy = {
  windowMs: 60 * 60 * 1000, // 1 hour
  maxRequests: 5, // 5 exports per hour per user
};

export interface ExportRouterOptions {
  config: AppConfig;
  repo: ExportRepository;
  requireAuth: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  rateLimiter?: AuthRateLimiter;
  ratePolicy?: RateLimitPolicy;
  batchSize?: number;
  logger?: Logger;
  now?: () => Date;
}

function writeStringChunk(res: Response, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    res.write(text, 'utf8', (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

export function createExportRouter({
  config,
  repo,
  requireAuth,
  rateLimiter,
  ratePolicy = DEFAULT_EXPORT_RATE_POLICY,
  batchSize = 100,
  logger = createLogger(),
  now = () => new Date(),
}: ExportRouterOptions): Router {
  const router = express.Router();
  const limiter = rateLimiter ?? new AuthRateLimiter(now);

  router.get('/api/export', requireAuth, async (req: Request, res: Response) => {
    const { user } = req.auth!;
    const { format } = exportQuerySchema.parse(req.query);

    const rateKey = `export:user:${user.id.toString()}`;
    limiter.consume(rateKey, ratePolicy);

    const currentTime = now();
    const userLocalToday = getUserLocalDate(currentTime, user.timezone);

    if (format === 'zip') {
      const filename = `morning-pages-export-${userLocalToday}.zip`;
      res.status(200);
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Cache-Control', 'no-store');

      const zipWriter = new ZipStreamWriter(res);
      let entryCount = 0;
      let summaryCount = 0;

      // 1. Add root README.md explaining the archive structure
      await zipWriter.appendFile(
        'README.md',
        buildExportReadmeMarkdown({
          exportedAtIso: currentTime.toISOString(),
          timezone: user.timezone,
        }),
      );

      // 2. Stream decrypted entries in batches ordered by local date
      let afterEntryDate: string | null = null;
      while (true) {
        const batch = await repo.fetchEntriesBatch({
          userId: user.id,
          afterEntryDate,
          batchSize,
        });
        if (batch.length === 0) break;

        for (const row of batch) {
          afterEntryDate = row.entryDate;
          const aad = buildEntryAad(row.userId, row.entryDate);
          const plaintext = decrypt(row.contentEnc, row.keyVersion, config.keyring, {
            associatedData: aad,
          });

          const mdFile = formatEntryMarkdownFile({
            entryDate: row.entryDate,
            wordCount: row.wordCount,
            content: plaintext,
          });

          await zipWriter.appendFile(`${row.entryDate}.md`, mdFile);
          entryCount += 1;
        }
      }

      // 3. Stream decrypted weekly summaries under weekly/<YYYY-Www>.md in batches
      let afterWeekStart: string | null = null;
      while (true) {
        const batch = await repo.fetchDoneSummariesBatch({
          userId: user.id,
          afterWeekStart,
          batchSize,
        });
        if (batch.length === 0) break;

        for (const sumRow of batch) {
          afterWeekStart = sumRow.weekStart;
          if (!sumRow.summaryEnc) continue;

          const sumAad = buildSummaryAad(sumRow.userId, sumRow.weekStart, 'summary');
          const summaryMd = decrypt(sumRow.summaryEnc, sumRow.keyVersion, config.keyring, {
            associatedData: sumAad,
          });

          let themes: string[] = [];
          if (sumRow.themesEnc) {
            const themesAad = buildSummaryAad(sumRow.userId, sumRow.weekStart, 'themes');
            const themesJson = decrypt(sumRow.themesEnc, sumRow.keyVersion, config.keyring, {
              associatedData: themesAad,
            });
            try {
              const parsed = JSON.parse(themesJson) as unknown;
              if (Array.isArray(parsed)) {
                themes = parsed.map((t) => String(t));
              }
            } catch {
              themes = [];
            }
          }

          const weekId = formatIsoWeekId(sumRow.weekStart);
          const summaryFileContent = formatWeeklySummaryMarkdownFile({
            weekId,
            weekStart: sumRow.weekStart,
            weekEnd: sumRow.weekEnd,
            themes,
            summaryMd,
          });

          await zipWriter.appendFile(`weekly/${weekId}.md`, summaryFileContent);
          summaryCount += 1;
        }
      }

      await zipWriter.finalize();

      // Audit log entry (metadata only, never journal or summary content — AGENTS.md Rule 1 & Brief 7)
      (req.log ?? logger).info(
        {
          audit: 'account_export',
          userId: user.id.toString(),
          format: 'zip',
          entryCount,
          summaryCount,
        },
        'Account data export completed',
      );

      res.end();
      return;
    }

    // format === 'md': Stream a single combined Markdown file ordered by date
    const filename = `morning-pages-export-${userLocalToday}.md`;
    res.status(200);
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Cache-Control', 'no-store');

    await writeStringChunk(
      res,
      [
        '# Morning Pages Export',
        '',
        `Exported at: ${currentTime.toISOString()}`,
        `Timezone: ${user.timezone}`,
        '',
      ].join('\n'),
    );

    let entryCount = 0;
    let afterEntryDate: string | null = null;
    while (true) {
      const batch = await repo.fetchEntriesBatch({
        userId: user.id,
        afterEntryDate,
        batchSize,
      });
      if (batch.length === 0) break;

      for (const row of batch) {
        afterEntryDate = row.entryDate;
        const aad = buildEntryAad(row.userId, row.entryDate);
        const plaintext = decrypt(row.contentEnc, row.keyVersion, config.keyring, {
          associatedData: aad,
        });

        const section = [
          '---',
          '',
          `## ${row.entryDate}`,
          '',
          `*Words: ${row.wordCount}*`,
          '',
          plaintext.replace(/\r\n/g, '\n'),
          '',
        ].join('\n');

        await writeStringChunk(res, section);
        entryCount += 1;
      }
    }

    (req.log ?? logger).info(
      {
        audit: 'account_export',
        userId: user.id.toString(),
        format: 'md',
        entryCount,
      },
      'Account data export completed',
    );

    res.end();
  });

  return router;
}
