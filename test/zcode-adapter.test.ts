import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseZCodePigeonSession, looksLikeZCodeModelIo } from '../src/adapters/zcode.js';
import { detectAdapter } from '../src/adapters/index.js';
import { buildSessionModel } from '../src/pigeon/process.js';

const BASE = Date.parse('2026-09-28T10:00:00.000Z');

/** Real model-io shape: one line per model turn; results replay in windows. */
function modelIoLine(opts: {
  turn: number;
  text?: string;
  toolCalls?: Array<{ id: string; name: string; input: Record<string, unknown> }>;
  windowMessages?: Array<Record<string, unknown>>;
}): string {
  return JSON.stringify({
    completedAt: new Date(BASE + opts.turn * 5000 + 4000).toISOString(),
    durationMs: 4000,
    requestId: `req-${opts.turn}`,
    attempt: 1,
    sessionId: 'sess_abcdef12-0000-1111-2222-333333333333',
    querySource: 'cli',
    startedAt: new Date(BASE + opts.turn * 5000).toISOString(),
    turnId: `turn-${opts.turn}`,
    type: 'model-io',
    request: {
      body: { model: 'GLM-5.3-Flash' },
      messages: opts.windowMessages ?? [],
      toolNames: [],
      messageCount: opts.windowMessages?.length ?? 0,
      messagesKind: 'full',
      messageOffset: 0,
    },
    response: {
      finishReason: 'tool_calls',
      text: opts.text ?? '',
      toolCalls: opts.toolCalls ?? [],
    },
  });
}

function toolResult(toolCallId: string, content: string, isError: boolean): Record<string, unknown> {
  return { role: 'tool', content, toolCallId, toolName: 'Bash', isError };
}

describe('zcode adapter (EXPERIMENTAL)', () => {
  const sample = [
    modelIoLine({
      turn: 0,
      text: 'I will inspect the failing module first.',
      toolCalls: [{ id: 'call_1', name: 'Read', input: { file_path: 'C:\\work\\app\\src\\auth.ts' } }],
      windowMessages: [
        { role: 'user', content: 'fix the login redirect loop' },
        { role: 'assistant', content: 'On it.' },
      ],
    }),
    modelIoLine({
      turn: 1,
      toolCalls: [{ id: 'call_2', name: 'Bash', input: { command: 'npm test' } }],
      windowMessages: [
        { role: 'user', content: 'fix the login redirect loop' },
        toolResult('call_1', 'import { session } from "./auth"', false),
      ],
    }),
    modelIoLine({
      turn: 2,
      toolCalls: [{ id: 'call_3', name: 'Edit', input: { file_path: 'C:\\work\\app\\src\\middleware.ts', old_string: 'a', new_string: 'b' } }],
      windowMessages: [
        { role: 'user', content: 'fix the login redirect loop' },
        toolResult('call_1', 'import { session } from "./auth"', false),
        toolResult('call_2', 'Tests: 4 failed, 12 passed', true),
      ],
    }),
    modelIoLine({
      turn: 3,
      text: 'Redirect guard fixed, rerunning tests.',
      toolCalls: [{ id: 'call_4', name: 'Bash', input: { command: 'npm test' } }],
      windowMessages: [
        { role: 'user', content: 'fix the login redirect loop' },
        toolResult('call_2', 'Tests: 4 failed, 12 passed', true),
        toolResult('call_3', 'ok', false),
      ],
    }),
    modelIoLine({
      turn: 4,
      text: 'All green now.',
      windowMessages: [
        toolResult('call_4', 'all 16 tests passed', false),
        { role: 'user', content: 'follow-up: also update the docs' },
      ],
    }),
  ].join('\n');

  it('detects the model-io format and picks the zcode adapter', () => {
    assert.equal(looksLikeZCodeModelIo(sample), true);
    assert.equal(detectAdapter(sample), 'zcode');
    assert.equal(detectAdapter('not json'), null);
  });

  it('maps task, tool calls, results and verification outcomes', () => {
    const result = parseZCodePigeonSession(sample);
    assert.equal(result.skippedLines, 0);
    assert.equal(result.sessionId, 'abcdef12');
    const types = result.events.map((e) => e.type);
    assert.ok(types.includes('MESSAGE'));
    assert.ok(types.includes('FILE_READ'));
    assert.ok(types.includes('FILE_CHANGED'));
    assert.ok(types.includes('TEST_STARTED'));
    assert.ok(types.includes('TEST_FAILED'));
    assert.ok(types.includes('TEST_PASSED'));
    // results replay in every window — each must be emitted exactly once
    assert.equal(types.filter((t) => t === 'TEST_FAILED').length, 1);
    assert.equal(types.filter((t) => t === 'TEST_PASSED').length, 1);

    const model = buildSessionModel(result.events);
    assert.equal(model.task, 'fix the login redirect loop');
    const problem = model.problems.find((p) => p.kind === 'test-failure');
    assert.ok(problem);
    assert.equal(problem.status, 'RECOVERED');
    assert.equal((result.events.find((e) => e.type === 'TEST_FAILED')?.metadata as { testsFailedCount?: number } | null)?.testsFailedCount, 4);
    // display-safe paths
    const changed = result.events.find((e) => e.type === 'FILE_CHANGED');
    assert.equal(changed?.filePath, 'work/app/src/middleware.ts');
  });

  it('maps Agent-tool spawns to subagents under main', () => {
    const text = [
      modelIoLine({
        turn: 0,
        toolCalls: [{ id: 'call_a', name: 'Agent', input: { subagent_type: 'general-purpose', description: 'research pricing' } }],
      }),
      modelIoLine({
        turn: 1,
        windowMessages: [toolResult('call_a', 'research done', false)],
      }),
    ].join('\n');
    const result = parseZCodePigeonSession(text);
    const started = result.events.find((e) => e.type === 'SUBAGENT_STARTED');
    const completed = result.events.find((e) => e.type === 'SUBAGENT_COMPLETED');
    assert.ok(started && completed);
    assert.equal(started.parentAgentId, 'main');
    assert.match(started.summary ?? '', /research pricing/u);
    assert.equal(completed.agentId, started.agentId);
    assert.equal(completed.status, 'ok');
  });

  it('skips corrupted lines without losing the session', () => {
    const text = ['{ broken json', modelIoLine({ turn: 0, text: 'hello' })].join('\n');
    const result = parseZCodePigeonSession(text);
    assert.equal(result.skippedLines, 1);
    assert.ok(result.events.length >= 1);
    assert.equal(result.warnings.length, 1);
  });
});
