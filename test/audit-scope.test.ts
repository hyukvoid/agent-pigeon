import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildSessionModel, isCodingSession } from '../src/pigeon/process.js';
import type { PigeonEvent, PigeonEventType } from '../src/pigeon/types.js';
import { PigeonUi, type SessionListItem } from '../src/ui/server.js';
import type { Server } from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BASE = Date.parse('2026-09-29T09:00:00.000Z');
let seq = 0;
function ev(offsetMs: number, type: PigeonEventType, extra: Partial<PigeonEvent> = {}, agentId = 'main'): PigeonEvent {
  seq++;
  return {
    id: `e${String(seq).padStart(4, '0')}`,
    sessionId: 'audit',
    agentId,
    type,
    timestamp: new Date(BASE + offsetMs).toISOString(),
    source: 'audit',
    ...extra,
  };
}

describe('audit validation A–F (privacy & product scope)', () => {
  it('A: a coding session (file + command evidence) is marked coding', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED', { metadata: { cwd: 'C:\\work\\inventory-api' } }),
      ev(1000, 'FILE_CHANGED', { filePath: 'src/api.ts' }),
      ev(5000, 'TEST_PASSED', { command: 'npm test' }),
    ]);
    assert.equal(isCodingSession(model), true);
  });

  it('B: a trivial conversation session ("hi") is NOT coding and hides from the main list', async () => {
    const model = buildSessionModel([
      ev(0, 'MESSAGE', { summary: 'hi', metadata: { role: 'user' } }),
      ev(800, 'MESSAGE', { summary: 'Hello! How can I help?', metadata: { role: 'assistant' } }),
    ]);
    assert.equal(isCodingSession(model), false);

    // Server list marks it non-coding so the UI files it under Other sessions.
    const dir = mkdtempSync(join(tmpdir(), 'pigeon-audit-'));
    const ui = new PigeonUi({ claudeDir: dir, codexDir: dir, zcodeDir: dir, extraDirs: [] });
    let server: Server | null = null;
    try {
      const lines = [
        { id: 'c1', sessionId: 'chat-1', agentId: 'main', type: 'MESSAGE', timestamp: new Date(BASE).toISOString(), source: 'generic-jsonl', summary: 'hi', metadata: { role: 'user' } },
        { id: 'c2', sessionId: 'chat-1', agentId: 'main', type: 'MESSAGE', timestamp: new Date(BASE + 800).toISOString(), source: 'generic-jsonl', summary: 'Hello!', metadata: { role: 'assistant' } },
      ].map((o) => JSON.stringify(o)).join('\n');
      writeFileSync(join(dir, 'chat.pigeon.jsonl'), lines, 'utf8');
      server = await ui.listen(0);
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions?limit=20`);
      const data = await res.json() as { sessions: SessionListItem[] };
      const chat = data.sessions.find((s) => s.sessionId === 'chat-1');
      assert.ok(chat);
      assert.equal(chat.coding, false);
    } finally {
      server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('C: test failure is VALIDATION and still RECOVERED by a later green run', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'TEST_FAILED', { command: 'npm test', error: 'AssertionError: 4 failing', metadata: { testsFailedCount: 4 } }),
      ev(4000, 'FILE_CHANGED', { filePath: 'src/fix.ts' }),
      ev(9000, 'TEST_PASSED', { command: 'npm test' }),
      ev(12_000, 'SESSION_COMPLETED', { metadata: { outcome: 'success' } }),
    ]);
    const p = model.problems[0];
    assert.ok(p);
    assert.equal(p.category, 'VALIDATION');
    assert.equal(p.providerDetail, null);
    assert.equal(p.status, 'RECOVERED');
    assert.equal(model.outcome.status, 'SUCCESS');
  });

  it('D: API 402 quota error is PROVIDER/QUOTA, BLOCKED, and never "recovered"', () => {
    const model = buildSessionModel([
      ev(0, 'MESSAGE', { summary: 'hi', metadata: { role: 'user' } }),
      ev(1500, 'ERROR', { error: 'API Error: 402 {"detail":{"code":402,"message":"insufficient_quota - You have exceeded your credit quota"}}' }),
      ev(3000, 'SESSION_COMPLETED'),
    ]);
    const p = model.problems[0];
    assert.ok(p);
    assert.equal(p.category, 'PROVIDER');
    assert.equal(p.providerDetail, 'QUOTA');
    assert.equal(p.status, 'BLOCKED');
    assert.equal(p.recoverySignal, null);
    assert.equal(p.followUpCount, 0);
    // The honest outcome: blocked, not "agent failed".
    assert.equal(model.outcome.status, 'BLOCKED');
    assert.match(p.description, /Provider issue — quota exceeded/u);
  });

  it('E: API 429 is PROVIDER/RATE_LIMIT and BLOCKED when the session ends', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'ERROR', { error: 'Error: 429 status code from API: rate_limit_exceeded' }),
      ev(4000, 'SESSION_COMPLETED'),
    ]);
    const p = model.problems[0];
    assert.ok(p);
    assert.equal(p.category, 'PROVIDER');
    assert.equal(p.providerDetail, 'RATE_LIMIT');
    assert.equal(p.status, 'BLOCKED');
    assert.equal(model.outcome.status, 'BLOCKED');
  });

  it('E2: provider failure while still running stays PENDING, not BLOCKED', () => {
    const model = buildSessionModel(
      [ev(0, 'SESSION_STARTED'), ev(1000, 'ERROR', { error: '429 too many requests' })],
      { running: true },
    );
    assert.equal(model.problems[0]?.status, 'PENDING');
    assert.equal(model.outcome.status, 'UNKNOWN');
  });

  it('F: the UI server binds to 127.0.0.1 only', async () => {
    const ui = new PigeonUi({});
    const server = await ui.listen(0);
    try {
      const address = server.address() as { address: string; port: number };
      assert.equal(address.address, '127.0.0.1');
      // Session end declared as blocked is honored too.
    } finally {
      server.close();
    }
  });

  it('G: a declared blocked outcome maps to BLOCKED and transport errors are ENVIRONMENT', () => {
    const blocked = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'ERROR', { error: 'fetch failed: ECONNRESET' }),
      ev(2000, 'SESSION_COMPLETED', { metadata: { outcome: 'blocked' } }),
    ]);
    assert.equal(blocked.problems[0]?.category, 'ENVIRONMENT');
    assert.equal(blocked.outcome.status, 'BLOCKED');
  });
});
