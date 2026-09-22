#!/usr/bin/env node
/**
 * POC-04A delivery hook — Claude Code UserPromptSubmit (or PostToolUse).
 *
 * Contract: read the ALREADY-COMPUTED local decision (decision.json written
 * by the background governor processor). If it holds an undelivered
 * VERIFY_FIRST, emit it once as safe additionalContext and mark it delivered.
 * Everything else — missing file, corrupt file, SILENT policy, already
 * delivered — prints nothing and exits 0.
 *
 * This hook does NOT: call Jev, touch the network, run agent-device, scan
 * transcripts, or compute state. One small file read + at most one small
 * file write. No Stop blocking.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.AGENT_PIGEON_HOME ?? join(homedir(), '.agent-pigeon');
const decisionPath = join(home, 'decision.json');

try {
  if (existsSync(decisionPath)) {
    const decision = JSON.parse(readFileSync(decisionPath, 'utf8'));
    if (
      decision &&
      decision.policy === 'VERIFY_FIRST' &&
      decision.delivered !== true &&
      typeof decision.message === 'string' &&
      decision.message.length > 0
    ) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: decision.message,
          },
          suppressOutput: true,
        }),
      );
      decision.delivered = true;
      writeFileSync(decisionPath, `${JSON.stringify(decision, null, 2)}\n`, 'utf8');
    }
  }
} catch {
  // A broken observer/deliverer must never break the agent.
}
process.exit(0);
