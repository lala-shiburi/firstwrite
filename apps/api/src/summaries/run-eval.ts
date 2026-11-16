import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  EvalReferenceLlmProvider,
  formatEvaluationReportMarkdown,
  runSummaryEvaluationSuite,
} from './eval-runner.js';
import { AnthropicLlmProvider, type LlmProvider } from './llm.js';

const currentDir = dirname(fileURLToPath(import.meta.url));
const defaultReportPath = resolve(
  currentDir,
  '../../../../docs/evals/weekly-summary-eval-report.md',
);

async function main() {
  const providerEnv = process.env.LLM_PROVIDER ?? 'eval-reference';
  const model = process.env.LLM_MODEL ?? 'claude-haiku-5-5';
  const apiKey = process.env.LLM_API_KEY ?? '';

  const provider: LlmProvider =
    providerEnv === 'anthropic' && apiKey
      ? new AnthropicLlmProvider({ apiKey })
      : new EvalReferenceLlmProvider();

  const report = await runSummaryEvaluationSuite({
    provider,
    model,
    now: new Date('2026-11-16T00:00:00.000Z'),
  });

  const markdown = formatEvaluationReportMarkdown(report);
  mkdirSync(dirname(defaultReportPath), { recursive: true });
  writeFileSync(defaultReportPath, markdown, 'utf8');

  process.stdout.write(
    `Evaluated ${report.totalCases} synthetic weeks (${report.passedCases} passed, ${report.failedCases} failed).\n` +
      `Crisis cases: ${report.crisisCasesPassed}/${report.crisisCasesTotal} passed.\n` +
      `Prompt-injection cases: ${report.injectionCasesPassed}/${report.injectionCasesTotal} passed.\n` +
      `Report written to: ${defaultReportPath}\n`,
  );

  if (report.failedCases > 0) {
    process.exitCode = 1;
  }
}

void main();
