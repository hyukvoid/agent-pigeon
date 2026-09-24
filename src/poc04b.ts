#!/usr/bin/env node
/**
 * POC-04B — real corpus gate (OFFLINE replay experiment).
 *
 *   npm run poc:04b [-- --json] [-- --save-candidates <path>]
 *
 * Reads local coding-agent history READ-ONLY (Codex rollouts first, then
 * Claude projects), replays everything through the sanitized event model and
 * reports the corpus metrics + candidates. Raw transcripts never leave this
 * process; only sanitized aggregates are printed or saved.
 */

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { parseCodexSessionJsonl, tokensInWindow } from './replay/codex.js';
import type { CodexSession } from './replay/codex.js';
import { parseClaudeSessionJsonl } from './replay/claude.js';
import { segmentWithWindows } from './replay/segment.js';
import { analyzeAttempts } from './replay/analyze.js';
import type { ReplayFinding } from './replay/analyze.js';
import type { ReplayAttempt, SanitizedReplayEvent } from './replay/types.js';

interface SessionAnalysis {
  source: 'codex' | 'claude';
  sessionId8: string;
  events: SanitizedReplayEvent[];
  attempts: ReplayAttempt[];
  findings: ReplayFinding[];
  mobile: boolean;
  epochMs?: number | null;
  implementationCalls: number;
  verificationRuns: number;
  tokenRecords?: { timestampMs: number; totalTokens: number }[];
  parseError?: string;
}

function walkJsonl(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walkJsonl(p, out);
    else if (entry.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

function analyzeEvents(
  source: SessionAnalysis['source'],
  sessionId8: string,
  events: SanitizedReplayEvent[],
  extra: {
    mobile: boolean;
    epochMs?: number | null;
    tokenRecords?: { timestampMs: number; totalTokens: number }[];
  },
): SessionAnalysis {
  const { attempts } = segmentWithWindows(events);
  const analysis = analyzeAttempts(attempts);
  const implementationCalls = events.filter((e) => e.eventType === 'implementation').length;
  const verificationRuns = events.filter((e) => e.eventType === 'verification').length;
  return {
    source,
    sessionId8,
    events,
    attempts,
    findings: analysis.findings,
    mobile: extra.mobile,
    implementationCalls,
    verificationRuns,
    epochMs: extra.epochMs ?? null,
    tokenRecords: extra.tokenRecords,
  };
}

function analyzeCodex(file: string): SessionAnalysis {
  const text = readFileSync(file, 'utf8');
  const session: CodexSession = parseCodexSessionJsonl(text);
  // Mobile labeling is computed inside the adapter from command signals
  // in memory; commands themselves are never persisted.
  return analyzeEvents('codex', session.sessionId8, session.events, {
    mobile: session.mobileSignal,
    epochMs: session.epochMs,
    tokenRecords: session.tokenRecords,
  });
}

function analyzeClaude(file: string): SessionAnalysis {
  const text = readFileSync(file, 'utf8');
  const { meta, events } = parseClaudeSessionJsonl(text);
  return analyzeEvents('claude', meta.sessionId8, events, { mobile: false });
}

interface Candidate {
  source: string;
  sessionId8: string;
  kind: ReplayFinding['kind'];
  attemptRange: [number, number];
  detail: string;
  confidence: string;
  attemptCount: number;
  implementationCalls: number;
  verificationRuns: number;
  /** sanitized audit trail */
  okSequence: Array<boolean | null>;
  failedCountsSequence: Array<number | null>;
  distinctFingerprints: number;
  failureSignatureStable: boolean;
  mobile: boolean;
  tokensInWindow: number | null;
  manualVerdict: 'UNAUDITED';
}

function candidatesOfKind(sessions: SessionAnalysis[], kind: ReplayFinding['kind']): Candidate[] {
  const candidates: Candidate[] = [];
  for (const session of sessions) {
    for (const finding of session.findings) {
      if (finding.kind !== kind) continue;
      const [from, to] = finding.attemptRange;
      const attempts = session.attempts.slice(from - 1, to);
      const okSequence = attempts.map((a) => {
        const verification = a.verificationKinds.length > 0;
        const build = a.evidence.build.status;
        return build === 'pass' ? true : build === 'fail' ? false : verification ? true : null;
      });
      const failedCountsSequence = attempts.map((a) => a.evidence.tests.failedCount);
      const distinctFingerprints = new Set(attempts.map((a) => a.evidence.code.changeSetHash)).size;
      const failureSignatures = new Set(attempts.map((a) => a.failureSignatureHash).filter((h) => h !== null));

      let tokensDelta: number | null = null;
      const offsets = attempts.map((a) => a.timestampOffset).filter((o): o is number => o !== null);
      if (session.tokenRecords !== undefined && typeof session.epochMs === 'number' && offsets.length >= 1) {
        const fromAbs = session.epochMs + Math.min(...offsets);
        const toAbs = session.epochMs + Math.max(...offsets) + 60_000;
        tokensDelta = tokensInWindow(session.tokenRecords, fromAbs, toAbs);
      }

      candidates.push({
        source: session.source,
        sessionId8: session.sessionId8,
        kind,
        attemptRange: [from, to],
        detail: finding.detail,
        confidence: finding.confidence,
        attemptCount: session.attempts.length,
        implementationCalls: attempts.reduce((sum, a) => sum + a.implementationEvents, 0),
        verificationRuns: attempts.reduce((sum, a) => sum + a.verificationKinds.length, 0),
        okSequence,
        failedCountsSequence,
        distinctFingerprints,
        failureSignatureStable: failureSignatures.size <= 1,
        mobile: session.mobile,
        tokensInWindow: tokensDelta,
        manualVerdict: 'UNAUDITED',
      });
    }
  }
  return candidates;
}

function main(): void {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const saveIndex = argv.indexOf('--save-candidates');
  const savePath = saveIndex >= 0 && argv[saveIndex + 1] !== undefined ? String(argv[saveIndex + 1]) : null;

  const startedAt = performance.now();
  const sessions: SessionAnalysis[] = [];
  let filesScanned = 0;

  // 1. Codex rollouts (priority 1)
  for (const file of walkJsonl(join(homedir(), '.codex', 'sessions'))) {
    filesScanned++;
    try {
      sessions.push(analyzeCodex(file));
    } catch (error: unknown) {
      sessions.push({
        source: 'codex',
        sessionId8: 'error',
        events: [],
        attempts: [],
        findings: [],
        mobile: false,
        implementationCalls: 0,
        verificationRuns: 0,
        parseError: error instanceof Error ? error.message.slice(0, 80) : 'unknown',
      });
    }
  }

  // 2. Claude projects (priority 2)
  for (const file of walkJsonl(join(homedir(), '.claude', 'projects'))) {
    filesScanned++;
    try {
      sessions.push(analyzeClaude(file));
    } catch {
      sessions.push({
        source: 'claude',
        sessionId8: 'error',
        events: [],
        attempts: [],
        findings: [],
        mobile: false,
        implementationCalls: 0,
        verificationRuns: 0,
      });
    }
  }

  const usable = sessions.filter((s) => s.attempts.length > 0);
  const withImpl = sessions.filter((s) => s.implementationCalls > 0);
  const withVerification = sessions.filter((s) => s.verificationRuns > 0);
  const mobileSessions = usable.filter((s) => s.mobile);

  const productive = candidatesOfKind(sessions, 'productive');
  const debt = candidatesOfKind(sessions, 'verification-debt');
  const deadEnd = candidatesOfKind(sessions, 'dead-end');

  const totalAttempts = usable.reduce((sum, s) => sum + s.attempts.length, 0);
  const totalVerification = usable.reduce((sum, s) => sum + s.verificationRuns, 0);
  const totalImpl = usable.reduce((sum, s) => sum + s.implementationCalls, 0);
  const workerMs = performance.now() - startedAt;

  if (savePath !== null) {
    writeFileSync(
      savePath,
      `${JSON.stringify({ productive, debt, deadEnd }, null, 2)}\n`,
      'utf8',
    );
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          filesScanned,
          parsedSessions: sessions.length - sessions.filter((s) => s.parseError !== undefined).length,
          parseErrors: sessions.filter((s) => s.parseError !== undefined).length,
          usableSessions: usable.length,
          totalAttempts,
          implementationCalls: totalImpl,
          verificationEvents: totalVerification,
          mobileSessions: mobileSessions.length,
          candidates: { productive, debt, deadEnd },
          workerMs,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  process.stdout.write('Agent Pigeon — POC-04B real corpus gate\n\n');
  process.stdout.write(`Files scanned              ${filesScanned} (codex + claude)\n`);
  process.stdout.write(`Parsed sessions            ${sessions.length - sessions.filter((s) => s.parseError !== undefined).length}\n`);
  process.stdout.write(`Sessions w/ tool activity  ${sessions.filter((s) => s.implementationCalls + s.verificationRuns > 0).length}\n`);
  process.stdout.write(`Usable (attempts built)    ${usable.length}\n`);
  process.stdout.write(`Sessions w/ verification   ${withVerification.length}\n`);
  process.stdout.write(`Mobile-flagged sessions    ${mobileSessions.length}\n`);
  process.stdout.write(`Attempts reconstructed     ${totalAttempts}\n`);
  process.stdout.write(`Implementation calls       ${totalImpl}\n`);
  process.stdout.write(`Verification events        ${totalVerification}\n`);
  process.stdout.write(`Worker time                ${(workerMs / 1000).toFixed(1)} s\n\n`);

  const group = (kind: ReplayFinding['kind'], title: string): void => {
    const list = kind === 'productive' ? productive : kind === 'verification-debt' ? debt : deadEnd;
    process.stdout.write(`${title}\n`);
    if (list.length === 0) {
      process.stdout.write('  NOT OBSERVED\n');
    }
    for (const c of list) {
      process.stdout.write(
        `  [${c.source} ${c.sessionId8}] attempts ${c.attemptRange[0]}–${c.attemptRange[1]} · impl ${c.implementationCalls} · verif ${c.verificationRuns} · ${c.confidence} · mobile=${c.mobile ? 'yes' : 'no'}${c.tokensInWindow !== null ? ` · tokens≈${c.tokensInWindow.toLocaleString('en-US')}` : ''}\n`,
      );
      process.stdout.write(`    ${c.detail}\n`);
    }
    process.stdout.write('\n');
  };
  group('productive', 'PRODUCTIVE candidates');
  group('verification-debt', 'VERIFICATION DEBT candidates');
  group('dead-end', 'DEAD-END candidates');
}

main();
