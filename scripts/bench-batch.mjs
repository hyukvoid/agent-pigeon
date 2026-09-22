// Benchmark the PostToolBatch delivery path (real compiled hook).
// Phase 1: one cold run that fires VERIFY_FIRST. Phase 2: 60 warm latched runs.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const home = mkdtempSync(join(tmpdir(), 'pigeon-bench-'));
const eventsPath = join(home, 'events.jsonl');
const BATCH = 'C:/Agent Pigeon/dist/src/governor-batch.js';
const OBSERVE = 'C:/Agent Pigeon/hooks/hook-posttooluse.mjs';
const env = () => ({ ...process.env, AGENT_PIGEON_HOME: home, AGENT_PIGEON_EVENTS: eventsPath });

function observe(tag) {
  spawnSync(process.execPath, [OBSERVE], {
    input: JSON.stringify({
      session_id: 'bench000-1111-2222-3333-444444444444',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: `C:/proj/${tag}.kt`, old_string: `old-${tag}`, new_string: `new-${tag}` },
      tool_response: {},
    }),
    env: env(),
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

function batch() {
  const started = performance.now();
  const result = spawnSync(process.execPath, [BATCH], {
    input: JSON.stringify({ session_id: 'bench000-1111-2222-3333-444444444444', hook_event_name: 'PostToolBatch' }),
    env: env(),
    encoding: 'utf8',
    windowsHide: true,
  });
  return { ms: performance.now() - started, fired: result.stdout.length > 0 };
}

for (const tag of ['A', 'B', 'C']) observe(tag);
const cold = batch();
if (!cold.fired) console.error('WARNING: cold run did not fire');

const samples = [];
for (let i = 0; i < 60; i++) samples.push(batch().ms);
samples.sort((a, b) => a - b);
const p = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))].toFixed(1);

console.log(JSON.stringify({
  coldFiringRun_ms: +cold.ms.toFixed(1),
  warmLatchedRuns: samples.length,
  p50_ms: p(0.5),
  p95_ms: p(0.95),
  max_ms: samples[samples.length - 1].toFixed(1),
  min_ms: samples[0].toFixed(1),
}, null, 2));
rmSync(home, { recursive: true, force: true });
