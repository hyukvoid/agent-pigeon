/**
 * Claude Code session JSONL parser (v0.1: single-agent, Claude-first).
 *
 * Reads ~/.claude/projects/<munged-project>/<session-uuid>.jsonl and emits
 * sanitized replay events. Raw content (commands, file paths, tool output,
 * prompts) is used in memory for hashing/counting and then dropped — it is
 * never written anywhere.
 */

import { createHash } from 'node:crypto';
import { contentFingerprint, pathFingerprint } from './fingerprint.js';
import { loadOrCreateSecret } from './secret.js';
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

/** Test/spec file paths (POC-04C.2): editing these is verification preparation, not a new implementation attempt. */
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[a-z]+$/i;

/**
 * Package-manager script indirection. Most repositories do not run `tsc` or
 * `jest` directly — they run `npm run typecheck`, `pnpm run test:unit`,
 * `yarn e2e`. Matching only the underlying tool makes real verification
 * invisible to the classifier (this repository's own fast check is
 * `npm run typecheck`).
 *
 * Deliberately excluded: lint/format/prettier/eslint scripts. They neither
 * compile nor execute the code, so they are not proof that a change works.
 */
const SCRIPT_TEST = String.raw`(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:test|tests|spec|e2e|unit)(?::[\w:.-]+)?\b`;
const SCRIPT_BUILD = String.raw`(?:npm|pnpm|yarn|bun)(?:\s+run)?\s+(?:build|typecheck|type-check|tsc|compile|check|verify|ci)(?::[\w:.-]+)?\b`;

const TEST_PATTERN = new RegExp(
  String.raw`\b(${SCRIPT_TEST}|jest\b|vitest\b|pytest\b|node --test\b|playwright\b|go test\b|cargo test\b|gradlew?(?:\.bat)?\b[^|;&]*\btest\b|mvn\b[^|;&]*\btest\b|dotnet test\b)`,
  'i',
);
const DEVICE_PATTERN = /\b(adb(?:\.exe)?\s|agent-device\s|emulator\s|maestro\s|xcrun\s)/i;
const BUILD_PATTERN = new RegExp(
  String.raw`\b(${SCRIPT_BUILD}|gradlew?(?:\.bat)?\s|gradle\s|mvn\s|make\b|cmake\b|tsc\b|go build\b|dotnet build\b|cargo build\b)`,
  'i',
);

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
 * digits, hex blobs and paths are masked, then up to THREE content lines are
 * hashed (POC-04C hardening). Harness wrapper lines ("Script failed",
 * "Command failed", bare exit-code statements) are discarded BEFORE hashing —
 * hashing them caused every failed command in every project to share one
 * signature (a real false-positive source found by POC-04C auditing).
 * The text itself is discarded; only the digest survives.
 */
export function failureSignature(text: string): string {
  const normalized = text
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<PATH>')
    .replace(/(?:\/(?:home|Users|root|tmp|var|mnt)\/\S+)/g, '<PATH>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<HEX>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<N>');

  const GENERIC_LINE =
    /^(?:(?:script|command|shell|exec(?:ution)?)\s+(?:failed|completed|error)?\s*[:]?|wall time:? <N>(?: seconds)?|output:?|exit code[:\s]*<N>|process exited(?: with code <N>)?|failed|error|<N>)\s*$/i;

  const contentLines = normalized
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 3 && !GENERIC_LINE.test(line));

  if (contentLines.length === 0) {
    // nothing content-bearing: fall back to a fixed "opaque failure" identity
    return sha8('<opaque-failure>');
  }
  // Error summaries live at the END of build/test output — hash the LAST
  // three content lines. (First lines are usually harness wrappers.)
  return sha8(contentLines.slice(-3).join('\n'));
}

interface ToolResultContent {
  type?: string;
  text?: string;
}

/** Change-content fields carried by implementation tool inputs. */
interface ImplementationInput {
  file_path?: string | string[];
  old_string?: string;
  new_string?: string;
  content?: string;
  new_source?: string;
  edits?: Array<{ old_string?: string; new_string?: string }>;
}

/**
 * Content-based changeFingerprint (HMAC-SHA256, 128-bit; POC-03.5.1).
 * Prefers the canonical change payload so "same file, different patch"
 * hashes differently; falls back to the HMAC path-list hash when no content
 * is available. Content is hashed and immediately discarded — the secret
 * never leaves the machine.
 */
function changeIdentityFromInput(
  input: ImplementationInput,
  secret: string | null,
): {
  count: number | null;
  hash: string | null;
  basis: 'content' | 'path' | null;
} {
  const paths: string[] = [];
  if (typeof input.file_path === 'string') paths.push(input.file_path);
  else if (Array.isArray(input.file_path)) {
    paths.push(...input.file_path.filter((p): p is string => typeof p === 'string'));
  }
  const unique = [...new Set(paths)];
  const pathHash = unique.length > 0 && secret !== null ? pathFingerprint(secret, unique) : null;

  let op: 'edit' | 'write' | 'notebook' | 'multi-edit' | null = null;
  let parts: string[] | null = null;
  if (typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    op = 'edit';
    parts = [input.old_string, input.new_string];
  } else if (typeof input.content === 'string') {
    op = 'write';
    parts = [input.content];
  } else if (typeof input.new_source === 'string') {
    op = 'notebook';
    parts = [input.new_source];
  } else if (Array.isArray(input.edits) && input.edits.length > 0) {
    const pairs = input.edits.flatMap((e) =>
      typeof e.old_string === 'string' && typeof e.new_string === 'string'
        ? [e.old_string, e.new_string]
        : [],
    );
    if (pairs.length > 0) {
      op = 'multi-edit';
      parts = pairs;
    }
  }

  if (op !== null && parts !== null && secret !== null) {
    return {
      count: unique.length > 0 ? unique.length : null,
      hash: contentFingerprint(secret, op, parts),
      basis: 'content',
    };
  }
  return { count: unique.length > 0 ? unique.length : null, hash: pathHash, basis: pathHash !== null ? 'path' : null };
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


function implementationTouchesOnlyTestFiles(input: ImplementationInput): boolean {
  const paths: string[] = [];
  if (typeof input.file_path === 'string') paths.push(input.file_path);
  else if (Array.isArray(input.file_path)) {
    paths.push(...input.file_path.filter((p): p is string => typeof p === 'string'));
  }
  if (paths.length === 0) return false;
  return paths.every((p) => TEST_PATH.test(p));
}

/** Parse one session JSONL (as a string) into sanitized events + meta. */
export interface ParseOptions {
      /**
       * Compute HMAC content fingerprints (default true — the research pipeline
       * needs them). Replay passes false: replay needs no fingerprints, and
       * skipping them keeps replay genuinely read-only (no secret file is ever
       * created).
       */
      fingerprints?: boolean;
    }

export function parseClaudeSessionJsonl(
  text: string,
  sessionId8Fallback = 'session',
  opts: ParseOptions = {},
): ReplaySession {
  const lines = text.split(/\r?\n/u).filter((line) => line.length > 0);
  const meta: ReplaySessionMeta = {
    sessionId8: sessionId8Fallback,
    lineCount: lines.length,
    parsedLineCount: 0,
    startedAtIso: null,
  };
  const events: SanitizedReplayEvent[] = [];

  let epochMs: number | null = null;
  // Model-turn ordinal: each assistant message is one turn/batch (POC-04C.2).
  let turnSeq = 0;
  // Per-install HMAC key for change/path fingerprints. Only loaded when
  // fingerprints are requested — replay runs without it (genuinely read-only).
  const secret = opts.fingerprints === false ? null : loadOrCreateSecret();
  /** tool_use_id -> in-flight call (toolName + kind), for pairing results. */
  const pending = new Map<
    string,
    {
      toolName: string;
      verificationKind: VerificationKind | null;
      change: { count: number | null; hash: string | null; basis: 'content' | 'path' | null };
    }
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

    // One assistant message = one model turn / tool batch (POC-04C.2). All
    // implementation calls inside it are ONE logical change, not N attempts.
    const messageHasImpl =
      obj.type === 'assistant' &&
      content.some((c) => c.type === 'tool_use' && typeof c.name === 'string' && IMPLEMENTATION_TOOLS.includes(c.name));
    if (messageHasImpl) turnSeq++;
    const messageTurn: number | null = messageHasImpl ? turnSeq : null;

    for (const block of content) {
      if (obj.type === 'assistant' && block.type === 'tool_use' && typeof block.name === 'string') {
        const toolName = block.name;
        if (IMPLEMENTATION_TOOLS.includes(toolName)) {
          const input = (block.input ?? {}) as ImplementationInput;
          const change = changeIdentityFromInput(input, secret);
          const testOnly = implementationTouchesOnlyTestFiles(input);
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
            fingerprintBasis: change.basis,
            failureSignatureHash: null,
            testsFailedCount: null,
            durationMs: null,
            turn: messageTurn,
            testOnly,
          });
        } else if (toolName === 'Bash') {
          const command = typeof (block.input as { command?: unknown } | undefined)?.command === 'string'
            ? (block.input as { command: string }).command
            : '';
          const verificationKind = classifyVerificationCommand(command);
          const id = (block as unknown as { id?: string }).id ?? '';
          pending.set(id, { toolName, verificationKind, change: { count: null, hash: null, basis: null } });
          if (verificationKind !== null) {
            events.push({
              eventType: 'verification',
              timestampOffset: offset,
              toolName,
              ok: null,
              verificationKind,
              changedFilesCount: null,
              changeSetHash: null,
            fingerprintBasis: null,
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
            fingerprintBasis: null,
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
            fingerprintBasis: null,
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
