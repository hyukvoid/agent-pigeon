import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const dir = mkdtempSync(join(tmpdir(), 'pigeon-share-'));
// write a tiny claude session fixture
const lines = [
  JSON.stringify({ type: 'assistant', timestamp: '2026-09-22T12:00:00.000Z', sessionId: 'demo00000-1111-2222-3333-444444444444', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/repo/src/index.ts', old_string: 'old', new_string: 'new' } }] } }),
  JSON.stringify({ type: 'user', timestamp: '2026-09-22T12:00:30.000Z', sessionId: 'demo00000-1111-2222-3333-444444444444', toolUseResult: { stdout: '', stderr: 'Tests: 3 failed', durationMs: 100 }, message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: true, content: 'Tests: 3 failed' }] } }),
  JSON.stringify({ type: 'assistant', timestamp: '2026-09-22T12:01:00.000Z', sessionId: 'demo00000-1111-2222-3333-444444444444', message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: '/repo/src/index.ts', old_string: 'x', new_string: 'y' } }] } }),
  JSON.stringify({ type: 'user', timestamp: '2026-09-22T12:01:30.000Z', sessionId: 'demo00000-1111-2222-3333-444444444444', toolUseResult: { stdout: 'pass', stderr: '', durationMs: 50 }, message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: false, content: 'pass' }] } }),
];
const f = join(dir, 'demo.jsonl');
writeFileSync(f, lines.join('\n'), 'utf8');
console.log('fixture:', f);
