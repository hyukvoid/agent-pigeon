/**
 * View selection helpers: the "show me only the mess" problems-only view,
 * session-list filtering, and the deterministic Current Flight milestone
 * steps shown in the sidebar while a session runs.
 */

import type { PigeonEvent, SessionModel } from './types.js';

/** Event ids that survive the problems-only filter. */
export function problemEventIds(model: SessionModel): Set<string> {
  const keep = new Set<string>();
  for (const problem of model.problems) {
    keep.add(problem.eventId);
    for (const step of problem.followUps) keep.add(step.eventId);
    if (problem.recoverySignal !== null) keep.add(problem.recoverySignal.eventId);
  }
  const byId = new Map(model.timeline.map((t) => [t.event.id, t.event]));
  for (const id of [...keep]) {
    let event = byId.get(id);
    while (event !== undefined && event.parentId !== null && event.parentId !== undefined) {
      keep.add(event.parentId);
      event = byId.get(event.parentId);
    }
  }
  for (const { event } of model.timeline) {
    if (event.type === 'SESSION_STARTED' || event.type === 'SESSION_COMPLETED') keep.add(event.id);
    if (event.parentId !== null && event.parentId !== undefined && keep.has(event.parentId)) keep.add(event.id);
  }
  return keep;
}

export function problemsOnlyView(model: SessionModel): { events: PigeonEvent[]; hiddenCount: number } {
  const keep = problemEventIds(model);
  const events = model.timeline.filter((t) => keep.has(t.event.id)).map((t) => t.event);
  return { events, hiddenCount: model.routineCount };
}

export type SessionStatusFilter = 'all' | 'success' | 'failed' | 'running';

export interface SessionListEntry {
  sessionId: string;
  label: string;
  status: 'SUCCESS' | 'FAILED' | 'PARTIAL' | 'UNKNOWN' | 'RUNNING';
  durationMs: number | null;
  lastActivityMs: number | null;
  problems: number;
  source: string;
}

export function filterSessionList(
  entries: SessionListEntry[],
  filter: SessionStatusFilter,
  query: string,
): SessionListEntry[] {
  const q = query.trim().toLowerCase();
  return entries.filter((entry) => {
    if (filter === 'success' && !(entry.status === 'SUCCESS')) return false;
    if (filter === 'failed' && !(entry.status === 'FAILED' || entry.status === 'PARTIAL')) return false;
    if (filter === 'running' && entry.status !== 'RUNNING') return false;
    if (q.length > 0 && !entry.label.toLowerCase().includes(q) && !entry.sessionId.toLowerCase().includes(q)) {
      return false;
    }
    return true;
  });
}

/** Group entries under Today / Yesterday / Earlier headings (for the tree). */
export function groupByDay(entries: SessionListEntry[]): { heading: string; entries: SessionListEntry[] }[] {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const yesterdayMs = todayMs - 86_400_000;
  const groups: Record<string, SessionListEntry[]> = { Today: [], Yesterday: [], Earlier: [] };
  for (const entry of entries) {
    const ms = entry.lastActivityMs ?? 0;
    if (ms >= todayMs) groups.Today?.push(entry);
    else if (ms >= yesterdayMs) groups.Yesterday?.push(entry);
    else groups.Earlier?.push(entry);
  }
  return (['Today', 'Yesterday', 'Earlier'] as const)
    .map((heading) => ({ heading, entries: groups[heading] ?? [] }))
    .filter((g) => g.entries.length > 0);
}

export interface FlightStep {
  glyph: '✓' | '✕' | '●' | '↻' | '○';
  label: string;
  detail: string | null;
}

/**
 * Current Flight steps — the compact sidebar progress view. Derived strictly
 * from evidenced milestones: task message, verification outcomes, failures,
 * recoveries and subagent activity.
 */
export function currentFlightSteps(model: SessionModel): FlightStep[] {
  const steps: FlightStep[] = [];
  if (model.task !== null) steps.push({ glyph: '○', label: model.task, detail: null });
  for (const problem of model.problems) {
    steps.push({ glyph: '✕', label: problem.description, detail: null });
    if (problem.status === 'RECOVERED' || problem.status === 'POSSIBLY_RECOVERED') {
      steps.push({
        glyph: '↻',
        label: `Recovery: ${problem.recoverySignal?.description ?? 'signal observed'}`,
        detail: `${problem.attempts} attempt${problem.attempts === 1 ? '' : 's'}`,
      });
    }
  }
  const lastAgent = model.agents[model.agents.length - 1];
  if (model.sessionStatus === 'RUNNING' && lastAgent !== undefined && lastAgent.status === 'RUNNING') {
    steps.push({ glyph: '●', label: `${lastAgent.agentId} running`, detail: null });
  }
  if (model.outcome.status !== 'UNKNOWN') {
    steps.push({ glyph: model.outcome.status === 'FAILED' ? '✕' : '✓', label: `Outcome: ${model.outcome.status}`, detail: null });
  }
  if (steps.length === 0) {
    steps.push({ glyph: '●', label: 'Session activity recorded', detail: null });
  }
  return steps;
}
