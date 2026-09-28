import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

import { buildSessionModel } from '../src/pigeon/process.js';
import { parsePigeonJsonl } from '../src/adapters/generic-jsonl.js';
import type { PigeonEvent } from '../src/pigeon/types.js';

const BASE = Date.parse('2026-09-24T09:00:00.000Z');

/** Deterministic synthetic session with a realistic event mix + failures. */
function syntheticEvents(count: number): PigeonEvent[] {
  const events: PigeonEvent[] = [];
  let ms = 0;
  const failureKinds = ['TEST_FAILED', 'BUILD_FAILED', 'COMMAND_COMPLETED'] as const;
  for (let i = 0; i < count; i++) {
    ms += 1000;
    const mod = i % 20;
    let type: string;
    if (mod === 0) type = 'FILE_READ';
    else if (mod === 5) type = 'FILE_CHANGED';
    else if (mod === 7) type = 'MESSAGE';
    else if (mod === 9) type = 'TEST_STARTED';
    else if (mod === 11) type = failureKinds[i % 3] ?? 'ERROR';
    else if (mod === 13) type = 'TEST_PASSED';
    else if (mod === 15) type = 'COMMAND_STARTED';
    else if (mod === 17) type = 'COMMAND_COMPLETED';
    else type = 'TOOL_CALLED';
    const event: PigeonEvent = {
      id: `e${i}`,
      sessionId: 'perf',
      agentId: 'main',
      type: type as PigeonEvent['type'],
      timestamp: new Date(BASE + ms).toISOString(),
      source: 'perf',
      summary: `event ${i}`,
    };
    if (type === 'FILE_READ' || type === 'FILE_CHANGED') event.filePath = `src/module${i % 50}.ts`;
    if (type === 'COMMAND_STARTED' || type === 'COMMAND_COMPLETED' || type.startsWith('TEST_') || type.startsWith('BUILD_')) {
      event.command = 'npm test';
      event.exitCode = type === 'COMMAND_COMPLETED' ? (mod === 11 ? 1 : 0) : undefined;
    }
    if (type === 'TEST_FAILED') event.metadata = { testsFailedCount: 3 };
    events.push(event);
  }
  return events;
}

describe('performance (directive §26)', () => {
  // Generous CI budget: the processor is linear, these bounds are ~10x the
  // observed cost on a dev machine, so the test verifies scalability shape,
  // not exact speed.
  const budgets: Record<number, number> = { 100: 1000, 1000: 1500, 10_000: 6000 };

  for (const size of [100, 1000, 10_000]) {
    it(`processes ${size} events within ${budgets[size]}ms and stays correct`, () => {
      const events = syntheticEvents(size);
      const parseStart = performance.now();
      const text = events.map((e) => JSON.stringify(e)).join('\n');
      const parsed = parsePigeonJsonl(text);
      const parseMs = performance.now() - parseStart;

      const processStart = performance.now();
      const model = buildSessionModel(parsed.events);
      const processMs = performance.now() - processStart;

      assert.equal(model.timeline.length, size);
      assert.ok(model.problems.length > 0, 'synthetic failures detected');
      assert.ok(
        parseMs + processMs < (budgets[size] ?? 10_000),
        `${size} events took ${parseMs.toFixed(0)}+${processMs.toFixed(0)}ms`,
      );
    });
  }

  it('10k processing is roughly linear (10x events ⇒ <25x time of 1k)', () => {
    const timeFor = (size: number): number => {
      const start = performance.now();
      buildSessionModel(syntheticEvents(size));
      return performance.now() - start;
    };
    const small = timeFor(1000);
    const large = timeFor(10_000);
    assert.ok(large < small * 25, `1k=${small.toFixed(0)}ms 10k=${large.toFixed(0)}ms`);
  });
});
