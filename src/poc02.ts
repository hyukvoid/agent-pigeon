#!/usr/bin/env node
/**
 * POC-02 — real session replay CLI.
 *
 *   npm run poc:02 [-- --json] [-- --save-sanitized <dir>] [-- --session <id8>]
 *
 * Discovers Claude Code sessions under ~/.claude/projects (READ-ONLY),
 * replays them through the sanitizer -> segmentation -> POC-00-evidence
 * pipeline and reports findings. Raw transcript content never leaves this
 * process; only sanitized derivatives are printed or (with --save-sanitized)
 * written.
 */

import { readdirSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseClaudeSessionJsonl } from './replay/claude.js';
import { segmentIntoAttempts } from './replay/segment.js';
import { analyzeAttempts } from './replay/analyze.js';
import type { ReplayAnalysis, ReplayFinding } from './replay/analyze.js';
import type { ReplayAttempt, SanitizedReplayEvent } from './replay/types.js';

interface DiscoveredSession {
  file: string;
  projectDirName: string;
}

function discoverSessions(): DiscoveredSession[] {
  const root = join(homedir(), '.claude', 'projects');
  const sessions: DiscoveredSession[] = [];
  let projects: string[] = [];
  try {
    projects = readdirSync(root);
  } catch {
    return sessions;
  }
  for (const project of projects) {
    let files: string[] = [];
    try {
      files = readdirSync(join(root, project));
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith('.jsonl')) sessions.push({ file: join(root, project, file), projectDirName: project });
    }
  }
  return sessions;
}

function renderSessionReport(
  sessionId8: string,
  attempts: ReplayAttempt[],
  analysis: ReplayAnalysis,
): string {
  const lines: string[] = [];
  lines.push(`Session analyzed      ${sessionId8}`);
  lines.push(`Attempts              ${analysis.attemptCount}`);
  lines.push(`Implementation calls  ${analysis.implementationCalls}`);
  lines.push(`Verification runs     ${analysis.verificationRuns}`);

  const byKind = (kind: ReplayFinding['kind']): ReplayFinding[] =>
    analysis.findings.filter((f) => f.kind === kind);
  const heading: Record<ReplayFinding['kind'], string> = {
    'verification-debt': 'Verification Debt',
    'dead-end': 'Potential Dead-end',
    productive: 'Productive progress',
  };

  if (analysis.findings.length > 0) lines.push('');
  for (const kind of ['verification-debt', 'dead-end', 'productive'] as const) {
    for (const finding of byKind(kind)) {
      lines.push(heading[kind]);
      lines.push(`  Attempts ${finding.attemptRange[0]}–${finding.attemptRange[1]}: ${finding.detail}`);
      lines.push(`  Confidence    ${finding.confidence}`);
      lines.push('');
    }
  }

  lines.push('Verdict:');
  lines.push(`  ${analysis.verdict}`);
  lines.push(`Confidence:`);
  lines.push(`  ${analysis.overallConfidence}`);
  void attempts;
  return lines.join('\n');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const saveIndex = argv.indexOf('--save-sanitized');
  const saveDir = saveIndex >= 0 ? (argv[saveIndex + 1] ?? join(tmpdir(), 'agent-pigeon-sanitized')) : null;
  const sessionIndex = argv.indexOf('--session');
  const sessionFilter = sessionIndex >= 0 ? (argv[sessionIndex + 1] ?? null) : null;

  process.stdout.write('Agent Pigeon Replay\n\n');
  const sessions = discoverSessions().filter(
    (s) => sessionFilter === null || s.file.includes(sessionFilter),
  );

  if (sessions.length === 0) {
    process.stdout.write('No Claude Code sessions found (~/.claude/projects). Nothing to replay.\n');
    return;
  }

  interface SessionResult {
    sessionId8: string;
    meta: ReturnType<typeof parseClaudeSessionJsonl>['meta'];
    events: SanitizedReplayEvent[];
    attempts: ReplayAttempt[];
    analysis: ReplayAnalysis;
    report: string;
  }
  const results: SessionResult[] = [];
  let skippedNoActivity = 0;

  for (const session of sessions) {
    let text: string;
    try {
      text = readFileSync(session.file, 'utf8');
    } catch {
      continue;
    }
    const { meta, events } = parseClaudeSessionJsonl(text);
    const attempts = segmentIntoAttempts(events);
    const analysis = analyzeAttempts(attempts);
    if (attempts.length === 0) {
      skippedNoActivity++;
      continue;
    }
    results.push({
      sessionId8: meta.sessionId8,
      meta,
      events,
      attempts,
      analysis,
      report: renderSessionReport(meta.sessionId8, attempts, analysis),
    });
  }

  if (saveDir !== null) {
    mkdirSync(saveDir, { recursive: true });
    for (const result of results) {
      writeFileSync(
        join(saveDir, `sanitized-${result.sessionId8}.json`),
        JSON.stringify(
          { sessionId8: result.sessionId8, events: result.events, attempts: result.attempts },
          null,
          2,
        ),
        'utf8',
      );
    }
    process.stdout.write(`Sanitized derivatives saved to ${saveDir}\n\n`);
  }

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        results.map((r) => ({
          sessionId8: r.sessionId8,
          meta: r.meta,
          analysis: r.analysis,
        })),
        null,
        2,
      )}\n`,
    );
    return;
  }

  for (const result of results) {
    process.stdout.write(`${result.report}\n\n`);
  }
  process.stdout.write(
    `Summary: ${sessions.length} session(s) inspected · ${results.length} with implementation activity · ${skippedNoActivity} without reconstructable attempts\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`poc:02 failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
