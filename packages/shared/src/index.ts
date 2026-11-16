import { z } from 'zod';

// ───────────── Common primitives ─────────────

export const ianaTimezoneSchema = z
  .string()
  .min(1)
  .refine((tz) => {
    try {
      Intl.DateTimeFormat(undefined, { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, 'Invalid IANA timezone');

export const localDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a YYYY-MM-DD local date')
  .refine((val) => {
    const parts = val.split('-');
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (!year || month < 1 || month > 12 || day < 1 || day > 31) {
      return false;
    }
    const utcDate = new Date(Date.UTC(year, month - 1, day));
    return (
      utcDate.getUTCFullYear() === year &&
      utcDate.getUTCMonth() === month - 1 &&
      utcDate.getUTCDate() === day
    );
  }, 'Must be a valid calendar date');

/**
 * Formats a `Date` instant into a `YYYY-MM-DD` local calendar date in the given IANA timezone.
 * Never uses server local time or raw UTC alone (AGENTS.md Rule 2).
 */
export function getUserLocalDate(now: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(now);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  if (!year || !month || !day) {
    throw new Error(`Failed to format local date for timezone ${timezone}`);
  }
  return `${year}-${month}-${day}`;
}

/**
 * Adds `days` (positive or negative) to a `YYYY-MM-DD` calendar date and returns the new `YYYY-MM-DD` string.
 */
export function addDaysToLocalDate(dateStr: string, days: number): string {
  const parts = dateStr.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  const utc = new Date(Date.UTC(year, month - 1, day + days));
  const y = String(utc.getUTCFullYear()).padStart(4, '0');
  const m = String(utc.getUTCMonth() + 1).padStart(2, '0');
  const d = String(utc.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Computes the word count of a plaintext journal entry.
 */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(/\s+/).length;
}

export const localTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/, 'Must be a valid HH:MM or HH:MM:SS time');

// ───────────── Health ─────────────

export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  timestamp: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ───────────── Auth schemas ─────────────

/**
 * Common/known-breached passwords rejected at registration and password reset.
 */
export const COMMON_BREACHED_PASSWORDS = new Set([
  '1234567890',
  '12345678901',
  '123456789012',
  'password123',
  'password1234',
  'password12345',
  'qwertyuiop',
  'qwerty12345',
  'welcome1234',
  'letmein1234',
  'admin123456',
  'iloveyou123',
  'monkey12345',
  'dragon12345',
  'sunshine123',
  'princess123',
  'football123',
  'baseball123',
  'trustno1234',
  'superman123',
  'morningpages',
  'firstwrite1',
]);

export const passwordSchema = z
  .string()
  .min(10, 'Password must be at least 10 characters long')
  .max(200, 'Password must be at most 200 characters long')
  .refine(
    (pw) => {
      const normalized = pw.trim().toLowerCase();
      if (COMMON_BREACHED_PASSWORDS.has(normalized)) {
        return false;
      }
      // Reject single repeated character (e.g. "aaaaaaaaaa")
      if (/^(.)\1+$/.test(normalized)) {
        return false;
      }
      return true;
    },
    {
      message: 'This password is too common or has appeared in known data breaches',
    },
  );

export const registerRequestSchema = z.object({
  email: z.string().email().max(255),
  password: passwordSchema,
  timezone: ianaTimezoneSchema.default('UTC'),
  turnstileToken: z.string().optional(),
});

export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const loginRequestSchema = z.object({
  email: z.string().email().max(255),
  password: z.string().min(1).max(200),
  cancelDeletion: z.boolean().optional(),
});

export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const verifyEmailRequestSchema = z.object({
  token: z.string().min(1),
});

export type VerifyEmailRequest = z.infer<typeof verifyEmailRequestSchema>;

export const requestResetSchema = z.object({
  email: z.string().email().max(255),
});

export type RequestResetRequest = z.infer<typeof requestResetSchema>;

export const resetPasswordRequestSchema = z.object({
  token: z.string().min(1),
  password: passwordSchema,
});

export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

export const sessionIdParamSchema = z.object({
  id: z.string().regex(/^\d+$/, 'Session ID must be a positive integer'),
});

export const sessionItemSchema = z.object({
  id: z.string(),
  userAgent: z.string().nullable(),
  ip: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string(),
  current: z.boolean(),
});

export type SessionItem = z.infer<typeof sessionItemSchema>;

export const authUserSchema = z.object({
  id: z.string(),
  email: z.string().email(),
  timezone: ianaTimezoneSchema,
  emailVerified: z.boolean(),
  emailVerifiedAt: z.string().nullable(),
  aiConsentAt: z.string().nullable(),
  deletionScheduledAt: z.string().nullable(),
  deletionHardDeleteAt: z.string().nullable(),
  requiresVerificationBanner: z.boolean(),
});

export type AuthUser = z.infer<typeof authUserSchema>;

// ───────────── Entries schemas ─────────────

export const MAX_ENTRY_CHARACTERS = 100_000;

export const entryDateParamSchema = z.object({
  date: localDateSchema,
});

export const entriesListQuerySchema = z
  .object({
    from: localDateSchema.optional(),
    to: localDateSchema.optional(),
  })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: '"from" date must be earlier than or equal to "to" date',
    path: ['from'],
  });

export const upsertEntryRequestSchema = z.object({
  content: z
    .string()
    .max(
      MAX_ENTRY_CHARACTERS,
      `Entry exceeds maximum allowed size of ${MAX_ENTRY_CHARACTERS.toLocaleString()} characters`,
    ),
  expectedUpdatedAt: z.string().datetime().nullable().optional(),
});

export type UpsertEntryRequest = z.infer<typeof upsertEntryRequestSchema>;

export const entrySummarySchema = z.object({
  entryDate: localDateSchema,
  wordCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type EntrySummary = z.infer<typeof entrySummarySchema>;

export const entryDetailSchema = entrySummarySchema.extend({
  content: z.string(),
});

export type EntryDetail = z.infer<typeof entryDetailSchema>;

export const entriesListResponseSchema = z.object({
  entries: z.array(entrySummarySchema),
  meta: z.object({
    totalEntries: z.number().int().nonnegative(),
    totalWords: z.number().int().nonnegative(),
  }),
});

export type EntriesListResponse = z.infer<typeof entriesListResponseSchema>;

// ───────────── Settings schemas ─────────────

export const userSettingsSchema = z.object({
  timezone: ianaTimezoneSchema,
  reminderEnabled: z.boolean(),
  reminderTime: localTimeSchema,
  weeklySummaryEnabled: z.boolean(),
  summaryDeliveryTime: localTimeSchema,
  dailyWordGoal: z.number().int().min(10).max(50_000),
  aiConsentAt: z.string().nullable(),
});

export type UserSettings = z.infer<typeof userSettingsSchema>;

export const updateSettingsRequestSchema = z
  .object({
    timezone: ianaTimezoneSchema.optional(),
    reminderEnabled: z.boolean().optional(),
    reminderTime: localTimeSchema.optional(),
    weeklySummaryEnabled: z.boolean().optional(),
    summaryDeliveryTime: localTimeSchema.optional(),
    dailyWordGoal: z.number().int().min(10).max(50_000).optional(),
    aiConsent: z.boolean().optional(),
  })
  .strict();

export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;

// ───────────── Push schemas ─────────────

export const pushSubscribeRequestSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
});

export type PushSubscribeRequest = z.infer<typeof pushSubscribeRequestSchema>;

export const pushUnsubscribeRequestSchema = z.object({
  endpoint: z.string().url(),
});

export type PushUnsubscribeRequest = z.infer<typeof pushUnsubscribeRequestSchema>;

// ───────────── Summaries schemas ─────────────

export const summaryStatusSchema = z.enum(['pending', 'done', 'skipped', 'failed']);

export type SummaryStatus = z.infer<typeof summaryStatusSchema>;

export const weeklySummaryItemSchema = z.object({
  weekStart: localDateSchema,
  weekEnd: localDateSchema,
  status: summaryStatusSchema,
  summaryMd: z.string().nullable(),
  themes: z.array(z.string()).nullable(),
  skipReason: z.string().nullable(),
  createdAt: z.string(),
  deliveredAt: z.string().nullable(),
});

export type WeeklySummaryItem = z.infer<typeof weeklySummaryItemSchema>;

// ───────────── Export & Account schemas ─────────────

export const exportQuerySchema = z.object({
  format: z.enum(['zip', 'md']).default('zip'),
});

export type ExportQuery = z.infer<typeof exportQuerySchema>;

export const deleteAccountRequestSchema = z.object({
  password: z.string().min(1),
});

export type DeleteAccountRequest = z.infer<typeof deleteAccountRequestSchema>;

// ───────────── API Error ─────────────

export const apiErrorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
