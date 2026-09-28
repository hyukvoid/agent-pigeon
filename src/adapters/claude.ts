/**
 * Claude Code adapter (support level: PARTIAL) — maps Claude Code session
 * JSONL (~/.claude/projects/**\/*.jsonl) to Pigeon Events. Field shapes were
 * verified against real local sessions, not just documentation.
 *
 * Recovered evidence: file edits/writes/reads (display-safe paths), Bash
 * commands with recognized test/build verification outcomes, tool errors,
 * assistant/user messages, and sidechain (= subagent) activity.
 *
 * Not recoverable (hence PARTIAL):
 *  - explicit session end (logs just stop) → session status stays UNKNOWN
 *  - the link between a Task tool call and its sidechain stream is not in
 *    the log, so all sidechains share one 'sidechain' agent whose parent is
 *    the main agent
 */

import { classifyVerificationCommand, extractFailedCount } from '../replay/claude.js';
import type { PigeonEvent, PigeonEventType } from '../pigeon/types.js';

export interface ClaudeParseResult {
  events: PigeonEvent[];
  warnings: string[];
  skippedLines: number;
  sessionId: string | null;
}

export interface ClaudeLine {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  cwd?: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  isMeta?: boolean;
  isApiErrorMessage?: boolean;
  error?: string;
  message?: {
    role?: string;
    content?: string | Array<{
      type?: string;
      text?: string;
      id?: string;
      name?: string;
      input?: { command?: string; file_path?: string | string[]; description?: string; prompt?: string };
      tool_use_id?: string;
      is_error?: boolean;
      content?: string | Array<{ type?: string; text?: string }>;
    }>;
  };
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
    durationMs?: number;
  } | null;
}

const IMPL_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_TOOLS = new Set(['Read', 'View', 'Open']);

/** Display-safe path (repo-relative or last 4 segments) — same policy as the replay module. */
function displayPath(raw: string, cwd: string | null): string {
  let p = raw.replace(/[\\]+/gu, '/');
  const drive = /^[A-Za-z]:\//u;
  // Replace the drive prefix INCLUDING its slash so "C:/x/y" becomes "x/y"
  // (slice(2) would leave a leading slash and break cwd-prefix stripping).
  p = p.replace(drive, '');
  if (cwd !== null && cwd.length > 0) {
    const c = cwd.replace(/[\\]+/gu, '/').replace(drive, '').replace(/\/+$/u, '');
    if (c.length > 0 && p.toLowerCase().startsWith(c.toLowerCase() + '/')) {
      p = p.slice(c.length + 1);
    }
  }
  const segments = p.split('/').filter((seg) => seg.length > 0);
  if (segments.length > 4) return '…/' + segments.slice(-4).join('/');
  return segments.join('/');
}

function resultText(content: string | Array<{ type?: string; text?: string }> | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('\n');
  }
  return '';
}

function firstLine(text: string, max = 160): string {
  const line = text.replace(/<[^>]+>/gu, '').split(/\r?\n/u).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function parseClaudePigeonSession(text: string, fallbackId = 'claude-session'): ClaudeParseResult {
  const events: PigeonEvent[] = [];
  const warnings: string[] = [];
  let skippedLines = 0;
  let sessionId: string | null = null;
  let cwd: string | null = null;
  let seq = 0;
  const nextId = (): string => `cl${String(++seq).padStart(5, '0')}`;

  interface PendingCall {
    id: string;
    kind: 'command' | 'file' | 'read' | 'subagent' | 'tool';
    verificationKind: 'test' | 'build' | 'device' | null;
    command: string | null;
    toolName: string;
    filePath: string | null;
    agentId: string;
  }
  const pending = new Map<string, PendingCall>();

  const lines = text.split(/\r?\n/u);
  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let obj: ClaudeLine;
    try {
      obj = JSON.parse(trimmed) as ClaudeLine;
    } catch {
      skippedLines++;
      warnings.push(`line ${lineIndex + 1}: invalid JSON skipped`);
      return;
    }
    if (typeof obj.sessionId === 'string' && sessionId === null) sessionId = obj.sessionId;
    if (typeof obj.cwd === 'string' && obj.cwd.length > 0) cwd = obj.cwd;
    if (obj.type !== 'assistant' && obj.type !== 'user') return;
    const ms = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    if (!Number.isFinite(ms)) {
      skippedLines++;
      return;
    }
    const timestamp = new Date(ms).toISOString();
    const agentId = obj.isSidechain === true ? 'sidechain' : 'main';
    if (agentId === 'sidechain' && !events.some((e) => e.agentId === 'sidechain' && e.type === 'SUBAGENT_STARTED')) {
      events.push({
        id: nextId(),
        sessionId: sessionId ?? fallbackId,
        agentId: 'sidechain',
        parentAgentId: 'main',
        type: 'SUBAGENT_STARTED',
        timestamp,
        source: 'claude',
        status: 'running',
        summary: 'Subagent (sidechain) activity started',
      });
    }
    const sid = sessionId ?? fallbackId;
    const content = obj.message?.content;

    if (obj.type === 'user') {
      if (obj.isMeta === true) return;
      if (typeof content === 'string') {
        const summary = firstLine(content);
        if (summary.length > 0) {
          events.push({
            id: nextId(),
            sessionId: sid,
            agentId,
            type: 'MESSAGE',
            timestamp,
            source: 'claude',
            summary,
            metadata: { role: 'user' },
          });
        }
        return;
      }
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type !== 'tool_result') continue;
          const inFlight = pending.get(block.tool_use_id ?? '');
          const isError = block.is_error === true;
          const text = resultText(block.content);
          const tur = obj.toolUseResult ?? {};
          const output = `${typeof tur.stderr === 'string' ? tur.stderr : ''}\n${text}`.trim();
          if (inFlight === undefined) continue;
          if (inFlight.kind === 'command') {
            const failedCount = inFlight.verificationKind === 'test' ? extractFailedCount(output) : null;
            let type: PigeonEventType;
            let summary: string;
            if (inFlight.verificationKind === 'test') {
              if (isError) {
                type = 'TEST_FAILED';
                summary = `${inFlight.command ?? 'tests'} — ${failedCount !== null ? `${failedCount} test${failedCount === 1 ? '' : 's'} failed` : 'tests failed'}`;
              } else {
                type = 'TEST_PASSED';
                summary = `${inFlight.command ?? 'tests'} — passed`;
              }
            } else if (inFlight.verificationKind === 'build') {
              type = isError ? 'BUILD_FAILED' : 'BUILD_PASSED';
              summary = `${inFlight.command ?? 'build'} — ${isError ? 'failed' : 'passed'}`;
            } else {
              type = 'COMMAND_COMPLETED';
              summary = `${inFlight.command ?? inFlight.toolName} finished`;
            }
            events.push({
              id: nextId(),
              sessionId: sid,
              agentId: inFlight.agentId,
              parentId: inFlight.id,
              type,
              timestamp,
              durationMs: typeof tur.durationMs === 'number' ? tur.durationMs : null,
              source: 'claude',
              toolName: inFlight.toolName,
              command: inFlight.command,
              status: isError ? 'error' : 'ok',
              error: isError ? firstLine(output, 200) : null,
              summary,
              metadata: failedCount !== null ? { testsFailedCount: failedCount } : null,
            });
          } else if (isError) {
            events.push({
              id: nextId(),
              sessionId: sid,
              agentId: inFlight.agentId,
              parentId: inFlight.id,
              type: 'TOOL_RESULT',
              timestamp,
              source: 'claude',
              toolName: inFlight.toolName,
              filePath: inFlight.filePath,
              status: 'error',
              error: firstLine(output, 200),
              summary: `${inFlight.toolName} reported an error`,
            });
          }
          pending.delete(block.tool_use_id ?? '');
        }
      }
      return;
    }

    // assistant line
    if (obj.isApiErrorMessage === true || typeof obj.error === 'string') {
      const apiText = Array.isArray(content)
        ? content.map((block) => (block.type === 'text' && typeof block.text === 'string' ? block.text : '')).join('\n')
        : '';
      const identity = firstLine(apiText.length > 0 ? apiText : obj.error ?? 'API error', 200);
      if (identity.length > 0 && identity.toLowerCase() !== 'unknown') {
        events.push({
          id: nextId(),
          sessionId: sid,
          agentId,
          type: 'ERROR',
          timestamp,
          source: 'claude',
          status: 'error',
          error: identity,
          summary: 'API error reported',
        });
      }
    }
    if (!Array.isArray(content)) return;
    for (const block of content) {
      if (block.type === 'text') {
        const summary = firstLine(block.text ?? '');
        if (summary.length > 0 && !events.some((e) => e.type === 'MESSAGE' && e.timestamp === timestamp && e.agentId === agentId)) {
          events.push({
            id: nextId(),
            sessionId: sid,
            agentId,
            type: 'MESSAGE',
            timestamp,
            source: 'claude',
            summary,
            metadata: { role: 'assistant' },
          });
        }
        continue;
      }
      if (block.type !== 'tool_use' || typeof block.name !== 'string') continue;
      const toolName = block.name;
      const input = block.input ?? {};
      const callId = block.id ?? `unknown-${seq}`;
      const filePath = typeof input.file_path === 'string' && input.file_path.length > 0
        ? displayPath(input.file_path, cwd)
        : null;

      if (IMPL_TOOLS.has(toolName) && filePath !== null) {
        const type: PigeonEventType = toolName === 'Write' || toolName === 'NotebookEdit' ? 'FILE_CREATED' : 'FILE_CHANGED';
        pending.set(callId, { id: nextId(), kind: 'file', verificationKind: null, command: null, toolName, filePath, agentId });
        events.push({
          id: pending.get(callId)?.id ?? nextId(),
          sessionId: sid,
          agentId,
          type,
          timestamp,
          source: 'claude',
          toolName,
          filePath,
          status: 'running',
          summary: `${type === 'FILE_CREATED' ? 'Created' : 'Modified'} ${filePath}`,
        });
      } else if (READ_TOOLS.has(toolName) && filePath !== null) {
        events.push({
          id: nextId(),
          sessionId: sid,
          agentId,
          type: 'FILE_READ',
          timestamp,
          source: 'claude',
          toolName,
          filePath,
          status: 'ok',
          summary: `Read ${filePath}`,
        });
      } else if (toolName === 'Bash' && typeof input.command === 'string') {
        const verificationKind = classifyVerificationCommand(input.command);
        const kind: PendingCall['kind'] = verificationKind === null ? 'command' : 'command';
        const eventId = nextId();
        pending.set(callId, { id: eventId, kind, verificationKind, command: input.command, toolName, filePath: null, agentId });
        const type: PigeonEventType =
          verificationKind === 'test' ? 'TEST_STARTED'
            : verificationKind === 'build' ? 'BUILD_STARTED'
              : 'COMMAND_STARTED';
        events.push({
          id: eventId,
          sessionId: sid,
          agentId,
          type,
          timestamp,
          source: 'claude',
          toolName,
          command: input.command,
          status: 'running',
          summary: `Ran ${input.command}`,
          metadata: verificationKind !== null ? { verificationKind } : null,
        });
      } else if (toolName === 'Task' || toolName === 'Agent') {
        const subId = `sub-${(block.id ?? String(seq)).slice(-8)}`;
        const task = firstLine(input.description ?? input.prompt ?? '', 120) || null;
        pending.set(callId, { id: nextId(), kind: 'subagent', verificationKind: null, command: null, toolName, filePath: null, agentId });
        events.push({
          id: pending.get(callId)?.id ?? nextId(),
          sessionId: sid,
          agentId: subId,
          parentAgentId: agentId,
          type: 'SUBAGENT_STARTED',
          timestamp,
          source: 'claude',
          toolName,
          status: 'running',
          summary: task !== null ? `Subagent started: ${task}` : 'Subagent started',
          metadata: { task },
        });
      } else {
        pending.set(callId, { id: nextId(), kind: 'tool', verificationKind: null, command: null, toolName, filePath, agentId });
        events.push({
          id: pending.get(callId)?.id ?? nextId(),
          sessionId: sid,
          agentId,
          type: 'TOOL_CALLED',
          timestamp,
          source: 'claude',
          toolName,
          filePath,
          status: 'running',
          summary: filePath !== null ? `${toolName} ${filePath}` : `Called ${toolName}`,
        });
      }
    }
  });

  return { events, warnings, skippedLines, sessionId };
}

export function looksLikeClaudeSession(text: string): boolean {
  const lines = text.split(/\r?\n/u).filter((l) => l.trim().length > 0).slice(0, 5);
  let hits = 0;
  for (const l of lines) {
    try {
      const obj = JSON.parse(l.trim()) as ClaudeLine;
      if ((obj.type === 'user' || obj.type === 'assistant' || obj.type === 'file-history-snapshot') &&
        (typeof obj.sessionId === 'string' || obj.parentUuid !== undefined)) {
        hits++;
      }
    } catch {
      // keep sniffing
    }
  }
  return hits >= 1;
}
