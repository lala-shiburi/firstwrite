Brief 7: Markdown export and account data features
Goal: Let users download everything they've written, easily and safely.
Requirements:
GET /api/export?format=zip streams a ZIP (do not build it fully in memory)
containing one file per entry named by local date (e.g. 2026-11-15.md ), each
beginning with YAML frontmatter ( date , words ) followed by the entry text. Include
weekly summaries under a weekly/ folder (e.g. 2026-W46.md ) and a short
README.md explaining the structure.
format=md returns a single combined Markdown file ordered by date.
Decrypt entries on the fly in batches/streams so memory stays flat for users with
years of entries.
Morning Pages: Agent Briefs
Page 7 of 12
Authenticated owner only, rate limited (e.g. a few exports per hour), with an audit log
entry (metadata only, no content).
Frontend: a clear "Download all my entries" button in settings with a progress/spinner
state and sensible handling of long downloads.
Correct filename and headers; content with unusual characters must not break the
frontmatter or the zip (escape properly).
Acceptance criteria: tests with entries containing frontmatter-like text, emoji, very long
text, and thousands of entries; memory stays bounded; the exported files re-import
cleanly into a Markdown editor such as Obsidian.
