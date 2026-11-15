Brief 1: Project scaffold and tooling
Goal: A working monorepo skeleton that every other agent builds on.
Requirements:
Monorepo (npm or pnpm workspaces) with apps/web (React/Vite), apps/api
(Express), and packages/shared (shared TypeScript types and validation schemas
used by both sides).
TypeScript strict mode everywhere, ESLint, Prettier, and a single command to lint,
typecheck and test the whole repo.
Morning Pages: Agent Briefs
Page 2 of 12
A validated config module in the API (using a schema validator) that reads
environment variables and refuses to start if any required value is missing. Provide a
documented .env.example listing every variable used across the project (database
URL, encryption key(s), session secret, VAPID keys, email provider key, LLM provider
key and model name, app base URL).
A database migration setup using a migration tool of your choice (Drizzle or Prisma),
with the initial migration generated from schema.sql . Include a seed script for local
development.
Express bootstrapped with structured logging (pino and pino-http) (with a redaction
list so request bodies for entry and auth endpoints are never logged), a health
endpoint, centralized error-handling middleware (async errors must be caught, so use
Express 5 or an equivalent wrapper), helmet, same-origin CORS, and the trust proxy
setting configured for running behind Traefik so client IPs are correct for rate limiting
and session records.
Docker Compose for local development (Postgres plus the two apps with hot reload).
CI workflow that runs lint, typecheck and tests on every push.
Acceptance criteria:
A fresh clone plus .env plus one command starts Postgres, runs migrations, and
serves both apps locally.
Starting the API with a missing required environment variable fails immediately with a
clear message.
A test proves that logging a request to an entry endpoint does not emit the body.
Out of scope: auth, entries, any feature work.
