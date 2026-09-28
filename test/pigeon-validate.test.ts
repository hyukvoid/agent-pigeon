import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { validatePigeonEvent, validatePigeonEvents } from '../src/pigeon/validate.js';

const VALID = {
  id: 'e1',
  sessionId: 's1',
  type: 'FILE_CHANGED',
  timestamp: '2026-09-24T09:00:00.000Z',
};

describe('pigeon event validation', () => {
  it('accepts a minimal valid event', () => {
    const r = validatePigeonEvent(VALID);
    assert.equal(r.ok, true);
  });

  it('accepts every declared event type', () => {
    for (const type of [
      'SESSION_STARTED', 'SESSION_COMPLETED', 'AGENT_STARTED', 'AGENT_COMPLETED',
      'SUBAGENT_STARTED', 'SUBAGENT_COMPLETED', 'MESSAGE', 'TOOL_CALLED', 'TOOL_RESULT',
      'FILE_READ', 'FILE_CREATED', 'FILE_CHANGED', 'FILE_DELETED',
      'COMMAND_STARTED', 'COMMAND_COMPLETED',
      'TEST_STARTED', 'TEST_PASSED', 'TEST_FAILED',
      'BUILD_STARTED', 'BUILD_PASSED', 'BUILD_FAILED', 'ERROR', 'CHECKPOINT',
    ]) {
      const r = validatePigeonEvent({ ...VALID, type });
      assert.equal(r.ok, true, type);
    }
  });

  it('rejects non-objects and missing required fields', () => {
    assert.equal(validatePigeonEvent(null).ok, false);
    assert.equal(validatePigeonEvent('x').ok, false);
    assert.equal(validatePigeonEvent({}).ok, false);
    const r = validatePigeonEvent({ id: '', sessionId: 's', type: 'MESSAGE', timestamp: 'nope' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.errors.length >= 2);
  });

  it('rejects unknown types and statuses', () => {
    assert.equal(validatePigeonEvent({ ...VALID, type: 'AGENT_THOUGHT' }).ok, false);
    assert.equal(validatePigeonEvent({ ...VALID, status: 'vibes' }).ok, false);
  });

  it('rejects wrong field types', () => {
    assert.equal(validatePigeonEvent({ ...VALID, exitCode: 1.5 }).ok, false);
    assert.equal(validatePigeonEvent({ ...VALID, durationMs: -1 }).ok, false);
    assert.equal(validatePigeonEvent({ ...VALID, relatedEventIds: 'e2' }).ok, false);
    assert.equal(validatePigeonEvent({ ...VALID, metadata: [1] }).ok, false);
    assert.equal(validatePigeonEvent({ ...VALID, filePath: 3 }).ok, false);
  });

  it('accepts optional evidence fields', () => {
    const r = validatePigeonEvent({
      ...VALID,
      agentId: 'sub-1',
      parentAgentId: 'main',
      parentId: 'e0',
      durationMs: 1200,
      source: 'generic-jsonl',
      summary: 'Modified src/api.ts',
      filePath: 'src/api.ts',
      command: 'npm test',
      exitCode: 0,
      toolName: 'Bash',
      status: 'ok',
      error: null,
      relatedEventIds: ['e0'],
      metadata: { testsFailedCount: 0 },
    });
    assert.equal(r.ok, true);
  });

  it('validatePigeonEvents reports per-item failures without dropping valid items', () => {
    const r = validatePigeonEvents([VALID, { nope: true }, { ...VALID, id: 'e2' }]);
    assert.equal(r.events.length, 2);
    assert.equal(r.invalid.length, 1);
    assert.equal(r.invalid[0]?.index, 1);
  });
});
