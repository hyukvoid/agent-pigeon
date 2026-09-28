/**
 * `agent-pigeon session <file>` — one-session flight recorder report in the
 * terminal. Same SessionModel the VS Code extension renders, so CLI output
 * and IDE views always agree on the facts.
 */

import type { SessionModel } from './pigeon/types.js';

export function formatDuration(ms: number | null): string {
  if (ms === null) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

function offsetLabel(model: SessionModel, timestampMs: number): string {
  const start = model.startedMs ?? 0;
  const totalSeconds = Math.max(0, Math.round((timestampMs - start) / 1000));
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const KIND_LABEL: Record<string, string> = {
  'test-failure': 'Test failure',
  'build-failure': 'Build failure',
  'command-failure': 'Command failure',
  error: 'Error',
  'agent-failure': 'Agent failure',
  timeout: 'Timeout',
  abort: 'Aborted',
};

function agentGraphLine(model: SessionModel, agentId: string, depth: number, lines: string[], seen: Set<string>): void {
  const agent = model.agents.find((a) => a.agentId === agentId);
  if (agent === undefined || seen.has(agentId)) return;
  seen.add(agentId);
  const glyph =
    agent.status === 'SUCCESS' ? '✓' : agent.status === 'FAILED' ? '✕' : agent.status === 'RUNNING' ? '●' : '?';
  const indent = depth === 0 ? '' : `${'  '.repeat(depth - 1)}├─ `;
  lines.push(`  ${indent}${agent.agentId} ${glyph}${agent.durationMs !== null ? ` · ${formatDuration(agent.durationMs)}` : ''}`);
  for (const child of agent.children) agentGraphLine(model, child, depth + 1, lines, seen);
}

export function renderSessionOverview(model: SessionModel): string {
  const L = (label: string, value: string): string => `  ${label.padEnd(12, ' ')}${value}`;
  const lines: string[] = [];
  lines.push('Agent Pigeon — session');
  lines.push('');
  lines.push(L('Task', model.task ?? '(no task message recorded)'));
  lines.push(L('Status', `${model.outcome.status} · ${model.sessionStatus.toLowerCase()}${model.durationMs !== null ? ` · ${formatDuration(model.durationMs)}` : ''}`));
  lines.push(L('Agents', `${model.outcome.agents} (${model.agents.map((a) => a.agentId).join(', ')})`));
  lines.push(L('Files', `${model.outcome.filesChanged} changed · ${model.files.length} touched`));
  lines.push(L('Commands', `${model.outcome.commandsRun} run · ${model.outcome.commandsFailed} failed`));
  lines.push(L('Failures', `${model.outcome.failures} encountered · ${model.outcome.recovered} recovered${model.outcome.unresolved > 0 ? ` · ${model.outcome.unresolved} unresolved` : ''}`));

  if (model.problems.length > 0) {
    lines.push('');
    lines.push(`Problems — ${model.problems.length}`);
    for (const problem of model.problems) {
      lines.push(`  #${problem.index} ${KIND_LABEL[problem.kind] ?? problem.kind} · ${offsetLabel(model, problem.timestampMs)} · agent ${problem.agentId}`);
      lines.push(`     ${problem.description}`);
      if (problem.errorIdentity !== null) lines.push(`     ${problem.errorIdentity}`);
      if (problem.followUps.length > 0) {
        const shown = problem.followUps.slice(0, 4).map((f) => f.description);
        lines.push(`     Then: ${shown.join(', ')}${problem.followUps.length > 4 ? `, +${problem.followUps.length - 4} more` : ''}`);
      }
      if (problem.recoverySignal !== null) {
        lines.push(`     Recovery: ${problem.recoverySignal.description} (${offsetLabel(model, problem.recoverySignal.timestampMs)})`);
      }
      lines.push(`     Status: ${problem.status}${problem.attempts > 1 ? ` after ${problem.attempts} attempts` : ''}`);
    }
  } else {
    lines.push('');
    lines.push('Problems — 0');
  }

  lines.push('');
  lines.push('Agents');
  if (model.rootAgentId !== null) {
    const seen = new Set<string>();
    agentGraphLine(model, model.rootAgentId, 0, lines, seen);
    for (const agent of model.agents) {
      if (!seen.has(agent.agentId)) agentGraphLine(model, agent.agentId, 0, lines, seen);
    }
  }

  if (model.files.length > 0) {
    lines.push('');
    lines.push('Files touched');
    for (const file of model.files.slice(0, 12)) {
      const counts = [
        file.created > 0 ? `${file.created} created` : null,
        file.changed > 0 ? `${file.changed} changed` : null,
        file.deleted > 0 ? `${file.deleted} deleted` : null,
        file.reads > 0 ? `${file.reads} read` : null,
      ].filter((v) => v !== null).join(', ');
      lines.push(`  ${file.path}  ${counts} · ${file.agents.join(', ')}`);
    }
    if (model.files.length > 12) lines.push(`  … and ${model.files.length - 12} more`);
  }

  lines.push('');
  lines.push('Outcome');
  lines.push(`  ${model.outcome.status}`);
  lines.push(
    `  ${model.outcome.filesChanged} files changed · ` +
    `${model.outcome.testsPassed} test runs passed · ${model.outcome.failures} failures encountered, ${model.outcome.recovered} recovered · ` +
    `${model.outcome.agents} agents participated`,
  );
  for (const warning of model.warnings) lines.push(`  note: ${warning}`);
  lines.push('  Read-only: nothing was modified, stored, or uploaded.');
  return lines.join('\n');
}

export function renderSessionJson(model: SessionModel): string {
  return JSON.stringify(model, null, 2) + '\n';
}
