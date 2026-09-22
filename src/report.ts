/**
 * Human-readable POC report (POC-00 §10). The verdict line is the product:
 * a person must understand the situation at a glance, no code reading needed.
 */

import type { AttemptEvidence } from './core/types.js';
import type { SeriesSignals } from './core/signals.js';
import type { Evaluation } from './core/evaluate.js';
import type { JevOutcome } from './jev/types.js';

const LABEL_WIDTH = 26;
const SIGNATURE_DISPLAY_LIMIT = 30;

export function truncateForDisplay(text: string, limit = SIGNATURE_DISPLAY_LIMIT): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(1, limit - 1))}…`;
}

function label(name: string): string {
  return name.padEnd(LABEL_WIDTH, ' ');
}

function arrow(values: string[]): string {
  return values.join(' → ');
}

function formatTests(attempts: AttemptEvidence[]): string {
  return arrow(attempts.map((a) => (a.tests.failedCount === null ? '?' : String(a.tests.failedCount))));
}

function formatSignatureSeries(attempts: AttemptEvidence[], pick: (a: AttemptEvidence) => string | null): string {
  return arrow(
    attempts.map((a) => {
      const value = pick(a);
      return value === null ? '(none)' : truncateForDisplay(value);
    }),
  );
}

export interface TimingReport {
  deterministicMs: number;
  jevMs: number | null;
}

export interface ScenarioReportInput {
  scenarioTitle: string;
  attempts: AttemptEvidence[];
  signals: SeriesSignals;
  evaluation: Evaluation;
  jev: JevOutcome | null;
  timing: TimingReport;
}

export function renderJevSection(jev: JevOutcome | null): string {
  const lines: string[] = ['Jev'];
  if (jev === null) {
    lines.push(`${label('Progress')}skipped`);
    return lines.join('\n');
  }
  if (!jev.available) {
    lines.push(`${label('Progress')}${jev.reason}`);
    lines.push(`${label('Evidence gain')}n/a`);
    lines.push(`${label('Rethink needed')}n/a`);
    return lines.join('\n');
  }
  const { evaluation } = jev;
  lines.push(`${label('Progress')}${evaluation.progress.toFixed(2)}`);
  lines.push(`${label('Evidence gain')}${evaluation.evidenceGain.toFixed(2)}`);
  lines.push(`${label('Rethink needed')}${evaluation.rethinkNeeded.toFixed(2)}`);
  if (evaluation.tokens !== null) {
    lines.push(
      `${label('Jev tokens')}${evaluation.tokens.input} in / ${evaluation.tokens.output} out`,
    );
  }
  lines.push(`${label('Jev latency')}${evaluation.latencyMs.toFixed(0)} ms`);
  return lines.join('\n');
}

export function renderScenario(input: ScenarioReportInput): string {
  const { scenarioTitle, attempts, signals, evaluation, jev, timing } = input;

  const lines: string[] = [];
  lines.push(`Scenario: ${scenarioTitle}`);
  lines.push('');
  lines.push(`${label('Attempts')}${attempts.length}`);
  lines.push(`${label('Changed implementations')}${signals.changedImplementations}`);
  lines.push('');
  lines.push('Runtime proof');
  lines.push(`${label('Tests')}${formatTests(attempts)}`);
  lines.push(
    `${label('Crash')}${formatSignatureSeries(attempts, (a) => a.runtime.crashSignature)}`,
  );
  lines.push(
    `${label('Screen')}${formatSignatureSeries(attempts, (a) => a.runtime.screenSignature)}`,
  );
  lines.push('');
  lines.push(`${label('Verification debt')}${signals.verificationDebt}`);
  lines.push(`${label('Evidence gain')}${evaluation.evidenceGain}`);
  lines.push(`${label('Runtime progress')}${evaluation.runtimeProgress}`);
  if (evaluation.deadEndCandidate) {
    lines.push(`${label('Dead-end candidate')}YES`);
  }
  lines.push('');
  lines.push(renderJevSection(jev));
  lines.push('');
  lines.push(`${label('Policy')}${evaluation.policy}`);
  lines.push(`${label('Deterministic eval')}${formatMs(timing.deterministicMs)}`);
  lines.push('');
  lines.push('Verdict');
  lines.push('');
  lines.push(evaluation.verdict);
  return lines.join('\n');
}

function formatMs(ms: number): string {
  return ms >= 1 ? `${ms.toFixed(1)} ms` : `${(ms * 1000).toFixed(0)} µs`;
}
