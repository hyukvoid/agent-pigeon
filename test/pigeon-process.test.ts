import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionModel } from '../src/pigeon/process.js';
import { problemsOnlyView, currentFlightSteps, filterSessionList } from '../src/pigeon/select.js';
import type { PigeonEvent, PigeonEventType } from '../src/pigeon/types.js';

const BASE = Date.parse('2026-09-24T09:00:00.000Z');
let seq = 0;

function ev(offsetMs: number, type: PigeonEventType, extra: Partial<PigeonEvent> = {}, agentId = 'main'): PigeonEvent {
  seq++;
  return {
    id: `e${String(seq).padStart(4, '0')}`,
    sessionId: 's-test',
    agentId,
    type,
    timestamp: new Date(BASE + offsetMs).toISOString(),
    source: 'test',
    ...extra,
  };
}

describe('session processor — ordering and structure', () => {
  it('orders events chronologically regardless of input order', () => {
    const model = buildSessionModel([
      ev(3000, 'FILE_CHANGED', { filePath: 'b.ts' }),
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'FILE_READ', { filePath: 'a.ts' }),
    ]);
    assert.deepEqual(model.timeline.map((t) => t.event.type), ['SESSION_STARTED', 'FILE_READ', 'FILE_CHANGED']);
    assert.deepEqual(model.timeline.map((t) => t.offsetMs), [0, 1000, 3000]);
  });

  it('derives the task from the first user message', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'MESSAGE', { summary: 'assistant opener', metadata: { role: 'assistant' } }),
      ev(2000, 'MESSAGE', { summary: 'fix the login redirect', metadata: { role: 'user' } }),
    ]);
    assert.equal(model.task, 'fix the login redirect');
  });

  it('marks sessions without an end event UNKNOWN, with explicit running override', () => {
    const base = [ev(0, 'SESSION_STARTED'), ev(1000, 'MESSAGE', { summary: 'hi', metadata: { role: 'user' } })];
    assert.equal(buildSessionModel(base).sessionStatus, 'UNKNOWN');
    assert.equal(buildSessionModel(base, { running: true }).sessionStatus, 'RUNNING');
  });

  it('uses SESSION_COMPLETED metadata as the end and outcome', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'MESSAGE', { summary: 'work', metadata: { role: 'user' } }),
      ev(60_000, 'SESSION_COMPLETED', { metadata: { outcome: 'success' } }),
    ]);
    assert.equal(model.sessionStatus, 'COMPLETED');
    assert.equal(model.durationMs, 60_000);
    assert.equal(model.outcome.status, 'SUCCESS');
  });
});

describe('session processor — parent/child agents', () => {
  it('links subagents via parentAgentId and never invents parents', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'SUBAGENT_STARTED', { metadata: { task: 'run tests' } }, 'test-agent'),
      ev(10_000, 'SUBAGENT_COMPLETED', { status: 'ok' }, 'test-agent'),
    ]);
    const root = model.agents.find((a) => a.agentId === 'main');
    const sub = model.agents.find((a) => a.agentId === 'test-agent');
    assert.ok(root && sub);
    assert.deepEqual(root.children, ['test-agent']);
    assert.equal(sub.parentAgentId, 'main');
    assert.equal(sub.status, 'SUCCESS');
    assert.equal(sub.taskSummary, 'run tests');
  });

  it('an agent with no start event still appears with UNKNOWN status', () => {
    const model = buildSessionModel([ev(0, 'SESSION_STARTED'), ev(100, 'FILE_READ', { filePath: 'a.ts' }, 'mystery')]);
    const mystery = model.agents.find((a) => a.agentId === 'mystery');
    assert.ok(mystery);
    assert.equal(mystery.status, 'UNKNOWN');
  });
});

describe('session processor — failure detection', () => {
  it('detects test/build failures and non-zero command exits as problems', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'TEST_FAILED', { command: 'npm test', error: 'AssertionError', metadata: { testsFailedCount: 4 } }),
      ev(2000, 'BUILD_FAILED', { command: 'npm run build', error: 'error TS2304' }),
      ev(3000, 'COMMAND_COMPLETED', { command: 'node check.js', exitCode: 1 }),
      ev(4000, 'COMMAND_COMPLETED', { command: 'node ok.js', exitCode: 0 }),
    ]);
    assert.deepEqual(model.problems.map((p) => p.kind), ['test-failure', 'build-failure', 'command-failure']);
    assert.equal(model.outcome.failures, 3);
    assert.equal(model.outcome.commandsFailed, 1);
  });

  it('does not treat the word "error" in successful output as failure', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'COMMAND_COMPLETED', { command: 'grep -r "error" .', exitCode: 0, status: 'ok' }),
    ]);
    assert.equal(model.problems.length, 0);
  });
});

describe('session processor — recovery detection', () => {
  it('RECOVERED: test failure → file changed → tests passed', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'TEST_FAILED', { command: 'npm test', metadata: { testsFailedCount: 4 } }),
      ev(5000, 'FILE_READ', { filePath: 'src/auth.ts' }),
      ev(8000, 'FILE_CHANGED', { filePath: 'src/middleware.ts' }),
      ev(12_000, 'TEST_STARTED', { command: 'npm test' }),
      ev(16_000, 'TEST_PASSED', { command: 'npm test' }),
      ev(20_000, 'SESSION_COMPLETED', { metadata: { outcome: 'success' } }),
    ]);
    assert.equal(model.problems.length, 1);
    const p = model.problems[0];
    assert.ok(p);
    assert.equal(p.status, 'RECOVERED');
    assert.equal(p.followUpCount, 3);
    assert.ok(p.followUps.some((f) => f.description.includes('src/middleware.ts changed')));
    assert.equal(p.recoverySignal?.description, 'tests passed');
    assert.equal(model.outcome.recovered, 1);
    assert.equal(model.outcome.unresolved, 0);
    assert.equal(model.outcome.status, 'SUCCESS');
  });

  it('RECOVERED: command failure → same command succeeds later', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'COMMAND_COMPLETED', { command: 'node scripts/check.js', exitCode: 1, status: 'error' }),
      ev(5000, 'COMMAND_STARTED', { command: 'node scripts/check.js' }),
      ev(9000, 'COMMAND_COMPLETED', { command: 'node scripts/check.js', exitCode: 0, status: 'ok' }),
      ev(12_000, 'SESSION_COMPLETED', { metadata: { outcome: 'success' } }),
    ]);
    const p = model.problems[0];
    assert.ok(p);
    assert.equal(p.status, 'RECOVERED');
    assert.equal(p.recoverySignal?.description, 'node scripts/check.js succeeded');
  });

  it('a DIFFERENT succeeding command does not recover a failed command', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'COMMAND_COMPLETED', { command: 'node a.js', exitCode: 1, status: 'error' }),
      ev(5000, 'COMMAND_COMPLETED', { command: 'node b.js', exitCode: 0, status: 'ok' }),
    ]);
    const p = model.problems[0];
    assert.ok(p);
    assert.equal(p.status, 'UNRESOLVED');
    assert.equal(model.outcome.status, 'UNKNOWN');
  });

  it('a success declaration is only weak recovery evidence', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'COMMAND_COMPLETED', { command: 'node a.js', exitCode: 1, status: 'error' }),
      ev(5000, 'COMMAND_COMPLETED', { command: 'node b.js', exitCode: 0, status: 'ok' }),
      ev(12_000, 'SESSION_COMPLETED', { metadata: { outcome: 'success' } }),
    ]);
    const p = model.problems[0];
    assert.ok(p);
    assert.equal(p.status, 'POSSIBLY_RECOVERED');
    assert.equal(model.outcome.status, 'SUCCESS');
  });

  it('POSSIBLY_RECOVERED: code error followed by an unrelated positive signal', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'ERROR', { error: 'TypeError: cannot read properties of undefined (reading id)', toolName: 'WebFetch' }),
      ev(3000, 'FILE_CHANGED', { filePath: 'src/client.ts' }),
      ev(8000, 'TEST_PASSED', { command: 'npm test' }),
      ev(12_000, 'SESSION_COMPLETED', { metadata: { outcome: 'success' } }),
    ]);
    const p = model.problems[0];
    assert.ok(p);
    assert.equal(p.category, 'CODE');
    assert.equal(p.status, 'POSSIBLY_RECOVERED');
  });

  it('network/transport errors are ENVIRONMENT and never code-recovered', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'ERROR', { error: 'fetch failed: ECONNRESET while fetching' }),
      ev(3000, 'FILE_CHANGED', { filePath: 'src/client.ts' }),
      ev(8000, 'TEST_PASSED', { command: 'npm test' }),
      ev(12_000, 'SESSION_COMPLETED', { metadata: { outcome: 'success' } }),
    ]);
    const p = model.problems[0];
    assert.ok(p);
    assert.equal(p.category, 'ENVIRONMENT');
    assert.equal(p.status, 'BLOCKED');
  });

  it('UNRESOLVED: failure with no positive signal in a completed session', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'BUILD_FAILED', { command: 'npm run build' }),
      ev(12_000, 'SESSION_COMPLETED', { metadata: { outcome: 'failure' } }),
    ]);
    assert.equal(model.problems[0]?.status, 'UNRESOLVED');
    assert.equal(model.outcome.status, 'FAILED');
  });

  it('PENDING: unresolved failure while the session is still running', () => {
    const model = buildSessionModel(
      [ev(0, 'SESSION_STARTED'), ev(1000, 'TEST_FAILED', { command: 'npm test' })],
      { running: true },
    );
    assert.equal(model.problems[0]?.status, 'PENDING');
    assert.equal(model.sessionStatus, 'RUNNING');
  });

  it('merges consecutive same-kind failures into one problem with attempts count', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'TEST_FAILED', { command: 'npm test', metadata: { testsFailedCount: 4 } }),
      ev(6000, 'TEST_FAILED', { command: 'npm test', metadata: { testsFailedCount: 2 } }),
      ev(11_000, 'TEST_PASSED', { command: 'npm test' }),
      ev(15_000, 'SESSION_COMPLETED', { metadata: { outcome: 'success' } }),
    ]);
    assert.equal(model.problems.length, 1);
    const p = model.problems[0];
    assert.ok(p);
    assert.equal(p.attempts, 2);
    assert.equal(model.outcome.failures, 2);
  });

  it('agent-failure with reassignment recovers when the same task respawns', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'SUBAGENT_STARTED', { metadata: { task: 'browser verification' } }, 'browser-a'),
      ev(5000, 'SUBAGENT_COMPLETED', { status: 'error', error: 'crashed' }, 'browser-a'),
      ev(8000, 'SUBAGENT_STARTED', { metadata: { task: 'browser verification' } }, 'browser-b'),
      ev(15_000, 'SUBAGENT_COMPLETED', { status: 'ok' }, 'browser-b'),
    ]);
    const p = model.problems.find((x) => x.kind === 'agent-failure');
    assert.ok(p);
    assert.equal(p.status, 'RECOVERED');
    assert.match(p.recoverySignal?.description ?? '', /reassigned to browser-b/u);
  });

  it('subagent failure recovery can be performed by the parent agent', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'SUBAGENT_STARTED', { metadata: { task: 'browser check' } }, 'browser-agent'),
      ev(2000, 'COMMAND_STARTED', { command: 'node scripts/browser-check.js' }, 'browser-agent'),
      ev(5000, 'COMMAND_COMPLETED', { command: 'node scripts/browser-check.js', exitCode: 1, status: 'error' }, 'browser-agent'),
      ev(8000, 'FILE_CHANGED', { filePath: 'src/config.ts' }), // parent (main) fixes
      ev(10_000, 'COMMAND_STARTED', { command: 'node scripts/browser-check.js' }, 'browser-agent'),
      ev(13_000, 'COMMAND_COMPLETED', { command: 'node scripts/browser-check.js', exitCode: 0, status: 'ok' }, 'browser-agent'),
    ]);
    const p = model.problems[0];
    assert.ok(p);
    assert.equal(p.status, 'RECOVERED');
    assert.ok(p.followUps.some((f) => f.description.includes('src/config.ts changed')));
  });
});

describe('session processor — files and outcome', () => {
  it('aggregates file touches with agents, counts and involvement', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'FILE_READ', { filePath: 'src/api.ts' }),
      ev(2000, 'FILE_CHANGED', { filePath: 'src/api.ts', metadata: { additions: 21, deletions: 8 } }),
      ev(3000, 'FILE_CHANGED', { filePath: 'src/api.ts' }, 'reviewer'),
      ev(4000, 'TEST_FAILED', { command: 'npm test' }),
      ev(5000, 'FILE_CHANGED', { filePath: 'src/api.ts' }),
      ev(6000, 'TEST_PASSED', { command: 'npm test' }),
    ]);
    const file = model.files.find((f) => f.path === 'src/api.ts');
    assert.ok(file);
    assert.equal(file.changed, 3);
    assert.equal(file.reads, 1);
    assert.equal(file.edits, 3);
    assert.deepEqual(file.agents, ['main', 'reviewer']);
    assert.equal(file.firstTouchedBy, 'main');
    assert.equal(file.lastTouchedBy, 'main');
    assert.equal(file.additions, 21);
    assert.equal(file.deletions, 8);
    assert.equal(file.involvedInProblems, true);
    assert.equal(model.outcome.filesChanged, 1);
  });

  it('counts tests/builds/commands/agents in the outcome', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'TEST_PASSED', { command: 'npm test' }),
      ev(2000, 'TEST_FAILED', { command: 'npm test' }),
      ev(3000, 'BUILD_PASSED', { command: 'npm run build' }),
      ev(4000, 'COMMAND_COMPLETED', { command: 'node x.js', exitCode: 0 }),
      ev(5000, 'SESSION_COMPLETED', { metadata: { outcome: 'success' } }),
    ]);
    assert.equal(model.outcome.testsPassed, 1);
    assert.equal(model.outcome.testsFailed, 1);
    assert.equal(model.outcome.buildsPassed, 1);
    assert.equal(model.outcome.commandsRun, 1);
    assert.equal(model.outcome.agents, 1);
  });

  it('root agent status follows the session outcome', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'SESSION_COMPLETED', { metadata: { outcome: 'success' } }),
    ]);
    assert.equal(model.agents.find((a) => a.agentId === 'main')?.status, 'SUCCESS');
  });
});

describe('problems-only view ("show me only the mess")', () => {
  it('hides routine operations, keeps problems and their recovery chains', () => {
    const events = [
      ev(0, 'SESSION_STARTED'),
      ev(500, 'FILE_READ', { filePath: 'r1.ts' }),
      ev(1000, 'FILE_READ', { filePath: 'r2.ts' }),
      ev(2000, 'MESSAGE', { summary: 'do the thing', metadata: { role: 'user' } }),
      ev(3000, 'TEST_FAILED', { command: 'npm test' }),
      ev(4000, 'FILE_READ', { filePath: 'suspect.ts' }),
      ev(5000, 'FILE_CHANGED', { filePath: 'fix.ts' }),
      ev(6000, 'TEST_PASSED', { command: 'npm test' }),
      ev(7000, 'FILE_READ', { filePath: 'r3.ts' }),
      ev(8000, 'FILE_READ', { filePath: 'r4.ts' }),
      ev(9000, 'SESSION_COMPLETED', { metadata: { outcome: 'success' } }),
    ];
    const model = buildSessionModel(events);
    const { events: kept, hiddenCount } = problemsOnlyView(model);
    assert.ok(kept.every((e) => e.filePath !== 'r1.ts'));
    assert.ok(kept.some((e) => e.filePath === 'suspect.ts'));
    assert.ok(kept.some((e) => e.filePath === 'fix.ts'));
    assert.ok(hiddenCount > 0);
    assert.equal(model.routineCount, hiddenCount);
  });

  it('current flight steps list problems and recoveries in order', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(500, 'MESSAGE', { summary: 'fix login', metadata: { role: 'user' } }),
      ev(1000, 'TEST_FAILED', { command: 'npm test' }),
      ev(3000, 'TEST_PASSED', { command: 'npm test' }),
    ], { running: true });
    const steps = currentFlightSteps(model);
    assert.ok(steps.some((s) => s.label === 'fix login'));
    assert.ok(steps.some((s) => s.glyph === '✕'));
    assert.ok(steps.some((s) => s.glyph === '↻'));
  });
});

describe('session list filtering', () => {
  const entries = [
    { sessionId: 'a', label: 'Fix popup', status: 'SUCCESS' as const, durationMs: 1000, lastActivityMs: 1, problems: 0, source: 'codex' },
    { sessionId: 'b', label: 'Implement search', status: 'FAILED' as const, durationMs: 2000, lastActivityMs: 2, problems: 2, source: 'claude' },
    { sessionId: 'c', label: 'Refactor API', status: 'RUNNING' as const, durationMs: null, lastActivityMs: 3, problems: 0, source: 'codex' },
  ];
  it('filters by status', () => {
    assert.equal(filterSessionList(entries, 'success', '').length, 1);
    assert.equal(filterSessionList(entries, 'failed', '').length, 1);
    assert.equal(filterSessionList(entries, 'running', '').length, 1);
    assert.equal(filterSessionList(entries, 'all', '').length, 3);
  });
  it('filters by query on label and id', () => {
    assert.equal(filterSessionList(entries, 'all', 'search').length, 1);
    assert.equal(filterSessionList(entries, 'all', 'popup').length, 1);
    assert.equal(filterSessionList(entries, 'all', 'zzz-not-there').length, 0);
  });
});
