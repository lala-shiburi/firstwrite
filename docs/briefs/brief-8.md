Brief 8: Weekly summary pipeline
Goal: Every Sunday, generate and deliver a thoughtful summary of each consenting user's
week, reliably and cheaply.
Requirements:
Consent flow: UI explaining in plain language that the week's entries are sent to the
named LLM provider to produce the summary, with an explicit opt-in, a way to
withdraw at any time, and storage of ai_consent_at . Withdrawal stops processing
immediately and clears the enabled flag.
Scheduler: a pg-boss recurring job that runs hourly and selects users who: have
consented and enabled summaries, whose local time has reached their Sunday
delivery time, and who have no weekly_summaries row for that week yet. It inserts a
pending row and enqueues one job per user with a singleton key of user id plus week
start so retries and overlaps cannot double-generate.
Worker:
Load that Monday–Sunday week's entries for the user, decrypt, and skip with
status skipped and a reason if fewer than the minimum entries (default 2) exist.
Optionally send a gentle "quiet week" note.
Enforce caps on characters per entry and per week; truncate sensibly and note
truncation to the model.
Call the LLM through a provider interface (default Anthropic API, model name
from config, default claude-haiku-5-5 ), with timeouts, retries with exponential
backoff, and low worker concurrency to respect rate limits.
Request structured JSON output, validate it against a schema, and retry once on
invalid output before marking failed .
Encrypt the summary and themes before storing; record model name, input and
output tokens.
Morning Pages: Agent Briefs
Page 8 of 12
Send a generic push notification ("Your week in review is ready") and optionally
an email linking to the in-app page, with no summary content.
Cost controls: a configurable monthly spend ceiling computed from recorded token
usage; when reached, pause generation and alert the operator. Log token totals per
run (no content).
Frontend: a "Weekly reviews" page listing past summaries, a detail view, a delete
button per summary, and a visible note that this is a reflective tool and not therapy or
professional advice.
Plaintext entry text must never be logged or placed in job payloads; jobs carry only
user id and week start, and the worker reads from the database.
Acceptance criteria:
Tests with a mocked LLM provider: idempotency (running the scheduler twice yields
one summary), users without consent are never sent anywhere, too-few-entries
skips, malformed model output is retried then fails cleanly, consent withdrawal midrun aborts before the API call, spend ceiling pauses generation.
A test asserting that the outbound provider request is the only place entry text
leaves the system.
