Brief 3: Authentication and accounts
Goal: Complete, secure account management for a public app.
Requirements:
Register with email and password. Hash with argon2id. Enforce a sensible minimum
password length and reject known-breached or very common passwords if feasible.
Email verification: single-use token, hashed in the database, expires in 24 hours.
Unverified users can log in but see a verification banner and cannot enable AI
summaries.
Password reset: single-use token, hashed, expires in 1 hour. The "request reset"
endpoint must respond identically whether or not the email exists (no account
enumeration). Successful reset invalidates all existing sessions.
Sessions: random opaque tokens in httpOnly , Secure , SameSite=Lax cookies,
stored hashed in sessions . Sliding expiry. Endpoints to list active sessions, revoke
one, and "log out everywhere".
Rate limiting on register, login, request-reset and verify endpoints (per IP and per
account), with lockout/backoff after repeated failures.
CSRF protection for state-changing requests.
Cloudflare Turnstile (or equivalent) verification on registration, behind a config flag.
Email sending through a provider-agnostic interface with a dev implementation that
logs to the console, and templates for verification and reset emails. Emails must
contain no journal content.
Timezone captured at signup from the browser and editable in settings.
Morning Pages: Agent Briefs
Page 4 of 12
Account deletion endpoint requiring password re-entry: marks deleted_at ,
immediately revokes sessions, and enqueues a hard-delete job that removes the user
row (cascading to everything) after a 14-day grace period. Logging in during the grace
period offers to cancel deletion.
Acceptance criteria:
Tests for: token expiry, token reuse rejected, no account enumeration on reset,
session revocation after password reset, lockout behaviour, CSRF rejection, deletion
grace-period flow.
Passwords, tokens and session identifiers never appear in logs.
