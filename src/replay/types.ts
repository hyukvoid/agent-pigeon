/**
 * POC-02 sanitized replay event model.
 *
 * Privacy contract (spec §3): raw session transcripts are read but never
 * persisted. Everything that leaves the parser is a sanitized derivative:
 * tool names, numeric counts, booleans, millisecond offsets and short hashes.
 * No commands, no paths, no output text, no prompts. Path identity and error
 * identity survive only as sha256-8 hashes so "same as before" stays
 * detectable without storing the underlying strings.
 */

/** Implementation tools that change code. */
export const IMPLEMENTATION_TOOLS: readonly string[] = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

export type VerificationKind = 'test' | 'build' | 'device';

export interface SanitizedReplayEvent {
  eventType: 'implementation' | 'verification' | 'observation' | 'other';
  /** ms from first session event; null when the line had no timestamp. */
  timestampOffset: number | null;
  toolName: string;
  /** tool_result outcome; null when no result was observed (interrupted). */
  ok: boolean | null;
  /** For verification events: what kind of verification ran. */
  verificationKind: VerificationKind | null;
  /** Implementation events: number of distinct files touched by this call. */
  changedFilesCount: number | null;
  /**
   * Novelty identity for this change: sha256-8 of the NORMALIZED CHANGE
   * CONTENT when available (POC-03.5), falling back to the path-list hash.
   * Never the raw content.
   */
  changeSetHash: string | null;
  /** What the changeSetHash was derived from. */
  fingerprintBasis: 'content' | 'path' | null;
  /** sha256-8 of the normalized failure text; present only when a verification failed. */
  failureSignatureHash: string | null;
  /** Extracted failed-test count; null when unknown. Numbers only — never text. */
  testsFailedCount: number | null;
  durationMs: number | null;
  /**
   * Model-turn ordinal within the session (POC-04C.2): consecutive
   * implementation events in the SAME turn are one logical change, not N
   * attempts. Deterministic — message boundary (Claude) or turn boundary
   * (Codex) — never a time threshold. Null when the source has no turn
   * boundaries.
   */
  turn?: number | null;
  /** Implementation events that only touch test/spec files (verification preparation). */
  testOnly?: boolean | null;
  /**
   * Display-safe path used by report features (flight): repo-relative or the
   * last path segments — never an absolute home-directory path. Null for
   * non-file events.
   */
  path?: string | null;
}

export interface ReplayAttempt {
  index: number;
  /** AttemptEvidence for the POC-00 pipeline. */
  evidence: import('../core/types.js').AttemptEvidence;
  /** sha256-8 of the failure observed by this attempt's verification (null = none/unknown). */
  failureSignatureHash: string | null;
  verificationKinds: VerificationKind[];
  /** Implementation calls inside this attempt window. */
  implementationEvents: number;
  /** Breakdown by tool family (POC-04C.2 scaffolding carve-out). */
  implWrites: number;
  implEdits: number;
  /**
   * Distinct non-test-only model turns that produced this attempt's changes
   * (POC-04C.2). Empty when the source has no turn boundaries.
   */
  implTurns: number[];
  timestampOffset: number | null;
}
