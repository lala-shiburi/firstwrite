Brief 6: Daily reminders and push notifications
Goal: Remind users to write at their chosen local time, but only if they haven't written yet.
Requirements:
Morning Pages: Agent Briefs
Page 6 of 12
Settings UI: toggle reminders, choose local time, and a permission flow that explains
why before the browser prompt. Handle denied permission gracefully.
Frontend registers the push subscription with the VAPID public key and posts it to
the API; support multiple devices per user; allow unsubscribing.
Backend: generate and document the VAPID keys setup; store subscriptions; delete a
subscription when the push service returns 404 or 410.
Scheduler: a pg-boss recurring job that runs every minute, finds users with
reminders enabled whose local time has just reached their reminder time (handle
timezones and daylight saving correctly), who have no entry yet today (user-local
date, or an entry under a small word threshold, your choice, documented), and who
haven't already been reminded today. It enqueues one send job per user; it does not
send inline.
Send jobs push to all of the user's subscriptions with retries and exponential backoff,
and record that the reminder was sent so it is not repeated.
Notification text is generic and gently varied (never includes content or streak guilttripping). Clicking it opens the app on today's entry, focusing an existing window if
one is open.
The query must be efficient for large user counts (use the indexes in the schema,
process in batches).
Acceptance criteria:
Tests using a controllable clock: correct firing across at least three timezones
including one with DST change and one with a half-hour offset; no reminder if an entry
exists; no duplicate reminders if the job runs twice in the same minute; dead
subscriptions are cleaned up.
