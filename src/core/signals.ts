/**
 * Deterministic signal calculator.
 *
 * Everything here is computed locally from AttemptEvidence. No model is asked
 * anything (POC-00 spec §4). Pure functions: the same fixture always produces
 * the same signals.
 */

import type { AttemptEvidence } from './types.js';

export type DebtLevel = 'LOW' | 'MEDIUM' | 'HIGH';

/** Signals describing the transition between two consecutive attempts. */
export interface PairSignals {
  fromAttemptId: string;
  toAttemptId: string;
  /** null when either attempt lacks build status. */
  buildChanged: boolean | null;
  /** current failedCount - previous failedCount; null when either is unknown. */
  failedTestsDelta: number | null;
  crashChanged: boolean | null;
  screenChanged: boolean | null;
  /** true when the two attempts are different patches (changeSetHash differs). */
  codeNovelty: boolean | null;
  verificationPerformed: boolean;
  changedFilesCount: number | null;
}

export interface SeriesSignals {
  attemptCount: number;
  /** Attempts that actually changed code. */
  changedImplementations: number;
  pairs: PairSignals[];
  /** Trailing consecutive attempts sharing the same non-null crash signature. */
  sameCrashStreak: number;
  sameScreenStreak: number;
  sameTestsStreak: number;
  /** Trailing consecutive code-changing attempts with no runtime verification. */
  verificationDebtStreak: number;
  verificationDebt: DebtLevel;
}

function differs(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
): boolean | null {
  if (a === null || a === undefined || b === null || b === undefined) return null;
  return a !== b;
}

export function pairSignals(prev: AttemptEvidence, curr: AttemptEvidence): PairSignals {
  const failedDelta =
    prev.tests.failedCount === null || curr.tests.failedCount === null
      ? null
      : curr.tests.failedCount - prev.tests.failedCount;

  return {
    fromAttemptId: prev.attemptId,
    toAttemptId: curr.attemptId,
    buildChanged: differs(prev.build.status, curr.build.status),
    failedTestsDelta: failedDelta,
    crashChanged: differs(prev.runtime.crashSignature, curr.runtime.crashSignature),
    screenChanged: differs(prev.runtime.screenSignature, curr.runtime.screenSignature),
    codeNovelty: differs(prev.code.changeSetHash, curr.code.changeSetHash),
    verificationPerformed: curr.verification.performed,
    changedFilesCount: curr.code.changedFilesCount,
  };
}

/** An attempt counts as "changed code" when it shipped a patch. */
export function isCodeChanging(attempt: AttemptEvidence): boolean {
  return (attempt.code.changedFilesCount ?? 0) > 0 || attempt.code.changeSetHash !== null;
}

/**
 * Trailing streak of identical non-null values. A null value (never observed)
 * ends the streak and yields 0 — "we never looked" must not read as "nothing
 * changed".
 */
function trailingIdenticalStreak(values: (string | number | null)[]): number {
  if (values.length === 0) return 0;
  const last = values[values.length - 1];
  if (last === null) return 0;
  let streak = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (value === null || value !== last) break;
    streak++;
  }
  return streak;
}

export function verificationDebtLevel(streak: number): DebtLevel {
  if (streak >= 3) return 'HIGH';
  if (streak === 2) return 'MEDIUM';
  return 'LOW';
}

export function seriesSignals(attempts: AttemptEvidence[]): SeriesSignals {
  const pairs: PairSignals[] = [];
  for (let i = 1; i < attempts.length; i++) {
    const prev = attempts[i - 1];
    const curr = attempts[i];
    if (prev !== undefined && curr !== undefined) {
      pairs.push(pairSignals(prev, curr));
    }
  }

  let debtStreak = 0;
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    if (attempt === undefined) break;
    if (isCodeChanging(attempt) && !attempt.verification.performed) {
      debtStreak++;
    } else {
      break;
    }
  }

  return {
    attemptCount: attempts.length,
    changedImplementations: attempts.filter((a) => isCodeChanging(a)).length,
    pairs,
    sameCrashStreak: trailingIdenticalStreak(attempts.map((a) => a.runtime.crashSignature)),
    sameScreenStreak: trailingIdenticalStreak(attempts.map((a) => a.runtime.screenSignature)),
    sameTestsStreak: trailingIdenticalStreak(attempts.map((a) => a.tests.failedCount)),
    verificationDebtStreak: debtStreak,
    verificationDebt: verificationDebtLevel(debtStreak),
  };
}
