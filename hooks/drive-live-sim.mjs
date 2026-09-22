// Drive the REAL hook script with REAL-format Claude Code PostToolUse
// payloads (schema taken from the real transcripts parsed in POC-02).
// POC-03's live leg is quota-blocked, so this simulates the tool sequence a
// fix-and-verify session produces. The hook is the unmodified production
// script; only the agent's involvement is simulated.
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const HOOK = join(homedir(), '.agent-pigeon', 'hook.mjs');
const fileHash = createHash('sha256').update('C:/Users/user/agent-pigeon-poc03-sandbox/app.js').digest('hex').slice(0, 8);

const payloads = [
  {
    session_id: 'aaaa1111-2222-3333-4444-555566667777',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'node --test', description: 'run tests' },
    tool_response: { stdout: '', stderr: 'Tests: 2 failed, 0 passed, 2 total', is_error: true },
  },
  {
    session_id: 'aaaa1111-2222-3333-4444-555566667777',
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: 'C:/Users/user/agent-pigeon-poc03-sandbox/app.js', old_string: 'return a - b', new_string: 'return a + b' },
    tool_response: { filePath: 'C:/Users/user/agent-pigeon-poc03-sandbox/app.js' },
  },
  {
    session_id: 'aaaa1111-2222-3333-4444-555566667777',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'node --test', description: 'run tests' },
    tool_response: { stdout: '', stderr: 'Tests: 1 failed, 1 passed, 2 total', is_error: true },
  },
  {
    session_id: 'aaaa1111-2222-3333-4444-555566667777',
    hook_event_name: 'PostToolUse',
    tool_name: 'Edit',
    tool_input: { file_path: 'C:/Users/user/agent-pigeon-poc03-sandbox/app.js', old_string: 'return a + b', new_string: 'return a * b' },
    tool_response: { filePath: 'C:/Users/user/agent-pigeon-poc03-sandbox/app.js' },
  },
  {
    session_id: 'aaaa1111-2222-3333-4444-555566667777',
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_input: { command: 'node --test', description: 'verify' },
    tool_response: { stdout: 'pass 2\nfail 0', stderr: '', is_error: false },
  },
];

// Space the events in real time so the timeline offsets are meaningful.
for (const payload of payloads) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    windowsHide: true,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    console.error('hook exited nonzero for payload:', JSON.stringify(payload.tool_name), result.status);
    process.exit(1);
  }
  await new Promise((r) => setTimeout(r, 700));
}
console.log(`drove hook with ${payloads.length} PostToolUse payloads (app.js hash ${fileHash})`);
