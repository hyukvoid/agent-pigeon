import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildSessionModel } from '../src/pigeon/process.js';
import {
  parsePigeonJsonl,
  PigeonJsonlReader,
  looksLikePigeonJsonl,
} from '../src/adapters/generic-jsonl.js';
import { parseCodexPigeonSession, looksLikeCodexRollout } from '../src/adapters/codex.js';
import { parseClaudePigeonSession, looksLikeClaudeSession } from '../src/adapters/claude.js';
import { detectAdapter, discoverSessionFiles, loadSessionModel } from '../src/adapters/index.js';
import { fixturesRoot } from './paths.js';

const pigeonFixture = (name: string): string => join(fixturesRoot, 'pigeon', name);

describe('generic JSONL adapter (FULL reference)', () => {
  it('parses all four committed fixtures into valid sessions', () => {
    for (const name of [
      'a-simple-success.pigeon.jsonl',
      'b-failure-recovery.pigeon.jsonl',
      'c-parallel-agents.pigeon.jsonl',
      'd-acceptance-login.pigeon.jsonl',
    ]) {
      const result = parsePigeonJsonl(readFileSync(pigeonFixture(name), 'utf8'));
      assert.equal(result.skipped, 0, name);
      assert.ok(result.events.length >= 13, `${name} has enough events (${result.events.length})`);
      assert.ok(result.warnings.length === 0, name);
    }
  });

  it('skips corrupted lines without losing the rest of the session', () => {
    const text = [
      JSON.stringify({ id: 'e1', sessionId: 's', type: 'SESSION_STARTED', timestamp: '2026-09-24T09:00:00.000Z' }),
      '{ this is not json',
      JSON.stringify({ id: 'e2', sessionId: 's', type: 'MESSAGE', timestamp: 'bad-ts' }),
      '',
      JSON.stringify({ id: 'e3', sessionId: 's', type: 'CHECKPOINT', timestamp: '2026-09-24T09:00:05.000Z' }),
    ].join('\n');
    const result = parsePigeonJsonl(text);
    assert.equal(result.events.length, 2);
    assert.equal(result.skipped, 2);
    assert.equal(result.warnings.length, 2);
  });

  it('buffers partial trailing lines during incremental reads', () => {
    const reader = new PigeonJsonlReader();
    const line1 = JSON.stringify({ id: 'e1', sessionId: 's', type: 'SESSION_STARTED', timestamp: '2026-09-24T09:00:00.000Z' }) + '\n';
    const line2 = JSON.stringify({ id: 'e2', sessionId: 's', type: 'CHECKPOINT', timestamp: '2026-09-24T09:00:01.000Z' }) + '\n';
    assert.equal(reader.push(line1.slice(0, 40)).length, 0); // partial line
    assert.equal(reader.push(line1.slice(40)).length, 1);
    assert.equal(reader.push(line2.slice(0, 60)).length, 0);
    assert.equal(reader.push(line2.slice(60)).length, 1);
    assert.equal(reader.events.length, 2);
  });

  it('sniffs pigeon jsonl reliably', () => {
    const sample = readFileSync(pigeonFixture('a-simple-success.pigeon.jsonl'), 'utf8');
    assert.equal(looksLikePigeonJsonl(sample), true);
    assert.equal(looksLikePigeonJsonl('hello world\nno json here'), false);
  });
});

describe('acceptance fixture D (fix login, directive §32)', () => {
  const model = buildSessionModel(parsePigeonJsonl(readFileSync(pigeonFixture('d-acceptance-login.pigeon.jsonl'), 'utf8')).events);

  it('shows the full chronology', () => {
    assert.ok(model.timeline.length >= 28);
    assert.equal(model.timeline[0]?.event.type, 'SESSION_STARTED');
  });

  it('detects exactly two problems, both recovered', () => {
    assert.equal(model.problems.length, 2);
    const [test, browser] = model.problems;
    assert.ok(test && browser);
    assert.equal(test.kind, 'test-failure');
    assert.equal(test.status, 'RECOVERED');
    assert.equal(browser.kind, 'command-failure');
    assert.equal(browser.status, 'RECOVERED');
    assert.match(test.followUps.map((f) => f.description).join('; '), /inspected src\/auth\.ts/u);
  });

  it('shows the parallel agent graph Main → Test/Browser', () => {
    const main = model.agents.find((a) => a.agentId === 'main');
    assert.ok(main);
    assert.deepEqual(main.children, ['test-agent', 'browser-agent']);
    const testAgent = model.agents.find((a) => a.agentId === 'test-agent');
    const browserAgent = model.agents.find((a) => a.agentId === 'browser-agent');
    assert.equal(testAgent?.status, 'SUCCESS');
    assert.equal(browserAgent?.status, 'SUCCESS');
  });

  it('lists middleware.ts, auth.ts, config.ts as touched', () => {
    const paths = model.files.map((f) => f.path);
    for (const p of ['src/middleware.ts', 'src/auth.ts', 'src/config.ts']) {
      assert.ok(paths.includes(p), p);
    }
  });

  it('reports SUCCESS with failures 2 / recovered 2', () => {
    assert.equal(model.outcome.status, 'SUCCESS');
    assert.equal(model.outcome.failures, 2);
    assert.equal(model.outcome.recovered, 2);
    assert.equal(model.outcome.agents, 3);
  });
});

describe('codex adapter (PARTIAL)', () => {
  it('maps the sample rollout to pigeon events; the dead-end loop stays UNRESOLVED', () => {
    const text = readFileSync(join(fixturesRoot, 'codex', 'sample-rollout.jsonl'), 'utf8');
    assert.equal(looksLikeCodexRollout(text), true);
    const result = parseCodexPigeonSession(text);
    assert.equal(result.events.length > 0, true);
    const types = new Set(result.events.map((e) => e.type));
    assert.ok(types.has('SESSION_STARTED'));
    assert.ok(types.has('FILE_CHANGED'));
    assert.ok(types.has('TEST_STARTED'), 'npm test is classified as a test run');
    assert.ok(types.has('TEST_FAILED'));
    const model = buildSessionModel(result.events);
    assert.equal(model.sessionId, 'cdx00000-1111-2222-3333-444444444444');
    // The sample NEVER passes its tests (3 failing runs, same command): the
    // honest verdict is one problem, 3 attempts, UNRESOLVED — no fake recovery.
    const testProblem = model.problems.find((p) => p.kind === 'test-failure');
    assert.ok(testProblem, 'the failing npm test becomes a problem');
    assert.equal(testProblem.status, 'UNRESOLVED');
    assert.equal(testProblem.attempts, 3);
    const failedEvent = result.events.find((e) => e.type === 'TEST_FAILED');
    assert.equal((failedEvent?.metadata as { testsFailedCount?: number } | null)?.testsFailedCount, 8);
    assert.equal(model.outcome.recovered, 0);
  });

  it('parses patches embedded in exec-style commands and pairs their outcomes', () => {
    const text = [
      JSON.stringify({ timestamp: '2026-09-24T09:00:00.000Z', type: 'session_meta', payload: { id: 's1', cwd: 'C:/work/app' } }),
      JSON.stringify({
        timestamp: '2026-09-24T09:00:10.000Z', type: 'response_item',
        payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'const patch = "*** Begin Patch\\n*** Update File: C:\\\\work\\\\app\\\\src\\\\a.ts\\n@@\n-old\n+new"; await tools.exec_command({cmd:"node apply.js", workdir:"C:/work/app"})' },
      }),
      JSON.stringify({
        timestamp: '2026-09-24T09:00:20.000Z', type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'output_text', text: 'done. exit code: 0' }] },
      }),
    ].join('\n');
    const result = parseCodexPigeonSession(text);
    const fileEvent = result.events.find((e) => e.type === 'FILE_CHANGED');
    assert.ok(fileEvent);
    assert.equal(fileEvent.filePath, 'src/a.ts');
    // The exec wrapper only transports the patch; its success is recorded on
    // the file event itself (status running → ok once the output arrives).
    assert.equal(fileEvent.status, 'ok');
    const failedPatch = parseCodexPigeonSession(
      [
        JSON.stringify({ timestamp: '2026-09-24T09:00:00.000Z', type: 'session_meta', payload: { id: 's1', cwd: 'C:/work/app' } }),
        JSON.stringify({
          timestamp: '2026-09-24T09:00:10.000Z', type: 'response_item',
          payload: { type: 'custom_tool_call', call_id: 'c2', name: 'exec', input: 'const patch = "*** Begin Patch\\n*** Update File: C:\\\\work\\\\app\\\\src\\\\a.ts\\n@@\n-old\n+new"; await tools.exec_command({cmd:"node apply.js"})' },
        }),
        JSON.stringify({
          timestamp: '2026-09-24T09:00:20.000Z', type: 'response_item',
          payload: { type: 'custom_tool_call_output', call_id: 'c2', output: [{ type: 'output_text', text: 'Script failed\nexit code: 1' }] },
        }),
      ].join('\n'),
    );
    const model = buildSessionModel(failedPatch.events);
    const problem = model.problems.find((p) => p.kind === 'command-failure');
    assert.ok(problem, 'a failed embedded patch is a problem');
  });

  it('records a failed patch as a command failure', () => {
    const text = [
      JSON.stringify({ timestamp: '2026-09-24T09:00:00.000Z', type: 'session_meta', payload: { id: 's1' } }),
      JSON.stringify({
        timestamp: '2026-09-24T09:00:10.000Z', type: 'response_item',
        payload: { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: '*** Begin Patch\n*** Delete File: src/gone.ts\n*** End Patch' },
      }),
      JSON.stringify({
        timestamp: '2026-09-24T09:00:20.000Z', type: 'response_item',
        payload: { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'output_text', text: 'Script failed\nexit code: 1' }] },
      }),
    ].join('\n');
    const result = parseCodexPigeonSession(text);
    const model = buildSessionModel(result.events);
    const p = model.problems.find((x) => x.kind === 'command-failure');
    assert.ok(p, 'failed patch is a problem');
    assert.equal(p.agentId, 'main');
  });
});

describe('claude adapter (PARTIAL)', () => {
  const t = (offset: number): string => new Date(Date.parse('2026-09-24T09:00:00.000Z') + offset).toISOString();

  function claudeLine(obj: Record<string, unknown>): string {
    return JSON.stringify(obj);
  }

  const sample = [
    claudeLine({ type: 'user', timestamp: t(0), sessionId: 'sess-1234', cwd: 'C:/work/app', isMeta: true, message: { role: 'user', content: '<command-name>/model</command-name>' } }),
    claudeLine({ type: 'user', timestamp: t(1000), sessionId: 'sess-1234', message: { role: 'user', content: 'fix the popup bug' } }),
    claudeLine({ type: 'assistant', timestamp: t(2000), sessionId: 'sess-1234', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'C:/work/app/src/popup.ts' } }] } }),
    claudeLine({ type: 'assistant', timestamp: t(3000), sessionId: 'sess-1234', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'C:/work/app/src/popup.ts', old_string: 'a', new_string: 'b' } }] } }),
    claudeLine({ type: 'assistant', timestamp: t(4000), sessionId: 'sess-1234', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't3', name: 'Bash', input: { command: 'npm test' } }] } }),
    claudeLine({ type: 'user', timestamp: t(6000), sessionId: 'sess-1234', toolUseResult: { stderr: '', stdout: 'ok', durationMs: 2500 }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't3', is_error: true, content: 'Tests: 3 failed, 12 passed' }] } }),
    claudeLine({ type: 'assistant', timestamp: t(7000), sessionId: 'sess-1234', isApiErrorMessage: true, error: 'unknown', message: { role: 'assistant', content: [{ type: 'text', text: 'API Error: 402 insufficient_quota' }], } }),
    claudeLine({ type: 'assistant', timestamp: t(8000), sessionId: 'sess-1234', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't4', name: 'Bash', input: { command: 'npm test' } }] } }),
    claudeLine({ type: 'user', timestamp: t(10_000), sessionId: 'sess-1234', toolUseResult: { stdout: 'pass', durationMs: 2000 }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't4', is_error: false, content: 'all green' }] } }),
  ].join('\n');

  it('detects the claude format', () => {
    assert.equal(looksLikeClaudeSession(sample), true);
    assert.equal(detectAdapter(sample), 'claude');
  });

  it('maps edits, reads, commands and verification outcomes', () => {
    const result = parseClaudePigeonSession(sample);
    const types = result.events.map((e) => e.type);
    assert.ok(types.includes('MESSAGE'));
    assert.ok(types.includes('FILE_READ'));
    assert.ok(types.includes('FILE_CHANGED'));
    assert.ok(types.includes('TEST_STARTED'));
    assert.ok(types.includes('TEST_FAILED'));
    assert.ok(types.includes('TEST_PASSED'));
    const model = buildSessionModel(result.events);
    assert.equal(model.task, 'fix the popup bug');
    const problem = model.problems.find((p) => p.kind === 'test-failure');
    assert.ok(problem);
    assert.equal(problem.status, 'RECOVERED');
    assert.equal(problem.recoverySignal?.description, 'tests passed');
    const failed = result.events.find((e) => e.type === 'TEST_FAILED');
    assert.equal((failed?.metadata as { testsFailedCount?: number } | null)?.testsFailedCount, 3);
    // display-safe path: cwd prefix stripped
    const changed = result.events.find((e) => e.type === 'FILE_CHANGED');
    assert.equal(changed?.filePath, 'src/popup.ts');
  });

  it('records an API error with the real identity text', () => {
    const result = parseClaudePigeonSession(sample);
    const apiError = result.events.find((e) => e.type === 'ERROR');
    assert.ok(apiError);
    assert.match(apiError.error ?? '', /402/u);
  });

  it('maps sidechain lines to a subagent under main', () => {
    const sidechain = [
      claudeLine({ type: 'user', timestamp: t(0), sessionId: 'sess-9', message: { role: 'user', content: 'main thread' } }),
      claudeLine({ type: 'assistant', timestamp: t(1000), sessionId: 'sess-9', isSidechain: true, message: { role: 'assistant', content: [{ type: 'tool_use', id: 's1', name: 'Read', input: { file_path: 'C:/work/app/src/x.ts' } }] } }),
    ].join('\n');
    const result = parseClaudePigeonSession(sidechain);
    const started = result.events.find((e) => e.type === 'SUBAGENT_STARTED');
    assert.ok(started);
    assert.equal(started.agentId, 'sidechain');
    assert.equal(started.parentAgentId, 'main');
  });
});

describe('adapter registry', () => {
  it('detects each format from its first lines', () => {
    const codexText = readFileSync(join(fixturesRoot, 'codex', 'sample-rollout.jsonl'), 'utf8');
    const pigeonText = readFileSync(pigeonFixture('a-simple-success.pigeon.jsonl'), 'utf8');
    assert.equal(detectAdapter(codexText), 'codex');
    assert.equal(detectAdapter(pigeonText), 'generic-jsonl');
  });

  it('loadSessionModel end-to-end on the reference fixture', () => {
    const model = loadSessionModel(pigeonFixture('b-failure-recovery.pigeon.jsonl'));
    assert.ok(model);
    assert.equal(model.outcome.status, 'SUCCESS');
    assert.equal(model.problems.length, 2);
  });

  it('discoverSessionFiles finds pigeon fixtures in a directory (read-only)', () => {
    const found = discoverSessionFiles({ claudeDir: pigeonFixture('.'), codexDir: join(tmpdir(), 'definitely-missing-pigeon-dir') });
    assert.ok(found.length >= 4);
    assert.ok(found.every((f) => f.adapterId === 'generic-jsonl'));
    // newest first
    const mtimes = found.map((f) => f.mtimeMs);
    assert.deepEqual(mtimes, [...mtimes].sort((a, b) => b - a));
  });

  it('returns null for unreadable content instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pigeon-bad-'));
    try {
      const file = join(dir, 'x.jsonl');
      writeFileSync(file, 'not a session at all\n', 'utf8');
      assert.equal(loadSessionModel(file), null);
      mkdirSync(join(dir, 'sub'), { recursive: true });
      assert.equal(loadSessionModel(join(dir, 'missing.jsonl')), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
