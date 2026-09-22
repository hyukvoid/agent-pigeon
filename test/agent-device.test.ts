import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseAgentDeviceRecording, readingToEvidence } from '../src/agent-device/parse.js';
import { agentDeviceFixture, scenarioFixture } from './paths.js';

function readBoth(relA: string, relB: string): [string, string] {
  return [
    readFileSync(agentDeviceFixture(relA), 'utf8'),
    readFileSync(agentDeviceFixture(relB), 'utf8'),
  ];
}

describe('agent-device recording parser', () => {
  it('extracts crash + screen signatures for attempt a1', () => {
    const [a1] = readBoth('attempt-a1.txt', 'attempt-a2.txt');
    const evidence = readingToEvidence(parseAgentDeviceRecording(a1));
    assert.equal(evidence.crashSignature, 'NullPointerException:LoginViewModel#onSubmit');
    assert.equal(evidence.screenSignature, 'Login');
    assert.equal(evidence.verificationPerformed, true);
  });

  it('tracks progress across attempts: a2 moved crash and screen', () => {
    const [, a2] = readBoth('attempt-a1.txt', 'attempt-a2.txt');
    const evidence = readingToEvidence(parseAgentDeviceRecording(a2));
    assert.equal(evidence.crashSignature, 'IllegalStateException:OtpViewModel#verify');
    assert.equal(evidence.screenSignature, 'OTP');
    assert.equal(evidence.verificationPerformed, true);
  });

  it('ignores framework frames when normalizing the crash signature', () => {
    const [, a2] = readBoth('attempt-a1.txt', 'attempt-a2.txt');
    const reading = parseAgentDeviceRecording(a2);
    assert.ok(reading.crashSignature !== null);
    assert.ok(!reading.crashSignature.includes('View.performClick'));
  });

  it('parser output matches the runtime evidence stored in fixture-a.json', () => {
    const [a1Text, a2Text] = readBoth('attempt-a1.txt', 'attempt-a2.txt');
    const fixture: Array<{ runtime: { crashSignature: string | null; screenSignature: string | null } }> =
      JSON.parse(readFileSync(scenarioFixture('fixture-a.json'), 'utf8'));
    const first = fixture[0];
    const second = fixture[1];
    assert.ok(first && second);
    assert.deepEqual(readingToEvidence(parseAgentDeviceRecording(a1Text)), {
      crashSignature: first.runtime.crashSignature,
      screenSignature: first.runtime.screenSignature,
      verificationPerformed: true,
    });
    assert.deepEqual(readingToEvidence(parseAgentDeviceRecording(a2Text)), {
      crashSignature: second.runtime.crashSignature,
      screenSignature: second.runtime.screenSignature,
      verificationPerformed: true,
    });
  });

  it('reports no crash when logs are clean', () => {
    const recording = [
      '$ agent-device snapshot',
      '# window "Login"',
      '$ agent-device logs stop',
      '09-22 14:02:11.301  3121  3121 I Choreographer: Skipped 1 frames',
    ].join('\n');
    const evidence = readingToEvidence(parseAgentDeviceRecording(recording));
    assert.equal(evidence.crashSignature, null);
    assert.equal(evidence.screenSignature, 'Login');
    assert.equal(evidence.verificationPerformed, true);
  });
});
