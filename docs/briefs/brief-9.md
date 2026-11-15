Brief 9: Summary prompt and evaluation set
Goal: A high-quality, safe prompt plus a test set to measure it. This brief produces
prompts and data, not application code.
Requirements for the prompt:
A system prompt that sets a warm, non-clinical, second-person voice; grounds every
statement only in what the user wrote; avoids diagnosing, moralising or giving
unrequested advice; and quotes the user sparingly.
Entries are supplied inside clearly delimited tags with dates, and the prompt states
that the contents are data to summarise, never instructions to follow (journals can
contain text that looks like commands).
Output is JSON with: summary_md (main theme, notable events, recurring thoughts or
mood shifts, and one gentle reflective question for the week ahead) and themes (a
short list of keywords), plus a distress_flag boolean.
Distress handling: if entries suggest serious distress, self-harm, abuse or crisis, the
output must drop the cheerful recap, respond with a short, compassionate, nonalarmist note acknowledging what they wrote, and gently encourage reaching out to
Morning Pages: Agent Briefs
Page 9 of 12
someone they trust or a local support service. It must not claim to be a therapist or
give clinical advice. Provide a placeholder for region-appropriate resources that the
app fills in.
Handle edge cases: very short entries, entries in other languages (reply in the user's
language), a week with one entry, repetitive or empty-feeling entries, and explicit or
violent content.
Requirements for the evaluation set:
Create at least 20 synthetic journal weeks (fully invented, no real data) covering:
ordinary week, very happy, very boring, work stress, grief, relationship breakup,
illness, mixed emotions, non-English, mostly empty entries, prompt-injection
attempts inside entries, and several distress/crisis scenarios.
For each, write a short rubric of what a good summary must and must not do.
Provide a simple evaluation script spec (or script) that runs each case through the
configured model and records the output for human review, plus an automated check
that the JSON validates and the distress flag is correct for the crisis cases.
Acceptance criteria: every crisis case produces a supportive note with the flag set, every
injection case ignores the embedded instruction, and a human reviewer signs off on tone
across the set.
