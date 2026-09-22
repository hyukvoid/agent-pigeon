#!/usr/bin/env node
/**
 * Agent Pigeon — Claude Code PostToolUse hook (POC-03/04 hot path).
 *
 * Contract: read one hook JSON from stdin, append ONE sanitized JSONL event,
 * exit 0 immediately. Never blocks, never fails, never talks to the network,
 * never invokes Jev, never reads transcripts or git. All heavy work happens
 * in the offline worker (poc:03 / governor processor), not here.
 *
 * Stored fields (normalized metadata only — spec §5):
 *   ts, sessionId (8 chars), toolName, ok (tool success if determinable),
 *   changeFingerprint (HMAC-SHA256-128 over the NORMALIZED CHANGE CONTENT —
 *   never the content itself), fileHash (HMAC of the edited path),
 *   fingerprintBasis (content|path), verificationKind (for Bash commands —
 *   never the command text), testsFailedCount (a bare number).
 *
 * Fingerprints are keyed with a per-install secret (POC-03.5.1): digests
 * cannot be candidate-matched without this machine's secret. The secret is
 * generated locally, stored outside any repository, and never sent anywhere.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const EVENTS_FILE =
  process.env.AGENT_PIGEON_EVENTS ?? join(homedir(), '.agent-pigeon', 'events.jsonl');

const IMPLEMENTATION_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const TEST_PATTERN =
  /\b(npm (?:run )?test|pnpm (?:run )?test|yarn test|jest\b|vitest\b|pytest\b|node --test\b|playwright\b|go test\b|cargo test\b|gradlew?(?:\.bat)?\b[^|;&]*\btest\b)/i;
const DEVICE_PATTERN = /\b(adb(?:\.exe)?\s|agent-device\s|emulator\s|maestro\s)/i;
const BUILD_PATTERN =
  /\b(gradlew?(?:\.bat)?\s|gradle\s|mvn\s|make\b|cmake\b|tsc\b|npm run build\b|go build\b|dotnet build\b|cargo build\b)/i;

// --- per-install secret (POC-03.5.1) --------------------------------------
// Mirrors src/replay/secret.ts. Lives OUTSIDE any repository
// (<AGENT_PIGEON_HOME | ~/.agent-pigeon>/secret.key, mode 0600). Never
// committed, never included in events or Jev payloads.

function pigeonHome() {
  return process.env.AGENT_PIGEON_HOME ?? join(homedir(), '.agent-pigeon');
}

function loadOrCreateSecret() {
  const dir = pigeonHome();
  mkdirSync(dir, { recursive: true });
  const secretPath = join(dir, 'secret.key');
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  return secret;
}

function hmacFingerprint(secret, canonical) {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex').slice(0, 32);
}

const lf = (text) => String(text).replace(/\r\n?/gu, '\n');

// Canonicalization: serialization mechanics only (stable JSON key order,
// line endings). NO whitespace collapsing — indentation is semantics.
function contentFingerprint(secret, op, parts) {
  return hmacFingerprint(secret, JSON.stringify({ v: 2, op, parts: parts.map(lf) }));
}
function pathFingerprint(secret, paths) {
  return hmacFingerprint(secret, JSON.stringify({ v: 2, op: 'paths', paths: [...paths].sort() }));
}

function changeIdentity(toolName, input, secret) {
  const paths = [];
  if (typeof input?.file_path === 'string') paths.push(input.file_path);
  else if (Array.isArray(input?.file_path)) {
    paths.push(...input.file_path.filter((p) => typeof p === 'string'));
  }
  const unique = [...new Set(paths)];
  const pathHash = unique.length > 0 ? pathFingerprint(secret, unique) : null;

  let op = null;
  let parts = null;
  if (toolName === 'Edit' && typeof input?.old_string === 'string' && typeof input?.new_string === 'string') {
    op = 'edit';
    parts = [input.old_string, input.new_string];
  } else if (toolName === 'Write' && typeof input?.content === 'string') {
    op = 'write';
    parts = [input.content];
  } else if (toolName === 'NotebookEdit' && typeof input?.new_source === 'string') {
    op = 'notebook';
    parts = [input.new_source];
  } else if (toolName === 'MultiEdit' && Array.isArray(input?.edits) && input.edits.length > 0) {
    parts = input.edits.flatMap((e) =>
      e && typeof e.old_string === 'string' && typeof e.new_string === 'string'
        ? [e.old_string, e.new_string]
        : [],
    );
    if (parts.length === 0) parts = null;
    else op = 'multi-edit';
  }

  if (op !== null && parts !== null) {
    return { changeFingerprint: contentFingerprint(secret, op, parts), fingerprintBasis: 'content', fileHash: pathHash };
  }
  return { changeFingerprint: pathHash, fingerprintBasis: pathHash !== null ? 'path' : null, fileHash: pathHash };
}

function classifyCommand(command) {
  if (TEST_PATTERN.test(command)) return 'test';
  if (DEVICE_PATTERN.test(command)) return 'device';
  if (BUILD_PATTERN.test(command)) return 'build';
  return 'other';
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
      change = changeIdentity(toolName, input.tool_input ?? {}, loadOrCreateSecret());
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
