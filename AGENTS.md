# AGENTS.md

## Product
A public, multi-user "morning pages" journaling web app. Users write one free-form entry per day, get reminder notifications, can download all their entries as Markdown, and receive an AI-generated weekly summary every Sunday.

## Stack (fixed, do not substitute)
- **Frontend:** React + Vite + TypeScript, TanStack Query, Tailwind, built as a PWA (`vite-plugin-pwa`)
- **Backend:** Node + Express + TypeScript (Zod for request validation)
- **Database:** PostgreSQL (schema in the attached `schema.sql`, which is the source of truth; propose changes rather than silently diverging)
- **Jobs:** `pg-boss` (Postgres-backed queue; no Redis)
- **Push:** `web-push` with VAPID keys
- **Email:** a transactional provider behind an interface (Resend, Postmark or SES), never SMTP from the VPS
- **Hosting:** single VPS, Docker Compose, Traefik reverse proxy (configured through Docker labels, automatic HTTPS via Let's Encrypt)

## Non-negotiable rules
1. Entry text and weekly summaries are encrypted at the application layer (AES-256-GCM) before being written to the database. The key comes from an environment variable, never the database or the repo. Plaintext journal content must never appear in logs, error reports, analytics or job payloads.
2. Dates are user-local. `entry_date` and `week_start` are the user's local calendar dates, derived from `users.timezone` (IANA name). Never compute a user's "today" from server time or UTC alone.
3. Tokens are stored hashed (session tokens, email verify/reset tokens). Raw values only ever exist in the cookie or email link.
4. Losing a user's writing is the worst failure. Prefer safe failure modes: autosave retries, no destructive operations without confirmation, and no silent overwrites.
5. Weekly AI summaries require explicit consent (`users.ai_consent_at` set AND `weekly_summary_enabled` true). Without both, entries must never be sent to the LLM provider.
6. Push notification text is always generic. Never put journal content or summary content in a notification, because lock screens are public.
7. Everything must work on desktop and mobile browsers, and be usable one-handed on a phone.
8. Configuration (model name, provider keys, VAPID keys, encryption keys, spend limits) lives in environment variables with a validated config module that fails fast on startup if something is missing.

## API outline (agreed contract)
- `POST /api/auth/register | login | logout | verify-email | request-reset | reset-password`
- `GET /api/entries?from=&to=` · `GET /api/entries/:date` · `PUT /api/entries/:date` (upsert, used by autosave) · `DELETE /api/entries/:date`
- `GET /api/settings` · `PUT /api/settings`
- `POST /api/push/subscribe` · `DELETE /api/push/subscribe`
- `GET /api/summaries` · `GET /api/summaries/:weekStart` · `DELETE /api/summaries/:weekStart`
- `GET /api/export?format=zip|md`
- `DELETE /api/account`

## Definition of done for every brief
Typed code, input validation on every endpoint (schema-based), automated tests covering the acceptance criteria, no secrets committed, a short README section describing what was built and how to run its tests.
