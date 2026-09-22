/**
 * Deterministic evaluation: turns signals into evidence gain, runtime
 * progress, dead-end detection and a policy verdict. Jev never participates
 * here — this module must produce a complete report on its own (POC-00 §7).
 */

import type { AttemptEvidence } from './types.js';
import type { SeriesSignals } from './signals.js';
import { pairSignals, seriesSignals } from './signals.js';

export type Level = 'HIGH' | 'MEDIUM' | 'LOW';

export type Policy = 'CONTINUE' | 'VERIFY_FIRST' | 'RETHINK' | 'HUMAN_REVIEW';

export interface GainComponents {
  testsImproved: boolean;
  crashChanged: boolean;
  screenChanged: boolean;
}

export interface PairEvaluation {
  evidenceGain: Level;
  gainComponents: GainComponents;
  runtimeProgress: Level;
}

export interface Evaluation extends PairEvaluation {
  deadEndCandidate: boolean;
  policy: Policy;
  verdict: string;
  rationale: string[];
}

const LATEST_PAIR_DEFAULT: PairEvaluation = {
  evidenceGain: 'LOW',
  gainComponents: { testsImproved: false, crashChanged: false, screenChanged: false },
  runtimeProgress: 'LOW',
};

/** Evaluate the transition prev → curr (the "latest pair"). */
export function evaluatePair(prev: AttemptEvidence, curr: AttemptEvidence): PairEvaluation {
  const pair = pairSignals(prev, curr);
  const testsImproved = pair.failedTestsDelta !== null && pair.failedTestsDelta < 0;
  const crashChanged = pair.crashChanged === true;
  const screenChanged = pair.screenChanged === true;
  const changeCount = [testsImproved, crashChanged, screenChanged].filter(Boolean).length;

  const evidenceGain: Level = changeCount >= 2 ? 'HIGH' : changeCount === 1 ? 'MEDIUM' : 'LOW';
  const runtimeProgress: Level =
    testsImproved && changeCount >= 2 ? 'HIGH' : testsImproved || changeCount >= 1 ? 'MEDIUM' : 'LOW';

  return {
    evidenceGain,
    gainComponents: { testsImproved, crashChanged, screenChanged },
    runtimeProgress,
  };
}

/**
 * Dead-end candidate: repeated code novelty with a frozen app. Requires at
 * least 3 attempts of different patches where the runtime never moved — no
 * screen change, no crash transition, no test-count movement on any observed
 * pair — and requires runtime evidence to exist (streaks only count real or
 * clean observations), so fixture-C-style no-verification runs do not
 * masquerade as dead ends; they are caught by verification debt instead.
 * Unknown test counts (null) do not block the verdict; a known unchanged
 * count still appears via sameTestsStreak in the report.
 */
export function detectDeadEnd(attempts: AttemptEvidence[], signals: SeriesSignals): boolean {
  if (attempts.length < 3) return false;
  if (!signals.pairs.every((p) => p.codeNovelty === true)) return false;
  const runtimeMoved = signals.pairs.some(
    (p) =>
      p.crashChanged === true ||
      p.screenChanged === true ||
      (p.failedTestsDelta !== null && p.failedTestsDelta !== 0),
  );
  if (runtimeMoved) return false;
  return signals.sameCrashStreak >= 3 && signals.sameScreenStreak >= 3;
}

export interface ScenarioEvaluation {
  signals: SeriesSignals;
  evaluation: Evaluation;
}

/** Full deterministic pipeline for one attempt series. */
export function evaluateScenario(attempts: AttemptEvidence[]): ScenarioEvaluation {
  const signals = seriesSignals(attempts);

  const last = attempts[attempts.length - 1];
  const prev = attempts[attempts.length - 2];
  const pairEval: PairEvaluation =
    last !== undefined && prev !== undefined ? evaluatePair(prev, last) : LATEST_PAIR_DEFAULT;

  const deadEndCandidate = detectDeadEnd(attempts, signals);
  const rationale: string[] = [];

  let policy: Policy;
  let verdict: string;

  if (signals.verificationDebt === 'HIGH') {
    policy = 'VERIFY_FIRST';
    verdict = `⏸ ${signals.verificationDebtStreak} implementation attempts were made without collecting new runtime evidence.`;
    rationale.push(
      `verification debt streak = ${signals.verificationDebtStreak} (code-changing attempts with no runtime verification)`,
    );
  } else if (deadEndCandidate) {
    policy = 'RETHINK';
    verdict = '⚠ Different code. Same app.';
    rationale.push(
      `${attempts.length} different patches, but crash / screen / failed-test counts are identical across all of them`,
    );
  } else if (pairEval.runtimeProgress === 'HIGH') {
    policy = 'CONTINUE';
    verdict = '✓ Productive progress — runtime evidence improved.';
    rationale.push('failed tests decreased together with changed crash or screen signature');
  } else if (last !== undefined && last.build.status === 'fail') {
    policy = 'HUMAN_REVIEW';
    verdict = '‼ Build is failing — escalate for human review.';
    rationale.push('latest attempt does not build');
  } else {
    policy = 'CONTINUE';
    verdict = '• No strong signal yet — continue.';
    rationale.push('insufficient change in runtime evidence to classify further');
  }

  return {
    signals,
    evaluation: {
      ...pairEval,
      deadEndCandidate,
      policy,
      verdict,
      rationale,
    },
  };
}
