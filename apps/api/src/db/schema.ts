import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  customType,
  date,
  index,
  integer,
  pgEnum,
  pgTable,
  smallint,
  text,
  time,
  timestamp,
  unique,
} from 'drizzle-orm/pg-core';

const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

const inet = customType<{ data: string }>({
  dataType() {
    return 'inet';
  },
});

// ───────────── Users & auth ─────────────

export const users = pgTable('users', {
  id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
  email: citext('email').notNull().unique(),
  passwordHash: text('password_hash').notNull(),
  timezone: text('timezone').notNull().default('UTC'),
  emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true }),
  aiConsentAt: timestamp('ai_consent_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const sessions = pgTable(
  'sessions',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    userAgent: text('user_agent'),
    ip: inet('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  },
  (table) => ({
    userIdx: index('sessions_user_idx').on(table.userId),
  }),
);

export const emailTokenTypeEnum = pgEnum('email_token_type', ['verify', 'reset']);

export const emailTokens = pgTable(
  'email_tokens',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: emailTokenTypeEnum('type').notNull(),
    tokenHash: text('token_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userTypeIdx: index('email_tokens_user_idx').on(table.userId, table.type),
  }),
);

// ───────────── Entries ─────────────

export const entries = pgTable(
  'entries',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    entryDate: date('entry_date', { mode: 'string' }).notNull(),
    contentEnc: text('content_enc').notNull(),
    keyVersion: smallint('key_version').notNull().default(1),
    wordCount: integer('word_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userEntryDateUnique: unique('entries_user_id_entry_date_key').on(table.userId, table.entryDate),
    userDateIdx: index('entries_user_date_idx').on(table.userId, table.entryDate),
  }),
);

// ───────────── Reminders & push ─────────────

export const userSettings = pgTable(
  'user_settings',
  {
    userId: bigint('user_id', { mode: 'bigint' })
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    reminderEnabled: boolean('reminder_enabled').notNull().default(false),
    reminderTime: time('reminder_time').notNull().default('07:00'),
    weeklySummaryEnabled: boolean('weekly_summary_enabled').notNull().default(false),
    summaryDeliveryTime: time('summary_delivery_time').notNull().default('18:00'),
    dailyWordGoal: integer('daily_word_goal').notNull().default(750),
  },
  (table) => ({
    reminderIdx: index('settings_reminder_idx')
      .on(table.reminderTime)
      .where(sql`${table.reminderEnabled}`),
    summaryIdx: index('settings_summary_idx')
      .on(table.summaryDeliveryTime)
      .where(sql`${table.weeklySummaryEnabled}`),
  }),
);

export const pushSubscriptions = pgTable(
  'push_subscriptions',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    endpoint: text('endpoint').notNull().unique(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdx: index('push_subs_user_idx').on(table.userId),
  }),
);

// ───────────── Weekly AI summaries ─────────────

export const summaryStatusEnum = pgEnum('summary_status', ['pending', 'done', 'skipped', 'failed']);

export const weeklySummaries = pgTable(
  'weekly_summaries',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    weekStart: date('week_start', { mode: 'string' }).notNull(),
    weekEnd: date('week_end', { mode: 'string' }).notNull(),
    status: summaryStatusEnum('status').notNull().default('pending'),
    summaryEnc: text('summary_enc'),
    keyVersion: smallint('key_version').notNull().default(1),
    themesEnc: text('themes_enc'),
    model: text('model'),
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    skipReason: text('skip_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  },
  (table) => ({
    userWeekStartUnique: unique('weekly_summaries_user_id_week_start_key').on(
      table.userId,
      table.weekStart,
    ),
  }),
);
