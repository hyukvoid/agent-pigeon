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

function sha8(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

export function segmentIntoAttempts(events: SanitizedReplayEvent[]): ReplayAttempt[] {
  const attempts: ReplayAttempt[] = [];

  interface Window {
    implementationEvents: number;
    changedFilePathHashes: Set<string>;
    verification: Array<{
      kind: SanitizedReplayEvent['verificationKind'];
      ok: boolean | null;
      failureSignatureHash: string | null;
      testsFailedCount: number | null;
    }>;
    timestampOffset: number | null;
  }

  const open: Window = {
    implementationEvents: 0,
    changedFilePathHashes: new Set<string>(),
    verification: [],
    timestampOffset: null,
  };

  const flush = (): void => {
    if (open.implementationEvents === 0) return; // no implementation => not an attempt

    const lastTest = [...open.verification].reverse().find((v) => v.kind === 'test');
    const lastBuild = [...open.verification].reverse().find((v) => v.kind === 'build');
    const failedVerification = open.verification.find((v) => v.ok === false);
    const paths = [...open.changedFilePathHashes].sort();

    attempts.push({
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
        tests: { failedCount: lastTest ? lastTest.testsFailedCount : null },
        runtime: { crashSignature: null, screenSignature: null },
        verification: { performed: open.verification.length > 0 },
        code: {
          changedFilesCount: paths.length,
          changeSetHash: paths.length > 0 ? sha8(paths.join('\n')) : null,
        },
      },
      failureSignatureHash: failedVerification?.failureSignatureHash ?? null,
      verificationKinds: open.verification
        .map((v) => v.kind)
        .filter((kind): kind is NonNullable<typeof kind> => kind !== null),
      implementationEvents: open.implementationEvents,
      timestampOffset: open.timestampOffset,
    });

    open.implementationEvents = 0;
    open.changedFilePathHashes.clear();
    open.verification = [];
    open.timestampOffset = null;
  };

  for (const event of events) {
    if (event.eventType === 'implementation') {
      if (open.verification.length > 0) flush(); // previous attempt is complete
      open.implementationEvents++;
      if (event.changeSetHash !== null) open.changedFilePathHashes.add(event.changeSetHash);
      if (open.timestampOffset === null) open.timestampOffset = event.timestampOffset;
    } else if (event.eventType === 'verification') {
      open.verification.push({
        kind: event.verificationKind,
        ok: event.ok,
        failureSignatureHash: event.failureSignatureHash,
        testsFailedCount: event.testsFailedCount,
      });
    }
    // observation/other events are context only — they neither start nor end attempts
  }
  flush(); // trailing implementations without verification => verification debt

  return attempts;
}
