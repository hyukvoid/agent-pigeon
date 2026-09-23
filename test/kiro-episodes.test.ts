import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { segmentWithWindows } from '../src/replay/segment.js';
import { analyzeAttempts } from '../src/replay/analyze.js';
import type { SanitizedReplayEvent } from '../src/replay/types.js';

/**
 * CONTROLLED regression — the six VERIFY_FIRST warnings from the real
 * Claude-in-Kiro dogfood (see docs/research/CLAUDE-KIRO-DOGFOOD.md),
 * reconstructed as sanitized event sequences (one model turn per step).
 *
 * These are NOT organic findings. They exist to pin the revised rules:
 * the six original false/annoying warnings must NOT fire on the revised
 * pipeline, while genuine trailing debt must still fire.
 */

const TS = (n: number): string => new Date(Date.parse('2026-09-23T09:00:00.000Z') + n * 60_000).toISOString();

let seq = 0;
function impl(path: string, turn: number, opts: { testPath?: boolean; write?: boolean } = {}): SanitizedReplayEvent {
  seq++;
  return {
    eventType: 'implementation',
    timestampOffset: turn * 60_000,
    toolName: opts.write === true ? 'Write' : 'Edit',
    ok: null,
    verificationKind: null,
    changedFilesCount: 1,
    changeSetHash: `fp-${seq}`,
    fingerprintBasis: 'content',
    failureSignatureHash: null,
    testsFailedCount: null,
    durationMs: null,
    turn,
    testOnly: opts.testPath === true || TEST_PATH.test(path),
  };
}
function verify(turn: number, ok: boolean): SanitizedReplayEvent {
  seq++;
  return {
    eventType: 'verification',
    timestampOffset: turn * 60_000,
    toolName: 'Bash',
    ok,
    verificationKind: ok ? 'test' : 'build',
    changedFilesCount: null,
    changeSetHash: null,
    fingerprintBasis: null,
    failureSignatureHash: ok ? null : 'sig',
    testsFailedCount: ok ? 0 : 2,
    durationMs: null,
    turn,
    testOnly: null,
  };
}
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[a-z]+$/i;

function debtCount(events: SanitizedReplayEvent[]): number {
  const { attempts } = segmentWithWindows(events);
  return analyzeAttempts(attempts).findings.filter((f) => f.kind === 'verification-debt').length;
}

describe('CONTROLLED — Kiro dogfood episodes under revised rules (target: 0 of 6 fire)', () => {
  it('ep1 warnings (dead-stub deletion, import addition): resolved by later verification → silent', () => {
    const events = [
      impl('src/cli.ts', 1),                       // edit 1
      impl('src/cli.ts', 2),                       // edit 2
      impl('src/cli.ts', 3),                       // edit 3  (old: warning 1)
      verify(4, true),                             // npm run typecheck — recognized evidence
      impl('src/replay/corpus.ts', 5),             // extract scanSessions
      impl('src/cli.ts', 6),                       // call scanSessions
      impl('src/cli.ts', 7),                       // update import (old: warning 2)
      impl('test/replay.test.ts', 8, { testPath: true }),
      impl('test/replay.test.ts', 9, { testPath: true }),
      verify(10, true),                            // npm test → 79 pass
    ];
    assert.equal(debtCount(events), 0, 'both stretches were resolved by recognized verification');
  });

  it('ep2 warning (import after failing-test reproduction): productive loop → silent', () => {
    const events = [
      impl('test/governor.test.ts', 1),
      impl('test/governor.test.ts', 2),
      verify(3, false),                            // failing run reproduces the bug — evidence
      impl('experimental/src/governor-batch.ts', 4),
      impl('experimental/src/governor-batch.ts', 5),
      impl('experimental/src/governor-batch.ts', 6), // (old: warning 3)
      verify(7, true),                             // npm test → 81 pass
    ];
    assert.equal(debtCount(events), 0);
  });

  it('ep3 warning (mirrored classifier change): resolved by suite → silent', () => {
    const events = [
      impl('src/replay/claude.ts', 1),
      impl('experimental/hooks/hook-posttooluse.mjs', 2),
      impl('test/replay.test.ts', 3, { testPath: true }), // (old: warning 4)
      impl('test/governor.test.ts', 4, { testPath: true }),
      impl('test/governor.test.ts', 5, { testPath: true }),
      verify(6, true),                             // npm test → 84 pass
    ];
    assert.equal(debtCount(events), 0);
  });

  it('control: 3 edits to ONE test file → silent (path-aware neutrality)', () => {
    const events = [
      impl('test/a.test.ts', 1, { testPath: true }),
      impl('test/a.test.ts', 2, { testPath: true }),
      impl('test/a.test.ts', 3, { testPath: true }), // (old: warning 5)
    ];
    assert.equal(debtCount(events), 0);
  });

  it('control: scaffolding 3 new files → silent (nothing runnable yet)', () => {
    const events = [
      impl('src/new/a.ts', 1, { write: true }),
      impl('src/new/b.ts', 2, { write: true }),
      impl('src/new/c.ts', 3, { write: true }), // (old: warning 6)
    ];
    assert.equal(debtCount(events), 0, 'creation-only stretches cannot be verified yet');
  });

  it('CONTROL: genuine 3-turn unverified work still fires (precision target is not zero recall)', () => {
    const events = [impl('src/x.ts', 1), impl('src/y.ts', 2), impl('src/z.ts', 3)];
    assert.equal(debtCount(events), 1);
  });
});
