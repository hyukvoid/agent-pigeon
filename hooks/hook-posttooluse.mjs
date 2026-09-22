#!/usr/bin/env node
/**
 * Agent Pigeon — Claude Code PostToolUse hook (POC-03 hot path).
 *
 * Contract: read one hook JSON from stdin, append ONE sanitized JSONL event,
 * exit 0 immediately. Never blocks, never fails, never talks to the network,
 * never invokes Jev, never reads transcripts or git. All heavy work happens
 * in the offline worker (poc:03), not here.
 *
 * Stored fields (normalized metadata only — spec §5):
 *   ts, sessionId (8 chars), toolName, ok (tool success if determinable),
 *   fileHash (sha256-8 of the edited file path — never the path itself),
 *   verificationKind (test|build|device|other for Bash commands — never the
 *   command text).
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const EVENTS_FILE =
  process.env.AGENT_PIGEON_EVENTS ?? join(homedir(), '.agent-pigeon', 'events.jsonl');

const IMPLEMENTATION_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const TEST_PATTERN =
  /\b(npm (?:run )?test|pnpm (?:run )?test|yarn test|jest\b|vitest\b|pytest\b|node --test\b|playwright\b|go test\b|cargo test\b|gradlew?(?:\.bat)?\b[^|;&]*\btest\b)/i;
const DEVICE_PATTERN = /\b(adb(?:\.exe)?\s|agent-device\s|emulator\s|maestro\s)/i;
const BUILD_PATTERN =
  /\b(gradlew?(?:\.bat)?\s|gradle\s|mvn\s|make\b|cmake\b|tsc\b|npm run build\b|go build\b|dotnet build\b|cargo build\b)/i;

function classifyCommand(command) {
  if (TEST_PATTERN.test(command)) return 'test';
  if (DEVICE_PATTERN.test(command)) return 'device';
  if (BUILD_PATTERN.test(command)) return 'build';
  return 'other';
}

// --- changeFingerprint (POC-03.5 §1) -------------------------------------
// Mirrors src/replay/fingerprint.ts (contract-tested). Hashes the NORMALIZED
// change CONTENT so "same file, different patch" is novel; only the 8-hex
// digest is stored — raw source/edit text never persists and never reaches
// Jev or any network.

function sha8(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

function normalizeChangePayload(text) {
  return String(text).replace(/\s+/gu, ' ').trim();
}

function fingerprintParts(parts) {
  return sha8(parts.map((p) => normalizeChangePayload(p)).join('\u0000'));
}

function changeIdentity(toolName, input) {
  const pathHash =
    typeof input?.file_path === 'string' && input.file_path.length > 0
      ? sha8(input.file_path)
      : null;

  let parts = null;
  if (toolName === 'Edit' && typeof input?.old_string === 'string' && typeof input?.new_string === 'string') {
    parts = [input.old_string, input.new_string];
  } else if (toolName === 'Write' && typeof input?.content === 'string') {
    parts = [input.content];
  } else if (toolName === 'NotebookEdit' && typeof input?.new_source === 'string') {
    parts = [input.new_source];
  } else if (toolName === 'MultiEdit' && Array.isArray(input?.edits) && input.edits.length > 0) {
    parts = input.edits.flatMap((e) =>
      e && typeof e.old_string === 'string' && typeof e.new_string === 'string'
        ? [e.old_string, e.new_string]
        : [],
    );
    if (parts.length === 0) parts = null;
  }

  if (parts !== null) {
    return { changeFingerprint: fingerprintParts(parts), fingerprintBasis: 'content', fileHash: pathHash };
  }
  return { changeFingerprint: pathHash, fingerprintBasis: pathHash !== null ? 'path' : null, fileHash: pathHash };
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const toolName = typeof input.tool_name === 'string' ? input.tool_name : 'unknown';

    let change = { changeFingerprint: null, fingerprintBasis: null, fileHash: null };
    if (IMPLEMENTATION_TOOLS.has(toolName)) {
      change = changeIdentity(toolName, input.tool_input ?? {});
    }

    let verificationKind = null;
    if (toolName === 'Bash' && typeof input.tool_input?.command === 'string') {
      verificationKind = classifyCommand(input.tool_input.command);
    }

    const response = input.tool_response;
    const ok =
      response !== null && typeof response === 'object' && typeof response.is_error === 'boolean'
        ? !response.is_error
        : null;

    // Failed-test COUNT only (a number — no text leaves the machine's logs in
    // identifiable form). Single regex on Bash output, still microsecond-scale.
    let testsFailedCount = null;
    if (verificationKind === 'test' && response !== null && typeof response === 'object') {
      const out = `${typeof response.stderr === 'string' ? response.stderr : ''}${typeof response.stdout === 'string' ? response.stdout : ''}`;
      const match = /(\d+)\s+(?:tests?\s+)?failed/i.exec(out) ?? /(\d+)\s+failing/i.exec(out);
      if (match !== null) testsFailedCount = Number(match[1]);
    }

    const event = {
      ts: new Date().toISOString(),
      sessionId: typeof input.session_id === 'string' ? input.session_id.slice(0, 8) : null,
      toolName,
      ok,
      fileHash: change.fileHash,
      changeFingerprint: change.changeFingerprint,
      fingerprintBasis: change.fingerprintBasis,
      verificationKind,
      testsFailedCount,
    };
    mkdirSync(dirname(EVENTS_FILE), { recursive: true });
    appendFileSync(EVENTS_FILE, `${JSON.stringify(event)}\n`, 'utf8');
  } catch {
    // Never surface hook failures into the agent's workflow.
  }
  process.exit(0);
});
