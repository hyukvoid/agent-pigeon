/**
 * Attempt segmentation (spec §5): implementation changes followed by
 * verification run(s) form one attempt; implementation changes with no
 * following verification become a verification-debt attempt. Tool calls are
 * never treated as attempts by themselves.
 *
 * Window boundary rule: an attempt window closes when a NEW implementation
 * event begins (so build→test sequences attach to the same attempt) or at
 * session end. Verifications that occur before any implementation are
 * pre-attempt context and are discarded.
 */

import { createHash } from 'node:crypto';
import type { ReplayAttempt, SanitizedReplayEvent } from './types.js';

/** Window changeSetHash = sha256-128 of the sorted member fingerprints. */
function hashOfFingerprints(sortedFingerprints: string[]): string {
  return createHash('sha256').update(sortedFingerprints.join('\n'), 'utf8').digest('hex').slice(0, 32);
}

export interface AttemptWindow {
  implementationEvents: number;
  verifications: SanitizedReplayEvent[];
  timestampOffset: number | null;
  changeSetHash: string | null;
}

export interface Segmentation {
  attempts: ReplayAttempt[];
  windows: AttemptWindow[];
}

export function segmentWithWindows(events: SanitizedReplayEvent[]): Segmentation {
  const attempts: ReplayAttempt[] = [];
  const windows: AttemptWindow[] = [];

  interface OpenWindow {
    implementationEvents: number;
    implWrites: number;
    implEdits: number;
    changedFilePathHashes: Set<string>;
    implTurns: Set<number>;
    verification: SanitizedReplayEvent[];
    timestampOffset: number | null;
  }

  const open: OpenWindow = {
    implementationEvents: 0,
    implWrites: 0,
    implEdits: 0,
    changedFilePathHashes: new Set<string>(),
    implTurns: new Set<number>(),
    verification: [],
    timestampOffset: null,
  };

  const flush = (): void => {
    if (open.implementationEvents === 0) {
      // Pre-attempt verification (a failing test before any edit): context
      // only — discard so it never attaches to a later attempt.
      open.verification = [];
      return;
    }

    const lastTest = [...open.verification].reverse().find((v) => v.verificationKind === 'test');
    const lastBuild = [...open.verification].reverse().find((v) => v.verificationKind === 'build');
    const failedVerification = open.verification.find((v) => v.ok === false);
    const paths = [...open.changedFilePathHashes].sort();
    const changeSetHash = paths.length > 0 ? hashOfFingerprints(paths) : null;

    // A passing test run means zero failing tests, even when the runner did
    // not print a count (same inference as the POC-02 transcript parser).
    const testsFailedCount =
      lastTest !== undefined && lastTest.ok === true && lastTest.testsFailedCount === null
        ? 0
        : (lastTest?.testsFailedCount ?? null);

    const attempt: ReplayAttempt = {
      index: attempts.length,
      evidence: {
        attemptId: `attempt-${attempts.length + 1}`,
        build: {
          status: lastBuild
            ? lastBuild.ok === true
              ? 'pass'
              : lastBuild.ok === false
                ? 'fail'
                : 'unknown'
            : null,
        },
        tests: { failedCount: testsFailedCount },
        runtime: { crashSignature: null, screenSignature: null },
        verification: { performed: open.verification.length > 0 },
        code: {
          changedFilesCount: paths.length,
          changeSetHash,
        },
      },
      failureSignatureHash: failedVerification?.failureSignatureHash ?? null,
      verificationKinds: open.verification
        .map((v) => v.verificationKind)
        .filter((kind): kind is NonNullable<typeof kind> => kind !== null),
      implementationEvents: open.implementationEvents,
      implWrites: open.implWrites,
      implEdits: open.implEdits,
      implTurns: [...open.implTurns],
      timestampOffset: open.timestampOffset,
    };
    attempts.push(attempt);
    windows.push({
      implementationEvents: open.implementationEvents,
      verifications: [...open.verification],
      timestampOffset: open.timestampOffset,
      changeSetHash,
    });

    open.implementationEvents = 0;
    open.implWrites = 0;
    open.implEdits = 0;
    open.changedFilePathHashes.clear();
    open.implTurns.clear();
    open.verification = [];
    open.timestampOffset = null;
  };

  for (const event of events) {
    if (event.eventType === 'implementation') {
      if (open.verification.length > 0) flush(); // previous attempt is complete
      open.implementationEvents++;
      if (event.toolName === 'Write') open.implWrites++;
      else open.implEdits++;
      if (event.changeSetHash !== null) open.changedFilePathHashes.add(event.changeSetHash);
      if (event.turn !== null && event.turn !== undefined && event.testOnly !== true) {
        open.implTurns.add(event.turn);
      }
      if (open.timestampOffset === null) open.timestampOffset = event.timestampOffset;
    } else if (event.eventType === 'verification') {
      open.verification.push(event);
    }
    // observation/other events are context only — they neither start nor end attempts
  }
  flush(); // trailing implementations without verification => verification debt

  return { attempts, windows };
}

export function segmentIntoAttempts(events: SanitizedReplayEvent[]): ReplayAttempt[] {
  return segmentWithWindows(events).attempts;
}
