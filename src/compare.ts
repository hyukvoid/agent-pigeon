/**
 * Agent Pigeon — `compare` (v0.1 MVP).
 *
 * Side-by-side behavioral comparison of two coding-agent sessions using the
 * same trusted metrics as flight. No winner, no score, no ranking —
 * just the numbers and what they literally say.
 */

import type { SessionAnalysis } from './replay/corpus.js';
import { codingSessions, flightFacts } from './flight.js';
import type { FlightFacts } from './flight.js';

export interface CompareRow {
  metric: string;
  a: string;
  b: string;
}

export interface CompareResult {
  a: { sessionId8: string; sourceLabel: string };
  b: { sessionId8: string; sourceLabel: string };
  rows: CompareRow[];
  summaries: string[];
}

function fmtSpan(f: FlightFacts): string {
  return f.duration;
}

function fmtCount(n: number | null): string {
  return n === null ? '—' : n.toLocaleString('en-US');
}

function fmtLoop(loop: boolean[] | null): string {
  if (loop === null || loop.length === 0) return '—';
  // run-length encode consecutive identical outcomes
  const parts: string[] = [];
  let i = 0;
  while (i < loop.length) {
    const status = loop[i] ? 'PASS' : 'FAIL';
    let count = 1;
    while (i + count < loop.length && loop[i + count] === loop[i]) count++;
    parts.push(count > 1 ? `${status} ×${count}` : status);
    i += count;
  }
  return parts.join(' → edit → ');
}

function fmtStreak(s: { changes: number; attempts: number } | null): string {
  return s === null ? '—' : `${s.changes} changes / ${s.attempts} attempts`;
}

function fmtTouches(m: { path: string; touches: number } | null): string {
  return m === null ? '—' : `${m.touches} touches`;
}

function fmtPath(m: { path: string; touches: number } | null): string {
  return m === null ? '—' : m.path;
}

export function buildCompare(a: FlightFacts, b: FlightFacts): CompareResult {
  const rows: CompareRow[] = [];
  const summaries: string[] = [];

  rows.push({ metric: 'Session span', a: fmtSpan(a), b: fmtSpan(b) });
  rows.push({ metric: 'EDIT', a: fmtCount(a.edits), b: fmtCount(b.edits) });
  rows.push({ metric: 'Recognized verification', a: fmtCount(a.recognizedVerificationRuns), b: fmtCount(b.recognizedVerificationRuns) });

  // FAIL→PASS loop shape (compressed)
  const loopA = fmtLoop(a.debuggingLoop ?? null);
  const loopB = fmtLoop(b.debuggingLoop ?? null);
  if (loopA !== '—' || loopB !== '—') {
    rows.push({ metric: 'FAIL→PASS shape', a: loopA, b: loopB });
  }

  // Longest unverified streak
  const streakA = a.longestUnverifiedStreak;
  const streakB = b.longestUnverifiedStreak;
  if (streakA !== null || streakB !== null) {
    rows.push({
      metric: 'Longest unverified streak',
      a: streakA ? `${streakA.changes} changes / ${streakA.attempts} att` : '—',
      b: streakB ? `${streakB.changes} changes / ${streakB.attempts} att` : '—',
    });
  }

  // Most touched file
  rows.push({
    metric: 'Most touched file',
    a: a.mostTouched ? `${a.mostTouched.path} (${a.mostTouched.touches})` : '—',
    b: b.mostTouched ? `${b.mostTouched.path} (${b.mostTouched.touches})` : '—',
  });

  // READ (may be N/A for codex)
  rows.push({
    metric: 'READ (attributed)',
    a: a.reads !== null ? String(a.reads) : 'N/A',
    b: b.reads !== null ? String(b.reads) : 'N/A',
  });

  // Factual summaries (transparent, no evaluation)
  if (a.recognizedVerificationRuns !== b.recognizedVerificationRuns) {
    const more = a.recognizedVerificationRuns > b.recognizedVerificationRuns ? a : b;
    summaries.push(
      `${more.sourceLabel} ran more recognized verification (${Math.max(a.recognizedVerificationRuns, b.recognizedVerificationRuns)} vs ${Math.min(a.recognizedVerificationRuns, b.recognizedVerificationRuns)}).`,
    );
  }
  if (a.edits !== b.edits) {
    const more = a.edits > b.edits ? a : b;
    summaries.push(
      `${more.sourceLabel} made more implementation edits (${Math.max(a.edits, b.edits)} vs ${Math.min(a.edits, b.edits)}).`,
    );
  }
  if (a.mostTouched && b.mostTouched && a.mostTouched.path !== b.mostTouched.path) {
    summaries.push(
      `Most touched files differ: ${a.mostTouched.path} vs ${b.mostTouched.path}.`,
    );
  }

  return { a, b, rows, summaries };
}
