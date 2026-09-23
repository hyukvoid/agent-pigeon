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

  // --- Verification debt (turn-based, POC-04C.2) ---------------------------
  // Unit of evidence: the model TURN. A run of consecutive implementation
  // turns with no verification is debt. Raw Edit/Write calls inside ONE turn
  // are one logical attempt (a fix plus its import and type edits are not
  // three attempts), and test-only turns are verification preparation, not
  // implementation. Fall back to one synthetic turn per attempt for sources
  // without turn boundaries.
  const region: number[] = [];
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    if (attempt === undefined || attempt.evidence.verification.performed) break;
    region.unshift(i);
  }

  const turnIds = new Set<string>();
  let fallbackTurns = false;
  for (const i of region) {
    const attempt = attempts[i];
    if (attempt === undefined) continue;
    if (attempt.implTurns.length > 0) {
      for (const t of attempt.implTurns) turnIds.add(`t${t}`);
    } else {
      turnIds.add(`a${i}`);
      fallbackTurns = true;
    }
  }
  const distinctTurns = turnIds.size;

  // Scaffolding carve-out (POC-04C.2 dogfood): a stretch made ONLY of
  // new-file writes has nothing runnable to verify yet. Stay silent; the
  // activity still shows in the activity counts.
  const regionWrites = region.reduce((sum, i) => sum + (attempts[i]?.implWrites ?? 0), 0);
  const regionEdits = region.reduce((sum, i) => sum + (attempts[i]?.implEdits ?? 0), 0);
  const creationOnly = regionWrites > 0 && regionEdits === 0;

  if (region.length >= 1 && !creationOnly) {
    const first = (region[0] ?? 0) + 1;
    const last = (region[region.length - 1] ?? 0) + 1;
    if (distinctTurns >= 3) {
      findings.push({
        kind: 'verification-debt',
        attemptRange: [first, last],
        detail: `${distinctTurns} distinct implementation turns were made without collecting any verification evidence`,
        confidence: distinctTurns >= 3 ? 'HIGH' : 'MEDIUM',
      });
    } else if (distinctTurns === 2 && region.length >= 2) {
      findings.push({
        kind: 'verification-debt',
        attemptRange: [first, last],
        detail: `2 consecutive implementation attempts without any verification run`,
        confidence: 'MEDIUM',
      });
    } else if (fallbackTurns && region.length === 1) {
      // Turn-unaware source: only the old call-volume signal remains, and it
      // is weak (POC-04C.2: many calls are usually one coherent change).
      const attempt = attempts[region[0] ?? 0];
      if (attempt !== undefined && attempt.implementationEvents >= 5) {
        findings.push({
          kind: 'verification-debt',
          attemptRange: [first, last],
          detail: `${attempt.implementationEvents} implementation calls were made without collecting any verification evidence`,
          confidence: 'MEDIUM',
        });
      }
    }
  }

  // --- Dead-end exploration (failure-signature identity) -------------------
  // Consecutive attempts sharing the SAME failure signature while the code
  // kept changing. Runs are split whenever the signature changes.
  interface DeadEndRun {
    indices: number[];
    hash: string;
  }
  const deadEndRuns: DeadEndRun[] = [];
  let currentRun: number[] = [];
  let currentHash: string | null = null;
  const closeRun = (): void => {
    if (currentRun.length >= 2 && currentHash !== null) {
      deadEndRuns.push({ indices: currentRun, hash: currentHash });
    }
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
    for (let i = 1; i < run.indices.length; i++) {
      const prev = attempts[(run.indices[i - 1] ?? 0)];
      const curr = attempts[(run.indices[i] ?? 0)];
      if (prev === undefined || curr === undefined) continue;
      if (prev.evidence.code.changeSetHash === curr.evidence.code.changeSetHash) allNovel = false;
    }
    if (!allNovel) continue;
    const first = (run.indices[0] ?? 0) + 1;
    const last = (run.indices[run.indices.length - 1] ?? 0) + 1;
    findings.push({
      kind: 'dead-end',
      attemptRange: [first, last],
      detail: `${run.indices.length} different patches, same failure signature ${run.hash}`,
      confidence: run.indices.length >= 3 ? 'HIGH' : 'MEDIUM',
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
