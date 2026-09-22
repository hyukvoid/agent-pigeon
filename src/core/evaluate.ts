/**
 * Deterministic evaluation (POC-03.5 refactor): the three concepts are
 * DISTINCT and never aliases (§2):
 *
 *   runtimeChange  — something observable changed (magnitude: NONE/SINGLE/MULTIPLE)
 *   evidenceGain   — the latest attempt produced useful new diagnostic/runtime evidence
 *   goalProgress   — evidence moved the app measurably toward the stated task objective
 *                    (requires a ProgressContract; without one it stays UNKNOWN)
 *
 * HARD RULE: screenChanged=true or crashChanged=true never implies HIGH
 * goalProgress. Policy ladder (§10): OBSERVE → VERIFY_FIRST → RETHINK →
 * HUMAN_REVIEW (reserved).
 */

import type { AttemptEvidence } from './types.js';
import type { SeriesSignals } from './signals.js';
import { pairSignals, seriesSignals } from './signals.js';
import type { GoalProgressResult, ProgressContract } from './contract.js';
import { evaluateGoalProgress } from './contract.js';

export type Level = 'HIGH' | 'MEDIUM' | 'LOW';

export type RuntimeChangeLevel = 'NONE' | 'SINGLE' | 'MULTIPLE';

export type Policy = 'OBSERVE' | 'VERIFY_FIRST' | 'RETHINK' | 'HUMAN_REVIEW';

export interface GainComponents {
  testsImproved: boolean;
  crashChanged: boolean;
  screenChanged: boolean;
  buildChanged: boolean;
}

export interface PairEvaluation {
  runtimeChange: RuntimeChangeLevel;
  runtimeChangeDetail: string[];
  evidenceGain: Level;
  gainComponents: GainComponents;
}

export interface Evaluation extends PairEvaluation {
  goalProgress: GoalProgressResult;
  deadEndCandidate: boolean;
  policy: Policy;
  verdict: string;
  rationale: string[];
}

const EMPTY_GOAL: GoalProgressResult = {
  level: 'UNKNOWN',
  rationale: 'no attempt pair to evaluate',
  matchedSuccessSignals: [],
  matchedNoProgressSignals: [],
};

/** Evaluate the transition prev → curr (the "latest pair"). */
export function evaluatePair(prev: AttemptEvidence, curr: AttemptEvidence): PairEvaluation {
  const pair = pairSignals(prev, curr);
  const testsImproved = pair.failedTestsDelta !== null && pair.failedTestsDelta < 0;
  const crashChanged = pair.crashChanged === true;
  const screenChanged = pair.screenChanged === true;
  const buildChanged = pair.buildChanged === true;
  const changeCount = [testsImproved, crashChanged, screenChanged, buildChanged].filter(Boolean).length;

  const detail: string[] = [];
  if (testsImproved) detail.push(`failing tests ${pair.failedTestsDelta}`);
  if (crashChanged) detail.push('crash signature changed');
  if (screenChanged) detail.push('screen changed');
  if (buildChanged) detail.push('build status changed');

  const runtimeChange: RuntimeChangeLevel =
    changeCount >= 2 ? 'MULTIPLE' : changeCount === 1 ? 'SINGLE' : 'NONE';

  // Evidence gain: how much NEW diagnostic information the pair produced.
  const evidenceGain: Level = changeCount >= 2 ? 'HIGH' : changeCount === 1 ? 'MEDIUM' : 'LOW';

  return {
    runtimeChange,
    runtimeChangeDetail: detail,
    evidenceGain,
    gainComponents: { testsImproved, crashChanged, screenChanged, buildChanged },
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

/** Full deterministic pipeline for one attempt series (contract optional). */
export function evaluateScenario(attempts: AttemptEvidence[], contract?: ProgressContract | null): ScenarioEvaluation {
  const signals = seriesSignals(attempts);

  const last = attempts[attempts.length - 1];
  const prev = attempts[attempts.length - 2];
  const hasPair = last !== undefined && prev !== undefined;
  const pairEval: PairEvaluation = hasPair
    ? evaluatePair(prev, last)
    : {
        runtimeChange: 'NONE',
        runtimeChangeDetail: [],
        evidenceGain: 'LOW',
        gainComponents: { testsImproved: false, crashChanged: false, screenChanged: false, buildChanged: false },
      };

  const goalProgress: GoalProgressResult = hasPair
    ? evaluateGoalProgress({
        contract: contract ?? null,
        prev: {
          crashSignature: prev.runtime.crashSignature,
          screenSignature: prev.runtime.screenSignature,
          testsFailedCount: prev.tests.failedCount,
          verificationPerformed: prev.verification.performed,
        },
        curr: {
          crashSignature: last.runtime.crashSignature,
          screenSignature: last.runtime.screenSignature,
          testsFailedCount: last.tests.failedCount,
          verificationPerformed: last.verification.performed,
        },
        failedTestsDelta: signals.pairs[signals.pairs.length - 1]?.failedTestsDelta ?? null,
        runtimeChangeMagnitude: pairEval.runtimeChange,
      })
    : EMPTY_GOAL;

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
      `${attempts.length} materially different patches, but crash / screen / failed-test counts are identical across all of them`,
    );
  } else if (last !== undefined && last.build.status === 'fail') {
    policy = 'HUMAN_REVIEW';
    verdict = '‼ Build is failing — escalate for human review.';
    rationale.push('latest attempt does not build (HUMAN_REVIEW is reserved; mapping is provisional)');
  } else {
    policy = 'OBSERVE';
    verdict =
      goalProgress.level === 'HIGH'
        ? '✓ Productive progress — goal evidence improved.'
        : '• No strong signal yet — observe.';
    if (goalProgress.level === 'HIGH') {
      rationale.push(`contract-linked success: ${goalProgress.rationale}`);
    } else {
      rationale.push('no VERIFY_FIRST/RETHINK condition met; continuing observation');
    }
  }

  return {
    signals,
    evaluation: {
      ...pairEval,
      goalProgress,
      deadEndCandidate,
      policy,
      verdict,
      rationale,
    },
  };
}
