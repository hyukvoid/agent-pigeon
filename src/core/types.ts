/**
 * POC-00 evidence schema.
 *
 * One AttemptEvidence is what we know about a single coding-agent attempt
 * after its code change was built, run and observed. Fields are nullable on
 * purpose: a missing verification is itself a signal (verification debt), not
 * a data error.
 *
 * The schema measures CHANGE between attempts. It never carries source code,
 * paths, or environment details.
 */

export type BuildStatus = 'pass' | 'fail' | 'unknown';

export interface AttemptEvidence {
  attemptId: string;
  build: {
    status: BuildStatus | null;
  };
  tests: {
    failedCount: number | null;
  };
  runtime: {
    /** Normalized crash identity, e.g. `NullPointerException:LoginViewModel#onSubmit`. */
    crashSignature: string | null;
    /** Normalized screen identity observed after the attempt, e.g. `Login`. */
    screenSignature: string | null;
  };
  verification: {
    /** True only when runtime evidence (app run / snapshot / logs) was actually collected. */
    performed: boolean;
  };
  code: {
    changedFilesCount: number | null;
    /**
     * Stable hash of the sorted changed-file path list. Distinguishes "a
     * different patch" from "the same patch" without shipping file contents.
     */
    changeSetHash: string | null;
  };
}

const BUILD_STATUSES: readonly BuildStatus[] = ['pass', 'fail', 'unknown'];

function isBuildStatus(value: unknown): value is BuildStatus {
  return typeof value === 'string' && (BUILD_STATUSES as readonly string[]).includes(value);
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function isNullableCount(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0);
}

export type ValidationOutcome =
  | { ok: true; value: AttemptEvidence }
  | { ok: false; errors: string[] };

/**
 * Hand-rolled structural validator (POC keeps zero runtime dependencies).
 * Rejects wrong types; nulls are always legal.
 */
export function validateAttemptEvidence(raw: unknown): ValidationOutcome {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['evidence must be an object'] };
  }
  const e = raw as Record<string, unknown>;

  if (typeof e.attemptId !== 'string' || e.attemptId.length === 0) {
    errors.push('attemptId must be a non-empty string');
  }

  if (typeof e.build !== 'object' || e.build === null) {
    errors.push('build must be an object');
  } else {
    const status = (e.build as Record<string, unknown>).status;
    if (status !== undefined && status !== null && !isBuildStatus(status)) {
      errors.push('build.status must be "pass" | "fail" | "unknown" | null');
    }
  }

  if (typeof e.tests !== 'object' || e.tests === null) {
    errors.push('tests must be an object');
  } else {
    const failedCount = (e.tests as Record<string, unknown>).failedCount;
    if (failedCount !== undefined && !isNullableCount(failedCount)) {
      errors.push('tests.failedCount must be a non-negative integer or null');
    }
  }

  if (typeof e.runtime !== 'object' || e.runtime === null) {
    errors.push('runtime must be an object');
  } else {
    const runtime = e.runtime as Record<string, unknown>;
    if (!isNullableString(runtime.crashSignature)) {
      errors.push('runtime.crashSignature must be a string or null');
    }
    if (!isNullableString(runtime.screenSignature)) {
      errors.push('runtime.screenSignature must be a string or null');
    }
  }

  if (typeof e.verification !== 'object' || e.verification === null) {
    errors.push('verification must be an object');
  } else {
    const performed = (e.verification as Record<string, unknown>).performed;
    if (typeof performed !== 'boolean') {
      errors.push('verification.performed must be a boolean');
    }
  }

  if (typeof e.code !== 'object' || e.code === null) {
    errors.push('code must be an object');
  } else {
    const code = e.code as Record<string, unknown>;
    if (code.changedFilesCount !== undefined && !isNullableCount(code.changedFilesCount)) {
      errors.push('code.changedFilesCount must be a non-negative integer or null');
    }
    if (!isNullableString(code.changeSetHash)) {
      errors.push('code.changeSetHash must be a string or null');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as AttemptEvidence };
}
