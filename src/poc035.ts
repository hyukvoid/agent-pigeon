#!/usr/bin/env node
/**
 * POC-03.5 — reality fixtures runner.
 *
 *   npm run poc:035 [-- --json]
 *
 * Runs the five mandatory reality fixtures (A–E) through the deterministic
 * pipeline WITH their hand-authored ProgressContracts and prints the
 * three-concept separation (runtimeChange / evidenceGain / goalProgress).
 * No Jev: every one of these cases is deterministically decidable by design
 * (§6 — Jev is only for ambiguous cases, and no key exists on this machine).
 */

import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { evaluateScenario } from './core/evaluate.js';
import type { ProgressContract } from './core/contract.js';
import type { AttemptEvidence } from './core/types.js';
import { validateAttemptEvidence } from './core/types.js';
import { fixturesRoot } from './fixtures.js';

interface RealityFixture {
  name: string;
  caseId: string;
  contract: ProgressContract;
  attempts: AttemptEvidence[];
}

function loadReality(name: string, caseId: string): RealityFixture {
  const raw = JSON.parse(readFileSync(`${fixturesRoot}/scenarios/reality-${name}.json`, 'utf8')) as {
    contract: ProgressContract;
    attempts: unknown[];
  };
  const attempts: AttemptEvidence[] = [];
  for (const entry of raw.attempts) {
    const outcome = validateAttemptEvidence(entry);
    if (!outcome.ok) throw new Error(`reality-${name}: ${outcome.errors.join('; ')}`);
    attempts.push(outcome.value);
  }
  return { name, caseId, contract: raw.contract, attempts };
}

function renderCase(fixture: RealityFixture): string {
  const startedAt = performance.now();
  const { signals, evaluation } = evaluateScenario(fixture.attempts, fixture.contract);
  const evalMs = performance.now() - startedAt;
  const label = (s: string): string => s.padEnd(24, ' ');

  const lines: string[] = [];
  lines.push(`CASE ${fixture.caseId} — ${fixture.contract.task}`);
  lines.push('');
  lines.push(`${label('Attempts')}${fixture.attempts.length}`);
  lines.push(
    `${label('Runtime change')}${evaluation.runtimeChange}${evaluation.runtimeChangeDetail.length > 0 ? ` (${evaluation.runtimeChangeDetail.join('; ')})` : ''}`,
  );
  lines.push(`${label('Evidence gain')}${evaluation.evidenceGain}`);
  lines.push(`${label('Goal progress')}${evaluation.goalProgress.level} — ${evaluation.goalProgress.rationale}`);
  if (evaluation.goalProgress.matchedSuccessSignals.length > 0) {
    lines.push(`${label('Success signals')}${evaluation.goalProgress.matchedSuccessSignals.join(', ')}`);
  }
  if (evaluation.goalProgress.matchedNoProgressSignals.length > 0) {
    lines.push(`${label('No-progress signals')}${evaluation.goalProgress.matchedNoProgressSignals.join(', ')}`);
  }
  lines.push(`${label('Verification debt')}${signals.verificationDebt}`);
  lines.push(`${label('Dead-end candidate')}${evaluation.deadEndCandidate ? 'YES' : 'no'}`);
  lines.push(`${label('Policy')}${evaluation.policy}`);
  lines.push(`${label('Deterministic eval')}${evalMs >= 1 ? `${evalMs.toFixed(1)} ms` : `${(evalMs * 1000).toFixed(0)} µs`}`);
  lines.push('');
  lines.push(`Verdict: ${evaluation.verdict}`);
  return lines.join('\n');
}

function main(): void {
  const json = process.argv.slice(2).includes('--json');
  const fixtures: RealityFixture[] = [
    loadReality('a', 'A — Productive'),
    loadReality('b', 'B — New evidence, unclear progress'),
    loadReality('c', 'C — Different implementation, same outcome'),
    loadReality('d', 'D — Verification debt'),
    loadReality('e', 'E — Runtime changed in the wrong direction'),
  ];

  if (json) {
    const results = fixtures.map((f) => {
      const { signals, evaluation } = evaluateScenario(f.attempts, f.contract);
      return {
        case: f.caseId,
        contract: f.contract,
        runtimeChange: evaluation.runtimeChange,
        evidenceGain: evaluation.evidenceGain,
        goalProgress: evaluation.goalProgress,
        verificationDebt: signals.verificationDebt,
        deadEndCandidate: evaluation.deadEndCandidate,
        policy: evaluation.policy,
      };
    });
    process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
    return;
  }

  process.stdout.write('Agent Pigeon — POC-03.5 reality fixtures\n\n');
  process.stdout.write(fixtures.map(renderCase).join('\n\n'));
  process.stdout.write('\n');
}

main();
