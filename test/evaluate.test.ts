import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateScenario } from '../src/core/evaluate.js';
import { validateAttemptEvidence } from '../src/core/types.js';
import type { AttemptEvidence } from '../src/core/types.js';
import { scenarioFixture } from './paths.js';

function loadFixture(name: string): AttemptEvidence[] {
  const raw: unknown = JSON.parse(readFileSync(scenarioFixture(name), 'utf8'));
  const attempts: AttemptEvidence[] = [];
  for (const entry of raw as unknown[]) {
    const outcome = validateAttemptEvidence(entry);
    assert.equal(outcome.ok, true);
    if (outcome.ok) attempts.push(outcome.value);
  }
  return attempts;
}

describe('scenario evaluation', () => {
  it('A — productive progress: HIGH gain, HIGH progress, CONTINUE', () => {
    const { signals, evaluation } = evaluateScenario(loadFixture('fixture-a.json'));
    assert.equal(signals.verificationDebt, 'LOW');
    assert.equal(evaluation.evidenceGain, 'HIGH');
    assert.equal(evaluation.runtimeProgress, 'HIGH');
    assert.equal(evaluation.deadEndCandidate, false);
    assert.equal(evaluation.policy, 'CONTINUE');
    assert.match(evaluation.verdict, /Productive progress/u);
  });

  it('B — different code, same app: dead-end, RETHINK', () => {
    const { signals, evaluation } = evaluateScenario(loadFixture('fixture-b.json'));
    assert.equal(signals.verificationDebt, 'LOW');
    assert.equal(evaluation.evidenceGain, 'LOW');
    assert.equal(evaluation.runtimeProgress, 'LOW');
    assert.equal(evaluation.deadEndCandidate, true);
    assert.equal(evaluation.policy, 'RETHINK');
    assert.equal(evaluation.verdict, '⚠ Different code. Same app.');
  });

  it('C — verification debt: VERIFY_FIRST without any model', () => {
    const { signals, evaluation } = evaluateScenario(loadFixture('fixture-c.json'));
    assert.equal(signals.verificationDebt, 'HIGH');
    assert.equal(evaluation.policy, 'VERIFY_FIRST');
    assert.equal(
      evaluation.verdict,
      '⏸ 4 implementation attempts were made without collecting new runtime evidence.',
    );
  });
});
