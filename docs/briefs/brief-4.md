Brief 4: Entries API and the writing experience
Goal: The core loop: open the app, write, never lose a word.
Backend requirements:
PUT /api/entries/:date upserts an entry for the authenticated user. Validate the
date format, and reject dates more than one day in the future relative to the user's
local date. Encrypt content using the encryption module, compute word_count from
plaintext, and set updated_at .
GET endpoints return decrypted content only to the owner. GET /api/entries?
from=&to= returns list data (dates, word counts, and a short plaintext-free summary
of metadata) so the list view does not require decrypting everything.
Guard against lost updates from two devices: use an updated_at -based optimistic
check and, on conflict, return the server version so the client can merge rather than
overwrite.
Enforce a generous maximum entry size and return a clear error beyond it.
Frontend requirements:
A distraction-free editor as the home screen, opening on today's entry (using the
user's local date).
Autosave: debounced (about 1.5 seconds after typing stops), plus a save on blur, on
tab hide, and on page unload. Show an unobtrusive status ("Saving…", "Saved",
"Offline, will retry").
If a save fails, keep the text in memory and retry with backoff; warn before the user
closes the tab if unsaved changes exist.
Live word count with a progress marker toward the daily goal (default 750 words).
Entry list and a calendar view showing which days have entries; tapping a day opens it
for viewing and editing.
Morning Pages: Agent Briefs
Page 5 of 12
Fully responsive: comfortable on a phone with the on-screen keyboard open, and on a
wide desktop screen with a readable line length.
Accessible: keyboard navigable, proper labels, sufficient contrast, respects reducedmotion and system dark mode.
Acceptance criteria:
Tests: upsert is idempotent, date validation, owner-only access (a user cannot read
another user's entry by guessing dates), conflict handling between two simulated
devices.
A frontend test simulating a network failure mid-typing shows no loss of text and a
successful save after reconnection
