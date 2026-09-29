/**
 * Session processor — turns an ordered list of Pigeon Events into the
 * SessionModel the UI renders: timeline, agent graph, files touched,
 * problems with recovery chains, and the outcome summary.
 *
 * Every derivation here is a deterministic heuristic over observable events.
 * No AI inference, no guessing of intent. When the evidence does not answer
 * something (who is the parent agent? did the session end?), the model says
 * UNKNOWN instead of inventing an answer.
 */

import type {
  AgentNode,
  AgentStatus,
  FileTouch,
  OutcomeSummary,
  PigeonEvent,
  PigeonEventType,
  Problem,
  ProblemCategory,
  ProblemKind,
  ProblemStatus,
  ProviderDetail,
  RecoveryStep,
  SessionModel,
  TimelineEntry,
} from './types.js';

const FILE_EVENT_TYPES: readonly PigeonEventType[] = [
  'FILE_READ',
  'FILE_CREATED',
  'FILE_CHANGED',
  'FILE_DELETED',
];

const WRITE_EVENT_TYPES: readonly PigeonEventType[] = [
  'FILE_CREATED',
  'FILE_CHANGED',
  'FILE_DELETED',
];

const POSITIVE_SIGNAL_TYPES: readonly PigeonEventType[] = [
  'TEST_PASSED',
  'BUILD_PASSED',
];

export interface ProcessOptions {
  /** True while a live session file is still growing (no end event seen). */
  running?: boolean;
  /** Adapter warnings to surface alongside processor warnings. */
  warnings?: string[];
}

interface IndexedEvent {
  event: PigeonEvent;
  index: number;
  ms: number;
  /** ms relative to session start (first timestamped event). */
  offsetMs: number;
}

function isFailureEvent(e: PigeonEvent): boolean {
  switch (e.type) {
    case 'TEST_FAILED':
    case 'BUILD_FAILED':
    case 'ERROR':
      return true;
    case 'COMMAND_COMPLETED':
      return (typeof e.exitCode === 'number' && e.exitCode !== 0) || e.status === 'error' ||
        e.status === 'timeout' || e.status === 'aborted';
    case 'TOOL_RESULT':
      return e.status === 'error';
    case 'AGENT_COMPLETED':
    case 'SUBAGENT_COMPLETED':
      return e.status === 'error' || e.status === 'aborted' || e.status === 'timeout';
    default:
      return false;
  }
}

function problemKindFor(e: PigeonEvent): ProblemKind {
  switch (e.type) {
    case 'TEST_FAILED':
      return 'test-failure';
    case 'BUILD_FAILED':
      return 'build-failure';
    case 'COMMAND_COMPLETED':
      return e.status === 'timeout' ? 'timeout' : e.status === 'aborted' ? 'abort' : 'command-failure';
    case 'AGENT_COMPLETED':
    case 'SUBAGENT_COMPLETED':
      return 'agent-failure';
    default:
      return 'error';
  }
}

/**
 * Failure taxonomy. Provider/environment failures are recognizable from the
 * error identity only (HTTP status codes, transport errors) — never guessed
 * from free text beyond these structured patterns.
 */
const PROVIDER_PATTERNS: Array<{ detail: Exclude<ProviderDetail, null>; pattern: RegExp }> = [
  { detail: 'QUOTA', pattern: /\b402\b|quota\s*(exceeded|exhausted)|insufficient_quota|credit.{0,20}(exceeded| exhausted)|billing/iu },
  { detail: 'AUTH', pattern: /\b40[13]\b|unauthorized|forbidden|invalid[_\s]api[_\s]?key|authentication/iu },
  { detail: 'RATE_LIMIT', pattern: /\b429\b|rate[_\s]?limit|too\s+many\s+requests/iu },
];

const ENVIRONMENT_PATTERN = /timeout|timed\s*out|ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|socket\s+hang\s+up|network\s+(error|unreachable)|DNS/iu;

export function classifyProblemCategory(
  kind: ProblemKind,
  errorIdentity: string | null,
): { category: ProblemCategory; providerDetail: ProviderDetail } {
  const identity = errorIdentity ?? '';
  switch (kind) {
    case 'test-failure':
    case 'build-failure':
      return { category: 'VALIDATION', providerDetail: null };
    case 'command-failure':
    case 'timeout':
    case 'abort':
      return { category: 'TOOL', providerDetail: null };
    default: {
      for (const { detail, pattern } of PROVIDER_PATTERNS) {
        if (pattern.test(identity)) return { category: 'PROVIDER', providerDetail: detail };
      }
      if (ENVIRONMENT_PATTERN.test(identity)) return { category: 'ENVIRONMENT', providerDetail: null };
      // API-ish errors that carry no matched signature still name their source
      // when the identity mentions one, so "API Error: 500" reads honestly.
      if (/\bAPI\b|overloaded|internal\s+server\s+error|\b5\d\d\b/iu.test(identity)) {
        return { category: 'PROVIDER', providerDetail: null };
      }
      return { category: kind === 'agent-failure' ? 'UNKNOWN' : 'CODE', providerDetail: null };
    }
  }
}

/** Human label for a PROVIDER detail (used in evidence-based descriptions). */
export function providerDetailLabel(detail: ProviderDetail): string {
  switch (detail) {
    case 'QUOTA': return 'quota exceeded';
    case 'AUTH': return 'authentication failed';
    case 'RATE_LIMIT': return 'rate limited';
    default: return 'provider error';
  }
}

/**
 * The verification family a positive signal must match to count as recovery
 * evidence for a failure kind. Command failures recover only when the SAME
 * command later completes successfully — a different command proves nothing.
 */
function positiveMatch(failure: PigeonEvent, candidate: PigeonEvent): boolean {
  switch (failure.type) {
    case 'TEST_FAILED':
      return candidate.type === 'TEST_PASSED';
    case 'BUILD_FAILED':
      return candidate.type === 'BUILD_PASSED';
    case 'COMMAND_COMPLETED': {
      if (candidate.type !== 'COMMAND_COMPLETED') return false;
      const a = failure.command ?? null;
      const b = candidate.command ?? null;
      return a !== null && b !== null && a === b &&
        ((typeof candidate.exitCode === 'number' && candidate.exitCode === 0) || candidate.status === 'ok');
    }
    case 'AGENT_COMPLETED':
    case 'SUBAGENT_COMPLETED':
      return false; // handled via reassignment detection below
    default:
      return candidate.type === 'TEST_PASSED' || candidate.type === 'BUILD_PASSED' ||
        (candidate.type === 'COMMAND_COMPLETED' &&
          ((typeof candidate.exitCode === 'number' && candidate.exitCode === 0) || candidate.status === 'ok'));
  }
}

function firstLine(text: string | null | undefined, max = 160): string | null {
  if (typeof text !== 'string') return null;
  const line = text.replace(/[\\]+/gu, '/').split(/\r?\n/u).map((l) => l.trim()).find((l) => l.length > 0);
  if (line === undefined || line.length === 0) return null;
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function failureDescription(e: PigeonEvent): string {
  const what = e.command ?? e.toolName ?? e.filePath ?? null;
  const head = firstLine(e.error) ?? null;
  switch (e.type) {
    case 'TEST_FAILED': {
      const failed = (e.metadata as { testsFailedCount?: unknown } | null)?.testsFailedCount;
      const count = typeof failed === 'number' ? `${failed} test${failed === 1 ? '' : 's'} failed` : 'tests failed';
      return `${e.command ?? 'test run'} — ${count}`;
    }
    case 'BUILD_FAILED':
      return `${e.command ?? e.toolName ?? 'build'} — build failed`;
    case 'COMMAND_COMPLETED': {
      const code = typeof e.exitCode === 'number' ? ` (exit code ${e.exitCode})` : '';
      return `${e.command ?? e.toolName ?? 'command'} failed${code}`;
    }
    case 'AGENT_COMPLETED':
    case 'SUBAGENT_COMPLETED':
      return `${e.agentId} failed`;
    case 'TOOL_RESULT':
      return `${e.toolName ?? 'tool'} call reported an error`;
    default:
      return what !== null ? `${what} — error` : 'error reported';
  }
}

/** Sort key: timestamp, then input order (stable). */
function chronological(a: IndexedEvent, b: IndexedEvent): number {
  return a.ms - b.ms || a.index - b.index;
}

function agentChain(agentId: string, agents: Map<string, AgentNode>): string[] {
  // agentId itself plus all ancestors and descendants — recovery work for a
  // subagent's failure is typically done by the parent, so the "same work
  // context" is the whole family around the failing agent.
  const chain = [agentId];
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of agents.values()) {
      if (node.parentAgentId !== null && chain.includes(node.agentId) && !chain.includes(node.parentAgentId)) {
        chain.push(node.parentAgentId);
        changed = true;
      }
      if (node.parentAgentId !== null && chain.includes(node.parentAgentId) && !chain.includes(node.agentId)) {
        chain.push(node.agentId);
        changed = true;
      }
    }
  }
  return chain;
}

export function buildSessionModel(events: PigeonEvent[], opts: ProcessOptions = {}): SessionModel {
  const warnings = [...(opts.warnings ?? [])];

  // --- Chronological indexing -------------------------------------------
  const indexed: IndexedEvent[] = events.map((event, index) => {
    const parsed = Date.parse(event.timestamp);
    return { event, index, ms: Number.isFinite(parsed) ? parsed : 0, offsetMs: 0 };
  });
  indexed.sort(chronological);
  const startMs = indexed.length > 0 ? (indexed[0]?.ms ?? 0) : null;
  for (const item of indexed) item.offsetMs = startMs !== null ? item.ms - startMs : 0;

  const sessionId = indexed[0]?.event.sessionId ?? 'unknown-session';
  const source = indexed.find((i) => typeof i.event.source === 'string')?.event.source ?? 'unknown';

  // --- Session lifecycle --------------------------------------------------
  let sessionStatus: SessionModel['sessionStatus'] = opts.running === true ? 'RUNNING' : 'UNKNOWN';
  let endedMs: number | null = null;
  let declaredOutcome: string | null = null;
  let project: string | null = null;
  for (const { event, ms } of indexed) {
    if (event.type === 'SESSION_STARTED') {
      const meta = (event.metadata ?? {}) as Record<string, unknown>;
      if (project === null && typeof meta.cwd === 'string' && meta.cwd.length > 0) {
        const segments = meta.cwd.replace(/[\\]+/gu, '/').split('/').filter((s) => s.length > 0);
        project = segments[segments.length - 1] ?? null;
      }
    }
    if (event.type === 'SESSION_COMPLETED') {
      endedMs = ms;
      sessionStatus = 'COMPLETED';
      const meta = (event.metadata ?? {}) as Record<string, unknown>;
      const candidate = meta.outcome ?? meta.status;
      if (typeof candidate === 'string') declaredOutcome = candidate;
    }
  }
  if (endedMs === null && indexed.length > 0) {
    // No explicit end event: last activity is the best observable end.
    endedMs = indexed[indexed.length - 1]?.ms ?? null;
  }
  const durationMs = startMs !== null && endedMs !== null ? Math.max(0, endedMs - startMs) : null;

  // --- Task summary ---------------------------------------------------------
  // Prefer the user's task message. Harness-injected user-role messages are
  // not tasks: XML blocks (<environment_context>), slash commands (/model),
  // injected instruction files (# AGENTS.md …), and long harness preambles.
  // Short user messages are preferred; longer ones remain fallbacks.
  const isTaskShaped = (s: string): boolean => !(s.startsWith('<') || s.startsWith('/') || s.startsWith('#'));
  let task: string | null = null;
  let shortTask: string | null = null;
  let taskUserFallback: string | null = null;
  let taskFallback: string | null = null;
  for (const { event } of indexed) {
    if (event.type !== 'MESSAGE' || typeof event.summary !== 'string' || event.summary.length === 0) continue;
    const role = (event.metadata as { role?: unknown } | null)?.role;
    if (role === 'user') {
      if (isTaskShaped(event.summary)) {
        if (shortTask === null && event.summary.length <= 200) {
          shortTask = event.summary.length > 120 ? `${event.summary.slice(0, 119)}…` : event.summary;
          break;
        }
        if (taskUserFallback === null) taskUserFallback = event.summary.length > 120 ? `${event.summary.slice(0, 119)}…` : event.summary;
      }
    }
    if (taskFallback === null) taskFallback = event.summary.length > 120 ? `${event.summary.slice(0, 119)}…` : event.summary;
  }
  if (task === null) task = shortTask ?? taskUserFallback ?? taskFallback;

  // --- Agents ---------------------------------------------------------------
  const agents = new Map<string, AgentNode>();
  const agentOf = (id: string | null | undefined): AgentNode => {
    const key = id ?? 'main';
    let node = agents.get(key);
    if (node === undefined) {
      node = {
        agentId: key,
        parentAgentId: null,
        status: 'UNKNOWN',
        taskSummary: null,
        startedMs: null,
        endedMs: null,
        durationMs: null,
        filesTouched: [],
        commandsRun: [],
        errors: [],
        children: [],
        eventCount: 0,
      };
      agents.set(key, node);
    }
    return node;
  };

  for (const { event, ms } of indexed) {
    const node = agentOf(event.agentId);
    node.eventCount++;
    if (node.startedMs === null || ms < node.startedMs) node.startedMs = ms;
    if (ms > (node.endedMs ?? -1)) node.endedMs = ms;
    if (event.type === 'AGENT_STARTED' || event.type === 'SUBAGENT_STARTED') {
      if (node.startedMs === null || ms < node.startedMs) node.startedMs = ms;
      const parent = event.parentAgentId ?? 'main';
      if (event.agentId !== undefined && event.agentId !== parent) {
        const parentNode = agentOf(parent);
        node.parentAgentId = parent;
        if (!parentNode.children.includes(node.agentId)) parentNode.children.push(node.agentId);
      }
      const meta = (event.metadata ?? {}) as Record<string, unknown>;
      if (node.taskSummary === null && typeof meta.task === 'string') node.taskSummary = meta.task;
      node.status = 'RUNNING';
    }
    if (event.type === 'AGENT_COMPLETED' || event.type === 'SUBAGENT_COMPLETED') {
      node.endedMs = ms;
      if (node.startedMs === null) node.startedMs = startMs;
      node.durationMs = node.startedMs !== null ? Math.max(0, ms - node.startedMs) : null;
      if (event.status === 'error' || event.status === 'aborted' || event.status === 'timeout') {
        node.status = 'FAILED';
      } else if (event.status === 'ok' || (event.metadata as Record<string, unknown> | null)?.outcome === 'success') {
        node.status = 'SUCCESS';
      } else {
        node.status = 'UNKNOWN';
      }
    }
    const path = event.filePath ?? null;
    if (path !== null && WRITE_EVENT_TYPES.includes(event.type)) {
      if (!node.filesTouched.includes(path)) node.filesTouched.push(path);
    }
    if (event.type === 'COMMAND_STARTED' && typeof event.command === 'string' && !node.commandsRun.includes(event.command)) {
      node.commandsRun.push(event.command);
    }
    if (event.type === 'COMMAND_COMPLETED' && typeof event.command === 'string' && !node.commandsRun.includes(event.command)) {
      node.commandsRun.push(event.command);
    }
    if (isFailureEvent(event) && event.type !== 'COMMAND_COMPLETED' && event.type !== 'TOOL_RESULT') {
      const identity = firstLine(event.error) ?? failureDescription(event);
      if (!node.errors.includes(identity)) node.errors.push(identity);
    }
    if (event.type === 'MESSAGE' && node.taskSummary === null && typeof event.summary === 'string') {
      node.taskSummary = event.summary.length > 120 ? `${event.summary.slice(0, 119)}…` : event.summary;
    }
  }
  for (const node of agents.values()) {
    node.durationMs = node.startedMs !== null && node.endedMs !== null ? Math.max(0, node.endedMs - node.startedMs) : null;
  }
  const rootAgentId = agents.has('main') ? 'main' : (agents.keys().next().value ?? null);

  // --- Files touched ----------------------------------------------------------
  const fileMap = new Map<string, FileTouch>();
  for (const { event, ms } of indexed) {
    const path = event.filePath;
    if (path === null || path === undefined) continue;
    let record = fileMap.get(path);
    if (record === undefined) {
      record = {
        path,
        created: 0,
        changed: 0,
        deleted: 0,
        reads: 0,
        edits: 0,
        additions: null,
        deletions: null,
        agents: [],
        firstTouchedBy: null,
        lastTouchedBy: null,
        firstMs: null,
        lastMs: null,
        involvedInProblems: false,
      };
      fileMap.set(path, record);
    }
    const agentId = event.agentId ?? 'main';
    if (!record.agents.includes(agentId)) record.agents.push(agentId);
    if (record.firstTouchedBy === null) record.firstTouchedBy = agentId;
    record.lastTouchedBy = agentId;
    if (record.firstMs === null || ms < record.firstMs) record.firstMs = ms;
    if (record.lastMs === null || ms > record.lastMs) record.lastMs = ms;
    switch (event.type) {
      case 'FILE_CREATED': record.created++; record.edits++; break;
      case 'FILE_CHANGED': record.changed++; record.edits++; break;
      case 'FILE_DELETED': record.deleted++; record.edits++; break;
      case 'FILE_READ': record.reads++; break;
      default: break;
    }
    const meta = (event.metadata ?? {}) as Record<string, unknown>;
    if (typeof meta.additions === 'number') {
      record.additions = (record.additions ?? 0) + meta.additions;
    }
    if (typeof meta.deletions === 'number') {
      record.deletions = (record.deletions ?? 0) + meta.deletions;
    }
  }
  const files = [...fileMap.values()].sort((a, b) => b.edits - a.edits || a.path.localeCompare(b.path));

  // --- Problems & recovery ------------------------------------------------------
  const problems: Problem[] = [];
  const consumed = new Set<number>(); // failure indices folded into an earlier problem's attempt count
  const fileInvolved = new Set<string>();

  for (let i = 0; i < indexed.length; i++) {
    const item = indexed[i];
    if (item === undefined || consumed.has(item.index)) continue;
    const failure = item.event;
    if (!isFailureEvent(failure)) continue;
    const kind = problemKindFor(failure);
    const errorIdentity = firstLine(failure.error);
    const { category, providerDetail } = classifyProblemCategory(kind, errorIdentity);
    const familyAgents = new Set(agentChain(failure.agentId ?? 'main', agents));

    // Provider/environment failures are not coding failures: the code-recovery
    // heuristic (test fail → edit → test pass) must not run against them, and
    // a session that stops on one is BLOCKED, not FAILED.
    if (category === 'PROVIDER' || category === 'ENVIRONMENT') {
      const label = providerDetailLabel(providerDetail);
      problems.push({
        index: problems.length + 1,
        kind,
        category,
        providerDetail,
        eventId: failure.id,
        timestampMs: item.ms,
        agentId: failure.agentId ?? 'main',
        description:
          category === 'PROVIDER'
            ? `Provider issue — ${label}`
            : `Environment issue — ${label.replace('provider error', 'transport/network failure')}`,
        errorIdentity,
        followUps: [],
        followUpCount: 0,
        recoverySignal: null,
        status: sessionStatus === 'RUNNING' ? 'PENDING' : 'BLOCKED',
        attempts: 1,
      });
      continue;
    }

    // Collect follow-up actions + search for a recovery signal. Follow-ups
    // are capped: a long unresolved stretch can contain hundreds of routine
    // commands, and listing them all would bury the failure.
    const MAX_FOLLOW_UPS = 12;
    const followUps: RecoveryStep[] = [];
    let followUpCount = 0;
    let recoverySignal: RecoveryStep | null = null;
    let attempts = 1;
    const scanFrom = i + 1;
    for (let j = scanFrom; j < indexed.length; j++) {
      const later = indexed[j];
      if (later === undefined) continue;
      const candidate = later.event;
      if (!familyAgents.has(candidate.agentId ?? 'main')) continue;

      // Consecutive same-kind failures merge into one problem line.
      if (isFailureEvent(candidate) && problemKindFor(candidate) === kind) {
        // For command failures only merge when the command matches, so two
        // different failing commands stay two problems.
        if (kind !== 'command-failure' || (candidate.command ?? null) === (failure.command ?? null)) {
          consumed.add(later.index);
          attempts++;
          continue;
        }
      }

      if (recoverySignal === null) {
        if (positiveMatch(failure, candidate)) {
          recoverySignal = {
            eventId: candidate.id,
            timestampMs: later.ms,
            description:
              candidate.type === 'TEST_PASSED' ? 'tests passed'
                : candidate.type === 'BUILD_PASSED' ? 'build passed'
                  : `${candidate.command ?? 'command'} succeeded`,
          };
          break;
        }
        if (kind === 'agent-failure') {
          // Reassignment: a subagent started for the same task afterwards.
          // The failing agent's task comes from its start event (agent
          // summary), not from the completion event itself.
          const failedTask = failure.agentId !== undefined ? agents.get(failure.agentId)?.taskSummary : null;
          const meta = (candidate.metadata ?? {}) as Record<string, unknown>;
          if ((candidate.type === 'SUBAGENT_STARTED' || candidate.type === 'AGENT_STARTED') &&
              failedTask !== null && typeof meta.task === 'string' && meta.task === failedTask) {
            recoverySignal = {
              eventId: candidate.id,
              timestampMs: later.ms,
              description: `reassigned to ${candidate.agentId ?? 'another agent'}`,
            };
            break;
          }
        }
        if (candidate.type === 'SESSION_COMPLETED') {
          const meta = (candidate.metadata ?? {}) as Record<string, unknown>;
          if (meta.outcome === 'success' || meta.status === 'success') {
            recoverySignal = {
              eventId: candidate.id,
              timestampMs: later.ms,
              description: 'session completed successfully afterwards',
            };
          }
          break;
        }
        // Record observable follow-up work between failure and signal.
        if (candidate.type === 'FILE_CHANGED' || candidate.type === 'FILE_CREATED' || candidate.type === 'FILE_DELETED') {
          followUpCount++;
          if (followUps.length < MAX_FOLLOW_UPS) {
            followUps.push({
              eventId: candidate.id,
              timestampMs: later.ms,
              description: `${candidate.filePath ?? 'file'} ${candidate.type === 'FILE_CREATED' ? 'created' : candidate.type === 'FILE_DELETED' ? 'deleted' : 'changed'}`,
            });
          }
          fileInvolved.add(candidate.filePath ?? '');
        } else if (candidate.type === 'FILE_READ') {
          followUpCount++;
          if (followUps.length < MAX_FOLLOW_UPS) {
            followUps.push({
              eventId: candidate.id,
              timestampMs: later.ms,
              description: `inspected ${candidate.filePath ?? 'file'}`,
            });
          }
          fileInvolved.add(candidate.filePath ?? '');
        } else if (candidate.type === 'COMMAND_STARTED' || candidate.type === 'TEST_STARTED' || candidate.type === 'BUILD_STARTED') {
          followUpCount++;
          if (followUps.length < MAX_FOLLOW_UPS) {
            const label = candidate.command !== null && candidate.command !== undefined
              ? `ran ${firstLine(candidate.command, 80)}`
              : `ran ${candidate.toolName ?? 'verification'}`;
            followUps.push({ eventId: candidate.id, timestampMs: later.ms, description: label });
          }
        }
      }
    }

    let status: ProblemStatus;
    if (recoverySignal !== null) {
      // A same-kind positive signal is strong evidence; anything else is a
      // weaker correlation and must stay POSSIBLY_RECOVERED.
      const strong =
        (failure.type === 'TEST_FAILED' && recoverySignal.description === 'tests passed') ||
        (failure.type === 'BUILD_FAILED' && recoverySignal.description === 'build passed') ||
        (failure.type === 'COMMAND_COMPLETED' && recoverySignal.description.endsWith('succeeded')) ||
        kind === 'agent-failure';
      status = strong ? 'RECOVERED' : 'POSSIBLY_RECOVERED';
    } else if (sessionStatus === 'RUNNING') {
      status = 'PENDING';
    } else {
      status = 'UNRESOLVED';
    }

    if (errorIdentity !== null && failure.filePath !== null && failure.filePath !== undefined) {
      fileInvolved.add(failure.filePath);
    }
    problems.push({
      index: problems.length + 1,
      kind,
      category,
      providerDetail,
      eventId: failure.id,
      timestampMs: item.ms,
      agentId: failure.agentId ?? 'main',
      description: failureDescription(failure),
      errorIdentity,
      followUps,
      followUpCount,
      recoverySignal,
      status,
      attempts,
    });
  }
  for (const file of files) {
    file.involvedInProblems = fileInvolved.has(file.path);
  }
  problems.sort((a, b) => a.timestampMs - b.timestampMs);
  problems.forEach((p, i) => { p.index = i + 1; });

  // --- Outcome ------------------------------------------------------------------
  const count = (t: PigeonEventType): number => indexed.reduce((n, i) => n + (i.event.type === t ? 1 : 0), 0);
  const testsPassed = count('TEST_PASSED');
  const testsFailed = count('TEST_FAILED');
  const buildsPassed = count('BUILD_PASSED');
  const buildsFailed = count('BUILD_FAILED');
  const commandsRun = count('COMMAND_COMPLETED');
  const commandsFailed = indexed.reduce(
    (n, i) => n + (i.event.type === 'COMMAND_COMPLETED' && isFailureEvent(i.event) ? 1 : 0),
    0,
  );
  const recovered = problems.filter((p) => p.status === 'RECOVERED' || p.status === 'POSSIBLY_RECOVERED').length;
  const unresolved = problems.filter((p) => p.status === 'UNRESOLVED').length;
  const failures = problems.reduce((n, p) => n + p.attempts, 0);

  const blockedProblems = problems.filter((p) => p.status === 'BLOCKED').length;
  let outcomeStatus: OutcomeSummary['status'];
  if (declaredOutcome !== null) {
    outcomeStatus =
      declaredOutcome === 'success' ? 'SUCCESS'
        : declaredOutcome === 'failure' || declaredOutcome === 'error' ? 'FAILED'
          : declaredOutcome === 'blocked' || declaredOutcome === 'stopped' ? 'BLOCKED'
            : declaredOutcome === 'partial' ? 'PARTIAL' : 'UNKNOWN';
  } else if (sessionStatus !== 'COMPLETED') {
    outcomeStatus = 'UNKNOWN';
  } else if (unresolved > 0) {
    outcomeStatus = 'FAILED';
  } else if (blockedProblems > 0) {
    // Stopped from outside the work itself (provider quota/auth, environment)
    // with no unresolved coding failure: the honest verdict is BLOCKED.
    outcomeStatus = 'BLOCKED';
  } else if (problems.length === 0) {
    outcomeStatus = 'SUCCESS';
  } else if (recovered === problems.length) {
    outcomeStatus = 'SUCCESS';
  } else {
    outcomeStatus = 'PARTIAL';
  }

  const outcome: OutcomeSummary = {
    status: outcomeStatus,
    filesChanged: new Set(
      indexed.filter((i) => WRITE_EVENT_TYPES.includes(i.event.type) && i.event.filePath)
        .map((i) => i.event.filePath as string),
    ).size,
    testsPassed,
    testsFailed,
    buildsPassed,
    buildsFailed,
    commandsRun,
    commandsFailed,
    failures,
    recovered,
    unresolved,
    agents: agents.size,
  };

  // The root agent owns the session outcome: when the session completes, the
  // root agent's graph status follows it (subagents keep their own evidence).
  const root = rootAgentId !== null ? agents.get(rootAgentId) : undefined;
  if (root !== undefined && root.status === 'UNKNOWN' && sessionStatus === 'COMPLETED') {
    root.status = outcomeStatus === 'SUCCESS' ? 'SUCCESS' : outcomeStatus === 'FAILED' ? 'FAILED' : 'UNKNOWN';
  }

  // --- "Show me only the mess" support --------------------------------------------
  // Events that are neither problems, follow-ups, recovery signals, agent
  // lifecycle around problems, nor session bookkeeping are routine noise.
  const keep = new Set<string>();
  for (const p of problems) {
    keep.add(p.eventId);
    for (const f of p.followUps) keep.add(f.eventId);
    if (p.recoverySignal !== null) keep.add(p.recoverySignal.eventId);
    // Verification starts that pair with outcomes near problems stay visible.
  }
  // Keep the paired start of a kept start/end pair (COMMAND_STARTED ↔ COMPLETED).
  const byId = new Map(indexed.map((i) => [i.event.id, i.event]));
  for (const id of [...keep]) {
    const event = byId.get(id);
    if (event?.parentId !== null && event?.parentId !== undefined) keep.add(event.parentId);
  }
  for (const { event } of indexed) {
    if (event.type === 'SESSION_STARTED' || event.type === 'SESSION_COMPLETED') keep.add(event.id);
    if (event.parentId !== null && event.parentId !== undefined && keep.has(event.parentId)) keep.add(event.id);
  }
  const routineCount = indexed.length - keep.size;

  const timeline: TimelineEntry[] = indexed.map((i) => ({ event: i.event, offsetMs: i.offsetMs }));

  if (indexed.length > 0 && indexed.every((i) => i.ms === 0)) {
    warnings.push('no parseable timestamps in session; events shown in source order');
  }

  return {
    sessionId,
    source,
    task,
    project,
    sessionStatus,
    startedMs: startMs,
    endedMs,
    durationMs,
    timeline,
    agents: [...agents.values()].sort((a, b) => (a.startedMs ?? 0) - (b.startedMs ?? 0)),
    rootAgentId,
    files,
    problems,
    outcome,
    routineCount,
    warnings,
  };
}

/** Event types that count as coding-work evidence (directive: discovery scope). */
const CODING_EVENT_TYPES: readonly PigeonEventType[] = [
  'FILE_READ',
  'FILE_CREATED',
  'FILE_CHANGED',
  'FILE_DELETED',
  'COMMAND_STARTED',
  'COMMAND_COMPLETED',
  'TEST_STARTED',
  'TEST_PASSED',
  'TEST_FAILED',
  'BUILD_STARTED',
  'BUILD_PASSED',
  'BUILD_FAILED',
  'TOOL_CALLED',
  'TOOL_RESULT',
];

/**
 * Whether a session shows coding-work evidence: any file operation, command,
 * test/build run, or tool invocation. Pure-conversation sessions (a greeting,
 * a question with no tool use) are not coding sessions — the UI lists them
 * separately instead of pretending every chat is a flight.
 */
export function isCodingSession(model: SessionModel): boolean {
  return model.timeline.some((t) => CODING_EVENT_TYPES.includes(t.event.type));
}

export const PROBLEM_STATUS_ORDER: readonly ProblemStatus[] = [
  'UNRESOLVED',
  'PENDING',
  'POSSIBLY_RECOVERED',
  'RECOVERED',
];

export const AGENT_STATUS_LABEL: Record<AgentStatus, string> = {
  RUNNING: '● Running',
  SUCCESS: '✓',
  FAILED: '✕',
  CANCELLED: '⊘',
  UNKNOWN: '?',
};

export const POSITIVE_SIGNALS: readonly PigeonEventType[] = POSITIVE_SIGNAL_TYPES;
