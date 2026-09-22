import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateScenario } from '../src/core/evaluate.js';
import { buildJevPayload } from '../src/jev/payload.js';
import { validateAttemptEvidence } from '../src/core/types.js';
import type { AttemptEvidence } from '../src/core/types.js';
import { scenarioFixture } from './paths.js';

function loadValidated(name: string): AttemptEvidence[] {
  const raw: unknown = JSON.parse(readFileSync(scenarioFixture(name), 'utf8'));
  const attempts: AttemptEvidence[] = [];
  for (const entry of raw as unknown[]) {
    const outcome = validateAttemptEvidence(entry);
    assert.equal(outcome.ok, true, `${name} must satisfy the evidence schema`);
    if (outcome.ok) attempts.push(outcome.value);
  }
  return attempts;
}

/**
 * POC-00 success criterion 3: the same fixture always produces the same
 * local signals. Runs the full deterministic pipeline twice per fixture and
 * compares serialized output.
 */
describe('determinism', () => {
  for (const fixture of ['fixture-a.json', 'fixture-b.json', 'fixture-c.json']) {
    it(`${fixture}: identical signals and evaluation across runs`, () => {
      const attempts = loadValidated(fixture);
      const run = (): string => {
        const { signals, evaluation } = evaluateScenario(attempts);
        const prev = attempts[attempts.length - 2];
        const curr = attempts[attempts.length - 1];
        assert.ok(prev && curr);
        const payload = buildJevPayload(prev, curr, signals);
        return JSON.stringify({ signals, evaluation, payload });
      };
      assert.equal(run(), run());
    });
  }
});
