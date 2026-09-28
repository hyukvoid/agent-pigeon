/**
 * Codex adapter (support level: PARTIAL) — maps Codex rollout JSONL sessions
 * to Pigeon Events. Field shapes were verified against real local rollouts
 * (~/.codex/sessions/**\/*.jsonl), not just documentation.
 *
 * What is recovered (evidence):
 *  - session_meta → SESSION_STARTED (id, cwd)
 *  - response_item message → MESSAGE (first line as summary)
 *  - custom_tool_call / function_call apply_patch → FILE_CREATED/CHANGED/DELETED
 *  - shell/exec calls → COMMAND_STARTED … COMMAND_COMPLETED (exit code parsed
 *    from the output when the log shows it)
 *  - call_id pairing between call and output
 *
 * What is NOT recoverable from this format (hence PARTIAL):
 *  - subagent/parallel-agent structure (Codex logs none)
 *  - structured test/build outcomes (only command exit codes)
 *  - explicit failure/error records beyond command exit codes
 */

import { classifyVerificationCommand, extractFailedCount } from '../replay/claude.js';
import type { PigeonEvent, PigeonEventType } from '../pigeon/types.js';

export interface CodexParseResult {
  events: PigeonEvent[];
  warnings: string[];
  skippedLines: number;
  sessionId: string | null;
}

interface CodexOutputPart {
  type?: string;
  text?: string;
}

interface CodexLine {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  payload?: {
    type?: string;
    session_id?: string;
    id?: string;
    cwd?: string;
    role?: string;
    content?: CodexOutputPart[];
    name?: string;
    input?: string;
    arguments?: string;
    call_id?: string;
    output?: string | CodexOutputPart[];
  };
}

const SHELL_TOOL_NAMES = new Set(['shell', 'exec', 'local_shell', 'container.exec', 'exec_command']);

function iso(ms: number | null): string {
  return new Date(ms ?? 0).toISOString();
}

function outputText(output: string | CodexOutputPart[] | undefined): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n');
  }
  return '';
}

function firstLine(text: string, max = 160): string {
  const line = text.split(/\r?\n/u).map((l) => l.trim()).find((l) => l.length > 0) ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/** Display-safe path: strip the session cwd prefix and drive letters. */
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

/** Extract the file paths an apply_patch call touches, by operation. */
export function parseApplyPatchPaths(patchText: string): { op: 'add' | 'update' | 'delete'; path: string }[] {
  const out: { op: 'add' | 'update' | 'delete'; path: string }[] = [];
  // Real rollouts sometimes carry the patch inside a JS string literal, where
  // newlines and backslashes are still escaped ("*** Begin Patch\n*** Add
  // File: C:\\dir\\file"). Unescape so the header lines become matchable.
  const normalized = patchText.includes('*** Begin Patch')
    ? patchText.replace(/\\\\/gu, '\\').replace(/\\n/gu, '\n').replace(/\\r/gu, '')
    : patchText;
  const patterns: [RegExp, 'add' | 'update' | 'delete'][] = [
    [/^\*\*\* Add File: (.+)$/gmu, 'add'],
    [/^\*\*\* Update File: (.+)$/gmu, 'update'],
    [/^\*\*\* Delete File: (.+)$/gmu, 'delete'],
  ];
  for (const [pattern, op] of patterns) {
    for (const match of normalized.matchAll(pattern)) {
      const path = (match[1] ?? '').trim();
      if (path.length > 0) out.push({ op, path });
    }
  }
  return out;
}

function extractCommand(name: string, input: string | undefined, args: string | undefined): string | null {
  if (args !== undefined && args.length > 0) {
    try {
      const parsed = JSON.parse(args) as { command?: string | string[] };
      if (typeof parsed.command === 'string') return parsed.command;
      if (Array.isArray(parsed.command)) return parsed.command.join(' ');
    } catch {
      // fall through to raw input
    }
  }
  if (typeof input === 'string' && input.length > 0) {
    // Some rollouts wrap commands as JS-ish tool input. Two observed shapes:
    //   tools.exec_command("npm test")
    //   tools.exec_command({cmd:"npm test", workdir:"...", ...})
    const object = /exec_command\(\s*\{\s*cmd:\s*"((?:[^"\\]|\\.)*)"/u.exec(input);
    if (object !== null) return (object[1] ?? '').replace(/\\"/gu, '"').replace(/\\n/gu, ' ');
    const quoted = /exec_command\(\s*"((?:[^"\\]|\\.)*)"/u.exec(input);
    if (quoted !== null) return (quoted[1] ?? '').replace(/\\"/gu, '"');
    if (SHELL_TOOL_NAMES.has(name)) return firstLine(input, 300);
  }
  return null;
}

function exitCodeFromText(text: string): number | null {
  const match = /exit code[:\s]+(\d+)/iu.exec(text);
  return match !== null ? Number(match[1]) : null;
}

export function parseCodexPigeonSession(text: string, fallbackId = 'codex-session'): CodexParseResult {
  const events: PigeonEvent[] = [];
  const warnings: string[] = [];
  let skippedLines = 0;
  let sessionId = fallbackId;
  let seq = 0;
  const nextId = (): string => `cx${String(++seq).padStart(5, '0')}`;

  interface PendingCall {
    id: string | null;
    kind: 'command' | 'other' | 'patch';
    command: string | null;
    toolName: string;
    startedMs: number | null;
    /** Set when the command was classified as a test/build verification run. */
    verificationKind: 'test' | 'build' | 'device' | null;
    patchEventIds?: string[];
  }
  const pending = new Map<string, PendingCall>();
  let cwd: string | null = null;

  const lines = text.split(/\r?\n/u);
  lines.forEach((line, lineIndex) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let obj: CodexLine;
    try {
      obj = JSON.parse(trimmed) as CodexLine;
    } catch {
      skippedLines++;
      warnings.push(`line ${lineIndex + 1}: invalid JSON skipped`);
      return;
    }
    const ms = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
    if (!Number.isFinite(ms)) {
      skippedLines++;
      return;
    }
    const timestamp = iso(ms);
    const payload = obj.payload ?? {};

    if (obj.type === 'session_meta') {
      sessionId = payload.session_id ?? payload.id ?? sessionId;
      cwd = typeof payload.cwd === 'string' ? payload.cwd : cwd;
      events.push({
        id: nextId(),
        sessionId,
        agentId: 'main',
        type: 'SESSION_STARTED',
        timestamp,
        source: 'codex',
        summary: cwd !== null ? `Session started in ${cwd}` : 'Session started',
        metadata: { cwd },
      });
      return;
    }
    if (obj.type !== 'response_item') {
      return; // turn_context, event_msg, etc. — not agent activity evidence
    }

    switch (payload.type) {
      case 'message': {
        const text = outputText(payload.content);
        if (text.length > 0) {
          events.push({
            id: nextId(),
            sessionId,
            agentId: 'main',
            type: 'MESSAGE',
            timestamp,
            source: 'codex',
            summary: firstLine(text),
            metadata: { role: payload.role ?? 'assistant' },
          });
        }
        break;
      }
      case 'custom_tool_call':
      case 'function_call': {
        const toolName = payload.name ?? 'unknown';
        const rawInput = payload.input ?? payload.arguments ?? '';
        const callId = payload.call_id ?? `unknown-${seq}`;
        // apply_patch arrives either as its own tool call or embedded in an
        // exec-style command (real rollouts use both shapes).
        if (toolName === 'apply_patch' || rawInput.includes('*** Begin Patch')) {
          const patchEventIds: string[] = [];
          for (const { op, path } of parseApplyPatchPaths(rawInput)) {
            const type: PigeonEventType = op === 'add' ? 'FILE_CREATED' : op === 'delete' ? 'FILE_DELETED' : 'FILE_CHANGED';
            const eventId = nextId();
            patchEventIds.push(eventId);
            events.push({
              id: eventId,
              sessionId,
              agentId: 'main',
              type,
              timestamp,
              source: 'codex',
              toolName: 'apply_patch',
              filePath: displayPath(path, cwd),
              status: 'running',
              summary: `${op === 'add' ? 'Created' : op === 'delete' ? 'Deleted' : 'Modified'} ${displayPath(path, cwd)}`,
              metadata: { callId },
            });
          }
          if (patchEventIds.length > 0) {
            pending.set(callId, {
              id: null,
              kind: 'patch',
              command: 'apply_patch',
              toolName: 'apply_patch',
              startedMs: ms,
              verificationKind: null,
              patchEventIds,
            });
          }
        } else if (SHELL_TOOL_NAMES.has(toolName)) {
          const command = extractCommand(toolName, payload.input, payload.arguments);
          const verificationKind = command !== null ? classifyVerificationCommand(command) : null;
          const eventId = nextId();
          pending.set(callId, {
            id: eventId,
            kind: 'command',
            command,
            toolName,
            startedMs: ms,
            verificationKind,
          });
          const type: PigeonEventType =
            verificationKind === 'test' ? 'TEST_STARTED'
              : verificationKind === 'build' ? 'BUILD_STARTED'
                : 'COMMAND_STARTED';
          events.push({
            id: eventId,
            sessionId,
            agentId: 'main',
            type,
            timestamp,
            source: 'codex',
            toolName,
            command,
            status: 'running',
            summary: command !== null ? `Ran ${firstLine(command, 120)}` : `Ran ${toolName}`,
            metadata: verificationKind !== null ? { verificationKind } : null,
          });
        } else {
          const eventId = nextId();
          pending.set(callId, { id: eventId, kind: 'other', command: null, toolName, startedMs: ms, verificationKind: null });
          events.push({
            id: eventId,
            sessionId,
            agentId: 'main',
            type: 'TOOL_CALLED',
            timestamp,
            source: 'codex',
            toolName,
            status: 'running',
            summary: `Called ${toolName}`,
            metadata: { callId },
          });
        }
        break;
      }
      case 'custom_tool_call_output':
      case 'function_call_output': {
        const callId = payload.call_id ?? '';
        const inFlight = pending.get(callId);
        const text = outputText(payload.output);
        if (inFlight === undefined) break;
        if (inFlight.kind === 'patch') {
          const exitCode = exitCodeFromText(text);
          const failed = exitCode !== null ? exitCode !== 0 : false;
          if (failed) {
            events.push({
              id: nextId(),
              sessionId,
              agentId: 'main',
              type: 'COMMAND_COMPLETED',
              timestamp,
              source: 'codex',
              toolName: 'apply_patch',
              command: 'apply_patch',
              exitCode,
              status: 'error',
              error: firstLine(text, 200),
              summary: 'apply_patch failed',
              metadata: { callId, outputSnippet: firstLine(text, 300) },
            });
          } else {
            // The patch applied: the file events are the success record.
            for (const id of inFlight.patchEventIds ?? []) {
              const emitted = events.find((e) => e.id === id);
              if (emitted !== undefined) emitted.status = 'ok';
            }
          }
        } else if (inFlight.kind === 'command') {
          const exitCode = exitCodeFromText(text);
          const failed = exitCode !== null ? exitCode !== 0 : false;
          const kind = inFlight.verificationKind;
          const type: PigeonEventType =
            kind === 'test' ? (failed ? 'TEST_FAILED' : 'TEST_PASSED')
              : kind === 'build' ? (failed ? 'BUILD_FAILED' : 'BUILD_PASSED')
                : 'COMMAND_COMPLETED';
          const failedCount = kind === 'test' && failed ? extractFailedCount(text) : null;
          events.push({
            id: nextId(),
            sessionId,
            agentId: 'main',
            parentId: inFlight.id,
            type,
            timestamp,
            source: 'codex',
            toolName: inFlight.toolName,
            command: inFlight.command,
            exitCode,
            status: failed ? 'error' : 'ok',
            error: failed ? firstLine(text, 200) : null,
            summary:
              type === 'TEST_FAILED' ? `${firstLine(inFlight.command ?? 'tests', 80)} — ${failedCount !== null ? `${failedCount} test${failedCount === 1 ? '' : 's'} failed` : 'tests failed'}`
                : type === 'TEST_PASSED' ? `${firstLine(inFlight.command ?? 'tests', 80)} — passed`
                  : type === 'BUILD_FAILED' ? `${firstLine(inFlight.command ?? 'build', 80)} — failed`
                    : type === 'BUILD_PASSED' ? `${firstLine(inFlight.command ?? 'build', 80)} — passed`
                      : inFlight.command !== null ? `${firstLine(inFlight.command, 120)} finished${exitCode !== null ? ` (exit ${exitCode})` : ''}`
                        : 'command finished',
            metadata: {
              callId,
              outputSnippet: firstLine(text, 300),
              ...(failedCount !== null ? { testsFailedCount: failedCount } : {}),
            },
          });
        } else {
          events.push({
            id: nextId(),
            sessionId,
            agentId: 'main',
            parentId: inFlight.id,
            type: 'TOOL_RESULT',
            timestamp,
            source: 'codex',
            toolName: inFlight.toolName,
            status: 'ok',
            summary: `${inFlight.toolName} result`,
            metadata: { callId, outputSnippet: firstLine(text, 300) },
          });
        }
        pending.delete(callId);
        break;
      }
      default:
        // reasoning items etc. — intentionally not agent-observable evidence
        break;
    }
  });

  return { events, warnings, skippedLines, sessionId };
}

export function looksLikeCodexRollout(text: string): boolean {
  const lines = text.split(/\r?\n/u).filter((l) => l.trim().length > 0).slice(0, 5);
  return lines.some((l) => {
    try {
      const obj = JSON.parse(l.trim()) as CodexLine;
      return obj.type === 'session_meta' || (obj.type === 'response_item' && typeof obj.ordinal === 'number');
    } catch {
      return false;
    }
  });
}
