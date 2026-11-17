## Brief 10: Deployment and operations

**Goal:** A hardened, observable, backed-up production setup on a single VPS, deployed the same way as the owner's existing projects: GitHub Actions, SSH to the VPS, Docker Compose behind an existing Traefik.

**Reference files:** The owner's existing Teamflo `deploy.yml`, both Dockerfiles and `docker-compose.yaml` are attached. Copy their structure: a pnpm monorepo, separate `test-api` and `test-web` jobs gating a `deploy` job, `appleboy/ssh-action`, a `.env` written from GitHub secrets, `docker compose up -d --build`, `docker image prune -f`, and Traefik labels on the external `proxy` network. Do not copy their problems (see "Fixes to the reference" below).

### Requirements

**Existing Traefik (do not define one)**
- Traefik already runs on the VPS and is configured outside this repo. Assume an external Docker network named `proxy`, a `websecure` entrypoint, a certificate resolver named `myresolver`, the Docker provider enabled, and public DNS already pointing at the VPS.
- Do not add a `traefik` service. Document these assumptions in the README so a fresh VPS can be set up.

**Compose services**
- `api`, `web` and `db` (Postgres 15) in one `docker-compose.yaml` at the repo root.
- `api` and `web` join both the external `proxy` network and an internal default network.
- `db` joins ONLY the internal network, uses a persistent named volume (`postgres_data`), and publishes no host port.
- Nothing in this stack publishes host ports.
- All services have `restart: unless-stopped` and resource limits.
- Prefix all container names, Traefik router names and Traefik service names with the project name (for example `morningpages-api`), because the `proxy` network is shared with other projects.

**Images**
- Both app images build from the repo root so the shared package is available to each. Add a `.dockerignore` so `.env`, `.git` and `node_modules` never enter the build context.
- Web image: multi-stage. A Vite build receives `VITE_API_BASE_URL` and the Sentry DSN as build args, then the output is served by a small non-root Node static server on internal port 8080. Traefik remains the external reverse proxy.
- Use ONE name for each build arg end to end, with the `VITE_` prefix for anything the browser needs. (The reference passes `VITE_SENTRY_DSN` from compose but declares `SENTRY_DSN` in the Dockerfile, so the value never arrives.)
- API image: multi-stage, production dependencies only, runs as a non-root user, listens on port 3000 with `HOST=0.0.0.0`, and receives its configuration from the `.env` file at runtime.

**Traefik routing labels**
- On each service: `traefik.enable=true` and `traefik.docker.network=proxy`.
- Web router: `Host(<domain>)` on `websecure`, TLS, `myresolver`.
- API router: the same host plus `PathPrefix(/api)` on `websecure`, TLS, `myresolver`, explicitly targeting container port 3000, with an explicit higher priority than the web router instead of relying on default rule-length ordering.
- The API mounts all its routes under `/api` and exposes `/api/health`, so there is NO path-stripping middleware.
- The HTTP to HTTPS redirect is handled by the existing Traefik. Verify it and document it if it is missing.

**Headers and caching**
- The Node static server must fall back to `index.html` for unknown paths (so refreshing a deep link does not return 404).
- Serve the service worker file and the web manifest with a no-cache header, and hashed assets with long-lived immutable caching.
- Enable compression.
- Apply security headers (HSTS, a CSP suited to a PWA, nosniff, frame denial) in the Node static server or as Traefik middleware labels.
- Traefik's rate-limit middleware may be added as a coarse outer layer, but the application's own per-account limits from Brief 3 still apply.

**Real client IP**
- Traefik forwards the client address in `X-Forwarded-For`. Set Express's trust proxy to the correct number of hops (one for Traefik alone, two if Cloudflare is in front).
- Add a test or smoke check proving that rate limiting and session records see the real client IP and not Traefik's.

**CI (GitHub Actions)**
- Runs on pull requests targeting `main` and on pushes to `main`.
- Jobs: build the shared package; test the API against a Postgres service container using the SAME major version as production (15); lint, build and test the web app.
- Only a push to `main`, after BOTH test jobs pass, triggers the deploy job.
- Use a concurrency group so two deploys can never overlap.

**Deploy job**
- SSH to the VPS as a dedicated deploy user (key in a GitHub secret, host key pinned) and change to the app directory (for example `~/morning-pages`).
- Fetch and reset to the exact commit SHA that passed CI (not a plain `git pull`).
- Write the production `.env` from GitHub Actions secrets with file permissions 600. Never echo values to logs.
- Run `docker compose up -d --build`, run migrations (below), run a health-check smoke test against `/api/health` through the public URL, and only then prune unused images.
- If the smoke test fails, the workflow fails visibly.

**Migrations**
- Run automatically on every deploy as a one-shot step (for example `docker compose run --rm api <migrate command>`) before the new API serves traffic.
- Take a `pg_dump` immediately before applying any pending migration.
- Write migrations so the previous app version still works against the new schema (add columns and tables first, remove things in a later release), because rollback of code is easy but rollback of data is not.

**Database readiness and credentials**
- Give `db` a `pg_isready` healthcheck and make `api` depend on it with the `service_healthy` condition (a plain `depends_on` does not wait for readiness). The API should also retry its first connection briefly.
- Keep ONE source of truth for database credentials: build `DATABASE_URL` from the `POSTGRES_*` values instead of storing a separate full URL secret that can drift.
- Validate at startup that `DATABASE_URL` points at the Compose database (host = the prefixed `db` service name) and that the credentials match. Fail fast with a clear message otherwise.

**Production configuration**
- All of the following come from GitHub Actions secrets into the generated `.env`, and every variable is documented in `.env.example`: `HOST`, `PORT`, `POSTGRES_*`, the session secret, the encryption keyring and current key version, VAPID keys, the email provider key, the LLM provider key, model name and monthly spend ceiling, the allowed CORS origin and app base URL, and the Sentry DSN.
- The frontend calls `https://<domain>/api` (same origin).

**Secrets handling**
- A documented process for generating the encryption keys and VAPID keys, storing them outside the repo and images, and rotating them.
- The encryption key must also be backed up separately and securely (for example a password manager plus an offline copy), because without it the encrypted journals in every backup are unreadable.

**Backups**
- Nightly `pg_dump`, compressed and ENCRYPTED, copied off the VPS to object storage, with retention (for example 14 daily and 8 weekly), failure alerts, and a documented and TESTED restore procedure.
- Run it from host cron or a small backup container in the Compose file.

**Server hardening checklist**
- SSH keys only, firewall allowing only 80, 443 and SSH, automatic security updates, fail2ban or equivalent, non-root containers.
- Docker socket access limited to Traefik (read-only or via a socket proxy) as part of the existing Traefik setup.

**Monitoring**
- Uptime check on `/api/health`.
- Error tracking (Sentry or similar) configured to scrub request bodies and journal content.
- Docker log rotation.
- Alerts for disk space, failed backups, failed deploys, failed jobs and LLM spend.

**Rollback**
- A documented procedure to redeploy a previous commit SHA (rebuild with `docker compose up -d --build` at that revision), including what to do when a migration has already run.
- Database rollback means restoring the pre-migration dump, so state clearly when that is and is not acceptable.

**Optional:** Cloudflare in front for DDoS protection, with correct real-IP handling as above.

### Fixes to the reference (do not copy these from the Teamflo files)
- `db` is on the shared `proxy` network, so any container there can reach Postgres. Use an internal-only network.
- Generic names (`db`, `api`, `web`) and router names can collide with other projects on the shared network. Prefix everything.
- Build arg name mismatch (`VITE_SENTRY_DSN` vs `SENTRY_DSN`).
- No static-origin config, so no SPA fallback and no cache headers.
- CI uses Postgres 16 while production uses 15.
- No `.dockerignore`, containers run as root, API image carries dev dependencies.
- `DB_PASSWORD` and `DATABASE_URL` are separate secrets that can drift.
- Deploy uses `git pull` instead of an exact SHA, has no concurrency control, no migrations, no health check, and no pre-migration backup.

### Acceptance criteria
- A runbook document covering deploy, rollback, restore from backup, key rotation, and "what to do if the server is compromised".
- A performed and recorded restore test.
- A clean deploy from a merge to `main` succeeds end to end, including migrations and the smoke test.
- Refreshing a deep link (for example `/entries/2026-11-15`) loads the app instead of returning 404.
- The database is unreachable from other containers on the `proxy` network.
- Two overlapping pushes to `main` never deploy at the same time.