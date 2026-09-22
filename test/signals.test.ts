import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { seriesSignals } from '../src/core/signals.js';
import { validateAttemptEvidence } from '../src/core/types.js';
import type { AttemptEvidence } from '../src/core/types.js';
import { scenarioFixture } from './paths.js';

function loadFixture(name: string): AttemptEvidence[] {
  const raw: unknown = JSON.parse(readFileSync(scenarioFixture(name), 'utf8'));
  const attempts: AttemptEvidence[] = [];
  for (const entry of raw as unknown[]) {
    const outcome = validateAttemptEvidence(entry);
    assert.equal(outcome.ok, true, `fixture ${name} must validate`);
    if (outcome.ok) attempts.push(outcome.value);
  }
  return attempts;
}

describe('schema validator', () => {
  it('rejects a malformed attempt', () => {
    const outcome = validateAttemptEvidence({
      attemptId: 'x1',
      build: { status: 'BUILD OK' },
      tests: { failedCount: '8' },
      runtime: { crashSignature: null, screenSignature: null },
      verification: { performed: 'yes' },
      code: { changedFilesCount: -1, changeSetHash: null },
    });
    assert.equal(outcome.ok, false);
    if (!outcome.ok) {
      assert.equal(outcome.errors.length, 4);
    }
  });

  it('accepts nulls everywhere they are allowed', () => {
    const outcome = validateAttemptEvidence({
      attemptId: 'x1',
      build: { status: null },
      tests: { failedCount: null },
      runtime: { crashSignature: null, screenSignature: null },
      verification: { performed: false },
      code: { changedFilesCount: null, changeSetHash: null },
    });
    assert.equal(outcome.ok, true);
  });
});

describe('series signals', () => {
  it('scenario A pair: tests improved, crash and screen changed', () => {
    const attempts = loadFixture('fixture-a.json');
    const signals = seriesSignals(attempts);
    assert.equal(signals.pairs.length, 1);
    const pair = signals.pairs[0];
    assert.ok(pair);
    assert.equal(pair.failedTestsDelta, -9);
    assert.equal(pair.crashChanged, true);
    assert.equal(pair.screenChanged, true);
    assert.equal(pair.buildChanged, false);
    assert.equal(pair.codeNovelty, true);
    assert.equal(signals.verificationDebt, 'LOW');
    assert.equal(signals.sameCrashStreak, 1);
  });

  it('scenario B: three novel patches, frozen runtime', () => {
    const attempts = loadFixture('fixture-b.json');
    const signals = seriesSignals(attempts);
    assert.equal(signals.attemptCount, 3);
    assert.equal(signals.changedImplementations, 3);
    assert.ok(signals.pairs.every((p) => p.codeNovelty === true));
    assert.ok(signals.pairs.every((p) => p.failedTestsDelta === 0));
    assert.ok(signals.pairs.every((p) => p.crashChanged === false && p.screenChanged === false));
    assert.equal(signals.sameCrashStreak, 3);
    assert.equal(signals.sameScreenStreak, 3);
    assert.equal(signals.sameTestsStreak, 3);
    assert.equal(signals.verificationDebt, 'LOW');
  });

  it('scenario C: four unverified code-changing attempts => HIGH debt', () => {
    const attempts = loadFixture('fixture-c.json');
    const signals = seriesSignals(attempts);
    assert.equal(signals.verificationDebtStreak, 4);
    assert.equal(signals.verificationDebt, 'HIGH');
    assert.equal(signals.sameCrashStreak, 0, 'null runtime must not read as "same crash"');
  });
});
