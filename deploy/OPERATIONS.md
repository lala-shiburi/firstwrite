# Morning Pages production operations

This runbook assumes a Linux VPS with Docker Compose v2 and the existing Traefik installation. It is intentionally not a Traefik deployment: Traefik remains owned and operated outside this repository.

## Required infrastructure and one-time setup

- DNS for `APP_DOMAIN` points to the VPS.
- Traefik has the external Docker network `proxy`, Docker provider enabled, `exposedByDefault=false`, a `websecure` entrypoint, and the `myresolver` ACME resolver.
- Traefik redirects HTTP (`web`) to HTTPS (`websecure`). Confirm `curl -sSI "http://$APP_DOMAIN/api/health"` returns a 301/308 with an HTTPS `Location` before enabling the app.
- Traefik's Docker socket is read-only or provided through a restricted socket proxy. Do not expose the dashboard publicly without strong access control.
- Create the external network once: `docker network create proxy`.
- The VPS firewall allows only SSH, TCP 80, and TCP 443. Use SSH keys only, automatic security updates, and fail2ban or an equivalent.
- Use a dedicated deploy account with a pinned SSH host key in GitHub (`VPS_HOST_FINGERPRINT`). Restrict its SSH key and repository access. Membership in the Docker group is effectively root access; treat the deploy account accordingly.
- Do not publish host ports from this stack. The API and web containers attach to `proxy` and the internal Compose network; Postgres attaches only to the internal network.

Deploy the repository at `~/morning-pages` for the deploy user. Configure GitHub Actions secrets for `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY`, `VPS_HOST_FINGERPRINT`, and every application variable listed in [`.env.example`](../.env.example). Set `APP_DOMAIN`, `APP_BASE_URL`, `CORS_ORIGIN`, and `VITE_API_BASE_URL` to the public site (`https://<domain>`, `https://<domain>`, and `https://<domain>/api` respectively). Use `TRUST_PROXY=1` for Traefik alone or `TRUST_PROXY=2` when Cloudflare is the additional trusted hop. Configure Cloudflare's trusted forwarded-header IP ranges at Traefik; do not trust arbitrary forwarded headers from the Internet.

The generated application `.env` is written by CI with mode `0600`; it is not tracked, copied into either Docker build, or included in image layers. The web build contains only the public API URL, public VAPID key, and public Sentry DSN. The encryption, session, database, provider, and VAPID private keys remain server-side.

## Key generation, storage, and rotation

Generate production values on a trusted workstation or password manager, never in the repository:

```sh
openssl rand -hex 32                 # ENCRYPTION_KEY_V1 (32-byte AES key)
openssl rand -hex 32                 # SESSION_SECRET
openssl rand -hex 32                 # POSTGRES_PASSWORD (URL-safe hex)
npx web-push generate-vapid-keys     # VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY
```

Set `VAPID_SUBJECT` to an operator contact. Keep a second, separately secured copy of every encryption key (for example, in a password manager plus an offline encrypted copy). Back up the VAPID private key and database credentials separately too. Never put private key material in Git, an image, an issue, a log, or an object-storage backup without independent encryption. Preserve old encryption key versions until every row and every retained database backup encrypted with them has expired or been re-encrypted.

For an encryption-key rotation, add `ENCRYPTION_KEY_V<n>` while retaining every existing key, deploy with the old current version first, then deploy with `ENCRYPTION_KEY_CURRENT_VERSION=<n>`. Run `docker compose run --rm api npm run db:reencrypt:prod --workspace=@firstwrite/api`; verify completion and inspect that no rows use old versions before removing an old key from the runtime keyring. Keep old keys in the secure offline key archive for the full backup-retention period. Rotating a database password requires a coordinated Postgres credential update and `.env` update; changing only one side will intentionally fail startup validation. Rotate a compromised session secret by revoking sessions, and rotate VAPID keys only with an announced push-subscription refresh plan.

## Deploy and verify

Merges to `main` run shared-package build, API tests and migrations against PostgreSQL 15, and web lint/build/tests. Only a successful push to `main` enters deployment. Workflow-level concurrency serializes runs for `main`.

The deploy step:

1. Fetches and resets the VPS checkout to the exact tested Git SHA.
2. Writes `.env` without printing secrets and sets permissions to `0600`.
3. Starts Postgres and waits for its `pg_isready` health check.
4. Creates an encrypted pre-migration dump and uploads it to the configured object store.
5. Runs the one-shot production migration against the new API image before restarting the serving API. Migrations must be additive/backward-compatible; remove old schema only in a later release.
6. Runs `docker compose up -d --build`, checks public `https://<domain>/api/health`, verifies the HTTP-to-HTTPS redirect, and only then prunes unused images.

Check deployment health and the SPA fallback:

```sh
cd ~/morning-pages
docker compose ps
curl --fail --show-error "https://$APP_DOMAIN/api/health"
curl --fail --show-error --output /dev/null "https://$APP_DOMAIN/entries/2026-11-15"
docker inspect firstwrite-db --format '{{json .NetworkSettings.Networks}}'
```

The final inspection should show only the project-internal network on `firstwrite-db`, never `proxy`. Verify Docker log rotation with `docker inspect firstwrite-api --format '{{json .HostConfig.LogConfig}}'`. The compose services apply bounded CPU/memory and `json-file` log rotation; API, web, and Postgres run as non-root users. Traefik terminates TLS and routes to the Node static web origin on internal port 8080; the web container does not run a reverse proxy.

## Encrypted nightly backups

Install `age`, `rclone`, and Docker Compose on the VPS. Configure an `rclone` remote for private object storage with access limited to this backup destination. Create `/etc/morning-pages/backup.env` owned by the deploy account with mode `0600`:

```sh
AGE_RECIPIENT=age1...
RCLONE_REMOTE=private-backups:morning-pages
ALERT_WEBHOOK_URL=https://your-alert-provider.example/webhook/...
COMPOSE_DIR=/home/DEPLOY_USER/morning-pages
```

Only the age **recipient/public key** is on the server. Keep the corresponding identity/private key offline and separately backed up. The script runs `pg_dump` in custom (compressed) format, encrypts the stream before writing a temporary file, uploads it, and removes that temporary file. Daily dumps older than 14 days and weekly dumps older than 56 days are removed from the object store. Pre-migration dumps are kept separately; apply an object-store lifecycle policy after confirming it exceeds your rollback needs. Any backup/upload/retention failure exits non-zero and sends a generic alert to the configured webhook.

Schedule a nightly run as the deploy account (edit the path to the checkout; keep cron logs rotated):

```cron
CRON_TZ=UTC
15 2 * * * /home/DEPLOY_USER/morning-pages/deploy/backup.sh daily >> /home/DEPLOY_USER/morning-pages-backup.log 2>&1
```

Configure alerting for the cron exit status, webhook delivery, disk space, failed GitHub deployments, API/job errors, uptime of `/api/health`, and monthly LLM spend. Keep health checks content-free. Sentry is optional but, when configured, both SDKs remove request bodies, request metadata, breadcrumbs, user/context data, and original exception messages before events leave the process. Do not add journal text to Sentry tags, messages, breadcrumbs, or error contexts.

## Restore from an encrypted backup

Restore into an isolated PostgreSQL 15 instance first. Never overwrite the only live copy during a test. Download a selected object-store dump to a protected temporary location and confirm its age identity is available offline:

```sh
umask 077
rclone copyto private-backups:morning-pages/daily/firstwrite-YYYYMMDDTHHMMSSZ.dump.age /secure/restore.dump.age
age --decrypt --identity /secure/backup-identity.txt /secure/restore.dump.age \
  | pg_restore --list
```

For an isolated restore, start a separate PostgreSQL 15 Compose project (for example `docker compose -p firstwrite-restore -f /secure/restore/docker-compose.yaml up -d db`) with the same database major version and test credentials. Never run these restore commands against the production Compose project. Create an empty database in the isolated project, then stream the dump through `age`:

```sh
docker compose -p firstwrite-restore -f /secure/restore/docker-compose.yaml exec -T db sh -c 'createdb -U "$POSTGRES_USER" restore_check'
age --decrypt --identity /secure/backup-identity.txt /secure/restore.dump.age \
  | docker compose -p firstwrite-restore -f /secure/restore/docker-compose.yaml exec -T db sh -c 'pg_restore --exit-on-error --no-owner -U "$POSTGRES_USER" -d restore_check'
```

Validate that expected tables, indexes, migration metadata, and representative row counts exist; confirm app-level ciphertext remains decryptable using the separately backed-up application encryption key. Do not export plaintext journal rows into logs or test reports. Record duration and outcome below.

For an actual production recovery, notify users/operators, stop API traffic and workers, preserve the current database for forensics, and take a fresh encrypted snapshot if possible. Restore only after confirming the selected point-in-time and expected data loss. Restore the dump and matching code/key set, apply only compatible migrations, restart services, and verify health, login, and encrypted-data reads. A database restore replaces all writes after that backup.

### Live VPS restore-test record

Do not mark this test complete until a restore has been performed against the live VPS's backup and encryption-key process. This workspace has no VPS or object-storage credentials, so no live restore has been claimed.

| Field                                                | Record  |
| ---------------------------------------------------- | ------- |
| Test date/time (UTC)                                 | Pending |
| Operator                                             | Pending |
| Backup object and timestamp                          | Pending |
| Isolated target / Postgres version                   | Pending |
| Encryption identity verified from offline copy       | Pending |
| Tables, migration state, row-count/decryption checks | Pending |
| Restore duration                                     | Pending |
| Result, issues, and follow-up                        | Pending |

## Rollback and migration policy

For a code-only rollback, identify a previously successful commit SHA in GitHub Actions, check it out in `~/morning-pages`, then rebuild and restart with `docker compose up -d --build`. Run this only when that version is compatible with the current schema. The automatic deploy migration flow is intentionally forward-only.

If a migration has already run, first prefer a forward fix or a compatible old application release. Restoring the pre-migration dump is a destructive point-in-time rollback: it loses every entry, account, and setting written after the dump. It is acceptable only after an explicit incident decision and user/data-loss assessment. Stop writes, preserve the current database, restore the pre-migration dump, then redeploy matching code. Never attempt an ad-hoc destructive schema downgrade.

## If the server is compromised

1. Isolate the VPS at the provider firewall; preserve disk and encrypted backup evidence before rebuilding. Do not destroy logs or snapshots.
2. Disable the deploy SSH key and revoke VPS access tokens, GitHub credentials, object-store credentials, alert webhooks, and provider credentials from a clean device.
3. Assume all server `.env` values and application encryption keys were exposed. Rotate DB, email, LLM, VAPID, session, and monitoring credentials. Generate a new encryption-key version, deploy the new keyring, and re-encrypt stored data in a controlled environment; do not discard the old key until the incident response and retained backups are handled.
4. Review GitHub workflow/deploy history, object-store audit logs, DNS/Traefik changes, database access, account/session activity, and backup integrity. Determine notification and breach-reporting obligations.
5. Rebuild a clean VPS from trusted images, recreate the hardened Traefik/network arrangement, restore only a verified encrypted backup, deploy a reviewed commit, invalidate all user sessions, and verify encrypted journal access before reopening traffic.

## Server and monitoring checklist

- [ ] SSH keys only; dedicated deploy account; host key fingerprint pinned in GitHub.
- [ ] Firewall permits only SSH, 80, and 443; security updates automatic; fail2ban/equivalent enabled.
- [ ] Traefik socket read-only or behind a restricted socket proxy; dashboard private.
- [ ] External proxy network exists; redirect and ACME resolver verified; API/web routes use prefixed labels.
- [ ] Database is on the internal network only, has no published port, and its volume is included in encrypted backups.
- [ ] `/api/health` uptime alert and deployment-failure alerts are active.
- [ ] Disk-space, backup-failure, failed-job, error-tracking, and LLM-spend alerts have named recipients.
- [ ] Sentry request/body scrubbing verified before production DSN is enabled.
- [ ] Nightly encrypted backup and retention jobs are active; encryption identity is stored separately.
- [ ] Restore-test record above is completed and repeated periodically.
