/**
 * Core data model for Agent Pigeon.
 *
 * The pipeline is a funnel:
 *   transcript lines -> PigeonEvent -> Action -> Attempt -> Window -> Verdict
 *
 * Everything above `Window` is deterministic and computed locally. Only the
 * genuinely ambiguous residue is ever escalated to Jev, and even then only
 * derived signals travel, never source code.
 */

/** Outcome of a single verification run (a build, a test run, a launch, a logcat read). */
export type Outcome = 'pass' | 'fail' | 'error' | 'unknown';

/** What kind of evidence a verification produced. */
export type VerificationKind =
  | 'gradle_build'
  | 'gradle_unit_test'
  | 'gradle_instrumentation_test'
  | 'app_launch'
  | 'logcat'
  | 'adb_other'
  | 'unknown';

/**
 * A normalized crash signature. Deliberately excludes memory addresses, thread
 * ids, timestamps and line-level churn so that "the same crash" hashes the same
 * across attempts even when the surrounding code moved.
 */
export interface CrashSignature {
  /** e.g. `java.lang.IllegalStateException` */
  exception: string;
  /** First app-owned stack frame, normalized: `com.example.ui.CartScreen.render` */
  topFrame: string | null;
  /** Short normalized message, digits and hex replaced. */
  message: string | null;
  /** Stable hash of the above. */
  hash: string;
}

/** One verification event with the Android evidence extracted from its output. */
export interface Verification {
  kind: VerificationKind;
  outcome: Outcome;
  /** Command that produced this evidence, normalized (paths and flags stripped of noise). */
  command: string | null;
  /** Wall-clock duration if the transcript reported one. */
  durationMs: number | null;

  /** Normalized failing test identifiers, sorted. */
  failingTests: string[];
  /** Number of failing tests, when the tool output stated it. */
  testFailCount: number | null;
  /** Total tests executed, when stated. */
  testTotal: number | null;

  /** Normalized compile error signatures (`file:line: message`), sorted and capped. */
  compileErrors: string[];

  /** Runtime crash, if the output contained one. */
  crash: CrashSignature | null;

  /** Reached runtime state, e.g. `com.example/.MainActivity`. */
  runtimeState: string | null;

  /**
   * Hash over everything that must change for us to believe the app got better.
   * Two attempts with the same fingerprint produced the same observable result.
   */
  fingerprint: string;

  /**
   * Individually addressable evidence atoms (one failing test, one crash hash,
   * one compile error...). Used to compute whether an attempt learned anything
   * that earlier attempts had not already shown.
   */
  evidenceKeys: string[];

  /** Small local-only excerpt for the human report. Never sent anywhere. */
  excerpt: string | null;
}

/** How an action relates to making progress. */
export type ActionClass = 'edit' | 'inspect' | 'verify' | 'other';

/** A tool call paired with its result. */
export interface Action {
  seq: number;
  ts: number;
  toolUseId: string | null;
  tool: string;
  klass: ActionClass;

  /** Repo-relative path for edit actions. */
  path: string | null;
  /** Hash of the actual change, so "same edit twice" is detectable. */
  patchHash: string | null;
  /** Rough size of the change, in changed lines. */
  changedLines: number;

  /** Raw-ish command for bash actions, normalized. */
  command: string | null;

  /** Present when klass === 'verify'. */
  verification: Verification | null;

  /** True when the tool itself reported failure/interruption. */
  interrupted: boolean;
}

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
}

export function emptyTokens(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
}

export function addTokens(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreate: a.cacheCreate + b.cacheCreate,
  };
}

/** A normalized transcript record. */
export interface PigeonEvent {
  seq: number;
  ts: number;
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  kind: 'user_prompt' | 'assistant' | 'tool_call' | 'tool_result' | 'api_error' | 'meta';

  toolUseId: string | null;
  toolName: string | null;
  toolInput: Record<string, unknown> | null;
  /** Raw tool result payload, shape varies by tool. */
  toolResult: unknown;

  /** Assistant prose / thinking. Stays local; used only for strategy-claim detection. */
  text: string | null;
  tokens: TokenUsage | null;
}

/**
 * One attempt: the edits the agent made, followed by the verification(s) that
 * revealed whether those edits helped. Progress is only observable at
 * verification points, which is why attempts are cut this way rather than per
 * tool call or per turn.
 */
export interface Attempt {
  index: number;
  startTs: number;
  endTs: number;

  actions: Action[];
  editedFiles: string[];
  patchHashes: string[];
  changedLines: number;

  /** All verifications in this attempt's verification cluster. */
  verifications: Verification[];
  /** The verification that best represents this attempt's result. */
  terminal: Verification | null;

  tokens: TokenUsage;

  /** The agent claimed a materially different approach in prose. */
  declaredStrategyChange: boolean;
}

export type Trend = 'improving' | 'flat' | 'worsening' | 'insufficient';

/** Deterministic signals over a window of attempts. Never asked of Jev. */
export interface WindowSignals {
  attemptCount: number;
  verifiedAttemptCount: number;

  firstTs: number;
  lastTs: number;
  /** Wall clock with idle gaps (> idleGapMs) removed. */
  activeMs: number;
  idleMs: number;

  /** Terminal outcome fingerprints, oldest first. */
  fingerprints: string[];
  /** Length of the trailing run of identical fingerprints. */
  identicalOutcomeRun: number;
  distinctOutcomes: number;

  outcomes: Outcome[];
  allFailing: boolean;
  latestOutcome: Outcome | null;

  /** Failing-test counts oldest first, nulls where unknown. */
  testFailSeries: (number | null)[];
  testTrend: Trend;

  /** Trailing run length of the identical crash hash. */
  crashRepeatRun: number;
  crashHashes: (string | null)[];

  /** 0..1. How different the *edits* were across the window. */
  editNovelty: number;
  /** 0..1. Fraction of distinct patch hashes. */
  patchNovelty: number;

  /**
   * 0..1. Fraction of the latest attempt's evidence atoms that no earlier
   * attempt in the window had already produced. This is the deterministic
   * proxy for "did we learn anything".
   */
  newEvidenceRatio: number;
  /** Evidence atoms that appeared for the first time in the latest attempt. */
  newEvidenceKeys: string[];

  /** Outcomes flipped between pass and fail on an unchanged test set. */
  looksFlaky: boolean;

  tokens: TokenUsage;
  declaredStrategyChanges: number;
}

export type VerdictLabel =
  | 'PROGRESSING'
  | 'NO_PROGRESS'
  | 'UNCERTAIN'
  | 'INSUFFICIENT_EVIDENCE';

export type VerdictReason =
  | 'test_failures_decreasing'
  | 'new_evidence_gained'
  | 'latest_attempt_passed'
  | 'recovered_after_regression'
  | 'flaky_outcomes'
  | 'too_few_verified_attempts'
  | 'no_verification_at_all'
  | 'dead_end_exploration'
  | 'repetition_loop'
  | 'identical_crash_across_distinct_patches'
  | 'borderline_stall';

export interface Verdict {
  label: VerdictLabel;
  reason: VerdictReason;
  /** Local heuristic confidence, 0..1. Not a calibrated probability. */
  confidence: number;
  /** Human-readable evidence lines. This is the product. */
  evidence: string[];
  /** Set when a Jev evaluation contributed. */
  jev?: JevAxes | null;
}

/** Independent probabilistic axes, each a Jev Noul in 0..1. */
export interface JevAxes {
  progress: number;
  evidence_gain: number;
  human_needed: number;
  model: string | null;
  latencyMs: number | null;
}

/** A contiguous stretch of attempts that was judged as a unit. */
export interface AnalyzedWindow {
  sessionId: string;
  cwd: string | null;
  /** Attempt indices covered, inclusive. */
  from: number;
  to: number;
  signals: WindowSignals;
  verdict: Verdict;
  attempts: Attempt[];
}

export interface SessionAnalysis {
  sessionId: string;
  file: string;
  cwd: string | null;
  gitBranch: string | null;
  startTs: number;
  endTs: number;
  eventCount: number;
  malformedLines: number;
  actions: Action[];
  attempts: Attempt[];
  windows: AnalyzedWindow[];
  tokens: TokenUsage;
  /** True when the session contained any Android-flavoured evidence. */
  androidEvidence: boolean;
  parseWarnings: string[];
}
