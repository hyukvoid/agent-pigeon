/**
 * Agent Pigeon — `flight` report (v0.1 MVP).
 *
 * Turns ONE coding-agent session into a compact, factual flight report:
 * activity bars, most-touched file, the debugging loop shape, the longest
 * unverified implementation streak, and the final recognized-verification
 * state.
 *
 * Everything is reconstructed from the same sanitized, fingerprint-free
 * events replay uses. Read-only; no network; no persistent state. Paths are
 * display-safe (repo-relative or last segments — never a home directory).
 */

import type { SessionAnalysis } from './replay/corpus.js';
import type { ReplayAttempt } from './replay/types.js';

export interface FlightArgs {
  json: boolean;
  session?: string;
  claudeDir?: string;
  codexDir?: string;
}

export function parseFlightArgs(argv: string[]): FlightArgs {
  const args: FlightArgs = { json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--session') {
      args.session = argv[i + 1];
      i++;
    } else if (a === '--claude-dir') {
      args.claudeDir = argv[i + 1] ?? '';
      i++;
    } else if (a === '--codex-dir') {
      args.codexDir = argv[i + 1] ?? '';
      i++;
    } else throw new Error(`unknown option: ${a ?? '(empty)'}`);
  }
  return args;
}

const IMPLEMENTATION_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

interface VerificationOutcome {
  performed: boolean;
  ok: boolean | null;
}

function verificationOutcome(attempt: ReplayAttempt): VerificationOutcome {
  if (!attempt.evidence.verification.performed) return { performed: false, ok: null };
  if (attempt.evidence.build.status === 'pass') return { performed: true, ok: true };
  if (attempt.evidence.build.status === 'fail') return { performed: true, ok: false };
  if (attempt.evidence.tests.failedCount !== null) {
    return { performed: true, ok: attempt.evidence.tests.failedCount === 0 };
  }
  return { performed: true, ok: null };
}

/** Last debugging loop: FAILs followed by a PASS (needs ≥1 FAIL). */
export function biggestDebuggingLoop(attempts: ReplayAttempt[]): boolean[] | null {
  let best: boolean[] | null = null;
  let run: boolean[] = [];
  for (const attempt of attempts) {
    const outcome = verificationOutcome(attempt);
    if (!outcome.performed) {
      run = [];
      continue;
    }
    if (outcome.ok === null) continue;
    run.push(outcome.ok);
    if (run.length >= 2 && run[run.length - 1] === true && run.slice(0, -1).includes(false)) {
      best = [...run];
    }
  }
  return best;
}

/** Longest streak of consecutive attempts without performed verification. */
export function longestUnverifiedStreak(attempts: ReplayAttempt[]): { changes: number; attempts: number } | null {
  let best: { changes: number; attempts: number } | null = null;
  let changes = 0;
  let count = 0;
  for (const attempt of attempts) {
    if (!attempt.evidence.verification.performed) {
      count++;
      changes += attempt.implementationEvents;
      if (best === null || changes > best.changes) best = { changes, attempts: count };
    } else {
      changes = 0;
      count = 0;
    }
  }
  return best;
}

export type FinalState = 'recognized verification found' | 'last recognized verification failed' | 'no recognized verification';

export function finalVerificationState(attempts: ReplayAttempt[]): FinalState {
  for (let i = attempts.length - 1; i >= 0; i--) {
    const attempt = attempts[i];
    if (attempt === undefined || !attempt.evidence.verification.performed) continue;
    const outcome = verificationOutcome(attempt);
    if (outcome.ok === true) return 'recognized verification found';
    if (outcome.ok === false) return 'last recognized verification failed';
    return 'no recognized verification';
  }
  return 'no recognized verification';
}

export interface MostTouched {
  path: string;
  touches: number;
}

export function mostTouchedFile(session: SessionAnalysis): MostTouched | null {
  const touches = new Map<string, number>();
  for (const e of session.events) {
    const isImpl = e.eventType === 'implementation';
    const isRead = e.eventType === 'observation' && e.toolName === 'Read';
    if (!isImpl && !isRead) continue;
    const key = e.path ?? '';
    if (key.length === 0) continue;
    touches.set(key, (touches.get(key) ?? 0) + 1);
  }
  let best: MostTouched | null = null;
  for (const [path, count] of touches) {
    if (best === null || count > best.touches) best = { path, touches: count };
  }
  return best;
}

export interface FlightFacts {
  sourceLabel: string;
  sessionId8: string;
  duration: string;
  reads: number;
  edits: number;
  recognizedVerificationRuns: number;
  debuggingLoop: boolean[] | null;
  longestUnverifiedStreak: { changes: number; attempts: number } | null;
  mostTouched: MostTouched | null;
  finalState: FinalState;
}

function durationOf(session: SessionAnalysis): number | null {
  const offsets = session.events.map((e) => e.timestampOffset).filter((o): o is number => o !== null);
  if (offsets.length === 0) return null;
  return Math.max(...offsets) - Math.min(...offsets);
}

function durationLabel(ms: number | null): string {
  if (ms === null || ms <= 0) return 'n/a';
  const minutes = ms / 60_000;
  if (minutes < 1) return `${Math.round(ms / 1000)} s`;
  if (minutes < 90) return `${Math.round(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ${Math.round(minutes - hours * 60)} min`;
}

export function flightFacts(session: SessionAnalysis): FlightFacts {
  const attempts = session.attempts;
  const reads = session.events.filter((e) => e.eventType === 'observation' && e.toolName === 'Read').length;
  return {
    sourceLabel: session.source === 'codex' ? 'Codex' : 'Claude Code',
    sessionId8: session.sessionId8,
    duration: durationLabel(durationOf(session)),
    reads,
    edits: session.implementationCalls,
    recognizedVerificationRuns: session.verificationRuns,
    debuggingLoop: biggestDebuggingLoop(attempts),
    longestUnverifiedStreak: longestUnverifiedStreak(attempts),
    mostTouched: mostTouchedFile(session),
    finalState: finalVerificationState(attempts),
  };
}

/** Sessions with real implementation activity, newest wall-clock session
 * first. Falls back to relative offsets only for turn-unaware sources. */
export function codingSessions(sessions: SessionAnalysis[]): SessionAnalysis[] {
  const aware = sessions.some((s) => s.lastEventMs !== null);
  const key = (s: SessionAnalysis): number =>
    aware && s.lastEventMs !== null ? s.lastEventMs : lastEventOffset(s);
  return sessions
    .filter((s) => s.implementationCalls > 0)
    .sort((a, b) => key(b) - key(a));
}

function lastEventOffset(s: SessionAnalysis): number {
  let max = 0;
  for (const e of s.events) {
    if (e.timestampOffset !== null && e.timestampOffset !== undefined) max = Math.max(max, e.timestampOffset);
  }
  return max;
}

function bar(label: string, value: number, max: number): string {
  const width = 18;
  const filled = value === 0 ? '' : '█'.repeat(Math.max(1, Math.round((value / max) * width)));
  return `  ${label.padEnd(10, ' ')}${filled.padEnd(width, ' ')}  ${value}`;
}

export function renderFlight(facts: FlightFacts): string {
  const lines: string[] = [];
  lines.push(`🐦 Agent Pigeon — ${facts.sourceLabel}`);
  lines.push(`  ${facts.duration} · 1 session`);
  lines.push('');
  const max = Math.max(facts.reads, facts.edits, facts.recognizedVerificationRuns, 1);
  lines.push(bar('READ', facts.reads, max));
  lines.push(bar('EDIT', facts.edits, max));
  lines.push(bar('VERIFY', facts.recognizedVerificationRuns, max));
  if (facts.debuggingLoop !== null) {
    lines.push(bar('FAIL→PASS', facts.debuggingLoop.length, max));
  }
  lines.push('');
  if (facts.mostTouched !== null) {
    lines.push('🔥 Most touched file');
    lines.push(`   ${facts.mostTouched.path} · ${facts.mostTouched.touches} touches`);
    lines.push('');
  }
  if (facts.debuggingLoop !== null && facts.debuggingLoop.length >= 2) {
    lines.push('🔁 Biggest debugging loop');
    const shape = facts.debuggingLoop.map((ok) => (ok ? 'PASS' : 'FAIL')).join(' → edit → ');
    lines.push(`   ${shape}`);
    lines.push('');
  }
  if (facts.longestUnverifiedStreak !== null && facts.longestUnverifiedStreak.changes >= 3) {
    lines.push('⏱ Longest coding streak');
    lines.push(`   ${facts.longestUnverifiedStreak.changes} implementation changes`);
    lines.push('   without recognized verification');
    lines.push('');
  }
  lines.push('Final state');
  const mark = facts.finalState === 'recognized verification found' ? '✓' : facts.finalState === 'last recognized verification failed' ? '✗' : '·';
  lines.push(`   ${mark} ${facts.finalState}`);
  lines.push('');
  lines.push('Local · Read-only · Nothing uploaded');
  return lines.join('\n');
}
