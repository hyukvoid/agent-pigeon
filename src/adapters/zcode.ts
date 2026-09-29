/**
 * ZCode adapter (support level: EXPERIMENTAL) — maps ZCode's model-io
 * rollout logs (~/.zcode/cli/rollout/model-io-sess_*.jsonl) to Pigeon
 * Events. Field shapes verified against real local rollouts.
 *
 * Source shape (one line = one model turn):
 *   { sessionId, startedAt, requestId, turnId,
 *     request:  { messages: [...], messagesKind, messageOffset },
 *     response: { text, toolCalls: [{ id, name, input }] } }
 *
 * Tool outcomes arrive as role:"tool" messages in SUBSEQUENT requests
 * ({ toolCallId, toolName, isError }). Message windows repeat across lines,
 * so results are de-duplicated by toolCallId.
 *
 * Known limitations (why EXPERIMENTAL):
 *  - the model-io log is a debug artifact; it may be truncated, disabled, or
 *    change shape between ZCode versions
 *  - tool results carry only isError — no exit codes
 *  - no explicit session end record
 *  - user task text is taken from the first request window
 */

import { classifyVerificationCommand, extractFailedCount } from '../replay/claude.js';
import type { PigeonEvent, PigeonEventType } from '../pigeon/types.js';

export interface ZCodeParseResult {
  events: PigeonEvent[];
  warnings: string[];
  skippedLines: number;
  sessionId: string | null;
}

interface ZCodeToolCall {
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface ZCodeMessage {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
}

export interface ZCodeLine {
  sessionId?: string;
  startedAt?: string;
  completedAt?: string;
  requestId?: string;
  turnId?: string;
  request?: {
    messages?: ZCodeMessage[];
    messagesKind?: string;
    messageOffset?: number;
  };
  response?: {
    text?: string;
    toolCalls?: ZCodeToolCall[];
  };
}

const IMPL_TOOLS: Record<string, PigeonEventType> = {
  Edit: 'FILE_CHANGED',
  MultiEdit: 'FILE_CHANGED',
  Write: 'FILE_CREATED',
  NotebookEdit: 'FILE_CREATED',
};
const READ_TOOLS = new Set(['Read', 'View', 'Open']);
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

function displayPath(raw: string): string {
  let p = raw.replace(/[\\]+/gu, '/');
  p = p.replace(/^[A-Za-z]:\//u, '');
  const segments = p.split('/').filter((s) => s.length > 0);
  if (segments.length > 4) return '…/' + segments.slice(-4).join('/');
  return segments.join('/');
}

function firstLine(text: string, max = 160): string {
  const line = text.split(/\r?\n/u).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function inputString(input: Record<string, unknown> | undefined, key: string): string | null {
  const value = input?.[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

export function parseZCodePigeonSession(text: string, fallbackId = 'zcode-session'): ZCodeParseResult {
  const events: PigeonEvent[] = [];
  const warnings: string[] = [];
  let skippedLines = 0;
  let sessionId: string | null = null;
  let seq = 0;
  const nextId = (): string => `zc${String(++seq).padStart(5, '0')}`;

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
  const resolvedResults = new Set<string>();
  let taskCaptured = false;

  const lines = text.split(/\r?\n/u);
  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let obj: ZCodeLine;
    try {
      obj = JSON.parse(trimmed) as ZCodeLine;
    } catch {
      skippedLines++;
      warnings.push(`line ${lineIndex + 1}: invalid JSON skipped`);
      return;
    }
    if (typeof obj.startedAt !== 'string' || !Number.isFinite(Date.parse(obj.startedAt))) {
      skippedLines++;
      return;
    }
    if (typeof obj.sessionId === 'string' && sessionId === null) {
      sessionId = obj.sessionId.replace(/^sess_/u, '').slice(0, 8) || obj.sessionId.slice(0, 8);
    }
    const sid = sessionId ?? fallbackId;
    const timestamp = new Date(Date.parse(obj.startedAt)).toISOString();

    if (!taskCaptured) {
      // The first request window carries the conversation so far; its last
      // user text message is the session task.
      const messages = obj.request?.messages ?? [];
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i];
        if (message === undefined || message.role !== 'user') continue;
        const textContent = typeof message.content === 'string' ? message.content : '';
        const summary = firstLine(textContent);
        if (summary.length > 0 && !summary.startsWith('<')) {
          events.push({
            id: nextId(),
            sessionId: sid,
            agentId: 'main',
            type: 'MESSAGE',
            timestamp,
            source: 'zcode',
            summary,
            metadata: { role: 'user' },
          });
          break;
        }
      }
      taskCaptured = true;
    }

    // Tool results from this request window (skip already-seen ids —
    // windows replay history on every line).
    for (const message of obj.request?.messages ?? []) {
      if (message === undefined || message.role !== 'tool') continue;
      const callId = message.toolCallId ?? '';
      if (callId.length === 0 || resolvedResults.has(callId)) continue;
      resolvedResults.add(callId);
      const inFlight = pending.get(callId);
      if (inFlight === undefined) continue;
      const isError = message.isError === true;
      const resultText = typeof message.content === 'string' ? message.content : '';
      pending.delete(callId);
      if (inFlight.kind === 'command') {
        let type: PigeonEventType;
        let summary: string;
        const failedCount = isError && inFlight.verificationKind === 'test' ? extractFailedCount(resultText) : null;
        if (inFlight.verificationKind === 'test') {
          type = isError ? 'TEST_FAILED' : 'TEST_PASSED';
          summary = isError
            ? `${firstLine(inFlight.command ?? 'tests', 80)} — ${failedCount !== null ? `${failedCount} test${failedCount === 1 ? '' : 's'} failed` : 'tests failed'}`
            : `${firstLine(inFlight.command ?? 'tests', 80)} — passed`;
        } else if (inFlight.verificationKind === 'build') {
          type = isError ? 'BUILD_FAILED' : 'BUILD_PASSED';
          summary = `${firstLine(inFlight.command ?? 'build', 80)} — ${isError ? 'failed' : 'passed'}`;
        } else {
          type = 'COMMAND_COMPLETED';
          summary = `${firstLine(inFlight.command ?? inFlight.toolName, 80)} finished`;
        }
        events.push({
          id: nextId(),
          sessionId: sid,
          agentId: inFlight.agentId,
          parentId: inFlight.id,
          type,
          timestamp,
          source: 'zcode',
          toolName: inFlight.toolName,
          command: inFlight.command,
          status: isError ? 'error' : 'ok',
          error: isError ? firstLine(resultText, 200) : null,
          summary,
          metadata: failedCount !== null ? { testsFailedCount: failedCount } : null,
        });
      } else if (inFlight.kind === 'subagent') {
        events.push({
          id: nextId(),
          sessionId: sid,
          agentId: inFlight.agentId,
          parentAgentId: 'main',
          type: 'SUBAGENT_COMPLETED',
          timestamp,
          source: 'zcode',
          status: isError ? 'error' : 'ok',
          summary: isError ? 'Subagent reported an error' : 'Subagent finished',
          error: isError ? firstLine(resultText, 200) : null,
        });
      } else if (isError) {
        events.push({
          id: nextId(),
          sessionId: sid,
          agentId: inFlight.agentId,
          parentId: inFlight.id,
          type: 'TOOL_RESULT',
          timestamp,
          source: 'zcode',
          toolName: inFlight.toolName,
          filePath: inFlight.filePath,
          status: 'error',
          error: firstLine(resultText, 200),
          summary: `${inFlight.toolName} reported an error`,
        });
      }
    }

    // The turn's own output: message + tool calls.
    const responseText = obj.response?.text ?? '';
    if (responseText.trim().length > 0) {
      events.push({
        id: nextId(),
        sessionId: sid,
        agentId: 'main',
        type: 'MESSAGE',
        timestamp,
        source: 'zcode',
        summary: firstLine(responseText),
        metadata: { role: 'assistant' },
      });
    }
    for (const call of obj.response?.toolCalls ?? []) {
      if (call === undefined || typeof call.name !== 'string') continue;
      const toolName = call.name;
      const input = call.input ?? {};
      const callId = typeof call.id === 'string' && call.id.length > 0 ? call.id : `unseen-${nextId()}`;
      const filePathRaw = inputString(input, 'file_path') ?? inputString(input, 'path') ?? inputString(input, 'notebook_path');

      if (toolName in IMPL_TOOLS) {
        const type: PigeonEventType = IMPL_TOOLS[toolName] ?? 'FILE_CHANGED';
        const filePath = filePathRaw !== null ? displayPath(filePathRaw) : null;
        const eventId = nextId();
        pending.set(callId, { id: eventId, kind: 'file', verificationKind: null, command: null, toolName, filePath, agentId: 'main' });
        events.push({
          id: eventId,
          sessionId: sid,
          agentId: 'main',
          type,
          timestamp,
          source: 'zcode',
          toolName,
          filePath,
          status: 'running',
          summary: `${type === 'FILE_CREATED' ? 'Created' : 'Modified'} ${filePath ?? '(unknown file)'}`,
        });
      } else if (READ_TOOLS.has(toolName) && filePathRaw !== null) {
        events.push({
          id: nextId(),
          sessionId: sid,
          agentId: 'main',
          type: 'FILE_READ',
          timestamp,
          source: 'zcode',
          toolName,
          filePath: displayPath(filePathRaw),
          status: 'ok',
          summary: `Read ${displayPath(filePathRaw)}`,
        });
      } else if (toolName === 'Bash' && typeof input.command === 'string') {
        const verificationKind = classifyVerificationCommand(input.command);
        const eventId = nextId();
        pending.set(callId, { id: eventId, kind: 'command', verificationKind, command: input.command, toolName, filePath: null, agentId: 'main' });
        const type: PigeonEventType =
          verificationKind === 'test' ? 'TEST_STARTED'
            : verificationKind === 'build' ? 'BUILD_STARTED'
              : 'COMMAND_STARTED';
        events.push({
          id: eventId,
          sessionId: sid,
          agentId: 'main',
          type,
          timestamp,
          source: 'zcode',
          toolName,
          command: input.command,
          status: 'running',
          summary: `Ran ${input.command}`,
          metadata: verificationKind !== null ? { verificationKind } : null,
        });
      } else if (SPAWN_TOOLS.has(toolName)) {
        const task = firstLine(inputString(input, 'description') ?? inputString(input, 'prompt') ?? '', 120) || null;
        const subId = `sub-${callId.slice(-8)}`;
        const eventId = nextId();
        pending.set(callId, { id: eventId, kind: 'subagent', verificationKind: null, command: null, toolName, filePath: null, agentId: subId });
        events.push({
          id: eventId,
          sessionId: sid,
          agentId: subId,
          parentAgentId: 'main',
          type: 'SUBAGENT_STARTED',
          timestamp,
          source: 'zcode',
          toolName,
          status: 'running',
          summary: task !== null ? `Subagent started: ${task}` : 'Subagent started',
          metadata: { task },
        });
      } else {
        const eventId = nextId();
        pending.set(callId, {
          id: eventId,
          kind: 'tool',
          verificationKind: null,
          command: null,
          toolName,
          filePath: filePathRaw !== null ? displayPath(filePathRaw) : null,
          agentId: 'main',
        });
        events.push({
          id: eventId,
          sessionId: sid,
          agentId: 'main',
          type: 'TOOL_CALLED',
          timestamp,
          source: 'zcode',
          toolName,
          filePath: filePathRaw !== null ? displayPath(filePathRaw) : null,
          status: 'running',
          summary: filePathRaw !== null ? `${toolName} ${displayPath(filePathRaw)}` : `Called ${toolName}`,
        });
      }
    }
  });

  return { events, warnings, skippedLines, sessionId };
}

export function looksLikeZCodeModelIo(text: string): boolean {
  const lines = text.split(/\r?\n/u).filter((l) => l.trim().length > 0).slice(0, 5);
  let hits = 0;
  for (const l of lines) {
    try {
      const obj = JSON.parse(l.trim()) as ZCodeLine;
      if (typeof obj.sessionId === 'string' && obj.response !== undefined &&
        (obj.response.toolCalls !== undefined || typeof obj.response.text === 'string')) {
        hits++;
      }
    } catch {
      // keep sniffing
    }
  }
  return hits >= 1;
}
