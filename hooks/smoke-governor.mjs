// Smoke: deployed hook copies + governor chain on an isolated home.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join('C:/Users/user/AppData/Local/Temp', 'pigeon-smoke-'));
const eventsPath = join(home, 'events.jsonl');
const hook = join(homedir(), '.agent-pigeon', 'hook.mjs');
const deliver = join(homedir(), '.agent-pigeon', 'deliver-verify-first.mjs');
const processor = 'C:/Agent Pigeon/dist/src/governor-process.js';
const env = () => ({ ...process.env, AGENT_PIGEON_HOME: home, AGENT_PIGEON_EVENTS: eventsPath });

for (const tag of ['A', 'B', 'C']) {
  execFileSync(
    process.execPath,
    [hook],
    {
      input: JSON.stringify({
        session_id: 'smoke000-1111-2222-3333-444444444444',
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: `C:/proj/${tag}.kt`, old_string: `old-${tag}`, new_string: `new-${tag}` },
        tool_response: {},
      }),
      env: env(),
      windowsHide: true,
    },
  );
}
const decision = JSON.parse(
  execFileSync(process.execPath, [processor, '--events', eventsPath, '--json'], { env: env(), encoding: 'utf8' }),
);
const delivery = execFileSync(process.execPath, [deliver], { env: env(), encoding: 'utf8' });
const parsed = JSON.parse(delivery);
console.log('policy:', decision.policy, '| distinct:', decision.distinctEdits);
console.log('delivered context starts with:', JSON.stringify(parsed.hookSpecificOutput.additionalContext.slice(0, 13)));
console.log('secret in events:', eventsPath && readFileSync(eventsPath, 'utf8').includes(readFileSync(join(home, 'secret.key'), 'utf8').trim()));
console.log('secret in decision:', readFileSync(join(home, 'decision.json'), 'utf8').includes(readFileSync(join(home, 'secret.key'), 'utf8').trim()));
rmSync(home, { recursive: true, force: true });
