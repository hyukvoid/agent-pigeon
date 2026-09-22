import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateScenario } from '../src/core/evaluate.js';
import { buildJevPayload } from '../src/jev/payload.js';
import { renderScenario, renderJevSection } from '../src/report.js';
import { validateAttemptEvidence } from '../src/core/types.js';
import type { AttemptEvidence } from '../src/core/types.js';
import type { JevOutcome } from '../src/jev/types.js';
import { scenarioFixture } from './paths.js';
import { MockJev } from './helpers/mock-jev.js';

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

const TIMING = { deterministicMs: 0.21, jevMs: null };

describe('report rendering', () => {
  it('scenario B renders the human verdict and the flat runtime proof', async () => {
    const attempts = loadFixture('fixture-b.json');
    const { signals, evaluation } = evaluateScenario(attempts);
    const mock = new MockJev();
    const prev = attempts[attempts.length - 2];
    const curr = attempts[attempts.length - 1];
    assert.ok(prev && curr);
    const payload = buildJevPayload(prev, curr, signals);
    const jev = await mock.evaluate(payload);

    const report = renderScenario({
      scenarioTitle: 'Different code, same app',
      attempts,
      signals,
      evaluation,
      jev,
      timing: TIMING,
    });

    assert.match(report, /Scenario: Different code, same app/u);
    assert.match(report, /8 → 8 → 8/u);
    assert.match(report, /Verification debt\s+LOW/u);
    assert.match(report, /Evidence gain\s+LOW/u);
    assert.match(report, /Policy\s+RETHINK/u);
    assert.match(report, /⚠ Different code\. Same app\./u);
    assert.match(report, /Rethink needed\s+0\.91/u);
  });

  it('renders JEV: unavailable when no provider is configured', () => {
    const unavailable: JevOutcome = {
      available: false,
      reason: 'JEV: unavailable (no API key configured)',
    };
    const section = renderJevSection(unavailable);
    assert.match(section, /JEV: unavailable/u);
    assert.match(section, /Evidence gain\s+n\/a/u);
  });

  it('is deterministic for identical inputs', async () => {
    const attempts = loadFixture('fixture-a.json');
    const first = evaluateScenario(attempts);
    const second = evaluateScenario(attempts);
    assert.equal(JSON.stringify(first), JSON.stringify(second));

    const mock = new MockJev();
    const payload = buildJevPayload(attempts[0]!, attempts[1]!, first.signals);
    const a = await mock.evaluate(payload);
    const b = await mock.evaluate(payload);
    assert.equal(JSON.stringify(a), JSON.stringify(b));
  });
});
