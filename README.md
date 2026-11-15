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
