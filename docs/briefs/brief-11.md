Brief 11: Security and privacy review
Goal: An independent review before any real users arrive. Run this agent against the
finished codebase, read-only, and have it produce a report.
Requirements:
Review authentication, session handling, CSRF, rate limiting, authorisation (every
endpoint must verify the resource belongs to the requesting user), input validation,
and dependency vulnerabilities.
Morning Pages: Agent Briefs
Page 11 of 12
Verify the non-negotiable rules from the Shared Context one by one, with evidence:
plaintext journal content absent from logs, error reports, job payloads and caches;
tokens hashed; consent gate enforced before every LLM call; push text generic; dates
handled in user-local time.
Attempt common attack classes in a test environment: IDOR on entries and
summaries, account enumeration, session fixation, stored XSS via entry content
rendered in the UI, header and cookie flags, zip-slip or path issues in export, prompt
injection through entries affecting the summary output.
Check account deletion actually removes all data, including from job tables, and
consider backup retention implications for the privacy policy.
Deliverable: a prioritised findings report (critical, high, medium, low) with reproduction
steps and recommended fixes. No fixes should be applied by the reviewing agent itself.
