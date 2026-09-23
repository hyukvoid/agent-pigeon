#!/usr/bin/env node
/**
 * POC-03 worker — one-shot offline processor (NOT a daemon).
 *
 *   npm run poc:03 [-- --events <path>] [-- --json]
 *
 * Reads the JSONL event stream the hook appended, reconstructs the attempt
 * timeline with the POC-02 segmenter, and runs the unchanged POC-00
 * evaluator. All heavy work happens here, off the agent's hot path.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { evaluateScenario } from '../../src/core/evaluate.js';
import { segmentWithWindows } from '../../src/replay/segment.js';
import { analyzeAttempts } from '../../src/replay/analyze.js';
import type { ReplayAttempt, SanitizedReplayEvent } from '../../src/replay/types.js';

interface HookEvent {
  ts: string;
  sessionId: string | null;
  toolName: string;
  ok: boolean | null;
  fileHash: string | null;
  changeFingerprint?: string | null;
  fingerprintBasis?: 'content' | 'path' | null;
  verificationKind: string | null;
  testsFailedCount?: number | null;
  /** Batch/turn ordinal (revised live design; optional). */
  turn?: number | null;
}

const IMPLEMENTATION_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function toReplayEvent(event: HookEvent, epochMs: number): SanitizedReplayEvent | null {
  const tsMs = Date.parse(event.ts);
  const offset = Number.isFinite(tsMs) ? tsMs - epochMs : null;

  if (IMPLEMENTATION_TOOLS.has(event.toolName)) {
    // Novelty = content fingerprint when the hook could derive one (POC-03.5),
    // path hash otherwise.
    const novelty = event.changeFingerprint ?? event.fileHash;
    return {
      eventType: 'implementation',
      timestampOffset: offset,
      toolName: event.toolName,
      ok: event.ok,
      verificationKind: null,
      changedFilesCount: novelty !== null ? 1 : null,
      changeSetHash: novelty,
      fingerprintBasis: event.fingerprintBasis ?? (event.fileHash !== null ? 'path' : null),
      failureSignatureHash: null,
      testsFailedCount: null,
      durationMs: null,
      turn: event.turn ?? null,
      testOnly: null,
    };
  }
  if (event.toolName === 'Bash' && event.verificationKind !== null && event.verificationKind !== 'other') {
    const ok =
      event.ok ??
      (event.testsFailedCount !== undefined && event.testsFailedCount !== null
        ? event.testsFailedCount === 0
        : null);
    return {
      eventType: 'verification',
      timestampOffset: offset,
      toolName: event.toolName,
      ok,
      verificationKind: event.verificationKind as SanitizedReplayEvent['verificationKind'],
      changedFilesCount: null,
      changeSetHash: null,
            fingerprintBasis: null,
      failureSignatureHash: null,
      testsFailedCount: event.testsFailedCount ?? null,
      durationMs: null,
    };
  }
  return {
    eventType: 'other',
    timestampOffset: offset,
    toolName: event.toolName,
    ok: event.ok,
    verificationKind: null,
    changedFilesCount: null,
    changeSetHash: null,
            fingerprintBasis: null,
    failureSignatureHash: null,
    testsFailedCount: null,
    durationMs: null,
  };
}

function describeVerification(window: { verifications: SanitizedReplayEvent[] }): string {
  if (window.verifications.length === 0) return 'NOT VERIFIED';
  return window.verifications
    .map((v) => {
      const kind = v.verificationKind ?? 'run';
      if (v.ok === false) {
        return `${kind}: FAILED${v.testsFailedCount !== null ? ` (${v.testsFailedCount} failing)` : ''}`;
      }
      if (v.ok === true) {
        return `${kind}: passed${v.testsFailedCount !== null ? ` (${v.testsFailedCount} failing)` : ''}`;
      }
      return `${kind}: unknown`;
    })
    .join(', ');
}

function renderTimeline(attempts: ReplayAttempt[], windows: ReturnType<typeof segmentWithWindows>['windows']): string {
  const lines: string[] = ['Attempt timeline', ''];
  attempts.forEach((attempt, i) => {
    const window = windows[i];
    const offsetSeconds =
      attempt.timestampOffset === null ? '?' : (attempt.timestampOffset / 1000).toFixed(1);
    const edits = attempt.implementationEvents === 1 ? '1 edit' : `${attempt.implementationEvents} edits`;
    const line = [
      `Attempt ${attempt.index + 1}`,
      `+${offsetSeconds}s`,
      edits,
      describeVerification(window ?? { verifications: [] }),
    ].join('  ');
    lines.push(line);
  });
  return lines.join('\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const eventsIndex = argv.indexOf('--events');
  const eventsPath =
    eventsIndex >= 0 && argv[eventsIndex + 1] !== undefined
      ? String(argv[eventsIndex + 1])
      : join(homedir(), '.agent-pigeon', 'events.jsonl');
  const json = argv.includes('--json');

  if (!existsSync(eventsPath)) {
    process.stdout.write(`No event stream at ${eventsPath}. Run a hooked Claude session first.\n`);
    return;
  }
  const lines = readFileSync(eventsPath, 'utf8').split(/\r?\n/u).filter((l) => l.length > 0);

  const hookEvents: HookEvent[] = [];
  for (const line of lines) {
    try {
      hookEvents.push(JSON.parse(line) as HookEvent);
    } catch {
      // ignore malformed lines; be robust
    }
  }
  if (hookEvents.length === 0) {
    process.stdout.write('Event stream is empty.\n');
    return;
  }

  const startedAt = performance.now();
  const finiteEpochs = hookEvents.map((e) => Date.parse(e.ts)).filter(Number.isFinite);
  const epochMs = finiteEpochs.length > 0 ? Math.min(...finiteEpochs) : 0;
  const replayEvents = hookEvents
    .map((event) => toReplayEvent(event, epochMs))
    .filter((event): event is SanitizedReplayEvent => event !== null);
  const { attempts, windows } = segmentWithWindows(replayEvents);
  const { signals, evaluation } = evaluateScenario(attempts.map((a) => a.evidence));
  const analysis = analyzeAttempts(attempts);
  // POC-00's debt level is attempt-streak based; a single window stacking many
  // unverified implementation calls is caught by the replay layer instead.
  // Both are deterministic. A replay debt finding escalates the policy.
  const policy =
    analysis.findings.some((f) => f.kind === 'verification-debt') ? 'VERIFY_FIRST' : evaluation.policy;
  const workerMs = performance.now() - startedAt;

  const implementationCount = replayEvents.filter((e) => e.eventType === 'implementation').length;
  const verificationCount = replayEvents.filter((e) => e.eventType === 'verification').length;
  const otherCount = replayEvents.filter((e) => e.eventType === 'other').length;

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ events: hookEvents.length, attempts, signals, evaluation, analysis, policy, workerMs }, null, 2)}\n`,
    );
    return;
  }

  process.stdout.write('Agent Pigeon — POC-03 live timeline\n\n');
  process.stdout.write(
    `Events                ${hookEvents.length} (${implementationCount} implementation, ${verificationCount} verification, ${otherCount} other)\n`,
  );
  process.stdout.write(`Attempts              ${attempts.length}\n`);
  process.stdout.write(`Session(s)            ${new Set(hookEvents.map((e) => e.sessionId)).size}\n\n`);
  if (attempts.length > 0) {
    process.stdout.write(`${renderTimeline(attempts, windows)}\n\n`);
    process.stdout.write(`Verification debt     ${signals.verificationDebt}\n`);
    process.stdout.write(`Dead-end candidate    ${evaluation.deadEndCandidate ? 'YES' : 'no'}\n`);
    for (const finding of analysis.findings) {
      process.stdout.write(
        `Finding               ${finding.kind} (attempts ${finding.attemptRange[0]}–${finding.attemptRange[1]}, ${finding.confidence}): ${finding.detail}\n`,
      );
    }
    process.stdout.write(`Policy                ${policy}\n\n`);
    process.stdout.write(`Verdict\n\n${evaluation.verdict}\n`);
  } else {
    process.stdout.write('No attempts reconstructable from the event stream (INCONCLUSIVE).\n');
  }
  process.stdout.write(`\nWorker processing time ${(workerMs * 1000).toFixed(0)} µs\n`);
}

main();
