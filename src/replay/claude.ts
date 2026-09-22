/**
 * Claude Code session JSONL parser (v0.1: single-agent, Claude-first).
 *
 * Reads ~/.claude/projects/<munged-project>/<session-uuid>.jsonl and emits
 * sanitized replay events. Raw content (commands, file paths, tool output,
 * prompts) is used in memory for hashing/counting and then dropped — it is
 * never written anywhere.
 */

import { createHash } from 'node:crypto';
import type { SanitizedReplayEvent, VerificationKind } from './types.js';
import { IMPLEMENTATION_TOOLS } from './types.js';

export interface ReplaySessionMeta {
  /** First 8 chars of the session UUID. */
  sessionId8: string;
  lineCount: number;
  parsedLineCount: number;
  /** ISO timestamp of the first timestamped line. Not persisted in reports. */
  startedAtIso: string | null;
}

export interface ReplaySession {
  meta: ReplaySessionMeta;
  events: SanitizedReplayEvent[];
}

export interface ClaudeSessionLine {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  isSidechain?: boolean;
  message?: {
    content?: Array<{
      type?: string;
      name?: string;
      input?: { command?: string; file_path?: string | string[]; edits?: unknown[] };
      content?: string | Array<{ type?: string; text?: string }>;
      is_error?: boolean;
    }>;
  };
  toolUseResult?: {
    stdout?: string;
    stderr?: string;
    durationMs?: number;
    filePath?: string | null;
    filenames?: string[] | null;
    type?: string;
  } | null;
}

function sha8(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

const TEST_PATTERN =
  /\b(npm (?:run )?test|pnpm (?:run )?test|yarn test|jest\b|vitest\b|pytest\b|playwright\b|go test\b|cargo test\b|gradlew?(?:\.bat)?\b[^|;&]*\btest\b|mvn\b[^|;&]*\btest\b|dotnet test\b)/i;
const DEVICE_PATTERN = /\b(adb(?:\.exe)?\s|agent-device\s|emulator\s|maestro\s|xcrun\s)/i;
const BUILD_PATTERN =
  /\b(gradlew?(?:\.bat)?\s|gradle\s|mvn\s|make\b|cmake\b|tsc\b|npm run build\b|pnpm run build\b|yarn build\b|go build\b|dotnet build\b|cargo build\b)/i;

export function classifyVerificationCommand(command: string): VerificationKind | null {
  if (TEST_PATTERN.test(command)) return 'test';
  if (DEVICE_PATTERN.test(command)) return 'device';
  if (BUILD_PATTERN.test(command)) return 'build';
  return null;
}

const FAILURE_COUNT_PATTERNS: readonly RegExp[] = [
  /(\d+)\s+\/\s*\d+\s+tests?\s+failed/i,
  /(\d+)\s+(?:tests?|specs?|examples?)\s+failed/i,
  /(\d+)\s+failing\b/i,
  /Tests?:\s*(\d+)\s*failed/i,
];

/** Extract only a NUMBER from failure-shaped text; never returns any words. */
export function extractFailedCount(text: string): number | null {
  for (const pattern of FAILURE_COUNT_PATTERNS) {
    const match = pattern.exec(text);
    if (match !== null) {
      const value = Number(match[1]);
      if (Number.isFinite(value)) return value;
    }
  }
  return null;
}

/**
 * Normalize error text so the same failure hashes the same across attempts:
 * digits, hex blobs and paths are masked before hashing. The result is a
 * short identity hash — the text itself is discarded.
 */
export function failureSignature(text: string): string {
  const normalized = text
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<PATH>')
    .replace(/(?:\/(?:home|Users|root|tmp|var|mnt)\/\S+)/g, '<PATH>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<HEX>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<N>');
  const firstMeaningful = normalized
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 3)[0];
  return sha8(firstMeaningful ?? normalized);
}

interface ToolResultContent {
  type?: string;
  text?: string;
}

function contentText(content: string | ToolResultContent[] | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === 'object' && part !== null && typeof part.text === 'string' ? part.text : ''))
      .join('\n');
  }
  return '';
}

function changedFilesFromInput(input: { file_path?: string | string[] }): {
  count: number | null;
  hash: string | null;
} {
  const paths: string[] = [];
  if (typeof input.file_path === 'string') paths.push(input.file_path);
  else if (Array.isArray(input.file_path)) {
    paths.push(...input.file_path.filter((p): p is string => typeof p === 'string'));
  }
  const unique = [...new Set(paths)];
  return {
    count: unique.length > 0 ? unique.length : null,
    hash: unique.length > 0 ? sha8([...unique].sort().join('\n')) : null,
  };
}

/** Parse one session JSONL (as a string) into sanitized events + meta. */
export function parseClaudeSessionJsonl(text: string, sessionId8Fallback = 'session'): ReplaySession {
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  const meta: ReplaySessionMeta = {
    sessionId8: sessionId8Fallback,
    lineCount: lines.length,
    parsedLineCount: 0,
    startedAtIso: null,
  };
  const events: SanitizedReplayEvent[] = [];

  let epochMs: number | null = null;
  /** tool_use_id -> in-flight call (toolName + kind), for pairing results. */
  const pending = new Map<
    string,
    { toolName: string; verificationKind: VerificationKind | null; change: { count: number | null; hash: string | null } }
  >();

  for (const line of lines) {
    let obj: ClaudeSessionLine;
    try {
      obj = JSON.parse(line) as ClaudeSessionLine;
    } catch {
      continue;
    }
    if (obj.sessionId !== undefined) {
      meta.sessionId8 = obj.sessionId.slice(0, 8);
    }
    if (obj.type !== 'assistant' && obj.type !== 'user') continue;
    meta.parsedLineCount++;

    let offset: number | null = null;
    if (typeof obj.timestamp === 'string') {
      const ms = Date.parse(obj.timestamp);
      if (Number.isFinite(ms)) {
        if (epochMs === null) {
          epochMs = ms;
          meta.startedAtIso = obj.timestamp;
        }
        offset = ms - epochMs;
      }
    }

    const content = obj.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (obj.type === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string') {
        const toolName = block.name;
        if (IMPLEMENTATION_TOOLS.includes(toolName)) {
          const change = changedFilesFromInput((block.input ?? {}) as { file_path?: string | string[] });
          const id = (block as unknown as { id?: string }).id ?? '';
          pending.set(id, { toolName, verificationKind: null, change });
          events.push({
            eventType: 'implementation',
            timestampOffset: offset,
            toolName,
            ok: null,
            verificationKind: null,
            changedFilesCount: change.count,
            changeSetHash: change.hash,
            failureSignatureHash: null,
            testsFailedCount: null,
            durationMs: null,
          });
        } else if (toolName === 'Bash') {
          const command = typeof (block.input as { command?: unknown } | undefined)?.command === 'string'
            ? (block.input as { command: string }).command
            : '';
          const verificationKind = classifyVerificationCommand(command);
          const id = (block as unknown as { id?: string }).id ?? '';
          pending.set(id, { toolName, verificationKind, change: { count: null, hash: null } });
          if (verificationKind !== null) {
            events.push({
              eventType: 'verification',
              timestampOffset: offset,
              toolName,
              ok: null,
              verificationKind,
              changedFilesCount: null,
              changeSetHash: null,
              failureSignatureHash: null,
              testsFailedCount: null,
              durationMs: null,
            });
          } else {
            events.push({
              eventType: 'other',
              timestampOffset: offset,
              toolName,
              ok: null,
              verificationKind: null,
              changedFilesCount: null,
              changeSetHash: null,
              failureSignatureHash: null,
              testsFailedCount: null,
              durationMs: null,
            });
          }
        } else {
          events.push({
            eventType: 'observation',
            timestampOffset: offset,
            toolName,
            ok: null,
            verificationKind: null,
            changedFilesCount: null,
            changeSetHash: null,
            failureSignatureHash: null,
            testsFailedCount: null,
            durationMs: null,
          });
        }
      }

      if (obj.type === 'user' && block.type === 'tool_result') {
        const toolUseId = (block as unknown as { tool_use_id?: string }).tool_use_id ?? '';
        const inFlight = pending.get(toolUseId);
        const isError = (block as unknown as { is_error?: boolean }).is_error === true;
        const resultText = contentText(block.content);
        const tur = obj.toolUseResult ?? {};
        const outputText = `${typeof tur.stderr === 'string' ? tur.stderr : ''}\n${resultText}`;

        // Find the matching event (the last event of this call's kind without ok set).
        for (let i = events.length - 1; i >= 0; i--) {
          const event = events[i];
          if (event === undefined) continue;
          const matches =
            inFlight !== undefined &&
            ((inFlight.verificationKind !== null && event.eventType === 'verification' && event.ok === null) ||
              (inFlight.verificationKind === null && inFlight.toolName === event.toolName && event.ok === null));
          if (!matches) continue;
          event.ok = !isError;
          event.durationMs = typeof tur.durationMs === 'number' ? tur.durationMs : null;
          if (event.eventType === 'verification' && inFlight.verificationKind !== null) {
            if (isError) {
              event.failureSignatureHash = failureSignature(outputText);
              const failed = extractFailedCount(outputText);
              event.testsFailedCount = failed;
            } else if (inFlight.verificationKind === 'test') {
              event.testsFailedCount = 0;
            }
          }
          break;
        }
      }
    }
  }

  return { meta, events };
}
