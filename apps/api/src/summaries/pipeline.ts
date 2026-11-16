import {
  getMondaySundayWeekBounds,
  getUserLocalDate,
  getUserLocalHourMinute,
  getWeekdayOfLocalDate,
  llmSummaryOutputSchema,
  normalizeHourMinute,
  type LlmSummaryOutput,
  type PushNotificationPayload,
} from '@firstwrite/shared';
import type PgBoss from 'pg-boss';
import type { Logger } from 'pino';
import type { EmailProvider } from '../auth/index.js';
import type { AppConfig } from '../config.js';
import { buildEntryAad, buildSummaryAad, decrypt, encrypt } from '../crypto/index.js';
import { createLogger } from '../logger.js';
import {
  deliverToSubscriptionWithRetry,
  type PushRepository,
  type SendPushSubscriptionOptions,
  type WebPushClient,
} from '../push/index.js';
import {
  applySupportResourcesPlaceholder,
  buildWeeklySummaryUserPrompt,
  computeTokenCostUsd,
  prepareWeekEntriesWithCaps,
  WEEKLY_SUMMARY_SYSTEM_PROMPT,
  type LlmProvider,
} from './llm.js';
import type { SummariesRepository } from './repository.js';

export const SUMMARY_HOURLY_TICK_QUEUE = 'weekly-summaries-hourly-tick';
export const SUMMARY_GENERATE_QUEUE = 'weekly-summaries-generate-user';
export const DEFAULT_MIN_ENTRIES_FOR_SUMMARY = 2;

/**
 * Job payload carries ONLY `userId` and `weekStart` (AGENTS.md Rule 1 & Brief 8:
 * plaintext journal content must NEVER be placed in job payloads).
 */
export interface WeeklySummaryJobData {
  userId: string;
  weekStart: string;
}

export interface WeeklySummaryJobQueue {
  enqueueSummaryJob(job: WeeklySummaryJobData): Promise<boolean>;
}

export function buildWeeklySummarySingletonKey(userId: string | bigint, weekStart: string): string {
  return `weekly-summary:${String(userId)}:${weekStart}`;
}

/**
 * Generic push notification payload for completed weekly summaries (AGENTS.md Rule 6 & Brief 8):
 * Never includes summary content or journal content.
 */
export function buildSummaryReadyPushPayload(weekStart: string): PushNotificationPayload {
  return {
    title: 'Morning Pages',
    body: 'Your week in review is ready',
    url: '/?view=summaries',
    tag: `morning-pages-weekly-${weekStart}`,
  };
}

export function buildSummaryReadyEmail(params: {
  to: string;
  appBaseUrl: string;
  weekStart: string;
}) {
  const link = `${params.appBaseUrl.replace(/\/$/, '')}/?view=summaries&week=${encodeURIComponent(params.weekStart)}`;
  return {
    to: params.to,
    subject: 'Your week in review is ready',
    text: [
      'Your weekly Morning Pages review is ready to read inside the app:',
      link,
      '',
      'For your privacy, summary text is never included in emails or notifications.',
    ].join('\n'),
    html: [
      '<p>Your weekly <strong>Morning Pages</strong> review is ready to read inside the app:</p>',
      `<p><a href="${link}">View your week in review</a></p>`,
      '<p>For your privacy, summary text is never included in emails or notifications.</p>',
    ].join('\n'),
  };
}

export class InMemoryWeeklySummaryJobQueue implements WeeklySummaryJobQueue {
  public readonly enqueuedJobs: WeeklySummaryJobData[] = [];
  private readonly enqueuedKeys = new Set<string>();

  public async enqueueSummaryJob(job: WeeklySummaryJobData): Promise<boolean> {
    const key = buildWeeklySummarySingletonKey(job.userId, job.weekStart);
    if (this.enqueuedKeys.has(key)) {
      return false;
    }
    this.enqueuedKeys.add(key);
    this.enqueuedJobs.push({ ...job });
    return true;
  }

  public async drainSummaryJobs(params: {
    config: AppConfig;
    summariesRepo: SummariesRepository;
    llmProvider: LlmProvider;
    pushRepo?: PushRepository;
    pushClient?: WebPushClient;
    emailProvider?: EmailProvider;
    now?: () => Date;
    minEntries?: number;
    maxCharsPerEntry?: number;
    maxCharsPerWeek?: number;
    onBeforeLlmCall?: (job: WeeklySummaryJobData) => Promise<void> | void;
    onOperatorAlert?: (alert: { code: string; spentUsd: number; limitUsd: number }) => void;
    logger?: Logger;
    pushRetryOptions?: SendPushSubscriptionOptions;
  }): Promise<{
    processed: number;
    done: number;
    skipped: number;
    failed: number;
    pausedBySpendCeiling: number;
    abortedByConsentWithdrawal: number;
  }> {
    let processed = 0;
    let done = 0;
    let skipped = 0;
    let failed = 0;
    let pausedBySpendCeiling = 0;
    let abortedByConsentWithdrawal = 0;

    while (this.enqueuedJobs.length > 0) {
      const job = this.enqueuedJobs.shift()!;
      const outcome = await processWeeklySummaryJob({
        job,
        config: params.config,
        summariesRepo: params.summariesRepo,
        llmProvider: params.llmProvider,
        pushRepo: params.pushRepo,
        pushClient: params.pushClient,
        emailProvider: params.emailProvider,
        now: params.now ? params.now() : new Date(),
        minEntries: params.minEntries,
        maxCharsPerEntry: params.maxCharsPerEntry,
        maxCharsPerWeek: params.maxCharsPerWeek,
        onBeforeLlmCall: params.onBeforeLlmCall,
        onOperatorAlert: params.onOperatorAlert,
        logger: params.logger,
        pushRetryOptions: params.pushRetryOptions,
      });

      processed += 1;
      if (outcome.status === 'done') done += 1;
      else if (outcome.status === 'skipped') skipped += 1;
      else if (outcome.status === 'failed') failed += 1;
      else if (outcome.status === 'paused_spend_ceiling') pausedBySpendCeiling += 1;
      else if (outcome.status === 'aborted_no_consent') abortedByConsentWithdrawal += 1;
    }

    return {
      processed,
      done,
      skipped,
      failed,
      pausedBySpendCeiling,
      abortedByConsentWithdrawal,
    };
  }
}

export interface RunSummarySchedulerTickOptions {
  now: Date;
  repo: SummariesRepository;
  queue: WeeklySummaryJobQueue;
  batchSize?: number;
}

export interface SummarySchedulerTickResult {
  usersEvaluated: number;
  pendingInserted: number;
  jobsEnqueued: number;
}

/**
 * Hourly `pg-boss` scheduler tick:
 * Selects users in batches who have BOTH `users.ai_consent_at IS NOT NULL` and `weekly_summary_enabled = true`,
 * whose local calendar date in `users.timezone` is Sunday (`weekday === 0`), whose local time has reached
 * `summary_delivery_time`, and who have no `weekly_summaries` row for that Monday–Sunday week yet.
 * Inserts a `pending` row (`UNIQUE (user_id, week_start)`) and enqueues one job per user with singleton key
 * `weekly-summary:<userId>:<weekStart>`.
 */
export async function runWeeklySummarySchedulerTick({
  now,
  repo,
  queue,
  batchSize = 200,
}: RunSummarySchedulerTickOptions): Promise<SummarySchedulerTickResult> {
  let afterUserId = 0n;
  let usersEvaluated = 0;
  let pendingInserted = 0;
  let jobsEnqueued = 0;

  while (true) {
    const batch = await repo.fetchSummaryEligibleUsersBatch(afterUserId, batchSize);
    if (batch.length === 0) break;

    for (const candidate of batch) {
      usersEvaluated += 1;
      afterUserId = candidate.userId;

      // Double-check strict consent invariant (AGENTS.md Rule 5)
      if (!candidate.aiConsentAt || !candidate.weeklySummaryEnabled) {
        continue;
      }

      const userLocalDate = getUserLocalDate(now, candidate.timezone);
      const weekday = getWeekdayOfLocalDate(userLocalDate);
      // 0 = Sunday in user-local calendar
      if (weekday !== 0) {
        continue;
      }

      const userLocalTime = getUserLocalHourMinute(now, candidate.timezone);
      const deliveryTime = normalizeHourMinute(candidate.summaryDeliveryTime);
      if (userLocalTime < deliveryTime) {
        continue;
      }

      const { weekStart, weekEnd } = getMondaySundayWeekBounds(userLocalDate);

      const inserted = await repo.insertPendingSummaryIfAbsent({
        userId: candidate.userId,
        weekStart,
        weekEnd,
        now,
      });

      if (!inserted) {
        // Row already exists for (userId, weekStart) -> idempotency guaranteed
        continue;
      }

      pendingInserted += 1;
      const enqueued = await queue.enqueueSummaryJob({
        userId: candidate.userId.toString(),
        weekStart,
      });
      if (enqueued) {
        jobsEnqueued += 1;
      }
    }
  }

  return { usersEvaluated, pendingInserted, jobsEnqueued };
}

function parseAndValidateLlmJson(rawText: string): LlmSummaryOutput | null {
  const trimmed = rawText.trim();
  // Strip optional markdown code fences if the model wrapped its JSON
  const cleaned = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    const parsedJson = JSON.parse(cleaned) as unknown;
    const validated = llmSummaryOutputSchema.safeParse(parsedJson);
    return validated.success ? validated.data : null;
  } catch {
    return null;
  }
}

function getMonthStartUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
}

export type ProcessSummaryJobOutcome =
  | { status: 'done'; inputTokens: number; outputTokens: number }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string }
  | { status: 'paused_spend_ceiling'; spentUsd: number }
  | { status: 'aborted_no_consent' };

/**
 * Worker handler for a single user's weekly summary generation job.
 */
export async function processWeeklySummaryJob(params: {
  job: WeeklySummaryJobData;
  config: AppConfig;
  summariesRepo: SummariesRepository;
  llmProvider: LlmProvider;
  pushRepo?: PushRepository;
  pushClient?: WebPushClient;
  emailProvider?: EmailProvider;
  now?: Date;
  minEntries?: number;
  maxCharsPerEntry?: number;
  maxCharsPerWeek?: number;
  onBeforeLlmCall?: (job: WeeklySummaryJobData) => Promise<void> | void;
  onOperatorAlert?: (alert: { code: string; spentUsd: number; limitUsd: number }) => void;
  logger?: Logger;
  pushRetryOptions?: SendPushSubscriptionOptions;
}): Promise<ProcessSummaryJobOutcome> {
  const {
    job,
    config,
    summariesRepo,
    llmProvider,
    pushRepo,
    pushClient,
    emailProvider,
    now = new Date(),
    minEntries = DEFAULT_MIN_ENTRIES_FOR_SUMMARY,
    maxCharsPerEntry,
    maxCharsPerWeek,
    onBeforeLlmCall,
    onOperatorAlert,
    logger = createLogger(),
    pushRetryOptions,
  } = params;

  const userId = BigInt(job.userId);
  const existingRow = await summariesRepo.findSummaryByUserAndWeek(userId, job.weekStart);
  if (!existingRow || existingRow.status === 'done' || existingRow.status === 'skipped') {
    return { status: 'skipped', reason: 'already_processed' };
  }

  // 1. Verify consent before reading entries
  const initialConsent = await summariesRepo.checkUserConsentActive(userId);
  if (!initialConsent.consentedAndEnabled) {
    await summariesRepo.deleteSummaryByUserAndWeek(userId, job.weekStart);
    return { status: 'aborted_no_consent' };
  }

  // 2. Check monthly spend ceiling BEFORE making any LLM call
  const monthStart = getMonthStartUtc(now);
  const usageSoFar = await summariesRepo.getMonthlyTokenUsage(monthStart);
  const spentUsd = computeTokenCostUsd(usageSoFar.inputTokens, usageSoFar.outputTokens);
  if (spentUsd >= config.LLM_MONTHLY_SPEND_LIMIT_USD) {
    logger.warn(
      {
        alert: 'llm_monthly_spend_ceiling_reached',
        spentUsd,
        limitUsd: config.LLM_MONTHLY_SPEND_LIMIT_USD,
      },
      'LLM monthly spend ceiling reached; pausing weekly summary generation',
    );
    if (onOperatorAlert) {
      onOperatorAlert({
        code: 'LLM_SPEND_CEILING_REACHED',
        spentUsd,
        limitUsd: config.LLM_MONTHLY_SPEND_LIMIT_USD,
      });
    }
    return { status: 'paused_spend_ceiling', spentUsd };
  }

  // 3. Load Monday-Sunday week's entries and check minimum threshold (default 2)
  const encryptedEntries = await summariesRepo.fetchWeekEntriesForUser(
    userId,
    existingRow.weekStart,
    existingRow.weekEnd,
  );
  const nonEmptyEntries = encryptedEntries.filter((e) => e.wordCount > 0);

  if (nonEmptyEntries.length < minEntries) {
    await summariesRepo.markSummarySkipped({
      userId,
      weekStart: existingRow.weekStart,
      skipReason: 'too_few_entries',
    });
    logger.info(
      {
        userId: userId.toString(),
        weekStart: existingRow.weekStart,
        entryCount: nonEmptyEntries.length,
        skipReason: 'too_few_entries',
      },
      'Skipped weekly summary due to too few entries',
    );
    return { status: 'skipped', reason: 'too_few_entries' };
  }

  // 4. Decrypt entries in memory and apply per-entry and per-week character caps
  const decryptedEntries = nonEmptyEntries.map((row) => {
    const aad = buildEntryAad(row.userId, row.entryDate);
    const plaintext = decrypt(row.contentEnc, row.keyVersion, config.keyring, {
      associatedData: aad,
    });
    return {
      entryDate: row.entryDate,
      content: plaintext,
    };
  });

  const { entries: cappedEntries, anyTruncated } = prepareWeekEntriesWithCaps(decryptedEntries, {
    maxCharsPerEntry,
    maxCharsPerWeek,
  });

  // Optional hook for testing mid-run consent withdrawal immediately before the outbound LLM API call
  if (onBeforeLlmCall) {
    await onBeforeLlmCall(job);
  }

  // 5. Re-verify consent immediately before calling the outbound LLM provider (AGENTS.md Rule 5 & Brief 8)
  const preCallConsent = await summariesRepo.checkUserConsentActive(userId);
  if (!preCallConsent.consentedAndEnabled) {
    await summariesRepo.deleteSummaryByUserAndWeek(userId, existingRow.weekStart);
    logger.info(
      { userId: userId.toString(), weekStart: existingRow.weekStart },
      'Aborted weekly summary generation before LLM call because consent was withdrawn',
    );
    return { status: 'aborted_no_consent' };
  }

  // 6. Call LLM provider, validate structured JSON output against schema, and retry ONCE on invalid output
  let validatedOutput: LlmSummaryOutput | null = null;
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let recordedModel = config.LLM_MODEL;

  for (let parseAttempt = 0; parseAttempt < 2; parseAttempt++) {
    const userPrompt = buildWeeklySummaryUserPrompt({
      weekStart: existingRow.weekStart,
      weekEnd: existingRow.weekEnd,
      entries: cappedEntries,
      anyTruncated,
      retryHint:
        parseAttempt === 1
          ? 'Your previous response was not valid JSON matching the required schema. Output ONLY raw valid JSON with "summary_md" (non-empty string) and "themes" (array of strings).'
          : undefined,
    });

    try {
      const llmRes = await llmProvider.generateWeeklySummary({
        model: config.LLM_MODEL,
        systemPrompt: WEEKLY_SUMMARY_SYSTEM_PROMPT,
        userPrompt,
      });

      recordedModel = llmRes.model || config.LLM_MODEL;
      totalInputTokens += llmRes.inputTokens;
      totalOutputTokens += llmRes.outputTokens;

      validatedOutput = parseAndValidateLlmJson(llmRes.rawText);
      if (validatedOutput) {
        break;
      }
    } catch (err) {
      const safeErrMessage = err instanceof Error ? err.message : 'LLM call failed';
      logger.warn(
        {
          userId: userId.toString(),
          weekStart: existingRow.weekStart,
          attempt: parseAttempt + 1,
          error: safeErrMessage,
        },
        'LLM provider call failed during weekly summary generation',
      );
      break;
    }
  }

  if (!validatedOutput) {
    await summariesRepo.markSummaryFailed({
      userId,
      weekStart: existingRow.weekStart,
      model: recordedModel,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    });
    logger.warn(
      {
        userId: userId.toString(),
        weekStart: existingRow.weekStart,
        model: recordedModel,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
      },
      'Weekly summary generation marked failed after invalid LLM output',
    );
    return { status: 'failed', reason: 'invalid_llm_output' };
  }

  // 7. Fill in {{SUPPORT_RESOURCES}} placeholder if distress_flag is set, then encrypt summary_md and themes JSON before storing in weekly_summaries (AGENTS.md Rule 1 & Brief 9)
  const finalSummaryMd = applySupportResourcesPlaceholder(
    validatedOutput.summary_md,
    Boolean(validatedOutput.distress_flag),
    preCallConsent.timezone ?? 'UTC',
  );

  const summaryAad = buildSummaryAad(userId, existingRow.weekStart, 'summary');
  const themesAad = buildSummaryAad(userId, existingRow.weekStart, 'themes');

  const encryptedSummary = encrypt(finalSummaryMd, config.keyring, {
    associatedData: summaryAad,
  });
  const encryptedThemes = encrypt(JSON.stringify(validatedOutput.themes), config.keyring, {
    associatedData: themesAad,
  });

  await summariesRepo.markSummaryDone({
    userId,
    weekStart: existingRow.weekStart,
    summaryEnc: encryptedSummary.ciphertext,
    themesEnc: encryptedThemes.ciphertext,
    keyVersion: encryptedSummary.keyVersion,
    model: recordedModel,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    deliveredAt: now,
  });

  // Log token totals per run (metadata only — never plaintext content!)
  logger.info(
    {
      userId: userId.toString(),
      weekStart: existingRow.weekStart,
      model: recordedModel,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
    },
    'Weekly summary generated and encrypted',
  );

  // 8. Deliver generic push notification ("Your week in review is ready") and optional email with no summary content
  if (pushRepo && pushClient) {
    const subs = await pushRepo.listSubscriptionsForUser(userId);
    const pushPayload = buildSummaryReadyPushPayload(existingRow.weekStart);
    for (const sub of subs) {
      await deliverToSubscriptionWithRetry({
        sub,
        payload: pushPayload,
        pushClient,
        repo: pushRepo,
        logger,
        options: pushRetryOptions,
      });
    }
  }

  if (emailProvider && preCallConsent.email) {
    await emailProvider.send(
      buildSummaryReadyEmail({
        to: preCallConsent.email,
        appBaseUrl: config.APP_BASE_URL,
        weekStart: existingRow.weekStart,
      }),
    );
  }

  return {
    status: 'done',
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
  };
}

/**
 * Registers the `pg-boss` recurring hourly scheduler (`0 * * * *`) and low-concurrency worker
 * (`teamSize: 2`) for production execution.
 */
export async function registerPgBossSummaryJobs(params: {
  boss: PgBoss;
  config: AppConfig;
  summariesRepo: SummariesRepository;
  llmProvider: LlmProvider;
  pushRepo?: PushRepository;
  pushClient?: WebPushClient;
  emailProvider?: EmailProvider;
  logger?: Logger;
}): Promise<void> {
  const {
    boss,
    config,
    summariesRepo,
    llmProvider,
    pushRepo,
    pushClient,
    emailProvider,
    logger = createLogger(),
  } = params;

  await boss.createQueue(SUMMARY_HOURLY_TICK_QUEUE);
  await boss.createQueue(SUMMARY_GENERATE_QUEUE);

  const pgBossQueueAdapter: WeeklySummaryJobQueue = {
    async enqueueSummaryJob(job) {
      const singletonKey = buildWeeklySummarySingletonKey(job.userId, job.weekStart);
      const jobId = await boss.send(SUMMARY_GENERATE_QUEUE, job, {
        singletonKey,
        retryLimit: 2,
        retryBackoff: true,
      });
      return jobId !== null;
    },
  };

  await boss.schedule(SUMMARY_HOURLY_TICK_QUEUE, '0 * * * *');

  await boss.work(SUMMARY_HOURLY_TICK_QUEUE, async () => {
    await runWeeklySummarySchedulerTick({
      now: new Date(),
      repo: summariesRepo,
      queue: pgBossQueueAdapter,
    });
  });

  // Low worker concurrency (batchSize: 1) to respect LLM provider rate limits
  await boss.work<WeeklySummaryJobData>(SUMMARY_GENERATE_QUEUE, { batchSize: 1 }, async (jobs) => {
    for (const job of jobs) {
      await processWeeklySummaryJob({
        job: job.data,
        config,
        summariesRepo,
        llmProvider,
        pushRepo,
        pushClient,
        emailProvider,
        logger,
      });
    }
  });
}
