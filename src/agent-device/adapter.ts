/**
 * AgentDeviceAdapter (POC-01 §5 boundary).
 *
 *   agent-device  ->  AgentDeviceAdapter  ->  AttemptEvidence  ->  POC-00 evaluator
 *
 * The core evaluator never learns agent-device exists; this module is the
 * only place that speaks its CLI output dialect. Pure functions — capture
 * (process invocation) lives in capture.ts.
 */

import type { AttemptEvidence, BuildStatus } from '../core/types.js';
import { readLogs, readSnapshot } from './parse.js';

export interface AgentDeviceCapture {
  attemptId: string;
  /** Raw `agent-device snapshot -i` stdout (null = not captured). */
  snapshotText: string | null;
  /** Raw log text for this attempt's window (agent-device logs, or a stand-in excerpt). */
  logsText: string | null;
  buildStatus?: BuildStatus | null;
  testsFailedCount?: number | null;
  code?: {
    changedFilesCount: number | null;
    changeSetHash: string | null;
  };
}

export function normalizeAgentDeviceEvidence(capture: AgentDeviceCapture): AttemptEvidence {
  const snapshot = capture.snapshotText === null
    ? { page: null, contentSignature: null }
    : readSnapshot(capture.snapshotText);
  const logs = readLogs(capture.logsText ?? '');

  // Compose the screen identity: content hash when node data exists (real
  // captures), bare page/window name for legacy recordings and acks.
  const screenSignature = snapshot.contentSignature
    ? `${snapshot.page ?? 'screen'}#${snapshot.contentSignature}`
    : snapshot.page;

  return {
    attemptId: capture.attemptId,
    build: { status: capture.buildStatus ?? null },
    tests: { failedCount: capture.testsFailedCount ?? null },
    runtime: {
      crashSignature: logs.crashSignature,
      screenSignature,
    },
    verification: { performed: capture.snapshotText !== null },
    code: {
      changedFilesCount: capture.code?.changedFilesCount ?? null,
      changeSetHash: capture.code?.changeSetHash ?? null,
    },
  };
}
