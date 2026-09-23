#!/usr/bin/env node
/**
 * Agent Pigeon — public CLI (v0.1).
 *
 *   agent-pigeon replay                 Analyze local coding-agent history (read-only)
 *   agent-pigeon init                   Install the VERIFY_FIRST live governor hooks
 *   agent-pigeon remove                 Remove them again
 *
 * Local-first: replay reads history read-only and never stores or uploads
 * anything. The live governor only ever issues VERIFY_FIRST — a single,
 * factual "verify your work" reminder, once per debt episode.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { discoverSessions, scanSessions } from './replay/corpus.js';
import type { SessionAnalysis } from './replay/corpus.js';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// ---------------------------------------------------------------------------
// shared helpers

function humanCount(n: number): string {
  return n.toLocaleString('en-US');
}

function printHelp(): void {
  process.stdout.write(`Agent Pigeon — proof-of-progress for coding agents

Usage:
  agent-pigeon replay [options]     Analyze local agent history (read-only)
  agent-pigeon init [options]       Install the live VERIFY_FIRST governor
  agent-pigeon remove [options]     Remove the governor hooks
  agent-pigeon help                 Show this help

Replay options:
  --source <claude|codex|all>       Which history to analyze (default: all)
  --json                            Machine-readable output
  --claude-dir <path>               Override history directory
  --codex-dir <path>                Override history directory

Init options:
  --global                          Install into ~/.claude/settings.json
                                    (default: ./.claude/settings.json)
  --dry-run                         Show what would change, write nothing

Learn more: README.md
`);
}

// ---------------------------------------------------------------------------
// replay

function summarize(sessions: SessionAnalysis[]): void {
  void sessions;
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
      args.claudeDir = argv[i + 1];
      i++;
    } else if (a === '--codex-dir') {
      args.codexDir = argv[i + 1];
      i++;
    } else throw new Error(`unknown option: ${a ?? '(empty)'}`);
  }
  return args;
}

function runReplay(args: ReplayArgs): void {
  const startedAt = performance.now();
  const discovered = discoverSessions({ claudeDir: args.claudeDir, codexDir: args.codexDir });
  const considered = discovered.files.filter((e) => args.source === 'all' || e.source === args.source);
  const { sessions, unreadable } = scanSessions(considered);

  const counts = {
    scanned: considered.length,
    claude: sessions.filter((s) => s.source === 'claude').length,
    codex: sessions.filter((s) => s.source === 'codex').length,
    unreadable,
  };
  const usable = sessions.filter((s) => s.attempts.length > 0);
  const totalAttempts = usable.reduce((sum, s) => sum + s.attempts.length, 0);
  const implementationCalls = usable.reduce((sum, s) => sum + s.implementationCalls, 0);
  const verificationRuns = usable.reduce((sum, s) => sum + s.verificationRuns, 0);
  const productive = sessions.flatMap((s) =>
    s.findings.filter((f) => f.kind === 'productive').map((f) => ({ session: s, finding: f })),
  );
  const debt = sessions.flatMap((s) =>
    s.findings.filter((f) => f.kind === 'verification-debt').map((f) => ({ session: s, finding: f })),
  );
  const worstDebt = [...debt].sort(
    (a, b) => b.finding.confidence.localeCompare(a.finding.confidence) || b.finding.attemptRange[0] - a.finding.attemptRange[0],
  )[0];
  const mobileSessions = usable.filter((s) => s.mobile).length;
  const workerMs = performance.now() - startedAt;

  if (args.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          scanned: counts,
          sessionsWithAttempts: usable.length,
          attempts: totalAttempts,
          implementationCalls,
          verificationRuns,
          mobileSessions: mobileSessions,
          productiveWindows: productive.length,
          verificationDebtWindows: debt.length,
          debt: debt.map((d) => ({
            source: d.session.source,
            sessionId8: d.session.sessionId8,
            range: d.finding.attemptRange,
            detail: d.finding.detail,
            confidence: d.finding.confidence,
            mobile: d.session.mobile,
          })),
          workerMs,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  const L = (name: string, value: string | number): string => `  ${name.padEnd(26, ' ')}${value}`;
  const lines: string[] = [];
  lines.push('Agent Pigeon — replay');
  lines.push('');
  lines.push(L('Scanned', `${humanCount(counts.scanned)} sessions (claude ${counts.claude} · codex ${counts.codex})`));
  if (counts.unreadable > 0) {
    lines.push(L('Unreadable', `${humanCount(counts.unreadable)} session file(s) skipped`));
  }
  lines.push(L('Sessions with attempts', `${usable.length}`));
  lines.push(L('Implementation attempts', humanCount(totalAttempts)));
  lines.push(L('Implementation changes', humanCount(implementationCalls)));
  lines.push(L('Verification runs', humanCount(verificationRuns)));
  lines.push(L('Mobile-flagged sessions', `${mobileSessions}`));
  lines.push('');
  lines.push(`Verification debt — ${debt.length} window(s)`);
  lines.push('  Changes made without running anything that could prove they worked.');
  if (worstDebt !== undefined) {
    lines.push(
      `  largest: session ${worstDebt.session.sessionId8} (${worstDebt.session.source}), ${worstDebt.finding.confidence.toLowerCase()} confidence`,
    );
  }
  lines.push('');
  lines.push(`Productive verification loops — ${productive.length} window(s)`);
  lines.push('  Verification failed, then passed. Healthy debugging: no warnings issued.');
  lines.push('');
  lines.push('Read-only analysis. Nothing was modified, stored, or uploaded.');
  void workerMs;
  process.stdout.write(lines.join('\n') + '\n');
}

// ---------------------------------------------------------------------------
// init / remove

interface InstallPlan {
  settingsPath: string;
  entries: Array<{ event: 'PostToolUse' | 'PostToolBatch'; matcher?: string; command: string; async?: boolean; timeout?: number }>;
}

function hookCommands(): { observe: string; batch: string } {
  const observe = join(packageRoot, 'hooks', 'hook-posttooluse.mjs');
  const batch = join(packageRoot, 'dist', 'src', 'governor-batch.js');
  return {
    observe: `node "${observe.replace(/\\/gu, '/')}"`,
    batch: `node "${batch.replace(/\\/gu, '/')}"`,
  };
}

function buildPlan(globalInstall: boolean, projectDir: string | null): InstallPlan {
  const settingsPath = globalInstall
    ? join(process.env.AGENT_PIGEON_CLAUDE_HOME ?? join(process.env.HOME ?? process.env.USERPROFILE ?? '.', '.claude'), 'settings.json')
    : join(resolve(projectDir ?? process.cwd()), '.claude', 'settings.json');
  const { observe, batch } = hookCommands();
  return {
    settingsPath,
    entries: [
      { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit|Bash', command: observe, async: true },
      { event: 'PostToolBatch', command: batch, timeout: 30 },
    ],
  };
}

function isOurHook(command: string): boolean {
  return command.includes('hook-posttooluse.mjs') || command.includes('governor-batch.js');
}

function applyInstall(settingsPath: string, plan: InstallPlan, dryRun: boolean, remove: boolean): void {
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as Record<string, unknown>;
    } catch (error: unknown) {
      process.stderr.write(
        `agent-pigeon: cannot parse ${settingsPath} — refusing to modify it. Fix or remove the file first.\n`,
      );
      process.exitCode = 1;
      return;
    }
  }
  if (typeof settings !== 'object' || settings === null) settings = {};
  const hooks = (settings.hooks ?? {}) as Record<string, unknown>;
  settings.hooks = hooks;

  let changes = 0;
  for (const entry of plan.entries) {
    if (!Array.isArray(hooks[entry.event])) hooks[entry.event] = [];
    const groups = hooks[entry.event] as Array<{
      matcher?: string;
      hooks?: Array<{ type?: string; command?: string }>;
    }>;
    let group = groups.find((g) => entry.matcher === undefined || g.matcher === entry.matcher);
    if (group === undefined) {
      group = { ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}), hooks: [] };
      groups.push(group);
    }
    if (!Array.isArray(group.hooks)) group.hooks = [];

    const existing = group.hooks.find((h) => typeof h.command === 'string' && isOurHook(h.command));
    if (remove) {
      if (existing !== undefined) {
        group.hooks = group.hooks.filter((h) => h !== existing);
        if (group.hooks.length === 0) {
          hooks[entry.event] = (hooks[entry.event] as unknown[]).filter((g) => g !== group);
        }
        if ((hooks[entry.event] as unknown[]).length === 0) delete hooks[entry.event];
        changes++;
        process.stdout.write(`- ${entry.event}${entry.matcher ? ` (${entry.matcher})` : ''}\n`);
      }
    } else if (existing === undefined) {
      group.hooks.push({
        type: 'command',
        command: entry.command,
        ...(entry.async !== undefined ? { async: entry.async } : {}),
        ...(entry.timeout !== undefined ? { timeout: entry.timeout } : {}),
      });
      changes++;
      process.stdout.write(`+ ${entry.event}${entry.matcher ? ` (${entry.matcher})` : ''} async\n`);
    }
  }

  if (changes === 0) {
    process.stdout.write(dryRun ? 'no changes needed\n' : remove ? 'nothing to remove\n' : 'already installed\n');
    return;
  }
  if (dryRun) {
    process.stdout.write('(dry run — nothing written)\n');
    return;
  }
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  process.stdout.write(`written: ${settingsPath}\n`);
}

function runInit(argv: string[], remove: boolean): void {
  let globalInstall = false;
  let dryRun = false;
  let projectDir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--global') globalInstall = true;
    else if (a === '--project') {
      projectDir = argv[i + 1] ?? null;
      i++;
    } else if (a === '--dry-run') dryRun = true;
    else throw new Error(`unknown option: ${a ?? '(empty)'}`);
  }
  const plan = buildPlan(globalInstall, projectDir);
  if (!remove) {
    process.stdout.write('Agent Pigeon — install live governor (VERIFY_FIRST only)\n\n');
    process.stdout.write(`Settings file   ${plan.settingsPath}\n`);
    process.stdout.write('What gets installed:\n');
    process.stdout.write('  · an async observer that records build/test/device verification after tool calls\n');
    process.stdout.write('  · a batch check that adds ONE factual reminder when code changes repeatedly without any verification\n');
    process.stdout.write('  · it never blocks, never calls a model, and never sees your source code\n\n');
    if (dryRun) process.stdout.write('Dry run — planned changes:\n');
  }
  applyInstall(plan.settingsPath, plan, dryRun, remove);
  if (!remove && !dryRun) {
    process.stdout.write('\nRemoval is always available: agent-pigeon remove\n');
  }
}

// ---------------------------------------------------------------------------

function main(): void {
  const argv = process.argv.slice(2);
  const command = argv[0];
  const rest = argv.slice(1);

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (command === '--version' || command === '-v') {
    process.stdout.write('agent-pigeon 0.1.0\n');
    return;
  }
  if (command === 'replay') {
    runReplay(parseReplayArgs(rest));
    return;
  }
  if (command === 'init') {
    runInit(rest, false);
    return;
  }
  if (command === 'remove') {
    runInit(rest, true);
    return;
  }
  throw new Error(`unknown command: ${command} (try 'agent-pigeon help')`);
}

try {
  main();
} catch (error: unknown) {
  process.stderr.write(`agent-pigeon: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
void summarize;
