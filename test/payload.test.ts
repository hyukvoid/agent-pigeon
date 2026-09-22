import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { evaluateScenario } from '../src/core/evaluate.js';
import { buildJevPayload, payloadSafetyIssues, sanitizeSignature } from '../src/jev/payload.js';
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

describe('Jev payload', () => {
  it('contains only normalized fields, no paths or secrets', () => {
    const attempts = loadFixture('fixture-b.json');
    const prev = attempts[0];
    const curr = attempts[attempts.length - 1];
    assert.ok(prev && curr);
    const { signals } = evaluateScenario(attempts);
    const payload = buildJevPayload(prev, curr, signals);
    const serialized = JSON.stringify(payload);

    assert.equal(payloadSafetyIssues(payload).length, 0);
    assert.doesNotMatch(serialized, /[A-Za-z]:\\/u);
    assert.doesNotMatch(serialized, /\/(?:home|Users|root|tmp)\//u);
    assert.doesNotMatch(serialized, /api[_-]?key|password|secret|authorization/iu);
    assert.ok(!serialized.includes('changeSetHash'), 'internal fields must not leak into payload');
    assert.doesNotMatch(serialized, /"[0-9a-f]{32}"/u, 'change fingerprints never travel to Jev');
  });

  it('carries the three independent questions', () => {
    const attempts = loadFixture('fixture-a.json');
    const prev = attempts[0];
    const curr = attempts[1];
    assert.ok(prev && curr);
    const { signals } = evaluateScenario(attempts);
    const payload = buildJevPayload(prev, curr, signals);
    assert.match(payload.questions.progress, /meaningful measurable progress/u);
    assert.match(payload.questions.evidenceGain, /useful new runtime evidence/u);
    assert.match(payload.questions.rethinkNeeded, /reconsider its current hypothesis/u);
  });

  it('sanitizer strips control characters and caps length', () => {
    const dirty = 'NPE\twith\nnewlines\r\nand   spaces';
    const clean = sanitizeSignature(dirty);
    assert.ok(!/[\n\r\t]/u.test(clean));
    assert.equal(clean, 'NPE with newlines and spaces');

    const long = 'x'.repeat(500);
    assert.ok(sanitizeSignature(long).length <= 120);
  });

  it('flags absolute paths as safety issues', () => {
    const attempts = loadFixture('fixture-b.json');
    const prev = attempts[0];
    const curr = attempts[1];
    assert.ok(prev && curr);
    const { signals } = evaluateScenario(attempts);
    const payload = buildJevPayload(prev, curr, signals);
    payload.current.crashSignature = 'NPE at C:\\Users\\dev\\Login.kt:84';
    assert.ok(payloadSafetyIssues(payload).length > 0);
  });
});
