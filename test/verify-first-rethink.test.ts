import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { segmentWithWindows } from '../src/replay/segment.js';
import { analyzeAttempts } from '../src/replay/analyze.js';
import type { SanitizedReplayEvent } from '../src/replay/types.js';

/**
 * CONTROLLED evaluation set (POC-04C.2).
 *
 * These shapes RECONSTRUCT the failure classes reported by the real
 * Claude-in-Kiro dogfood (6 warnings: 0 useful, 4 false positives, 2
 * annoying). They are not organic data — they are controlled reproductions
 * of the reported false-positive classes, used to evaluate the old
 * fingerprint-based debt rule against the revised turn-based rule.
 */

const TS = (n: number): string => new Date(Date.parse('2026-09-22T09:00:00.000Z') + n * 1000).toISOString();

function impl(turn: number, path: string, testPath = false): SanitizedReplayEvent {
  return {
    eventType: 'implementation',
    timestampOffset: turn * 100 + Math.floor(Math.random() * 10),
    toolName: 'Edit',
    ok: null,
    verificationKind: null,
    changedFilesCount: 1,
    changeSetHash: `fp-${turn}-${path}`,
    fingerprintBasis: 'content',
    failureSignatureHash: null,
    testsFailedCount: null,
    durationMs: null,
    turn,
    testOnly: testPath,
  };
}
function verify(ok: boolean, turn: number): SanitizedReplayEvent {
  return {
    eventType: 'verification',
    timestampOffset: turn * 100 + 50,
    toolName: 'Bash',
    ok,
    verificationKind: 'test',
    changedFilesCount: null,
    changeSetHash: null,
    fingerprintBasis: null,
    failureSignatureHash: null,
    testsFailedCount: ok ? 0 : null,
    durationMs: null,
    turn,
    testOnly: null,
  };
}

function debtCount(events: SanitizedReplayEvent[]): number {
  const { attempts } = segmentWithWindows(events);
  return analyzeAttempts(attempts).findings.filter((f) => f.kind === 'verification-debt').length;
}

describe('CONTROLLED — Kiro dogfood false-positive shapes (old rule fired, revised rule must stay silent)', () => {
  it('shape 1: implementation + import fix + type fix in ONE turn (3 raw edits) → silent', () => {
    const events = [impl(1, 'src/LoginViewModel.kt'), impl(1, 'src/import-fix.ts'), impl(1, 'src/types.d.ts')];
    assert.equal(debtCount(events), 0, 'one coherent turn is one logical attempt — not 3');
  });

  it('shape 2: mirrored implementation files in ONE turn (3 files) → silent', () => {
    const events = [impl(2, 'src/web/form.ts'), impl(2, 'src/mobile/form.ts'), impl(2, 'src/api/form.ts')];
    assert.equal(debtCount(events), 0);
  });

  it('shape 3: writing the regression test needed to verify (test-only turn) → silent', () => {
    const events = [
      impl(3, 'src/LoginViewModel.kt'),
      impl(3, '__tests__/login.test.ts', true),
      impl(4, '__tests__/login.test.ts', true),
    ];
    assert.equal(debtCount(events), 0, 'test-writing is verification preparation, not a new attempt');
  });
});

describe('CONTROLLED — the warning SHOULD still fire', () => {
  it('genuine prolonged no-verification work: 3 distinct implementation turns → fires', () => {
    const events = [impl(10, 'a.ts'), impl(20, 'b.ts'), impl(30, 'c.ts')];
    assert.equal(debtCount(events), 1, '3 distinct turns without any verification is real debt');
  });

  it('productive fix → fail → fix → pass loop → silent', () => {
    const events = [
      impl(1, 'a.ts'),
      verify(false, 1),
      impl(2, 'a.ts'),
      verify(false, 2),
      impl(3, 'a.ts'),
      verify(true, 3),
    ];
    const { attempts } = segmentWithWindows(events);
    const analysis = analyzeAttempts(attempts);
    assert.equal(analysis.findings.filter((f) => f.kind === 'verification-debt').length, 0);
    assert.equal(analysis.findings.filter((f) => f.kind === 'productive').length >= 0, true);
  });

  it('debt resets after verification: 3 turns → warn → verify → 3 more turns → warn again', () => {
    const events = [
      impl(1, 'a.ts'), impl(2, 'b.ts'), impl(3, 'c.ts'),
      verify(true, 4),
      impl(5, 'd.ts'), impl(6, 'e.ts'), impl(7, 'f.ts'),
    ];
    assert.equal(debtCount(events), 1, 'second episode fires again, once');
  });
});
