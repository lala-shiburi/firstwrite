import {
  getUserLocalDate,
  getUserLocalHourMinute,
  normalizeHourMinute,
  type PushNotificationPayload,
} from '@firstwrite/shared';
import type PgBoss from 'pg-boss';
import type { Logger } from 'pino';
import webpush from 'web-push';
import type { AppConfig } from '../config.js';
import { createLogger } from '../logger.js';
import type { PushRepository, PushSubscriptionRecord } from './repository.js';

export const REMINDER_TICK_QUEUE = 'reminders-minute-tick';
export const REMINDER_SEND_QUEUE = 'reminders-send-user';

/**
 * Documented word threshold choice (Brief 6):
 * Any entry with at least `1` word (`MIN_ENTRY_WORDS_TO_SUPPRESS_REMINDER = 1`) on the user's
 * local date counts as having started/written today's entry, suppressing the reminder.
 * An empty `0`-word entry row (or no row) still receives a gentle reminder.
 */
export const MIN_ENTRY_WORDS_TO_SUPPRESS_REMINDER = 1;

/**
 * Generic, gently varied reminder messages (AGENTS.md Rule 6 & Brief 6):
 * Never includes journal content, summary content, or streak guilt-tripping.
 */
export const GENERIC_REMINDER_MESSAGES: ReadonlyArray<{ title: string; body: string }> = [
  {
    title: 'Morning Pages',
    body: 'A quiet page is waiting whenever you are ready to write.',
  },
  {
    title: 'Morning Pages',
    body: 'Take a few unhurried minutes for your morning pages today.',
  },
  {
    title: 'Morning Pages',
    body: 'Your blank page for today is ready—write freely, just for yourself.',
  },
  {
    title: 'Morning Pages',
    body: 'Good morning. Whenever you have a quiet moment, today’s page is open.',
  },
];

export function selectGenericReminderCopy(
  userId: bigint,
  localDate: string,
): {
  title: string;
  body: string;
} {
  let hash = Number(userId % 997n);
  for (let i = 0; i < localDate.length; i++) {
    hash = (hash * 31 + localDate.charCodeAt(i)) >>> 0;
  }
  const index = hash % GENERIC_REMINDER_MESSAGES.length;
  return GENERIC_REMINDER_MESSAGES[index] ?? GENERIC_REMINDER_MESSAGES[0]!;
}

export function buildReminderPushPayload(
  userId: bigint,
  localDate: string,
): PushNotificationPayload {
  const copy = selectGenericReminderCopy(userId, localDate);
  return {
    title: copy.title,
    body: copy.body,
    url: '/',
    tag: `morning-pages-reminder-${localDate}`,
  };
}

// ───────────── Web Push Transport Abstraction ─────────────

export interface WebPushClient {
  sendNotification(
    subscription: {
      endpoint: string;
      keys: { p256dh: string; auth: string };
    },
    payload: string,
  ): Promise<void>;
}

export function createWebPushClient(config: AppConfig): WebPushClient {
  webpush.setVapidDetails(config.VAPID_SUBJECT, config.VAPID_PUBLIC_KEY, config.VAPID_PRIVATE_KEY);

  return {
    async sendNotification(subscription, payload) {
      await webpush.sendNotification(subscription, payload);
    },
  };
}

export interface SendPushSubscriptionOptions {
  maxRetries?: number;
  baseBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

function getPushStatusCode(err: unknown): number | undefined {
  if (typeof err === 'object' && err !== null && 'statusCode' in err) {
    const code = (err as { statusCode?: unknown }).statusCode;
    if (typeof code === 'number') return code;
  }
  return undefined;
}

/**
 * Sends a push notification to a single subscription with retries and exponential backoff.
 * If the push service returns `404` or `410` (dead/unsubscribed endpoint), deletes the subscription
 * from `push_subscriptions` immediately and does not retry.
 */
export async function deliverToSubscriptionWithRetry(params: {
  sub: PushSubscriptionRecord;
  payload: PushNotificationPayload;
  pushClient: WebPushClient;
  repo: PushRepository;
  logger?: Logger;
  options?: SendPushSubscriptionOptions;
}): Promise<'delivered' | 'dead_removed' | 'failed'> {
  const { sub, payload, pushClient, repo, logger = createLogger(), options } = params;
  const maxRetries = options?.maxRetries ?? 3;
  const baseBackoffMs = options?.baseBackoffMs ?? 200;
  const sleep =
    options?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const serializedPayload = JSON.stringify(payload);

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await pushClient.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: {
            p256dh: sub.p256dh,
            auth: sub.auth,
          },
        },
        serializedPayload,
      );
      return 'delivered';
    } catch (err) {
      const statusCode = getPushStatusCode(err);
      if (statusCode === 404 || statusCode === 410) {
        await repo.deleteSubscriptionById(sub.id);
        logger.info(
          { subscriptionId: sub.id.toString(), userId: sub.userId.toString(), statusCode },
          'Removed expired/unsubscribed push subscription (404/410)',
        );
        return 'dead_removed';
      }

      if (attempt < maxRetries) {
        const delayMs = baseBackoffMs * Math.pow(2, attempt);
        await sleep(delayMs);
      } else {
        logger.warn(
          { subscriptionId: sub.id.toString(), userId: sub.userId.toString(), statusCode },
          'Push delivery failed after retries',
        );
      }
    }
  }

  return 'failed';
}

// ───────────── Scheduler & Send Job Queue ─────────────

export interface ReminderSendJobData {
  userId: string;
  localDate: string;
}

export interface ReminderJobQueue {
  /**
   * Enqueues one reminder send job for `(userId, localDate)`.
   * Returns `true` if newly enqueued, or `false` if already enqueued/sent for that user and local date.
   */
  enqueueSendReminder(job: ReminderSendJobData): Promise<boolean>;
}

/**
 * In-memory queue and idempotency ledger that coordinates minute-tick scheduling and send jobs.
 */
export class InMemoryReminderJobQueue implements ReminderJobQueue {
  public readonly enqueuedJobs: ReminderSendJobData[] = [];
  public readonly sentLedger = new Set<string>();
  private readonly enqueuedKeys = new Set<string>();

  public static buildSingletonKey(userId: string | bigint, localDate: string): string {
    return `reminder:${String(userId)}:${localDate}`;
  }

  public hasBeenReminded(userId: string | bigint, localDate: string): boolean {
    const key = InMemoryReminderJobQueue.buildSingletonKey(userId, localDate);
    return this.sentLedger.has(key) || this.enqueuedKeys.has(key);
  }

  public markReminded(userId: string | bigint, localDate: string): void {
    const key = InMemoryReminderJobQueue.buildSingletonKey(userId, localDate);
    this.sentLedger.add(key);
  }

  public async enqueueSendReminder(job: ReminderSendJobData): Promise<boolean> {
    const key = InMemoryReminderJobQueue.buildSingletonKey(job.userId, job.localDate);
    if (this.enqueuedKeys.has(key) || this.sentLedger.has(key)) {
      return false;
    }
    this.enqueuedKeys.add(key);
    this.enqueuedJobs.push({ ...job });
    return true;
  }

  /**
   * Processes all currently queued send jobs through `processReminderSendJob`.
   */
  public async drainSendJobs(params: {
    repo: PushRepository;
    pushClient: WebPushClient;
    logger?: Logger;
    retryOptions?: SendPushSubscriptionOptions;
  }): Promise<{
    jobsProcessed: number;
    notificationsDelivered: number;
    deadSubscriptionsRemoved: number;
  }> {
    let jobsProcessed = 0;
    let notificationsDelivered = 0;
    let deadSubscriptionsRemoved = 0;

    while (this.enqueuedJobs.length > 0) {
      const job = this.enqueuedJobs.shift()!;
      const key = InMemoryReminderJobQueue.buildSingletonKey(job.userId, job.localDate);
      if (this.sentLedger.has(key)) {
        continue;
      }

      const res = await processReminderSendJob({
        job,
        repo: params.repo,
        pushClient: params.pushClient,
        markSent: (uid, date) => this.markReminded(uid, date),
        hasAlreadySent: (uid, date) =>
          this.sentLedger.has(InMemoryReminderJobQueue.buildSingletonKey(uid, date)),
        logger: params.logger,
        retryOptions: params.retryOptions,
      });

      jobsProcessed += 1;
      notificationsDelivered += res.delivered;
      deadSubscriptionsRemoved += res.deadRemoved;
    }

    return { jobsProcessed, notificationsDelivered, deadSubscriptionsRemoved };
  }
}

export interface RunReminderSchedulerTickOptions {
  now: Date;
  repo: PushRepository;
  queue: ReminderJobQueue;
  batchSize?: number;
  minWordThreshold?: number;
  hasAlreadyBeenReminded?: (userId: bigint, localDate: string) => boolean;
}

export interface ReminderTickResult {
  usersEvaluated: number;
  jobsEnqueued: number;
}

/**
 * Minutely scheduler tick:
 * Iterates in batches (`batchSize`, default `200`) through users with `reminder_enabled = true`,
 * computes each user's local time (`HH:MM`) and local date (`YYYY-MM-DD`) in `users.timezone`
 * (handling DST transitions and half-hour offsets accurately), checks whether they have written
 * today (`word_count >= minWordThreshold`), and enqueues one send job per eligible user.
 * Never sends push notifications inline.
 */
export async function runReminderSchedulerTick({
  now,
  repo,
  queue,
  batchSize = 200,
  minWordThreshold = MIN_ENTRY_WORDS_TO_SUPPRESS_REMINDER,
  hasAlreadyBeenReminded,
}: RunReminderSchedulerTickOptions): Promise<ReminderTickResult> {
  let afterUserId = 0n;
  let usersEvaluated = 0;
  let jobsEnqueued = 0;

  while (true) {
    const batch = await repo.fetchReminderEnabledUsersBatch(afterUserId, batchSize);
    if (batch.length === 0) {
      break;
    }

    for (const candidate of batch) {
      usersEvaluated += 1;
      afterUserId = candidate.userId;

      const userLocalTime = getUserLocalHourMinute(now, candidate.timezone);
      const targetReminderTime = normalizeHourMinute(candidate.reminderTime);

      if (userLocalTime !== targetReminderTime) {
        continue;
      }

      const userLocalDate = getUserLocalDate(now, candidate.timezone);

      if (hasAlreadyBeenReminded && hasAlreadyBeenReminded(candidate.userId, userLocalDate)) {
        continue;
      }

      const hasEntry = await repo.hasEntryForLocalDate(
        candidate.userId,
        userLocalDate,
        minWordThreshold,
      );
      if (hasEntry) {
        continue;
      }

      const enqueued = await queue.enqueueSendReminder({
        userId: candidate.userId.toString(),
        localDate: userLocalDate,
      });
      if (enqueued) {
        jobsEnqueued += 1;
      }
    }
  }

  return { usersEvaluated, jobsEnqueued };
}

/**
 * Worker handler for a single user's daily reminder send job.
 * Re-verifies idempotency and that no entry was written since the job was enqueued,
 * pushes to all of the user's subscriptions with retries and exponential backoff,
 * cleans up `404`/`410` dead subscriptions, and records that the reminder was sent.
 */
export async function processReminderSendJob(params: {
  job: ReminderSendJobData;
  repo: PushRepository;
  pushClient: WebPushClient;
  markSent: (userId: bigint, localDate: string) => void | Promise<void>;
  hasAlreadySent?: (userId: bigint, localDate: string) => boolean | Promise<boolean>;
  minWordThreshold?: number;
  logger?: Logger;
  retryOptions?: SendPushSubscriptionOptions;
}): Promise<{ delivered: number; deadRemoved: number; failed: number; skipped: boolean }> {
  const {
    job,
    repo,
    pushClient,
    markSent,
    hasAlreadySent,
    minWordThreshold = MIN_ENTRY_WORDS_TO_SUPPRESS_REMINDER,
    logger = createLogger(),
    retryOptions,
  } = params;

  const userId = BigInt(job.userId);

  if (hasAlreadySent && (await hasAlreadySent(userId, job.localDate))) {
    return { delivered: 0, deadRemoved: 0, failed: 0, skipped: true };
  }

  // Re-check if the user wrote an entry between enqueue and worker execution
  const hasEntryNow = await repo.hasEntryForLocalDate(userId, job.localDate, minWordThreshold);
  if (hasEntryNow) {
    await markSent(userId, job.localDate);
    return { delivered: 0, deadRemoved: 0, failed: 0, skipped: true };
  }

  const subscriptions = await repo.listSubscriptionsForUser(userId);
  if (subscriptions.length === 0) {
    await markSent(userId, job.localDate);
    return { delivered: 0, deadRemoved: 0, failed: 0, skipped: true };
  }

  const payload = buildReminderPushPayload(userId, job.localDate);

  let delivered = 0;
  let deadRemoved = 0;
  let failed = 0;

  for (const sub of subscriptions) {
    const outcome = await deliverToSubscriptionWithRetry({
      sub,
      payload,
      pushClient,
      repo,
      logger,
      options: retryOptions,
    });
    if (outcome === 'delivered') delivered += 1;
    else if (outcome === 'dead_removed') deadRemoved += 1;
    else failed += 1;
  }

  await markSent(userId, job.localDate);
  return { delivered, deadRemoved, failed, skipped: false };
}

/**
 * Registers the `pg-boss` recurring minutely scheduler (`* * * * *`) and send worker
 * for production/runtime execution.
 */
export async function registerPgBossReminderJobs(params: {
  boss: PgBoss;
  repo: PushRepository;
  pushClient: WebPushClient;
  logger?: Logger;
}): Promise<void> {
  const { boss, repo, pushClient, logger = createLogger() } = params;
  const sentTodayMemorySet = new Set<string>();

  await boss.createQueue(REMINDER_TICK_QUEUE);
  await boss.createQueue(REMINDER_SEND_QUEUE);

  const pgBossQueueAdapter: ReminderJobQueue = {
    async enqueueSendReminder(job) {
      const singletonKey = InMemoryReminderJobQueue.buildSingletonKey(job.userId, job.localDate);
      if (sentTodayMemorySet.has(singletonKey)) {
        return false;
      }
      const jobId = await boss.send(REMINDER_SEND_QUEUE, job, {
        singletonKey,
        retryLimit: 3,
        retryBackoff: true,
      });
      return jobId !== null;
    },
  };

  await boss.schedule(REMINDER_TICK_QUEUE, '* * * * *');

  await boss.work(REMINDER_TICK_QUEUE, async () => {
    await runReminderSchedulerTick({
      now: new Date(),
      repo,
      queue: pgBossQueueAdapter,
      hasAlreadyBeenReminded: (uid, localDate) =>
        sentTodayMemorySet.has(InMemoryReminderJobQueue.buildSingletonKey(uid, localDate)),
    });
  });

  await boss.work<ReminderSendJobData>(REMINDER_SEND_QUEUE, async (jobs) => {
    for (const job of jobs) {
      await processReminderSendJob({
        job: job.data,
        repo,
        pushClient,
        logger,
        hasAlreadySent: (uid, localDate) =>
          sentTodayMemorySet.has(InMemoryReminderJobQueue.buildSingletonKey(uid, localDate)),
        markSent: (uid, localDate) => {
          sentTodayMemorySet.add(InMemoryReminderJobQueue.buildSingletonKey(uid, localDate));
        },
      });
    }
  });
}
