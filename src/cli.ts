#!/usr/bin/env node
/**
 * POC-00 CLI.
 *
 *   npm run poc:00 [-- --scenario a|b|c|all] [--print-payload] [--json] [--no-jev]
 *
 * Runs the deterministic pipeline over the mandatory fixtures, optionally
 * consults Jev (if JEV_API_KEY is configured), and prints the report.
 * POC-00 never injects anything into a coding agent — policy is computed and
 * displayed only (§11).
 */

import { performance } from 'node:perf_hooks';
import { evaluateScenario } from './core/evaluate.js';
import { buildJevPayload, payloadSafetyIssues } from './jev/payload.js';
import { OpenAiCompatibleJev } from './jev/openai.js';
import type { JevOutcome, JevPayload, JevProvider } from './jev/types.js';
import type { AttemptEvidence } from './core/types.js';
import { SCENARIOS, loadAttempts } from './fixtures.js';
import { renderScenario } from './report.js';

interface CliArgs {
  scenario: 'a' | 'b' | 'c' | 'all';
  printPayload: boolean;
  json: boolean;
  noJev: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { scenario: 'all', printPayload: false, json: false, noJev: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--scenario': {
        const value = argv[i + 1];
        if (value === 'a' || value === 'b' || value === 'c' || value === 'all') {
          args.scenario = value;
          i++;
        } else {
          throw new Error(`--scenario expects a|b|c|all, got ${value ?? '(missing)'}`);
        }
        break;
      }
      case '--print-payload':
        args.printPayload = true;
        break;
      case '--json':
        args.json = true;
        break;
      case '--no-jev':
        args.noJev = true;
        break;
      default:
        throw new Error(`unknown argument: ${arg ?? '(empty)'}`);
    }
  }
  return args;
}

interface ScenarioResult {
  scenarioId: string;
  title: string;
  attempts: AttemptEvidence[];
  signals: ReturnType<typeof evaluateScenario>['signals'];
  evaluation: ReturnType<typeof evaluateScenario>['evaluation'];
  jev: JevOutcome | null;
  payload: JevPayload | null;
  payloadIssues: string[];
  deterministicMs: number;
}

async function runScenario(
  definition: (typeof SCENARIOS)[number],
  jevProvider: JevProvider | null,
  args: CliArgs,
): Promise<ScenarioResult> {
  const attempts = loadAttempts(definition.fixturePath);

  const startedAt = performance.now();
  const { signals, evaluation } = evaluateScenario(attempts);
  const deterministicMs = performance.now() - startedAt;

  let jev: JevOutcome | null = null;
  let payload: JevPayload | null = null;
  const payloadIssues: string[] = [];

  const last = attempts[attempts.length - 1];
  const prev = attempts[attempts.length - 2];
  if (jevProvider !== null && last !== undefined && prev !== undefined) {
    payload = buildJevPayload(prev, last, signals);
    payloadIssues.push(...payloadSafetyIssues(payload));
    if (!jevProvider.isConfigured()) {
      jev = { available: false, reason: 'JEV: unavailable (no API key configured)' };
    } else {
      jev = await jevProvider.evaluate(payload);
    }
  } else if (jevProvider === null) {
    jev = { available: false, reason: 'JEV: skipped (--no-jev)' };
  }

  return {
    scenarioId: definition.id,
    title: definition.title,
    attempts,
    signals,
    evaluation,
    jev,
    payload,
    payloadIssues,
    deterministicMs,
  };
}

function renderText(results: ScenarioResult[]): string {
  const blocks = results.map((result) =>
    renderScenario({
      scenarioTitle: result.title,
      attempts: result.attempts,
      signals: result.signals,
      evaluation: result.evaluation,
      jev: result.jev,
      timing: { deterministicMs: result.deterministicMs, jevMs: null },
    }),
  );
  return ['Agent Pigeon — POC-00', '', blocks.join('\n\n')].join('\n') + '\n';
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const selected =
    args.scenario === 'all' ? SCENARIOS : SCENARIOS.filter((s) => s.id === args.scenario);

  const useJev = !args.noJev;
  const jevProvider: JevProvider | null = useJev ? new OpenAiCompatibleJev() : null;

  const results: ScenarioResult[] = [];
  for (const definition of selected) {
    results.push(await runScenario(definition, jevProvider, args));
  }

  if (args.printPayload) {
    for (const result of results) {
      if (result.payload !== null) {
        process.stdout.write(
          `--- Jev payload (${result.title}) ---\n${JSON.stringify(result.payload, null, 2)}\n`,
        );
      }
    }
  }

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          poc: '00',
          scenarios: results.map((result) => ({
            id: result.scenarioId,
            title: result.title,
            attempts: result.attempts.length,
            signals: result.signals,
            evaluation: result.evaluation,
            jev: result.jev,
            payloadIssues: result.payloadIssues,
            deterministicMs: result.deterministicMs,
          })),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write(renderText(results));

  for (const result of results) {
    if (result.payloadIssues.length > 0) {
      process.stderr.write(
        `PRIVACY WARNING (${result.title}): ${result.payloadIssues.join('; ')}\n`,
      );
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`poc:00 failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
