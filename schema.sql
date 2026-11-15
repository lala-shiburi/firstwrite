-- Morning Pages: initial schema (PostgreSQL 15+)
-- Note: pg-boss creates and manages its own "pgboss" schema automatically.

CREATE EXTENSION IF NOT EXISTS citext;

-- ───────────── Users & auth ─────────────

CREATE TABLE users (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  email               CITEXT NOT NULL UNIQUE,
  password_hash       TEXT NOT NULL,                 -- argon2id
  timezone            TEXT NOT NULL DEFAULT 'UTC',   -- IANA name, e.g. 'Africa/Johannesburg'
  email_verified_at   TIMESTAMPTZ,
  ai_consent_at       TIMESTAMPTZ,                   -- NULL = no consent to LLM processing
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at       TIMESTAMPTZ,
  deleted_at          TIMESTAMPTZ                    -- soft-delete marker; hard-delete job follows
);

CREATE TABLE sessions (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash    TEXT NOT NULL UNIQUE,                -- store hash only
  user_agent    TEXT,
  ip            INET,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (user_id);

CREATE TYPE email_token_type AS ENUM ('verify', 'reset');

CREATE TABLE email_tokens (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        email_token_type NOT NULL,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_tokens_user_idx ON email_tokens (user_id, type);

-- ───────────── Entries ─────────────

CREATE TABLE entries (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_date   DATE NOT NULL,                        -- the user's LOCAL date
  content_enc  TEXT NOT NULL,                        -- AES-256-GCM: base64(nonce || ciphertext || tag)
  key_version  SMALLINT NOT NULL DEFAULT 1,          -- supports key rotation
  word_count   INTEGER NOT NULL DEFAULT 0,           -- plaintext metadata, for stats and goals
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, entry_date)                       -- one entry per day; PUT upserts on this
);
CREATE INDEX entries_user_date_idx ON entries (user_id, entry_date DESC);

-- ───────────── Reminders & push ─────────────

CREATE TABLE user_settings (
  user_id                  BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  reminder_enabled         BOOLEAN NOT NULL DEFAULT false,
  reminder_time            TIME NOT NULL DEFAULT '07:00',   -- user's local time
  weekly_summary_enabled   BOOLEAN NOT NULL DEFAULT false,  -- also requires users.ai_consent_at
  summary_delivery_time    TIME NOT NULL DEFAULT '18:00',   -- local time, on Sundays
  daily_word_goal          INTEGER NOT NULL DEFAULT 750
);

CREATE TABLE push_subscriptions (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX push_subs_user_idx ON push_subscriptions (user_id);

-- ───────────── Weekly AI summaries ─────────────

CREATE TYPE summary_status AS ENUM ('pending', 'done', 'skipped', 'failed');

CREATE TABLE weekly_summaries (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  week_start     DATE NOT NULL,                      -- Monday, user-local
  week_end       DATE NOT NULL,                      -- Sunday, user-local
  status         summary_status NOT NULL DEFAULT 'pending',
  summary_enc    TEXT,                               -- encrypted like entries (it's derived personal data)
  key_version    SMALLINT NOT NULL DEFAULT 1,
  themes_enc     TEXT,                               -- encrypted JSON array of themes
  model          TEXT,
  input_tokens   INTEGER,
  output_tokens  INTEGER,
  skip_reason    TEXT,                               -- e.g. 'too_few_entries'
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at   TIMESTAMPTZ,
  UNIQUE (user_id, week_start)                       -- idempotency: never two summaries per week
);

-- ───────────── Scheduler support ─────────────
-- The hourly/minutely jobs filter on timezone + reminder time.
CREATE INDEX settings_reminder_idx
  ON user_settings (reminder_time) WHERE reminder_enabled;
CREATE INDEX settings_summary_idx
  ON user_settings (summary_delivery_time) WHERE weekly_summary_enabled;
