#!/usr/bin/env node
/**
 * POC-04A governor processor — one-shot background worker (NOT a daemon).
 *
 *   npm run governor:process [-- --events <path>] [-- --json]
 *
 * Reads the hook event stream, computes the deterministic governor decision
 * (VERIFY_FIRST only, once per debt episode), persists the anti-spam latch
 * (governor-state.json) and writes decision.json for the delivery hook.
 * Pure local file I/O — no Jev, no network, no device access.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { pigeonHome } from '../../src/replay/secret.js';
import { computeGovernorDecision } from '../../src/governor/governor.js';
import type { GovernorEvent, GovernorState } from '../../src/governor/governor.js';

function main(): void {
  const argv = process.argv.slice(2);
  const eventsIndex = argv.indexOf('--events');
  const eventsPath =
    eventsIndex >= 0 && argv[eventsIndex + 1] !== undefined
      ? String(argv[eventsIndex + 1])
      : join(pigeonHome(), 'events.jsonl');
  const json = argv.includes('--json');

  const home = pigeonHome();
  mkdirSync(home, { recursive: true });
  const statePath = join(home, 'governor-state.json');
  const decisionPath = join(home, 'decision.json');

  if (!existsSync(eventsPath)) {
    process.stderr.write(`governor: no event stream at ${eventsPath}\n`);
    process.exitCode = 1;
    return;
  }

  const startedAt = performance.now();
  const events: GovernorEvent[] = [];
  for (const line of readFileSync(eventsPath, 'utf8').split(/\r?\n/u)) {
    if (line.length === 0) continue;
    try {
      events.push(JSON.parse(line) as GovernorEvent);
    } catch {
      // ignore malformed lines
    }
  }

  let state: GovernorState = { firedEpisodeStart: null };
  if (existsSync(statePath)) {
    try {
      const parsed = JSON.parse(readFileSync(statePath, 'utf8')) as GovernorState;
      state = { firedEpisodeStart: typeof parsed.firedEpisodeStart === 'string' ? parsed.firedEpisodeStart : null };
    } catch {
      state = { firedEpisodeStart: null };
    }
  }

  const decision = computeGovernorDecision(events, state);
  const workerMs = performance.now() - startedAt;

  writeFileSync(statePath, `${JSON.stringify(decision.state, null, 2)}\n`, 'utf8');
  const decisionDoc = {
    policy: decision.policy,
    message: decision.message,
    distinctEdits: decision.distinctEdits,
    episodeStartHash: decision.episodeStartHash,
    generatedAt: new Date().toISOString(),
    delivered: false,
  };
  writeFileSync(decisionPath, `${JSON.stringify(decisionDoc, null, 2)}\n`, 'utf8');

  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ...decisionDoc, state: decision.state, workerMs }, null, 2)}\n`,
    );
  } else {
    process.stdout.write(
      `Governor decision: ${decision.policy} (distinct edits in episode: ${decision.distinctEdits}, ${workerMs.toFixed(2)} ms)\n`,
    );
  }
}

main();
