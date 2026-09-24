// Linux validation fixture builder (writes synthetic histories only).
import fs from 'node:fs';
import path from 'node:path';

const ws = process.argv[2];
const claude = path.join(ws, 'dir with spaces', 'claude', 'projects', 'demo');
fs.mkdirSync(claude, { recursive: true });
const S = 'lin00000-1111-2222-3333-444444444444';
const t = (n) => new Date(Date.parse('2026-09-23T09:00:00.000Z') + n * 60_000).toISOString();
const edit = (id, n, p2) => JSON.stringify({ type: 'assistant', timestamp: t(n), sessionId: S, message: { content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: p2, old_string: `old ${id}`, new_string: `new ${id}` } }] } });
const test = (id, n, ok) => JSON.stringify({ type: 'user', timestamp: t(n), sessionId: S, toolUseResult: { stdout: ok ? 'pass' : '', stderr: ok ? '' : 'Tests: 2 failed', durationMs: 100 }, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !ok, content: ok ? 'pass' : 'Tests: 2 failed' }] } });

// healthy productive loop
fs.writeFileSync(path.join(claude, 'good.jsonl'), [
  edit('g1', 0, '/repo/src/a.ts'), test('g2', 60, false), edit('g3', 120, '/repo/src/a.ts'), test('g4', 180, true),
].join('\n'), 'utf8');

// debt stretch: 3 edits in 3 separate turns, no verification
fs.writeFileSync(path.join(claude, 'debt.jsonl'), [
  edit('d1', 0, '/repo/src/b.ts'), edit('d2', 60, '/repo/src/c.ts'), edit('d3', 120, '/repo/src/d.ts'),
].join('\n'), 'utf8');

// malformed: garbage, truncated line, ~long line, unicode, unknown types
fs.writeFileSync(path.join(claude, 'broken.jsonl'), [
  'not-json at all',
  JSON.stringify({ type: 'assistant', timestamp: t(300), sessionId: S, message: { content: [{ type: 'tool_use', id: 'u1', name: 'Edit', input: { file_path: 'C:/répertoire/unicode éàü.ts', old_string: 'ünïcode', new_string: 'fixé' } }] } }),
  '{"type":"user","timestamp":"2026-09-23T09:06:00.000Z","sessionId":"' + S + '","message":{"content":[{"type":"tool_result","tool_use_id":"u1","is_error":false}]},',
  '{"type":"user","timestamp":"2026-09-23T09:07:00.000Z","sessionId":"' + S + '","toolUseResult":{"stdout":"' + 'x'.repeat(300000) + '"}}',
  JSON.stringify({ type: 'agent_future_event', timestamp: t(400), payload: { whatever: { deep: [1, 2, 3] } } }),
].join('\n'), 'utf8');

// codex rollout with turn_context (turn-aware path) + exec JS tool calls
const codex = path.join(ws, 'dir with spaces', 'codex', 'sessions', '2026', '09', '23');
fs.mkdirSync(codex, { recursive: true });
const call = (id, n, input) => JSON.stringify({ timestamp: t(n), type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c' + id, name: 'exec', input } });
const out = (id, n, text) => JSON.stringify({ timestamp: t(n), type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c' + id, output: [{ type: 'output_text', text }] } });
fs.writeFileSync(path.join(codex, 'rollout.jsonl'), [
  JSON.stringify({ timestamp: t(0), type: 'session_meta', payload: { id: 'cod99999-1111-2222-3333-444444444444', cwd: '/repo' } }),
  JSON.stringify({ timestamp: t(30), type: 'turn_context', payload: { turn_id: 't1' } }),
  call(1, 60, 'const r = await tools.apply_patch("*** Begin Patch\\n*** Update File: src/app.ts\\n@@\\n-old line\\n+new line\\n*** End Patch")'),
  out(1, 90, 'patch applied'),
  call(2, 120, 'const r = await tools.exec_command("npm test")'),
  out(2, 150, 'Tests: 8 failed, 3 passed\nexit code: 1'),
  JSON.stringify({ timestamp: t(300), type: 'token_usage_record', payload: { thread_token_usage: { input_tokens: 500, output_tokens: 100, total_tokens: 600 } } }),
  JSON.stringify({ timestamp: t(400), type: 'turn_context', payload: { turn_id: 't2' } }),
  call(3, 460, 'const r = await tools.apply_patch("*** Begin Patch\\n*** Update File: src/app.ts\\n@@\\n-more\\n+fixed\\n*** End Patch")'),
  out(3, 490, 'patch applied'),
  call(4, 520, 'const r = await tools.exec_command("npm test")'),
  out(4, 550, 'all passing\nexit code: 0'),
  JSON.stringify({ timestamp: t(600), type: 'token_usage_record', payload: { thread_token_usage: { input_tokens: 900, output_tokens: 200, total_tokens: 1100 } } }),
].join('\n'), 'utf8');

// one very large session (~5 MB of reasoning lines) for resource check
const bigLines = [JSON.stringify({ timestamp: t(0), type: 'session_meta', payload: { id: 'big00000-1111-2222-3333-444444444444', cwd: '/repo' } })];
const chunk = JSON.stringify({ timestamp: t(60), type: 'response_item', payload: { type: 'reasoning', summary: 'x'.repeat(5000) } });
for (let i = 0; i < 1000; i++) bigLines.push(chunk);
fs.writeFileSync(path.join(ws, 'big-session.jsonl'), bigLines.join('\n'), 'utf8');

console.log('linux workspace ready at', ws);
