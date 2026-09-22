/**
 * ProgressContract (POC-03.5 §3) — minimal, hand-authored evaluation context.
 *
 * This is NOT a planner and NOT LLM-generated. It is declarative input that
 * lets the evaluator separate "something moved" from "the task got closer".
 * A contract may be attached to any attempt series (fixture, replay, live).
 *
 * Privacy: contains only task description text authored for evaluation —
 * never source code, never paths.
 */

export interface ProgressContract {
  /** The stated task objective, e.g. "Fix crash after Sign In". */
  task: string;
  /** Success signal: the app must stop crashing (crashSignature → null, observed). */
  crashMustDisappear?: boolean;
  /** Success signal: this normalized screen identity is reached. */
  targetScreenSignature?: string;
  /** Baseline screen the app must remain able to reach; losing it is a regression. */
  baselineScreenSignature?: string;
  /** Success signal: failing-test count moves down toward zero. */
  testsMustDecrease?: boolean;
  /** Documentation of evidence that is diagnostically useful but not goal movement. */
  usefulEvidenceSignals?: string[];
  /** Documentation of patterns that mean no progress. Matched signals are reported. */
  noProgressSignals?: string[];
}

export type GoalProgressLevel = 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN';

export interface GoalProgressResult {
  level: GoalProgressLevel;
  rationale: string;
  /** Contract-declared success signals satisfied by the latest pair. */
  matchedSuccessSignals: string[];
  /** Contract-declared no-progress signals observed on the latest pair. */
  matchedNoProgressSignals: string[];
}

/** Inputs the goal evaluator may look at for one prev→curr transition. */
export interface GoalProgressInput {
  contract: ProgressContract | null;
  prev: {
    crashSignature: string | null;
    screenSignature: string | null;
    testsFailedCount: number | null;
    verificationPerformed: boolean;
  };
  curr: {
    crashSignature: string | null;
    screenSignature: string | null;
    testsFailedCount: number | null;
    verificationPerformed: boolean;
  };
  failedTestsDelta: number | null;
  /** NONE / SINGLE / MULTIPLE — how much of the observable runtime moved. */
  runtimeChangeMagnitude: 'NONE' | 'SINGLE' | 'MULTIPLE';
}

const NO_CONTRACT: GoalProgressResult = {
  level: 'UNKNOWN',
  rationale: 'no ProgressContract supplied — goal progress cannot be claimed from movement alone',
  matchedSuccessSignals: [],
  matchedNoProgressSignals: [],
};

/**
 * Deterministic goal-progress evaluation. HARD RULE (POC-03.5 §2): a bare
 * screenChanged/crashChanged NEVER yields HIGH — HIGH requires a
 * contract-linked success signal (crash removed, target screen reached, or —
 * at best MEDIUM — failing tests moving down).
 */
export function evaluateGoalProgress(input: GoalProgressInput): GoalProgressResult {
  const { contract } = input;
  if (contract === null) return NO_CONTRACT;

  const { prev, curr } = input;
  const matchedSuccessSignals: string[] = [];
  const matchedNoProgressSignals: string[] = [];
  let rationale = '';

  const crashRemoved =
    contract.crashMustDisappear === true &&
    prev.crashSignature !== null &&
    curr.crashSignature === null &&
    curr.verificationPerformed;
  if (crashRemoved) matchedSuccessSignals.push('crash disappears');

  const targetReached =
    contract.targetScreenSignature !== undefined &&
    prev.screenSignature !== contract.targetScreenSignature &&
    curr.screenSignature === contract.targetScreenSignature;
  if (targetReached) matchedSuccessSignals.push(`target screen reached (${contract.targetScreenSignature})`);

  const testsDecreased =
    contract.testsMustDecrease === true &&
    input.failedTestsDelta !== null &&
    input.failedTestsDelta < 0;
  if (testsDecreased) matchedSuccessSignals.push(`failing tests decreased (${input.failedTestsDelta})`);

  const baselineLost =
    contract.baselineScreenSignature !== undefined &&
    prev.screenSignature === contract.baselineScreenSignature &&
    curr.screenSignature !== contract.baselineScreenSignature;
  const newCrashAppeared =
    prev.crashSignature === null && curr.crashSignature !== null && curr.verificationPerformed;
  const crashPersists =
    contract.crashMustDisappear === true &&
    prev.crashSignature !== null &&
    curr.crashSignature !== null;

  // No-progress documentation signals.
  if (
    contract.crashMustDisappear === true &&
    prev.crashSignature !== null &&
    prev.crashSignature === curr.crashSignature
  ) {
    matchedNoProgressSignals.push('same crash');
  }
  if (
    prev.screenSignature !== null &&
    prev.screenSignature === curr.screenSignature
  ) {
    matchedNoProgressSignals.push('same screen');
  }
  if (
    input.failedTestsDelta !== null &&
    input.failedTestsDelta === 0
  ) {
    matchedNoProgressSignals.push('same failed tests');
  }

  // Level selection — success signals first, then explicit regressions, then
  // honest ambiguity.
  if (crashRemoved || targetReached) {
    rationale = [
      crashRemoved ? 'crash removed' : null,
      targetReached ? `target screen reached (${contract.targetScreenSignature})` : null,
      testsDecreased ? `failing tests ${input.failedTestsDelta}` : null,
    ]
      .filter(Boolean)
      .join('; ');
    return { level: 'HIGH', rationale, matchedSuccessSignals, matchedNoProgressSignals };
  }

  if (baselineLost || newCrashAppeared) {
    const parts = [
      baselineLost ? `app no longer reaches baseline screen (${contract.baselineScreenSignature})` : null,
      newCrashAppeared ? 'a crash appeared where there was none' : null,
    ].filter(Boolean);
    return {
      level: 'LOW',
      rationale: `movement without improvement — ${parts.join(' and ')}`,
      matchedSuccessSignals,
      matchedNoProgressSignals,
    };
  }

  if (testsDecreased) {
    return {
      level: 'MEDIUM',
      rationale: `failing tests decreased (${input.failedTestsDelta}) — partial movement toward the objective`,
      matchedSuccessSignals,
      matchedNoProgressSignals,
    };
  }

  if (input.runtimeChangeMagnitude !== 'NONE' && crashPersists) {
    return {
      level: 'UNKNOWN',
      rationale: 'crash signature changed but the app still crashes — new evidence, goal impact unclear',
      matchedSuccessSignals,
      matchedNoProgressSignals,
    };
  }

  if (input.runtimeChangeMagnitude === 'NONE') {
    return {
      level: 'LOW',
      rationale: 'nothing observable changed — no movement toward the objective',
      matchedSuccessSignals,
      matchedNoProgressSignals,
    };
  }

  return {
    level: 'UNKNOWN',
    rationale: 'runtime moved but no contract-linked success or regression signal fired',
    matchedSuccessSignals,
    matchedNoProgressSignals,
  };
}
