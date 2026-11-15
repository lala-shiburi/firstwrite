Brief 10: Deployment and operations
Goal: A hardened, observable, backed-up production setup on a single VPS.
Requirements:
Production Docker Compose: traefik , api , web (the static build served by a small
nginx container), postgres (with a persistent volume, on an internal-only network
with no published ports), all with restart policies and resource limits. Only Traefik
publishes ports 80 and 443.
Traefik static configuration: entrypoints for 80 and 443, a global HTTP to HTTPS
redirect, a Let's Encrypt certificate resolver with persistent ACME storage
( acme.json with 600 permissions on a mounted volume), the Docker provider with
exposedByDefault set to false, and the dashboard either disabled or protected
behind authentication and not publicly exposed.
Traefik routing and middleware, set as labels on each service: route the main host's
/api path to the API and everything else to the web container; apply security
headers (HSTS, CSP suited to a PWA, no sniff, frame denial), compression, and a nocache header on the service worker file with long-cache headers on hashed assets
Morning Pages: Agent Briefs
Page 10 of 12
(set these in the nginx config or with a headers middleware). Traefik's rate-limit
middleware may be added as a coarse outer layer, but the application's own peraccount limits from Brief 3 still apply.
Docker socket safety: do not mount /var/run/docker.sock into Traefik directly with
write access. Mount it read-only at minimum, or put a socket proxy in front of it,
because anyone who compromises Traefik could otherwise control the host.
Real client IP: configure Traefik's forwarded-headers trust (and Cloudflare's IP ranges
if used) and set Express's trust proxy to match, so rate limits and session IP records
see the true client address and not Traefik's.
Secrets handling: documented process for providing environment secrets on the
server (not in the repo, not in images), including generation of encryption keys and
VAPID keys, and a documented procedure for key rotation.
Backups: nightly pg_dump , compressed and encrypted, copied off the VPS to object
storage, with retention (e.g. 14 daily, 8 weekly), failure alerts, and a documented and
tested restore procedure. Remember that encrypted entries require the encryption
key to be backed up separately and securely, or the backups are useless.
Server hardening checklist: SSH keys only, firewall allowing only 80/443/SSH,
automatic security updates, fail2ban or equivalent, non-root containers.
Monitoring: uptime check on a health endpoint, error tracking (Sentry or similar)
configured to scrub request bodies and journal content, log rotation, and alerts for
disk space, failed backups, failed jobs and LLM spend.
Deployment pipeline: a repeatable deploy (CI builds images, server pulls and restarts)
with automatic database migrations and a documented rollback.
Optional: Cloudflare in front for DDoS protection, with correct real-IP handling for
rate limiting.
Acceptance criteria: a runbook document covering deploy, rollback, restore from backup,
key rotation, and "what to do if the server is compromised"; a performed and recorded
restore test.
