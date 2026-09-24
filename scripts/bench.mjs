import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const HOOK = process.env.HOOK_PATH ?? '';
const SAMPLE = JSON.stringify({
  session_id: '01234567-89ab-cdef-1122-334455667788',
  transcript_path: 'C:/Users/user/.claude/projects/x/y.jsonl',
  cwd: 'C:/work/proj',
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command: 'npm test', description: 'run tests' },
  tool_response: { stdout: 'ok', stderr: 'Tests: 2 failed, 3 passed', interrupted: false },
});

const latencies = [];
for (let i = 0; i < 100; i++) {
  const started = performance.now();
  await new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.stdin.write(SAMPLE);
    child.stdin.end();
    child.on('exit', resolve);
    child.on('error', resolve);
  });
  latencies.push(performance.now() - started);
}
latencies.sort((a, b) => a - b);
const p = (q) => latencies[Math.min(latencies.length - 1, Math.floor(q * latencies.length))].toFixed(1);
console.log(
  JSON.stringify(
    {
      runs: latencies.length,
      p50_ms: p(0.5),
      p95_ms: p(0.95),
      max_ms: latencies[latencies.length - 1],
      min_ms: latencies[0],
    },
    null,
    2,
  ),
);
