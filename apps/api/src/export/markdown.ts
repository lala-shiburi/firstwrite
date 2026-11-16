/**
 * Escapes a string value for safe inclusion in YAML frontmatter (JSON string quoting is valid YAML 1.2
 * and safely escapes quotes, colons, backslashes, newlines, emoji, and control characters).
 */
export function yamlEscapeString(val: string): string {
  return JSON.stringify(val);
}

/**
 * Formats a `YYYY-MM-DD` Monday date into its ISO 8601 week identifier (`YYYY-Www`, e.g. `2026-W46`).
 */
export function formatIsoWeekId(localDateStr: string): string {
  const parts = localDateStr.split('-');
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);

  const date = new Date(Date.UTC(year, month - 1, day));
  // Thursday in current week decides the ISO week-numbering year
  const dayNum = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil(((date.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  const isoYear = date.getUTCFullYear();
  return `${String(isoYear).padStart(4, '0')}-W${String(weekNo).padStart(2, '0')}`;
}

/**
 * Normalizes line endings and ensures that if the body begins with a line `---`
 * (frontmatter-like text), it is separated by a blank line after the closing YAML
 * frontmatter delimiter so Markdown parsers (such as Obsidian) never misparse the body.
 */
function normalizeMarkdownBody(content: string): string {
  const normalized = content.replace(/\r\n/g, '\n');
  if (normalized.startsWith('---')) {
    return `\n${normalized}`;
  }
  return normalized;
}

/**
 * Formats a single journal entry as a standalone Markdown file (`<YYYY-MM-DD>.md`)
 * beginning with YAML frontmatter (`date`, `words`) followed by the entry text.
 */
export function formatEntryMarkdownFile(params: {
  entryDate: string;
  wordCount: number;
  content: string;
}): string {
  const safeDate = /^\d{4}-\d{2}-\d{2}$/.test(params.entryDate)
    ? params.entryDate
    : yamlEscapeString(params.entryDate);
  const safeWords = Math.max(0, Math.floor(params.wordCount));
  const body = normalizeMarkdownBody(params.content);

  return [`---`, `date: ${safeDate}`, `words: ${safeWords}`, `---`, '', body, ''].join('\n');
}

/**
 * Formats a weekly AI summary as a standalone Markdown file (`weekly/<YYYY-Www>.md`)
 * with YAML frontmatter (`week`, `week_start`, `week_end`, `themes`) followed by the summary markdown.
 */
export function formatWeeklySummaryMarkdownFile(params: {
  weekId: string;
  weekStart: string;
  weekEnd: string;
  themes: string[];
  summaryMd: string;
}): string {
  const themesYaml =
    params.themes.length === 0
      ? '[]'
      : `[${params.themes.map((t) => yamlEscapeString(t)).join(', ')}]`;
  const body = normalizeMarkdownBody(params.summaryMd);

  return [
    '---',
    `week: ${yamlEscapeString(params.weekId)}`,
    `week_start: ${params.weekStart}`,
    `week_end: ${params.weekEnd}`,
    `themes: ${themesYaml}`,
    '---',
    '',
    body,
    '',
  ].join('\n');
}

/**
 * Generates the `README.md` included at the root of the ZIP export explaining the archive structure.
 */
export function buildExportReadmeMarkdown(params: {
  exportedAtIso: string;
  timezone: string;
}): string {
  return [
    '# Morning Pages Export',
    '',
    `Exported at: ${params.exportedAtIso}`,
    `Timezone: ${params.timezone}`,
    '',
    '## Archive Structure',
    '',
    '- `<YYYY-MM-DD>.md` — Daily journal entries named by your local calendar date. Each file starts with YAML frontmatter (`date`, `words`) followed by your entry text.',
    '- `weekly/<YYYY-Www>.md` — Weekly AI review summaries (if enabled) named by ISO week number.',
    '- `README.md` — This guide.',
    '',
    'These standard Markdown files can be opened directly in any text editor or imported into tools such as Obsidian, iA Writer, or Logseq.',
    '',
  ].join('\n');
}
