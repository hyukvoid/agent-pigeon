/**
 * Replay analysis (POC-02): verification debt, dead-end exploration and
 * productive progress over real reconstructed attempts.
 *
 * Critical rule (spec §7): nothing is forced into a bucket. Without clear
 * evidence a segment is INCONCLUSIVE — false positives matter more than
 * recall.
 */

import type { ReplayAttempt } from './types.js';

export type Confidence = 'HIGH' | 'MEDIUM' | 'INCONCLUSIVE';

export interface ReplayFinding {
  kind: 'verification-debt' | 'dead-end' | 'productive';
  /** 1-based inclusive attempt index range. */
  attemptRange: [number, number];
  detail: string;
  confidence: Confidence;
}

export interface ReplayAnalysis {
  attemptCount: number;
  verificationRuns: number;
  implementationCalls: number;
  findings: ReplayFinding[];
  verdict: string;
  overallConfidence: Confidence;
}

const RANK: Record<Confidence, number> = { HIGH: 3, MEDIUM: 2, INCONCLUSIVE: 1 };

function runsof<T>(items: T[], predicate: (item: T) => boolean): Array<Array<number>> {
  const runs: number[][] = [];
  let current: number[] = [];
  items.forEach((item, index) => {
    if (predicate(item)) {
      current.push(index);
    } else if (current.length > 0) {
      runs.push(current);
      current = [];
    }
  });
  if (current.length > 0) runs.push(current);
  return runs;
}

export function analyzeAttempts(attempts: ReplayAttempt[]): ReplayAnalysis {
  const findings: ReplayFinding[] = [];
  const attemptCount = attempts.length;
  const verificationRuns = attempts.reduce((sum, a) => sum + a.verificationKinds.length, 0);
  const implementationCalls = attempts.reduce((sum, a) => sum + a.implementationEvents, 0);

  // --- Verification debt ---------------------------------------------------
  // (a) consecutive unverified attempts
  for (const run of runsof(attempts, (a) => !a.evidence.verification.performed)) {
    if (run.length < 2) continue;
    const first = (run[0] ?? 0) + 1;
    const last = (run[run.length - 1] ?? 0) + 1;
    findings.push({
      kind: 'verification-debt',
      attemptRange: [first, last],
      detail: `${run.length} consecutive implementation attempts without any verification run`,
      confidence: run.length >= 3 ? 'HIGH' : 'MEDIUM',
    });
  }
  // (b) a single window stacking many implementation calls with no verification
  for (const attempt of attempts) {
    if (!attempt.evidence.verification.performed && attempt.implementationEvents >= 3) {
      findings.push({
        kind: 'verification-debt',
        attemptRange: [attempt.index + 1, attempt.index + 1],
        detail: `${attempt.implementationEvents} implementation calls were made without collecting any verification evidence`,
        confidence: attempt.implementationEvents >= 5 ? 'HIGH' : 'MEDIUM',
      });
    }
  }

  // --- Dead-end exploration (failure-signature identity) -------------------
  // Consecutive attempts sharing the SAME failure signature while the code
  // kept changing. Runs are split whenever the signature changes.
  const deadEndRuns: number[][] = [];
  let currentRun: number[] = [];
  let currentHash: string | null = null;
  const closeRun = (): void => {
    if (currentRun.length >= 2) deadEndRuns.push(currentRun);
    currentRun = [];
  };
  attempts.forEach((attempt, index) => {
    const hash = attempt.failureSignatureHash;
    if (hash !== null && attempt.evidence.verification.performed && hash === currentHash) {
      currentRun.push(index);
    } else {
      closeRun();
      if (hash !== null && attempt.evidence.verification.performed) {
        currentHash = hash;
        currentRun = [index];
      } else {
        currentHash = null;
      }
    }
  });
  closeRun();

  for (const run of deadEndRuns) {
    let allNovel = true;
    for (let i = 1; i < run.length; i++) {
      const prev = attempts[(run[i - 1] ?? 0)];
      const curr = attempts[(run[i] ?? 0)];
      if (prev === undefined || curr === undefined) continue;
      if (prev.evidence.code.changeSetHash === curr.evidence.code.changeSetHash) allNovel = false;
    }
    if (!allNovel) continue;
    const first = (run[0] ?? 0) + 1;
    const last = (run[run.length - 1] ?? 0) + 1;
    findings.push({
      kind: 'dead-end',
      attemptRange: [first, last],
      detail: `${run.length} different patches, same failure signature ${currentHash ?? '?'}`,
      confidence: run.length >= 3 ? 'HIGH' : 'MEDIUM',
    });
  }

  // --- Productive progress -------------------------------------------------
  for (let i = 1; i < attempts.length; i++) {
    const prev = attempts[i - 1];
    const curr = attempts[i];
    if (prev === undefined || curr === undefined) continue;
    const prevCount = prev.evidence.tests.failedCount;
    const currCount = curr.evidence.tests.failedCount;
    if (prevCount !== null && currCount !== null && currCount < prevCount) {
      findings.push({
        kind: 'productive',
        attemptRange: [i, i + 1],
        detail: `failed tests ${prevCount} → ${currCount}`,
        confidence: prevCount - currCount >= 3 ? 'HIGH' : 'MEDIUM',
      });
    }
    const prevFail = prev.evidence.build.status === 'fail';
    const nowPass = curr.evidence.build.status === 'pass';
    if (prevFail && nowPass) {
      findings.push({
        kind: 'productive',
        attemptRange: [i, i + 1],
        detail: 'build went fail → pass',
        confidence: 'HIGH',
      });
    }
  }

  // --- Verdict -------------------------------------------------------------
  const severity = (kind: ReplayFinding['kind']): number =>
    kind === 'verification-debt' ? 3 : kind === 'dead-end' ? 2 : 1;
  const primary = [...findings].sort(
    (a, b) => severity(b.kind) - severity(a.kind) || RANK[b.confidence] - RANK[a.confidence],
  )[0];

  let verdict = 'INCONCLUSIVE — no strong pattern in this session';
  if (primary?.kind === 'verification-debt') {
    verdict = `⏸ Verification debt: ${primary.detail}`;
  } else if (primary?.kind === 'dead-end') {
    verdict = '⚠ Different code. Same error.';
  } else if (primary?.kind === 'productive') {
    verdict = '✓ Productive progress';
  }

  const overallConfidence =
    findings.length === 0
      ? 'INCONCLUSIVE'
      : findings.map((f) => f.confidence).sort((a, b) => RANK[b] - RANK[a])[0] ?? 'INCONCLUSIVE';

  return {
    attemptCount,
    verificationRuns,
    implementationCalls,
    findings,
    verdict,
    overallConfidence,
  };
}
