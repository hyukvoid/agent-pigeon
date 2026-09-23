#!/usr/bin/env node
/**
 * Agent Pigeon — public CLI (v0.1, replay-only).
 *
 *   agent-pigeon replay     Analyze local coding-agent history (read-only)
 *   agent-pigeon --help
 *   agent-pigeon --version
 *
 * Replay is genuinely read-only: it reads local session history, computes
 * counts in memory, and prints a report. It creates no files, stores no
 * state, and never accesses the network. A live governor was researched and
 * intentionally withheld from v0.1 (see experimental/ and docs/research).
 */

import { performance } from 'node:perf_hooks';

import { discoverSessions, analyzeFile, scanSessions } from './replay/corpus.js';
import type { SessionAnalysis } from './replay/corpus.js';

function humanCount(n: number): string {
  return n.toLocaleString('en-US');
}

function printHelp(): void {
  process.stdout.write(`Agent Pigeon — proof-of-progress for coding agents

Usage:
  agent-pigeon replay [options]     Analyze local agent history (read-only)
  agent-pigeon --help               Show this help
  agent-pigeon --version            Show version

Replay options:
  --source <claude|codex|all>       Which history to analyze (default: all)
  --json                            Machine-readable output
  --claude-dir <path>               Override Claude history directory
  --codex-dir <path>                Override Codex history directory

Replay reads your local session history, computes counts in memory, and
prints a report. It creates nothing, stores nothing, and sends nothing.
`);
}

interface ReplayArgs {
  source: 'all' | 'claude' | 'codex';
  json: boolean;
  claudeDir?: string;
  codexDir?: string;
}

function parseReplayArgs(argv: string[]): ReplayArgs {
  const args: ReplayArgs = { source: 'all', json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') args.json = true;
    else if (a === '--source') {
      const v = argv[i + 1];
      if (v === 'claude' || v === 'codex' || v === 'all') {
        args.source = v;
        i++;
      } else throw new Error(`--source expects claude|codex|all, got ${v ?? '(missing)'}`);
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

/** Distinct non-test implementation turns; falls back to attempts for
 * turn-unaware sources. */
function implementationTurnCount(sessions: SessionAnalysis[]): number {
  const direct = new Set<string>();
  let turnAware = false;
  for (const s of sessions) {
    for (const e of s.events) {
      if (e.eventType !== 'implementation' || e.testOnly === true) continue;
      if (e.turn !== null && e.turn !== undefined) {
        turnAware = true;
        direct.add(`${s.source}:${s.sessionId8}:${e.turn}`);
      }
    }
  }
  if (turnAware) return direct.size;
  return sessions.reduce((sum, s) => sum + s.attempts.length, 0);
}

function runReplay(args: ReplayArgs): void {
  const startedAt = performance.now();
  const discovered = discoverSessions({ claudeDir: args.claudeDir, codexDir: args.codexDir });
  const considered = discovered.files.filter((e) => args.source === 'all' || e.source === args.source);

  const sessions: SessionAnalysis[] = [];
  let unreadable = 0;
  let done = 0;
  for (const entry of considered) {
    try {
      sessions.push(analyzeFile(entry.path, entry.source, { fingerprints: false }));
    } catch {
      unreadable++; // a corrupt history file must never fail the whole replay
    }
    done++;
    if (!args.json && done % 50 === 0) {
      process.stderr.write(`scanned ${done}/${considered.length} history files…\n`);
    }
  }
  const workerMs = performance.now() - startedAt;

  const usable = sessions.filter((s) => s.attempts.length > 0);
  const totalAttempts = usable.reduce((sum, s) => sum + s.attempts.length, 0);
  const implementationChanges = usable.reduce((sum, s) => sum + s.implementationCalls, 0);
  const verificationRuns = usable.reduce((sum, s) => sum + s.verificationRuns, 0);
  const implementationTurns = implementationTurnCount(usable);
  const productive = sessions.flatMap((s) =>
    s.findings.filter((f) => f.kind === 'productive').map((f) => ({ session: s, finding: f })),
  );
  const unverified = sessions.flatMap((s) =>
    s.findings
      .filter((f) => f.kind === 'verification-debt')
      .map((f) => ({
        session: s,
        finding: f,
        turns: /(\d+) distinct implementation turns/.exec(f.detail)?.[1] ?? null,
      })),
  );
  unverified.sort((a, b) => Number(b.turns ?? 0) - Number(a.turns ?? 0));
  const mobileSessions = usable.filter((s) => s.mobile).length;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          scanned: {
            total: sessions.length + unreadable,
            claude: sessions.filter((s) => s.source === 'claude').length,
            codex: sessions.filter((s) => s.source === 'codex').length,
            unreadable,
          },
          sessionsWithCodeChanges: sessions.filter((s) => s.implementationCalls > 0).length,
          usableSessions: usable.length,
          attempts: totalAttempts,
          implementationChanges,
          implementationTurns,
          recognizedVerificationRuns: verificationRuns,
          mobileFlaggedSessions: mobileSessions,
          unverifiedStretches: unverified.length,
          productiveLoops: productive.length,
          workerMs: +workerMs.toFixed(1),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const L = (name: string, value: string | number): string => `  ${name.padEnd(30, ' ')}${value}`;
  const lines: string[] = [];
  lines.push('Agent Pigeon — replay');
  lines.push('');
  lines.push(L('History scanned', `${humanCount(sessions.length + unreadable)} sessions`));
  lines.push(L('Sessions with code changes', `${sessions.filter((s) => s.implementationCalls > 0).length}`));
  lines.push(L('Implementation attempts', humanCount(totalAttempts)));
  lines.push(L('Implementation changes', humanCount(implementationChanges)));
  lines.push(L('Recognized verification runs', humanCount(verificationRuns)));
  lines.push('');
  lines.push(`Unverified implementation stretches — ${unverified.length}`);
  lines.push('  Stretches where the agent changed code across 3+ separate turns');
  lines.push('  without any recognized verification (build / test / device run).');
  for (const u of unverified.slice(0, 5)) {
    lines.push(`  · ${u.session.source} session ${u.session.sessionId8} · ${u.turns ?? '?'} turns · ${u.finding.confidence.toLowerCase()} confidence`);
  }
  if (unverified.length > 5) lines.push(`  … and ${unverified.length - 5} more (--json for the full list)`);
  lines.push('');
  lines.push(`Recognized verification loops — ${productive.length}`);
  lines.push('  Verification failed, then passed. Healthy debugging — no warnings for these.');
  lines.push('');
  lines.push('Notes');
  lines.push('  · "Recognized" = build / test / device commands Agent Pigeon can identify.');
  lines.push('    Project-specific checks (custom scripts, smoke runs) may be invisible —');
  lines.push('    treat these results as prompts to inspect, not verdicts.');
  lines.push('  · Read-only: nothing was modified, stored, or uploaded.');
  process.stdout.write(lines.join('\n') + '\n');
}

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write('agent-pigeon 0.1.0\n');
    return;
  }
  if (command === 'replay') {
    runReplay(parseReplayArgs(argv.slice(1)));
    return;
  }
  throw new Error(`unknown command: ${command} (try 'agent-pigeon --help')`);
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`agent-pigeon: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
