#!/usr/bin/env node
/**
 * Agent Pigeon — Claude Code PostToolUse hook (POC-03/04 async observer).
 *
 * Contract: read one hook JSON from stdin, append ONE sanitized JSONL event,
 * exit 0 immediately. Never blocks, never fails, never talks to the network,
 * never invokes Jev, never reads transcripts or git. All heavy work happens
 * in the offline worker (poc:03 / governor batch hook), not here.
 *
 * Stored fields (normalized metadata only):
 *   ts, sessionId (8 chars), toolName, ok (tool success if determinable),
 *   changeFingerprint (HMAC-SHA256-128 over the NORMALIZED CHANGE CONTENT —
 *   never the content itself), fileHash (HMAC of the edited path),
 *   fingerprintBasis (content|path), verificationKind (for Bash commands —
 *   never the command text), testsFailedCount (a bare number).
 *
 * Fingerprints are keyed with a per-install secret (POC-03.5.1). PostToolUse
 * hooks may run CONCURRENTLY, so first-use secret creation is race-safe
 * (POC-04A.1): exclusive create, losers converge on the winner's secret.
 */

import { appendFileSync, chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHmac, randomBytes } from 'node:crypto';

const EVENTS_FILE =
  process.env.AGENT_PIGEON_EVENTS ?? join(homedir(), '.agent-pigeon', 'events.jsonl');

const IMPLEMENTATION_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

// Test/spec file paths: editing these is verification preparation (POC-04C.2).
const TEST_PATH = /(^|\/)(tests?|__tests__|spec)(\/|$)|\.(test|spec)\.[a-z]+$/i;

// MIRROR of src/replay/claude.ts classifyVerificationCommand. The live
// governor and replay must agree about what counts as evidence; a parity test
// drives this script and compares it against the TS classifier.
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

// --- per-install secret (race-safe, POC-04A.1) ----------------------------
// Mirrors src/replay/secret.ts. Lives OUTSIDE any repository
// (<AGENT_PIGEON_HOME | ~/.agent-pigeon>/secret.key). Concurrent first-use
// hooks converge on ONE secret via exclusive create + read-after-lose.

function pigeonHome() {
  return process.env.AGENT_PIGEON_HOME ?? join(homedir(), '.agent-pigeon');
}

const SECRET_PATTERN = /^[0-9a-f]{64}$/u;

function readValidSecret(secretPath) {
  if (!existsSync(secretPath)) return null;
  const existing = readFileSync(secretPath, 'utf8').trim();
  return SECRET_PATTERN.test(existing) ? existing : null;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function waitAndReadValidSecret(secretPath, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const secret = readValidSecret(secretPath);
    if (secret !== null) return secret;
    sleep(25);
  }
  return null;
}

function loadOrCreateSecret() {
  const dir = pigeonHome();
  mkdirSync(dir, { recursive: true });
  const secretPath = join(dir, 'secret.key');

  const existing = readValidSecret(secretPath);
  if (existing !== null) return existing;

  const secret = randomBytes(32).toString('hex');
  try {
    // Exclusive create: concurrent processes race; exactly one wins.
    const fd = openSync(secretPath, 'wx');
    try {
      writeSync(fd, `${secret}\n`);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(secretPath, 0o600);
    } catch {
      // best-effort on platforms without POSIX modes
    }
    return secret;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  // Lost the creation race: converge on the winner's secret (may still be
  // mid-flush, so poll briefly).
  const winners = waitAndReadValidSecret(secretPath);
  if (winners !== null) return winners;
  throw new Error('unable to converge on the per-install secret');
}

// --- fingerprints (HMAC-SHA256-128, POC-03.5.1) ---------------------------
// Canonicalization: serialization mechanics only (stable JSON key order,
// line endings). NO whitespace collapsing — indentation is semantics.

function hmacFingerprint(secret, canonical) {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex').slice(0, 32);
}

const lf = (text) => String(text).replace(/\r\n?/gu, '\n');

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
  // Test/spec-only edits are verification preparation (POC-04C.2): they must
  // not create implementation opportunities for the governor.
  const testOnly = unique.length > 0 && unique.every((p) => TEST_PATH.test(p));

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
    return { changeFingerprint: contentFingerprint(secret, op, parts), fingerprintBasis: 'content', fileHash: pathHash, testOnly };
  }
  return { changeFingerprint: pathHash, fingerprintBasis: pathHash !== null ? 'path' : null, fileHash: pathHash, testOnly };
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

    let change = { changeFingerprint: null, fingerprintBasis: null, fileHash: null, testOnly: null };
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

    // Failed-test COUNT only (a number). Single regex on Bash output.
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
      testOnly: change.testOnly,
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
