/**
 * Codex offline session adapter (POC-04B).
 *
 * Converts Codex rollout JSONL (~/.codex/sessions) into the SAME sanitized
 * event model the Claude parser produces. Offline only — no live Codex
 * support. Raw prompts, reasoning, source, shell output and paths are used
 * in memory for hashing/counting and never persisted.
 *
 * Mapped surfaces (validated against the local corpus):
 *  - response_item/custom_tool_call      name=apply_patch, input=patch text
 *                                        (*** Begin Patch … Update/Add File)
 *  - response_item/custom_tool_call      name=exec, input=plain command string
 *  - response_item/function_call         name=shell_command, arguments={command,…}
 *  - response_item/custom_tool_call_output / function_call_output
 *        paired via call_id; output = array of {text,type} elements
 *  - token_usage_record                  cumulative thread_token_usage
 *        (record timestamps allow per-window token deltas)
 */

import { contentFingerprint, pathFingerprint } from './fingerprint.js';
import { loadOrCreateSecret } from './secret.js';
import type { SanitizedReplayEvent, VerificationKind } from './types.js';
import { classifyVerificationCommand, extractFailedCount, failureSignature } from './claude.js';

export interface CodexTokenRecord {
  timestampMs: number;
  /** Cumulative thread total at this record. */
  totalTokens: number;
}

export interface CodexSession {
  sessionId8: string;
  /** cwd value, used in memory for mobile labeling only — never persisted. */
  cwd: string | null;
  /** Epoch of event offsets (first timestamped line), null if untimed. */
  epochMs: number | null;
  /** True when any command matched a mobile/Android signal (in-memory only). */
  mobileSignal: boolean;
  events: SanitizedReplayEvent[];
  tokenRecords: CodexTokenRecord[];
}

interface CodexLine {
  type?: string;
  timestamp?: string;
  payload?: {
    type?: string;
    name?: string;
    status?: string;
    id?: unknown;
    input?: unknown;
    arguments?: unknown;
    output?: unknown;
    call_id?: string;
    cwd?: unknown;
    thread_token_usage?: { total_tokens?: unknown } | null;
  } | null;
}

const lf = (text: string): string => text.replace(/\r\n?/gu, '\n');

/** Mobile/Android context signals (spec §5) — evaluated in memory only. */
const MOBILE_PATTERN =
  /\b(adb(?:\.exe)?\s|gradlew?(?:\.bat)?\b|emulator\b|agent-device\s|logcat\b|\.apk\b|aapt\d?\s|android\b|com\.android\.\w+)/i;

/** Codex `apply_patch` unified format: extract file ops without storing them. */
function parseApplyPatch(patch: string): {
  changedFilesCount: number;
  pathHash: string | null;
  fingerprintParts: string[];
} {
  const paths: string[] = [];
  for (const match of patch.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gmu)) {
    const path = match[1]?.trim();
    if (path !== undefined && path.length > 0) paths.push(path);
  }
  const unique = [...new Set(paths)];
  return {
    changedFilesCount: unique.length,
    pathHash: unique.length > 0 ? pathFingerprintFor(unique) : null,
    // The whole patch body is the change content: materially different
    // patches hash differently, re-applying the same patch hashes the same.
    fingerprintParts: [patch],
  };
}

// Secret is per-install and stable; fingerprints across one parse share it.
let cachedSecret: string | null = null;
function secret(): string {
  cachedSecret ??= loadOrCreateSecret();
  return cachedSecret;
}
function pathFingerprintFor(paths: string[]): string {
  return pathFingerprint(secret(), paths);
}

interface PendingOutput {
  isVerification: boolean;
  verificationKind: VerificationKind | null;
  eventIndex: number;
}

/** Parse one Codex rollout JSONL into sanitized events + token records. */
export function parseCodexSessionJsonl(text: string, sessionId8Fallback = 'codex'): CodexSession {
  const lines = text.split(/\r?\n/u);
  const events: SanitizedReplayEvent[] = [];
  const tokenRecords: CodexTokenRecord[] = [];
  let sessionId8 = sessionId8Fallback;
  let cwd: string | null = null;
  let mobileSignal = false;
  let epochMs: number | null = null;
  let sawTimestamp = false;

  /** call_id → metadata for pairing outputs back to their events. */
  const pending = new Map<string, PendingOutput>();

  const pushEvent = (event: Omit<SanitizedReplayEvent, 'fingerprintBasis'> & { fingerprintBasis?: SanitizedReplayEvent['fingerprintBasis'] }): SanitizedReplayEvent => {
    const full: SanitizedReplayEvent = { fingerprintBasis: null, ...event };
    events.push(full);
    return full;
  };

  for (const line of lines) {
    if (line.length === 0) continue;
    let obj: CodexLine;
    try {
      obj = JSON.parse(line) as CodexLine;
    } catch {
      continue;
    }
    const p = obj.payload;
    if (p === null || typeof p !== 'object') continue;

    if (obj.type === 'session_meta') {
      const meta = obj.payload as unknown as { id?: unknown; cwd?: unknown };
      if (typeof meta.id === 'string') sessionId8 = meta.id.slice(0, 8);
      if (typeof meta.cwd === 'string') cwd = meta.cwd;
      continue;
    }

    let offset: number | null = null;
    if (typeof obj.timestamp === 'string') {
      const ms = Date.parse(obj.timestamp);
      if (Number.isFinite(ms)) {
        sawTimestamp = true;
        if (epochMs === null) epochMs = ms;
        offset = ms - epochMs;
      }
    }

    if (obj.type === 'token_usage_record') {
      const total = p.thread_token_usage?.total_tokens;
      const ts = typeof obj.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
      if (typeof total === 'number' && Number.isFinite(ts)) {
        tokenRecords.push({ timestampMs: ts, totalTokens: total });
      }
      continue;
    }

    const isCustomCall = obj.type === 'response_item' && p.type === 'custom_tool_call';
    const isFunctionCall = obj.type === 'response_item' && p.type === 'function_call';
    const isCustomOutput = obj.type === 'response_item' && p.type === 'custom_tool_call_output';
    const isFnOutput = obj.type === 'response_item' && p.type === 'function_call_output';

    if ((isCustomCall || isFunctionCall) && typeof p.name === 'string') {
      const callId = typeof p.call_id === 'string' ? p.call_id : typeof p.id === 'string' ? p.id : '';

      if (p.name === 'apply_patch' || p.name === 'Edit' || p.name === 'Write') {
        const patchText =
          typeof p.input === 'string'
            ? p.input
            : typeof p.arguments === 'string'
              ? (() => {
                  try {
                    const args = JSON.parse(p.arguments) as { input?: unknown; patch?: unknown };
                    return typeof args.input === 'string' ? args.input : typeof args.patch === 'string' ? args.patch : '';
                  } catch {
                    return '';
                  }
                })()
              : '';
        const parsed = parseApplyPatch(patchText);
        const basis = parsed.fingerprintParts.length > 0 ? ('content' as const) : ('path' as const);
        pending.set(callId, { isVerification: false, verificationKind: null, eventIndex: events.length });
        pushEvent({
          eventType: 'implementation',
          timestampOffset: offset,
          toolName: 'apply_patch',
          ok: null,
          verificationKind: null,
          changedFilesCount: parsed.changedFilesCount,
          changeSetHash:
            parsed.fingerprintParts.length > 0
              ? contentFingerprint(secret(), 'patch', parsed.fingerprintParts)
              : parsed.pathHash,
          fingerprintBasis: parsed.pathHash !== null || parsed.fingerprintParts.length > 0 ? basis : null,
          failureSignatureHash: null,
          testsFailedCount: null,
          durationMs: null,
        });
      } else if (p.name === 'exec' || p.name === 'shell_command') {
        let command = '';
        if (typeof p.input === 'string') command = p.input;
        else if (typeof p.arguments === 'string') {
          try {
            const args = JSON.parse(p.arguments) as { command?: unknown };
            command = Array.isArray(args.command)
              ? args.command.filter((c): c is string => typeof c === 'string').join(' ')
              : typeof args.command === 'string'
                ? args.command
                : '';
          } catch {
            command = '';
          }
        }
        const verificationKind: VerificationKind | null =
          command.length > 0 ? classifyVerificationCommand(command) : null;
        if (MOBILE_PATTERN.test(command)) mobileSignal = true;
        pending.set(callId, { isVerification: verificationKind !== null, verificationKind, eventIndex: events.length });
        pushEvent({
          eventType: verificationKind !== null ? 'verification' : 'other',
          timestampOffset: offset,
          toolName: p.name,
          ok: null,
          verificationKind,
          changedFilesCount: null,
          changeSetHash: null,
          failureSignatureHash: null,
          testsFailedCount: null,
          durationMs: null,
        });
      }
      continue;
    }

    if ((isCustomOutput || isFnOutput) && typeof p.call_id === 'string') {
      const inFlight = pending.get(p.call_id);
      if (inFlight === undefined) continue;
      pending.delete(p.call_id);
      const event = events[inFlight.eventIndex];
      if (event === undefined || event.ok !== null) continue;

      const outputText = outputArrayText(p.output);
      if (event.eventType === 'verification' && inFlight.verificationKind !== null) {
        const exitCode = extractExitCode(outputText);
        if (exitCode !== null) event.ok = exitCode === 0;
        if (event.ok === false) {
          event.failureSignatureHash = failureSignature(outputText);
          event.testsFailedCount = extractFailedCount(outputText);
        } else if (event.ok === true && inFlight.verificationKind === 'test') {
          event.testsFailedCount = 0;
        }
      }
      continue;
    }
  }

  if (!sawTimestamp && events.length > 0) {
    // Events without timestamps keep null offsets; segmentation tolerates it.
  }
  void lf;

  return {
    sessionId8,
    cwd,
    epochMs,
    mobileSignal,
    events,
    tokenRecords: tokenRecords.sort((a, b) => a.timestampMs - b.timestampMs),
  };
}

function outputArrayText(output: unknown): string {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) {
    return output
      .map((elem) =>
        elem !== null && typeof elem === 'object' && typeof (elem as { text?: unknown }).text === 'string'
          ? (elem as { text: string }).text
          : '',
      )
      .join('\n');
  }
  return '';
}

function extractExitCode(text: string): number | null {
  const match = /exit code[:\s]+(\d+)/i.exec(text);
  if (match !== null) {
    const value = Number(match[1]);
    if (Number.isFinite(value)) return value;
  }
  return null;
}

/** Aggregate cumulative token usage across a [fromMs, toMs] window. */
export function tokensInWindow(
  records: CodexTokenRecord[],
  fromMs: number,
  toMs: number,
): number | null {
  const inWindow = records.filter((r) => r.timestampMs >= fromMs && r.timestampMs <= toMs);
  if (inWindow.length === 0) return null;
  const before = records.filter((r) => r.timestampMs < fromMs);
  const startTotal = before.length > 0 ? (before[before.length - 1]?.totalTokens ?? 0) : 0;
  const endTotal = inWindow[inWindow.length - 1]?.totalTokens ?? 0;
  const delta = endTotal - startTotal;
  return delta >= 0 ? delta : null;
}
