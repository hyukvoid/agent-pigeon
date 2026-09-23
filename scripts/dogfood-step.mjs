// POC-04C.2 dogfood harness — ONE batch step:
//   feed my real tool calls to the real observer hook → run the real
//   experimental live governor → report whether it fired.
// Usage: node scripts/dogfood-step.mjs <batch-name> <calls.json>
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = process.env.AGENT_PIGEON_HOME;
const eventsPath = process.env.AGENT_PIGEON_EVENTS;
if (home === undefined || eventsPath === undefined) throw new Error('set AGENT_PIGEON_HOME / AGENT_PIGEON_EVENTS');

const batchName = process.argv[2] ?? 'batch';
const calls = JSON.parse(readFileSync(process.argv[3], 'utf8'));

const OBSERVE = 'C:/Agent Pigeon/experimental/hooks/hook-posttooluse.mjs';
const LIVE = 'C:/Agent Pigeon/experimental/hooks/governor-live.mjs';

for (const call of calls) {
  const r = spawnSync(process.execPath, [OBSERVE], {
    input: JSON.stringify({
      session_id: 'dogfood00-1111-2222-3333-444444444444',
      hook_event_name: 'PostToolUse',
      tool_name: call.tool,
      tool_input: call.input,
      tool_response: call.response ?? {},
    }),
    env: { ...process.env, AGENT_PIGEON_HOME: home, AGENT_PIGEON_EVENTS: eventsPath },
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error('observer failed');
}

const b = spawnSync(process.execPath, [LIVE], {
  input: JSON.stringify({ session_id: 'dogfood00-1111-2222-3333-444444444444', hook_event_name: 'PostToolBatch' }),
  env: { ...process.env, AGENT_PIGEON_HOME: home, AGENT_PIGEON_EVENTS: eventsPath },
  encoding: 'utf8',
  windowsHide: true,
});

if (b.stdout.length > 0) {
  const parsed = JSON.parse(b.stdout);
  console.log(`[${batchName}] VERIFY_FIRST FIRED:`);
  console.log(parsed.hookSpecificOutput.additionalContext);
} else {
  console.log(`[${batchName}] silent`);
}
const state = JSON.parse(readFileSync(join(home, 'governor-live-state.json'), 'utf8'));
console.log(`    (opportunities: ${state.opp}, fired: ${state.fired})`);
