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

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const toolName = typeof input.tool_name === 'string' ? input.tool_name : 'unknown';

    let fileHash = null;
    const filePath = input.tool_input?.file_path;
    if (typeof filePath === 'string' && filePath.length > 0) {
      fileHash = createHash('sha256').update(filePath).digest('hex').slice(0, 8);
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
      fileHash,
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
