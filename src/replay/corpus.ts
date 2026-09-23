/**
 * Corpus discovery + analysis shared by the public `replay` command and the
 * offline research runner. READ-ONLY over local agent history; everything
 * that leaves this module is sanitized (hashes, counts, booleans).
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseCodexSessionJsonl } from './codex.js';
import { parseClaudeSessionJsonl } from './claude.js';
import { segmentWithWindows } from './segment.js';
import { analyzeAttempts } from './analyze.js';
import type { ReplayFinding } from './analyze.js';
import type { ReplayAttempt, SanitizedReplayEvent } from './types.js';

export interface SessionAnalysis {
  source: 'codex' | 'claude';
  sessionId8: string;
  events: SanitizedReplayEvent[];
  attempts: ReplayAttempt[];
  findings: ReplayFinding[];
  mobile: boolean;
  implementationCalls: number;
  verificationRuns: number;
  epochMs?: number | null;
  tokenRecords?: { timestampMs: number; totalTokens: number }[];
  parseError?: string;
}

export function walkJsonl(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkJsonl(p, out);
    else if (entry.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

export function analyzeEvents(
  source: SessionAnalysis['source'],
  sessionId8: string,
  events: SanitizedReplayEvent[],
  extra: {
    mobile: boolean;
    epochMs?: number | null;
    tokenRecords?: { timestampMs: number; totalTokens: number }[];
  } = { mobile: false },
): SessionAnalysis {
  const { attempts } = segmentWithWindows(events);
  const analysis = analyzeAttempts(attempts);
  return {
    source,
    sessionId8,
    events,
    attempts,
    findings: analysis.findings,
    mobile: extra.mobile,
    implementationCalls: events.filter((e) => e.eventType === 'implementation').length,
    verificationRuns: events.filter((e) => e.eventType === 'verification').length,
    epochMs: extra.epochMs ?? null,
    tokenRecords: extra.tokenRecords,
  };
}

export interface AnalyzeOptions {
  /** Compute HMAC content fingerprints (research mode). Default false for
   * the public replay path: replay needs no fingerprints, and skipping them
   * keeps replay genuinely read-only (no secret file is ever created). */
  fingerprints?: boolean;
}

export function analyzeCodexFile(file: string, opts: AnalyzeOptions = {}): SessionAnalysis {
  const text = readFileSync(file, 'utf8');
  const session = parseCodexSessionJsonl(text, 'codex', opts);
  return analyzeEvents('codex', session.sessionId8, session.events, {
    mobile: session.mobileSignal,
    epochMs: session.epochMs,
    tokenRecords: session.tokenRecords,
  });
}

export function analyzeClaudeFile(file: string, opts: AnalyzeOptions = {}): SessionAnalysis {
  const text = readFileSync(file, 'utf8');
  const { meta, events } = parseClaudeSessionJsonl(text, 'session', opts);
  return analyzeEvents('claude', meta.sessionId8, events);
}



export interface DiscoveredHistory {
  claudeDir: string;
  codexDir: string;
  files: { path: string; source: 'codex' | 'claude' }[];
}

/** Default local history locations (read-only). */
export function defaultHistoryDirs(): { claudeDir: string; codexDir: string } {
  return {
    claudeDir: join(homedir(), '.claude', 'projects'),
    codexDir: join(homedir(), '.codex', 'sessions'),
  };
}

/** Discover codex + claude session files (read-only). */
export function discoverSessions(opts: { claudeDir?: string; codexDir?: string } = {}): DiscoveredHistory {
  const defaults = defaultHistoryDirs();
  const claudeDir = opts.claudeDir ?? defaults.claudeDir;
  const codexDir = opts.codexDir ?? defaults.codexDir;
  const files: { path: string; source: 'codex' | 'claude' }[] = [];
  for (const p of walkJsonl(claudeDir)) files.push({ path: p, source: 'claude' });
  for (const p of walkJsonl(codexDir)) files.push({ path: p, source: 'codex' });
  return { claudeDir, codexDir, files };
}

export function analyzeFile(path: string, source: 'codex' | 'claude', opts: AnalyzeOptions = {}): SessionAnalysis {
  return source === 'codex' ? analyzeCodexFile(path, opts) : analyzeClaudeFile(path, opts);
}

export interface ScanResult {
  sessions: SessionAnalysis[];
  /** Files that were discovered but could not be read/analyzed. */
  unreadable: number;
}

/**
 * Analyze a list of discovered session files. Individual failures never abort
 * the scan, but they ARE counted: a summary that reports only the files it
 * managed to parse silently under-reports the history it looked at.
 */
export function scanSessions(files: { path: string; source: 'codex' | 'claude' }[]): ScanResult {
  const sessions: SessionAnalysis[] = [];
  let unreadable = 0;
  for (const entry of files) {
    try {
      sessions.push(analyzeFile(entry.path, entry.source));
    } catch {
      unreadable++;
    }
  }
  return { sessions, unreadable };
}
