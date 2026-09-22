import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readLogs, readSnapshot } from '../src/agent-device/parse.js';
import { normalizeAgentDeviceEvidence } from '../src/agent-device/adapter.js';
import { evaluateScenario } from '../src/core/evaluate.js';
import { pairSignals } from '../src/core/signals.js';
import type { AttemptEvidence } from '../src/core/types.js';
import { agentDeviceFixture } from './paths.js';

function real(name: string): string {
  return readFileSync(agentDeviceFixture(`real/${name}`), 'utf8');
}

describe('agent-device adapter against REAL emulator captures', () => {
  it('REAL A: repeated observation of the same state yields the same screen signature', () => {
    const a1 = readSnapshot(real('real-a1.snapshot.txt'));
    const a2 = readSnapshot(real('real-a2.snapshot.txt'));
    const b1 = readSnapshot(real('real-b1-homepage.snapshot.txt')); // captured later in the run
    const c2 = readSnapshot(real('real-c2-homepage.snapshot.txt'));
    assert.equal(a1.contentSignature, a2.contentSignature);
    assert.equal(a1.contentSignature, b1.contentSignature);
    assert.equal(a1.contentSignature, c2.contentSignature);
    assert.equal(a1.page, 'com.android.settings');
  });

  it('screen signature ignores ref numbering (noise rule)', () => {
    const renumbered = real('real-a1.snapshot.txt')
      .split('\n')
      .map((line) => line.replace(/^@e(\d+)/u, (m) => `@e${100 + Number(m.slice(2))}`))
      .join('\n');
    assert.equal(
      readSnapshot(real('real-a1.snapshot.txt')).contentSignature,
      readSnapshot(renumbered).contentSignature,
    );
  });

  it('REAL B: navigation produces a different screen signature', () => {
    const home = readSnapshot(real('real-b1-homepage.snapshot.txt'));
    const network = readSnapshot(real('real-b2-network.snapshot.txt'));
    assert.notEqual(home.contentSignature, network.contentSignature);
  });

  it('REAL B: real crash buffer yields the exception signature (framework-only fallback)', () => {
    const logs = readLogs(real('real-crash-buffer.txt'));
    assert.equal(logs.crashDetected, true);
    assert.equal(logs.crashSignature, 'RemoteServiceException$CrashedByAdbException');
  });

  it('adapter produces POC-00 AttemptEvidence from real captures', () => {
    const evidence = normalizeAgentDeviceEvidence({
      attemptId: 'real-a1',
      snapshotText: real('real-a1.snapshot.txt'),
      logsText: '',
    });
    assert.match(evidence.runtime.screenSignature ?? '', /^com\.android\.settings#[0-9a-f]{8}$/u);
    assert.equal(evidence.runtime.crashSignature, null);
    assert.equal(evidence.verification.performed, true);
    assert.equal(evidence.build.status, null);
    assert.equal(evidence.tests.failedCount, null);
  });

  it('crash present -> observed clean counts as crashChanged', () => {
    const before: AttemptEvidence = normalizeAgentDeviceEvidence({
      attemptId: 'c1',
      snapshotText: real('real-c1-crash.snapshot.txt'),
      logsText: real('real-crash-buffer.txt'),
    });
    const after: AttemptEvidence = normalizeAgentDeviceEvidence({
      attemptId: 'c2',
      snapshotText: real('real-c2-homepage.snapshot.txt'),
      logsText: '',
    });
    assert.notEqual(before.runtime.crashSignature, null);
    const pair = pairSignals(before, after);
    assert.equal(pair.crashChanged, true);
    assert.equal(pair.screenChanged, true);
  });

  it('REAL C: novel patches over a frozen runtime are a dead-end (Different code. Same app.)', () => {
    const homepage = real('real-a1.snapshot.txt');
    const attempts = ['patch-a.ts', 'patch-b.ts', 'patch-c.ts'].map((fileName, i) =>
      normalizeAgentDeviceEvidence({
        attemptId: `real-d${i}`,
        snapshotText: homepage,
        logsText: '',
        code: { changedFilesCount: 1, changeSetHash: `hash-${fileName}` },
      }),
    );
    const { signals, evaluation } = evaluateScenario(attempts);
    assert.equal(signals.changedImplementations, 3);
    assert.ok(signals.pairs.every((p) => p.codeNovelty === true));
    assert.equal(signals.sameScreenStreak, 3);
    assert.equal(evaluation.deadEndCandidate, true);
    assert.equal(evaluation.policy, 'RETHINK');
    assert.equal(evaluation.verdict, '⚠ Different code. Same app.');
  });
});
