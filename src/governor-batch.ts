#!/usr/bin/env node
/**
 * POC-04A.1 — PostToolBatch delivery hook (the primary VERIFY_FIRST channel).
 *
 * ONE process does the whole chain synchronously, before the next model call:
 *
 *   read local events → deterministic VERIFY_FIRST evaluation → anti-spam
 *   latch (atomic state replace, short exclusive lock) → additionalContext
 *   or silent
 *
 * It does NOT depend on decision.json, an async worker finishing, Jev, the
 * network, agent-device, transcript scanning, or git. It does NOT block the
 * loop beyond its own wall time and never emits decision:"block".
 *
 * Failure policy: FAIL OPEN. Missing/corrupt events or state, lock timeouts,
 * any unexpected error → print nothing, exit 0. The agent never sees a
 * broken hook.
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteJson, pigeonHome } from './replay/secret.js';
import { computeGovernorDecision } from './governor/governor.js';
import type { GovernorEvent, GovernorState } from './governor/governor.js';

/** Stored observer events additionally carry the truncated session id. */
interface StoredGovernorEvent extends GovernorEvent {
  sessionId?: string | null;
}

const LOCK_TIMEOUT_MS = 1500;
const LOCK_POLL_MS = 25;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readEvents(eventsPath: string, session8: string | null): GovernorEvent[] {
  if (!existsSync(eventsPath)) return [];
  const events: GovernorEvent[] = [];
  for (const line of readFileSync(eventsPath, 'utf8').split(/\r?\n/u)) {
    if (line.length === 0) continue;
    try {
      const event = JSON.parse(line) as StoredGovernorEvent;
      // Attribute events to this session when both sides know the session.
      if (session8 !== null && event.sessionId !== undefined && event.sessionId !== session8) continue;
      events.push(event);
    } catch {
      // skip malformed lines
    }
  }
  return events;
}

function readState(statePath: string): GovernorState {
  // Fail open: corrupt or partial state behaves as "nothing latched yet".
  try {
    if (!existsSync(statePath)) return { firedEpisodeStart: null };
    const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as GovernorState;
    return {
      firedEpisodeStart:
        typeof parsed.firedEpisodeStart === 'string' ? parsed.firedEpisodeStart : null,
    };
  } catch {
    return { firedEpisodeStart: null };
  }
}

/** Exclusive lock so concurrent batch invocations serialize read→latch. */
function acquireLock(lockPath: string): boolean {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return false;
      sleep(LOCK_POLL_MS);
    }
  }
  return false; // fail open: deliver nothing rather than block the agent
}

function releaseLock(lockPath: string): void {
  try {
    unlinkSync(lockPath);
  } catch {
    // best effort; stale locks simply expire via the timeout path
  }
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  try {
    let session8: string | null = null;
    try {
      const input = JSON.parse(raw) as { session_id?: unknown };
      if (typeof input.session_id === 'string' && input.session_id.length >= 8) {
        session8 = input.session_id.slice(0, 8);
      }
    } catch {
      // no/invalid stdin: proceed with all local events
    }

    const home = pigeonHome();
    mkdirSync(home, { recursive: true });
    const eventsPath = process.env.AGENT_PIGEON_EVENTS ?? join(home, 'events.jsonl');
    const statePath = join(home, 'governor-state.json');
    const lockPath = join(home, 'governor-batch.lock');

    if (!acquireLock(lockPath)) process.exit(0);

    try {
      const events = readEvents(eventsPath, session8);
      const state = readState(statePath);
      const decision = computeGovernorDecision(events, state);

      // Atomic latch replace: a crash mid-write leaves either the old or the
      // new file, never a partial one.
      atomicWriteJson(statePath, decision.state);

      if (decision.policy === 'VERIFY_FIRST' && decision.message !== null) {
        process.stdout.write(
          JSON.stringify({
            hookSpecificOutput: {
              hookEventName: 'PostToolBatch',
              additionalContext: decision.message,
            },
            suppressOutput: true,
          }),
        );
      }
    } finally {
      releaseLock(lockPath);
    }
  } catch {
    // Fail open: a broken governor must never break the agent.
  }
  process.exit(0);
});
