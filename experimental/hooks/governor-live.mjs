#!/usr/bin/env node
/**
 * Agent Pigeon — EXPERIMENTAL live governor (turn/batch-aware VERIFY_FIRST).
 *
 * This is the POC-04C.2 dogfood candidate. It is NOT the shipped v0.1 batch
 * hook (that one is deliberately silent without turn evidence).
 *
 * Design (watermark opportunity policy):
 *
 *   Every PostToolBatch invocation is one "verification opportunity" — the
 *   model decision point right before the next call. The hook consumes NEW
 *   observer events since its last watermark (byte offset) and:
 *
 *     - any verification event (test/build/device — failed runs count, they
 *       are collected evidence) resets the opportunity counter to zero
 *     - otherwise, if any non-test implementation event was consumed, this
 *       boundary is ONE implementation opportunity (how many edits it
 *       contained is irrelevant — impl+import+type+test is one attempt)
 *     - test-only events are neutral
 *     - at ≥3 consecutive implementation opportunities without verification:
 *       emit ONE factual VERIFY_FIRST additionalContext (anti-spam latch)
 *
 * Attribution note (POC-04A.1 open question, resolved by design): events are
 * NEVER assigned to batches. A late async event is simply consumed by the
 * NEXT boundary — worst case a warning moves one batch later; no event is
 * double-counted or lost (byte-offset watermark; truncation resets it).
 * Concurrent observer appends may rarely lose a line — that only reduces
 * warnings (fail-safe direction).
 *
 * Fail-open everywhere: corrupt/missing anything → silent, exit 0.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.AGENT_PIGEON_HOME ?? join(homedir(), '.agent-pigeon');
const eventsPath = process.env.AGENT_PIGEON_EVENTS ?? join(home, 'events.jsonl');
const statePath = join(home, 'governor-live-state.json');
const lockPath = join(home, 'governor-live.lock');

const OPPORTUNITY_THRESHOLD = 3;
const LOCK_TIMEOUT_MS = 1500;
const LOCK_POLL_MS = 25;

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function acquireLock() {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error) {
      if (error?.code !== 'EEXIST') return false;
      // stale lock: a live critical section is single-digit ms
      try {
        if (Date.now() - statSync(lockPath).mtimeMs >= 10_000) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {}
      sleep(LOCK_POLL_MS);
    }
  }
  return false;
}

function releaseLock() {
  try { unlinkSync(lockPath); } catch {}
}

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath, 'utf8'));
    return {
      watermark: typeof parsed.watermark === 'number' && parsed.watermark >= 0 ? parsed.watermark : 0,
      opp: typeof parsed.opp === 'number' && parsed.opp >= 0 ? parsed.opp : 0,
      fired: parsed.fired === true,
    };
  } catch {
    return { watermark: 0, opp: 0, fired: false };
  }
}

function writeState(state) {
  mkdirSync(home, { recursive: true });
  const tmp = `${statePath}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  renameSync(tmp, statePath);
}

/** Consume new events from the watermark. Returns {events, next, truncated}. */
function consumeEvents(state) {
  if (!existsSync(eventsPath)) return { events: [], next: state.watermark, truncated: state.watermark > 0 };
  const size = statSync(eventsPath).size;
  let watermark = state.watermark;
  if (size < watermark) watermark = 0; // rotated/truncated: start over
  const fd = openSync(eventsPath, 'r');
  try {
    const length = Math.max(0, size - watermark);
    const buf = Buffer.alloc(length);
    const bytesRead = readSync(fd, buf, 0, length, watermark);
    const chunk = buf.toString('utf8', 0, bytesRead);
    const lastNewline = chunk.lastIndexOf('\n');
    const complete = lastNewline >= 0 ? chunk.slice(0, lastNewline + 1) : '';
    const next = watermark + Buffer.byteLength(complete, 'utf8');
    const events = [];
    for (const line of complete.split('\n')) {
      if (line.length === 0) continue;
      try { events.push(JSON.parse(line)); } catch { /* skip corrupt line */ }
    }
    return { events, next, truncated: false };
  } finally {
    closeSync(fd);
  }
}

function main() {
  let emitted = null;
  if (!acquireLock()) process.exit(0); // fail open: silence this boundary

  try {
    const state = readState();
    const { events, next } = consumeEvents(state);

    let verifSeen = false;
    let implSeen = false;
    for (const event of events) {
      if (event === null || typeof event !== 'object') continue;
      if (event.toolName === 'Bash' && event.verificationKind && event.verificationKind !== 'other') {
        verifSeen = true; // collected evidence — even a failed run
      } else if (IMPLEMENTATION_TOOLS.has(event.toolName) && event.testOnly !== true) {
        implSeen = true;
      }
    }

    let opp = state.opp;
    let fired = state.fired;
    if (verifSeen) {
      opp = 0;
      fired = false;
    } else if (implSeen) {
      opp += 1; // one boundary = one implementation opportunity
    }

    if (opp >= OPPORTUNITY_THRESHOLD && !fired) {
      emitted = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolBatch',
          additionalContext: [
            'Agent Pigeon',
            '',
            `${opp} separate implementation batches were completed without collecting any verification evidence (no build, test, or device run).`,
            '',
            'Run a verification now — before making more implementation changes.',
          ].join('\n'),
        },
        suppressOutput: true,
      });
      fired = true;
    }

    writeState({ watermark: next, opp, fired });
  } catch (error) {
    if (process.env.AGENT_PIGEON_DEBUG) {
      process.stderr.write(`[agent-pigeon live] ${error instanceof Error ? (error.stack ?? error.message) : String(error)}
`);
    }
    // fail open
  } finally {
    releaseLock();
  }

  if (emitted !== null) process.stdout.write(emitted);
  process.exit(0);
}

const IMPLEMENTATION_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

main();
