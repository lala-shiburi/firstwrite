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
