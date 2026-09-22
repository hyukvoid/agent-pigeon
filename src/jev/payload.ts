/**
 * Normalized Jev payload construction.
 *
 * Privacy rules (POC-00 §13): the payload contains only normalized
 * signatures, counts and booleans. No source code, no API keys, no absolute
 * paths, no raw environment. Every free-text field is sanitized and
 * length-capped, and `payloadSafetyIssues` lets the CLI/tests verify that.
 */

import type { AttemptEvidence } from '../core/types.js';
import type { SeriesSignals } from '../core/signals.js';
import type { JevPayload, NormalizedAttemptView } from './types.js';
import { JEV_QUESTIONS } from './types.js';

const MAX_SIGNATURE_LENGTH = 120;
const MAX_ATTEMPT_ID_LENGTH = 40;

export function sanitizeSignature(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > MAX_SIGNATURE_LENGTH
    ? cleaned.slice(0, MAX_SIGNATURE_LENGTH)
    : cleaned;
}

export function sanitizeAttemptId(raw: string): string {
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return cleaned.length > MAX_ATTEMPT_ID_LENGTH ? cleaned.slice(0, MAX_ATTEMPT_ID_LENGTH) : cleaned;
}

export function toNormalizedView(attempt: AttemptEvidence): NormalizedAttemptView {
  return {
    attemptId: sanitizeAttemptId(attempt.attemptId),
    build: attempt.build.status,
    testsFailed: attempt.tests.failedCount,
    crashSignature:
      attempt.runtime.crashSignature === null
        ? null
        : sanitizeSignature(attempt.runtime.crashSignature),
    screenSignature:
      attempt.runtime.screenSignature === null
        ? null
        : sanitizeSignature(attempt.runtime.screenSignature),
    codeChanged: (attempt.code.changedFilesCount ?? 0) > 0 || attempt.code.changeSetHash !== null,
    changedFilesCount: attempt.code.changedFilesCount,
  };
}

export function buildJevPayload(
  previous: AttemptEvidence,
  current: AttemptEvidence,
  signals: SeriesSignals,
): JevPayload {
  const latestPair = signals.pairs[signals.pairs.length - 1];
  return {
    schema: 'agent-pigeon/jev-comparison@0',
    previous: toNormalizedView(previous),
    current: toNormalizedView(current),
    signals: {
      buildChanged: latestPair?.buildChanged ?? null,
      failedTestsDelta: latestPair?.failedTestsDelta ?? null,
      crashChanged: latestPair?.crashChanged ?? null,
      screenChanged: latestPair?.screenChanged ?? null,
      codeNovelty: latestPair?.codeNovelty ?? null,
      sameCrashStreak: signals.sameCrashStreak,
      sameScreenStreak: signals.sameScreenStreak,
      verificationDebt: signals.verificationDebt,
    },
    questions: JEV_QUESTIONS,
  };
}

const ABSOLUTE_PATH_PATTERNS: readonly RegExp[] = [
  /[A-Za-z]:\\/u,          // Windows drive paths (C:\...)
  /(?:^|[\s"'=])\/(?:home|Users|root|tmp|var|mnt)\//u, // POSIX absolute paths
  /(?:^|\/)Users\//u,
];

const SECRET_FIELD_PATTERNS: readonly RegExp[] = [
  /api[_-]?key/iu,
  /authorization/iu,
  /bearer\s/iu,
  /password/iu,
  /secret/iu,
  /token/iu,
];

/** Returns a list of privacy problems found in the serialized payload (empty = safe). */
export function payloadSafetyIssues(payload: JevPayload): string[] {
  const issues: string[] = [];
  const serialized = JSON.stringify(payload);

  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    if (pattern.test(serialized)) {
      issues.push(`payload contains an absolute-path-looking string matching ${pattern}`);
    }
  }
  for (const pattern of SECRET_FIELD_PATTERNS) {
    if (pattern.test(serialized)) {
      issues.push(`payload contains a secret-looking field matching ${pattern}`);
    }
  }

  const longFields: string[] = [
    payload.previous.attemptId,
    payload.current.attemptId,
    payload.previous.crashSignature ?? '',
    payload.previous.screenSignature ?? '',
    payload.current.crashSignature ?? '',
    payload.current.screenSignature ?? '',
  ];
  const oversized = longFields.filter((field) => field.length > MAX_SIGNATURE_LENGTH);
  if (oversized.length > 0) {
    issues.push('payload contains an unsanitized over-length free-text field');
  }

  return issues;
}
