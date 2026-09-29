/**
 * Pigeon Event Format — the normalized event model every adapter emits.
 *
 * This is the flight recorder's evidence contract. Events describe what the
 * agent observably DID (tool calls, file writes, commands, test runs,
 * subagent spawns) — never what it "thought". Adapters must not invent
 * reasoning, intent, or relationships that the source log does not show.
 *
 * Design rules:
 *  - Evidence First: every event is traceable to a line in a source log.
 *  - Local First: events carry metadata for display; adapters decide what
 *    (if anything) to redact. Nothing here uploads anywhere.
 *  - Do not fake support: when a source log cannot answer something
 *    (e.g. session end), the processor records UNKNOWN instead of guessing.
 */

export type PigeonEventType =
  | 'SESSION_STARTED'
  | 'SESSION_COMPLETED'
  | 'AGENT_STARTED'
  | 'AGENT_COMPLETED'
  | 'SUBAGENT_STARTED'
  | 'SUBAGENT_COMPLETED'
  | 'MESSAGE'
  | 'TOOL_CALLED'
  | 'TOOL_RESULT'
  | 'FILE_READ'
  | 'FILE_CREATED'
  | 'FILE_CHANGED'
  | 'FILE_DELETED'
  | 'COMMAND_STARTED'
  | 'COMMAND_COMPLETED'
  | 'TEST_STARTED'
  | 'TEST_PASSED'
  | 'TEST_FAILED'
  | 'BUILD_STARTED'
  | 'BUILD_PASSED'
  | 'BUILD_FAILED'
  | 'ERROR'
  | 'CHECKPOINT';

export const PIGEON_EVENT_TYPES: readonly PigeonEventType[] = [
  'SESSION_STARTED',
  'SESSION_COMPLETED',
  'AGENT_STARTED',
  'AGENT_COMPLETED',
  'SUBAGENT_STARTED',
  'SUBAGENT_COMPLETED',
  'MESSAGE',
  'TOOL_CALLED',
  'TOOL_RESULT',
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
  'ERROR',
  'CHECKPOINT',
];

/** Observable outcome of an operation, as evidenced by the source log. */
export type EventStatus = 'ok' | 'error' | 'running' | 'aborted' | 'timeout' | 'unknown';

export const EVENT_STATUSES: readonly EventStatus[] = [
  'ok',
  'error',
  'running',
  'aborted',
  'timeout',
  'unknown',
];

export interface PigeonEvent {
  /** Stable unique id within the session (adapter-assigned). */
  id: string;
  sessionId: string;
  /** Parent event id, when the source evidences one (e.g. call → result). */
  parentId?: string | null;
  /** Agent that produced the event. Defaults to 'main'. */
  agentId?: string;
  /** For subagents: the parent agent's id. Leave unset when unknown. */
  parentAgentId?: string | null;
  type: PigeonEventType;
  /** ISO 8601 timestamp. */
  timestamp: string;
  /** Operation duration in ms when the source shows it. */
  durationMs?: number | null;
  /** Adapter id, e.g. 'generic-jsonl' | 'codex' | 'claude'. */
  source?: string;
  /** One-line factual summary (display-safe). No speculation. */
  summary?: string;
  /** Adapter-specific extra evidence (counts, snippets, roles, ...). */
  metadata?: Record<string, unknown> | null;
  // --- convenience accessors (all optional) ---
  /** Display-safe file path (repo-relative or last segments). */
  filePath?: string | null;
  command?: string | null;
  exitCode?: number | null;
  toolName?: string | null;
  status?: EventStatus | null;
  /** Short error identity (first content line of the failure text). */
  error?: string | null;
  /** Event ids this event is evidence for / against. */
  relatedEventIds?: string[] | null;
}

/** How completely an adapter can reconstruct a session from its source. */
export type SupportLevel = 'FULL' | 'PARTIAL' | 'EXPERIMENTAL' | 'UNAVAILABLE';

export interface AdapterInfo {
  id: string;
  label: string;
  level: SupportLevel;
  /** Concrete, honest caveats — what the adapter cannot recover. */
  limitations: string[];
}

/** Agent lifecycle status derived from events (never guessed). */
export type AgentStatus = 'RUNNING' | 'SUCCESS' | 'FAILED' | 'CANCELLED' | 'UNKNOWN';

export type ProblemStatus = 'RECOVERED' | 'POSSIBLY_RECOVERED' | 'UNRESOLVED' | 'PENDING' | 'BLOCKED';

/**
 * Failure taxonomy. CODE/VALIDATION are about the work itself; TOOL is the
 * harness misfiring; PROVIDER/ENVIRONMENT are outside the agent's control
 * and must never be presented as coding failures or "recovered".
 */
export type ProblemCategory = 'CODE' | 'VALIDATION' | 'TOOL' | 'ENVIRONMENT' | 'PROVIDER' | 'UNKNOWN';

/** Refinement for PROVIDER problems (auth/quota/rate-limit). */
export type ProviderDetail = 'AUTH' | 'QUOTA' | 'RATE_LIMIT' | null;

export type ProblemKind =
  | 'test-failure'
  | 'build-failure'
  | 'command-failure'
  | 'error'
  | 'agent-failure'
  | 'timeout'
  | 'abort';

export interface TimelineEntry {
  event: PigeonEvent;
  /** ms from session start (or from first event when start is missing). */
  offsetMs: number;
}

export interface AgentNode {
  agentId: string;
  parentAgentId: string | null;
  status: AgentStatus;
  /** First evidenced task summary (MESSAGE or SUBAGENT task), may be null. */
  taskSummary: string | null;
  startedMs: number | null;
  endedMs: number | null;
  durationMs: number | null;
  filesTouched: string[];
  commandsRun: string[];
  errors: string[];
  children: string[];
  eventCount: number;
}

export interface FileTouch {
  path: string;
  created: number;
  changed: number;
  deleted: number;
  reads: number;
  /** Total write/delete operations (created + changed + deleted). */
  edits: number;
  /** +line / -line counts when the source evidences them. */
  additions: number | null;
  deletions: number | null;
  agents: string[];
  firstTouchedBy: string | null;
  lastTouchedBy: string | null;
  firstMs: number | null;
  lastMs: number | null;
  /** Paths this file's problem/recovery involvement (see problems[]). */
  involvedInProblems: boolean;
}

export interface RecoveryStep {
  eventId: string;
  timestampMs: number;
  description: string;
}

export interface Problem {
  index: number;
  kind: ProblemKind;
  /** Failure taxonomy (see ProblemCategory). */
  category: ProblemCategory;
  /** Refinement for PROVIDER problems (AUTH / QUOTA / RATE_LIMIT). */
  providerDetail: ProviderDetail;
  eventId: string;
  timestampMs: number;
  agentId: string;
  /** Factual description: what operation failed and what the evidence shows. */
  description: string;
  /** Raw error identity when the source shows one. */
  errorIdentity: string | null;
  /** Observable actions after the failure, up to the recovery signal. */
  followUps: RecoveryStep[];
  /** Total observable follow-up actions (followUps is capped for display). */
  followUpCount: number;
  /** The positive signal that ended this problem, when one exists. */
  recoverySignal: RecoveryStep | null;
  status: ProblemStatus;
  /** How many consecutive same-kind failures this problem covers. */
  attempts: number;
}

export interface OutcomeSummary {
  /**
   * BLOCKED means the session was stopped from outside the work itself
   * (provider quota/auth, environment) — not that the agent's changes
   * failed. Coding failures unresolved give FAILED.
   */
  status: 'SUCCESS' | 'FAILED' | 'PARTIAL' | 'BLOCKED' | 'UNKNOWN';
  filesChanged: number;
  testsPassed: number;
  testsFailed: number;
  buildsPassed: number;
  buildsFailed: number;
  commandsRun: number;
  commandsFailed: number;
  failures: number;
  recovered: number;
  unresolved: number;
  agents: number;
}

export interface SessionModel {
  sessionId: string;
  source: string;
  /** First evidenced task text (first MESSAGE from the user side, or null). */
  task: string | null;
  /** Project/repo folder name derived from the session cwd when logged. */
  project: string | null;
  /** 'RUNNING' only when the source shows a live/running session. */
  sessionStatus: 'RUNNING' | 'COMPLETED' | 'UNKNOWN';
  startedMs: number | null;
  endedMs: number | null;
  durationMs: number | null;
  timeline: TimelineEntry[];
  agents: AgentNode[];
  rootAgentId: string | null;
  files: FileTouch[];
  problems: Problem[];
  outcome: OutcomeSummary;
  /** Events hidden by the problems-only view (routine operations). */
  routineCount: number;
  /** Non-fatal parse/normalization notes from the adapter or processor. */
  warnings: string[];
}
