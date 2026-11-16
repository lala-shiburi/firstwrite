# Morning Pages (`firstwrite`)

A public, multi-user "morning pages" journaling web application. Users write one free-form entry per day, receive daily reminder notifications, can download all their entries as Markdown, and receive an AI-generated weekly summary every Sunday.

## Architecture & Monorepo Structure

This repository uses **npm workspaces** with TypeScript strict mode across all packages:

- [`packages/shared`](file:///Users/lala/Documents/code/firstwrite/packages/shared) (`@firstwrite/shared`) — Shared TypeScript types and Zod validation schemas used by both the frontend and backend.
- [`apps/api`](file:///Users/lala/Documents/code/firstwrite/apps/api) (`@firstwrite/api`) — Node + Express 5 + TypeScript backend, Drizzle ORM + PostgreSQL migrations, `pg-boss` job queue, `web-push`, and `pino` structured logging with strict privacy redaction.
- [`apps/web`](file:///Users/lala/Documents/code/firstwrite/apps/web) (`@firstwrite/web`) — React + Vite + TypeScript + TanStack Query + Tailwind CSS frontend configured as a PWA via `vite-plugin-pwa`.
- [`schema.sql`](file:///Users/lala/Documents/code/firstwrite/schema.sql) — Canonical PostgreSQL 15+ database schema.

## What Was Built in Brief 1 (Project Scaffold & Tooling)

1. **Monorepo & Tooling**:
   - Configured npm workspaces (`apps/web`, `apps/api`, `packages/shared`) with shared strict TypeScript configuration ([`tsconfig.base.json`](file:///Users/lala/Documents/code/firstwrite/tsconfig.base.json)), ESLint 9 flat config ([`eslint.config.js`](file:///Users/lala/Documents/code/firstwrite/eslint.config.js)), Prettier ([`.prettierrc.json`](file:///Users/lala/Documents/code/firstwrite/.prettierrc.json)), and Vitest ([`vitest.config.ts`](file:///Users/lala/Documents/code/firstwrite/vitest.config.ts)).
   - Added `npm run check` at the root to lint, typecheck, and test the entire repository in a single command.
2. **Validated Environment Config**:
   - Implemented [`apps/api/src/config.ts`](file:///Users/lala/Documents/code/firstwrite/apps/api/src/config.ts) with Zod validation that fails fast on startup with a clear error message if any required variable is missing or invalid (including 32-byte encryption key validation).
   - Provided a documented [`.env.example`](file:///Users/lala/Documents/code/firstwrite/.env.example) covering database URL, AES-256-GCM encryption keys, session secret, VAPID keys, transactional email provider settings, LLM provider key/model/spend ceiling, and base URLs.
3. **Database Migrations & Seed**:
   - Configured Drizzle ORM ([`apps/api/src/db/schema.ts`](file:///Users/lala/Documents/code/firstwrite/apps/api/src/db/schema.ts)) and initial SQL migration ([`apps/api/drizzle/0000_initial_schema.sql`](file:///Users/lala/Documents/code/firstwrite/apps/api/drizzle/0000_initial_schema.sql)) generated from `schema.sql`, plus migration runner ([`apps/api/src/db/migrate.ts`](file:///Users/lala/Documents/code/firstwrite/apps/api/src/db/migrate.ts)) and idempotent local seed script ([`apps/api/src/db/seed.ts`](file:///Users/lala/Documents/code/firstwrite/apps/api/src/db/seed.ts)).
4. **Express 5 Bootstrap & Privacy Redaction**:
   - Bootstrapped Express 5 in [`apps/api/src/app.ts`](file:///Users/lala/Documents/code/firstwrite/apps/api/src/app.ts) with `pino` + `pino-http` ([`apps/api/src/logger.ts`](file:///Users/lala/Documents/code/firstwrite/apps/api/src/logger.ts)) configured with a strict redaction list (`REDACT_PATHS`) so request bodies, entry content, passwords, cookies, and tokens are never logged.
   - Configured `helmet`, same-origin `cors`, `trust proxy` for running behind Traefik, `/health` & `/api/health` endpoints, and centralized error-handling middleware that catches async errors and formats Zod validation errors.
5. **Local Development & CI**:
   - Added [`docker-compose.yml`](file:///Users/lala/Documents/code/firstwrite/docker-compose.yml) to start PostgreSQL 16, run migrations, and serve both `api` and `web` with hot reload in one command.
   - Added GitHub Actions CI workflow ([`.github/workflows/ci.yml`](file:///Users/lala/Documents/code/firstwrite/.github/workflows/ci.yml)) running `npm run check` on every push and pull request.

## What Was Built in Brief 2 (Encryption Module)

1. **AES-256-GCM Encryption & Decryption ([`apps/api/src/crypto/encryption.ts`](file:///Users/lala/Documents/code/firstwrite/apps/api/src/crypto/encryption.ts))**:
   - Encrypts UTF-8 strings with AES-256-GCM using a fresh 12-byte (`96-bit`) cryptographically random nonce per encryption and a 16-byte (`128-bit`) authentication tag.
   - Produces a single string encoded as `base64(nonce || ciphertext || tag)` matching `entries.content_enc`, `weekly_summaries.summary_enc`, and `weekly_summaries.themes_enc`.
2. **Versioned Keyring & Startup Validation**:
   - `Keyring` and `createKeyringFromEnv` load keys from `ENCRYPTION_KEY_V1`, `ENCRYPTION_KEY_V2`, … (`ENCRYPTION_KEY_V<n>`) and/or `ENCRYPTION_KEYS_JSON`, and validate at startup in [`apps/api/src/config.ts`](file:///Users/lala/Documents/code/firstwrite/apps/api/src/config.ts) that every configured key is exactly 32 bytes (64 hex chars or 44 base64 chars) and that `ENCRYPTION_KEY_CURRENT_VERSION` is present in the keyring.
   - New writes use `keyring.currentVersion`; reads select the key matching the row's stored `key_version`.
3. **Row-Bound Additional Authenticated Data (AAD) Choice**:
   - `encrypt` and `decrypt` accept optional `associatedData` (`string | Buffer`), with canonical helpers `buildEntryAad(userId, entryDate)` (`"entry:<userId>:<entryDate>"`) and `buildSummaryAad(userId, weekStart, field)` (`"weekly_summary:<field>:<userId>:<weekStart>"`).
   - Binding each ciphertext to its owning row (`user_id` + local date/week) ensures that if ciphertext is ever copied between users, dates, or columns in the database, GCM authentication fails immediately on decryption.
4. **Safe Error Hierarchy**:
   - Dedicated error classes (`EncryptionError`, `InvalidKeyLengthError`, `UnknownKeyVersionError`, `TamperedDataError`, `WrongKeyError`) whose messages and stack traces never include plaintext or key material.
5. **Batch Re-Encryption Utility ([`apps/api/src/crypto/reencrypt.ts`](file:///Users/lala/Documents/code/firstwrite/apps/api/src/crypto/reencrypt.ts))**:
   - `reencryptAll` (runnable via `npm run db:reencrypt`) migrates `entries` and `weekly_summaries` rows from older key versions to `keyring.currentVersion` in configurable batches using optimistic version checks (`WHERE id = $1 AND key_version = $2`), making it safely resumable if interrupted.

## What Was Built in Brief 3 (Authentication and Accounts)

1. **Registration, Argon2id Hashing & Password Hardening ([`apps/api/src/auth/crypto.ts`](file:///Users/lala/Documents/code/firstwrite/apps/api/src/auth/crypto.ts), [`packages/shared/src/index.ts`](file:///Users/lala/Documents/code/firstwrite/packages/shared/src/index.ts))**:
   - `POST /api/auth/register` validates email, timezone (IANA), and password (minimum 10 characters, rejecting known-breached and repeated-character passwords), hashes passwords with **Argon2id** (`@noble/hashes/argon2`), and optionally verifies Cloudflare Turnstile tokens when `TURNSTILE_ENABLED=true`.
2. **Email Verification & Password Reset ([`apps/api/src/auth/routes.ts`](file:///Users/lala/Documents/code/firstwrite/apps/api/src/auth/routes.ts), [`apps/api/src/auth/email.ts`](file:///Users/lala/Documents/code/firstwrite/apps/api/src/auth/email.ts))**:
   - Single-use opaque tokens are generated with 32 bytes of CSPRNG entropy and stored **SHA-256 hashed** (`token_hash`) in `email_tokens` (24-hour expiry for `verify`, 1-hour expiry for `reset`).
   - Unverified users can log in (`requiresVerificationBanner: true`) and edit general settings (`PUT /api/settings`), but are blocked from enabling weekly AI summaries until verified.
   - `POST /api/auth/request-reset` responds identically whether or not the email exists (preventing account enumeration), and `POST /api/auth/reset-password` consumes the single-use token, updates the Argon2id hash, and immediately revokes all existing sessions.
   - Transactional emails are sent through the provider-agnostic `EmailProvider` interface with `ConsoleEmailProvider` for local development and contain zero journal content.
3. **Opaque Sessions, Sliding Expiry & CSRF Protection**:
   - Sessions use random opaque tokens stored hashed (`token_hash`) in `sessions` and sent in `HttpOnly; Secure; SameSite=Lax` cookies (`mp_session`) with 30-day sliding expiry.
   - Includes `GET /api/auth/sessions` (list active sessions), `DELETE /api/auth/sessions/:id` (revoke one), `POST /api/auth/logout`, and `POST /api/auth/logout-all` ("log out everywhere").
   - State-changing requests require a session-bound HMAC CSRF token in `X-CSRF-Token` (`requireCsrf`).
4. **Rate Limiting & Exponential Lockout ([`apps/api/src/auth/rate-limit.ts`](file:///Users/lala/Documents/code/firstwrite/apps/api/src/auth/rate-limit.ts))**:
   - Per-IP and per-account rate limiting on `register`, `login`, `request-reset`, and `verify-email` / `reset-password` with exponential backoff lockouts after repeated authentication failures.
5. **Account Deletion with 14-Day Grace Period**:
   - `DELETE /api/account` requires password re-entry, sets `users.deleted_at`, immediately revokes all sessions, and enqueues a hard-delete job (`AccountJobScheduler`) for 14 days later.
   - Logging in during the 14-day grace period prompts the user (`403 ACCOUNT_DELETION_PENDING`) and cancels deletion when `cancelDeletion: true` is supplied.

## What Was Built in Brief 4 (Entries API and the Writing Experience)

1. **Entries API & User-Local Date Enforcement ([`apps/api/src/entries/routes.ts`](file:///Users/lala/Documents/code/firstwrite/apps/api/src/entries/routes.ts), [`apps/api/src/entries/repository.ts`](file:///Users/lala/Documents/code/firstwrite/apps/api/src/entries/repository.ts))**:
   - `PUT /api/entries/:date` validates calendar dates (`YYYY-MM-DD`), computes the user's local calendar date from `users.timezone` (`getUserLocalDate`), and rejects dates more than one day in the future (`400 FUTURE_DATE_NOT_ALLOWED`).
   - Enforces a generous maximum entry size (`100,000` characters, returning `413 ENTRY_TOO_LARGE` beyond it), computes `word_count` from plaintext, and encrypts content with AES-256-GCM bound to the row via AAD (`buildEntryAad(userId, date)`).
2. **Owner-Only Access & Metadata-Only List Endpoint**:
   - `GET /api/entries/:date` and `DELETE /api/entries/:date` are scoped strictly to `req.auth.user.id` so a user can never read, overwrite, or delete another user's entry by guessing dates.
   - `GET /api/entries?from=&to=` queries only metadata (`entry_date`, `word_count`, `created_at`, `updated_at`, plus aggregate `totalEntries` and `totalWords`) without selecting or decrypting `content_enc`.
3. **Optimistic Concurrency & Conflict Resolution**:
   - `PUT /api/entries/:date` accepts `expectedUpdatedAt` and compares it against the stored `updated_at`. On conflict between two devices, it returns `409 ENTRY_CONFLICT` with the decrypted `serverEntry` so the client can merge both versions rather than silently overwriting.
4. **Distraction-Free Editor, Resilient Autosave & Views ([`apps/web/src/App.tsx`](file:///Users/lala/Documents/code/firstwrite/apps/web/src/App.tsx))**:
   - Opens directly on the user's local date (`getUserLocalDate(now, timezone)`), with live word count and progress bar toward the daily goal (default `750` words).
   - Autosaves after a `1.5s` debounce when typing stops, on editor blur, on tab hide (`visibilitychange`), and on `beforeunload` (warning before tab close if unsaved changes exist).
   - On network failure, keeps all text in memory, displays `"Offline, will retry"`, and retries with exponential backoff (and immediately on `online` reconnection).
   - Includes both an **Entries** list view and a monthly **Calendar** view highlighting days with entries; tapping any day opens it for viewing and editing.
   - Responsive and accessible: comfortable readable line length (`max-w-[68ch]`), keyboard navigable, proper ARIA roles/labels, `motion-reduce` support, and system dark mode (`dark:`).

## Getting Started (Local Development)

### Quick Start with Docker Compose

From a fresh clone:

```bash
cp .env.example .env
docker compose up
```

This single command starts PostgreSQL, waits for it to be healthy, runs the database migrations, and starts both the Express API (`http://localhost:3000`) and Vite React PWA (`http://localhost:5173`) with hot reload.

### Running Locally Without Docker (Host Node.js + Local Postgres)

```bash
cp .env.example .env
npm install
npm run db:migrate
npm run db:seed
npm run dev
```

## Running Lint, Typecheck, and Tests

Run the full verification suite (lint + typecheck + automated tests) across all workspaces with a single command:

```bash
npm run check
```

Or run individual steps:

```bash
npm run lint        # ESLint across all workspaces
npm run typecheck   # Build shared types + tsc --noEmit across all workspaces
npm run test        # Vitest unit & integration test suite
```
