import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { assessAttention, ATTENTION_TIERS } from '../src/pigeon/attention.js';
import { buildSessionModel, isCodingSession } from '../src/pigeon/process.js';
import { PigeonUi } from '../src/ui/server.js';
import type { SessionListItem } from '../src/ui/server.js';
import type { Server } from 'node:http';
import type { PigeonEvent, PigeonEventType } from '../src/pigeon/types.js';

const BASE = Date.parse('2026-09-29T09:00:00.000Z');
let seq = 0;
function ev(offsetMs: number, type: PigeonEventType, extra: Partial<PigeonEvent> = {}, agentId = 'main'): PigeonEvent {
  seq++;
  return {
    id: `e${String(seq).padStart(4, '0')}`,
    sessionId: 'radar',
    agentId,
    type,
    timestamp: new Date(BASE + offsetMs).toISOString(),
    source: 'radar',
    ...extra,
  };
}

describe('attention ranking (v0.3 radar)', () => {
  it('A: Codex test failure on a running session ranks at the top as RECOVERY IN PROGRESS', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED', { metadata: { cwd: 'C:\\work\\MA Now' } }),
      ev(1000, 'TEST_FAILED', { command: 'npm test', error: '4 failing', metadata: { testsFailedCount: 4 } }),
      ev(4000, 'FILE_CHANGED', { filePath: 'src/fix.ts' }),
    ], { running: true });
    const a = assessAttention(model, true);
    assert.equal(a.tier, 3);
    assert.equal(a.label, 'RECOVERY IN PROGRESS');
    assert.equal(a.headline?.category, 'VALIDATION');
    assert.match(a.headline?.summary ?? '', /npm test/u);
  });

  it('B: failure → recovery is RECOVERY IN PROGRESS while live, RECOVERED tier after', () => {
    const live = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'TEST_FAILED', { command: 'npm test' }),
      ev(3000, 'TEST_PASSED', { command: 'npm test' }),
    ], { running: true });
    const ended = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'TEST_FAILED', { command: 'npm test' }),
      ev(3000, 'TEST_PASSED', { command: 'npm test' }),
      ev(6000, 'SESSION_COMPLETED', { metadata: { outcome: 'success' } }),
    ]);
    assert.equal(assessAttention(live, true).tier, 4);
    assert.equal(assessAttention(ended, false).tier, 6);
    assert.equal(assessAttention(ended, false).headline, null);
  });

  it('C: a Claude session with no end record is IDLE — never DONE, never RUNNING', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED', { metadata: { cwd: 'C:\\work\\GameProbe' } }),
      ev(2000, 'TEST_PASSED', { command: 'npm test' }),
    ]);
    const a = assessAttention(model, false);
    assert.equal(a.tier, 6);
    assert.equal(a.label, 'IDLE');
    assert.ok(!ATTENTION_TIERS[6].match(/DONE/u));
    assert.equal(model.sessionStatus, 'UNKNOWN');
    assert.equal(a.headline, null);
  });

  it('D: provider quota is BLOCKED tier 1 with PROVIDER category', () => {
    const model = buildSessionModel([
      ev(0, 'MESSAGE', { summary: 'fix bug', metadata: { role: 'user' } }),
      ev(1000, 'ERROR', { error: 'API Error: 402 insufficient_quota' }),
      ev(3000, 'SESSION_COMPLETED'),
    ]);
    const a = assessAttention(model, false);
    assert.equal(a.tier, 1);
    assert.equal(a.headline?.category, 'PROVIDER');
    assert.equal(a.headline?.recoveryState, 'BLOCKED');
    assert.match(a.headline?.summary ?? '', /quota/iu);
  });

  it('E: healthy running sessions never enter the attention tiers', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'FILE_CHANGED', { filePath: 'src/api.ts' }),
    ], { running: true });
    const a = assessAttention(model, true);
    assert.equal(a.tier, 5);
    assert.equal(a.headline, null);
  });

  it('F: tier dominates tool identity — a blocked Codex ranks above a healthy Claude', () => {
    const blocked = buildSessionModel([
      ev(0, 'SESSION_STARTED', { metadata: { cwd: 'C:\\work\\MA Now' } }),
      ev(1000, 'ERROR', { error: '402 quota exceeded' }),
      ev(2000, 'SESSION_COMPLETED'),
    ]);
    const healthy = buildSessionModel([
      ev(0, 'SESSION_STARTED', { metadata: { cwd: 'C:\\work\\GameProbe' } }),
      ev(1000, 'FILE_READ', { filePath: 'src/x.ts' }),
    ], { running: true });
    const a1 = assessAttention(blocked, false);
    const a2 = assessAttention(healthy, true);
    assert.ok(a1.tier < a2.tier);
    assert.equal(a1.headline?.recoveryState, 'BLOCKED');
    assert.equal(a2.tier, 5);
  });

  it('an unresolved coding failure in an ended session is tier 2 FAILED', () => {
    const model = buildSessionModel([
      ev(0, 'SESSION_STARTED'),
      ev(1000, 'BUILD_FAILED', { command: 'npm run build', error: 'error TS2304' }),
      ev(6000, 'SESSION_COMPLETED'),
    ]);
    const a = assessAttention(model, false);
    assert.equal(a.tier, 2);
    assert.equal(a.headline?.category, 'VALIDATION');
    assert.equal(a.headline?.recoveryState, 'UNRESOLVED');
  });

  it('isCodingSession keeps pure conversations off the radar', () => {
    const chat = buildSessionModel([
      ev(0, 'MESSAGE', { summary: 'hi', metadata: { role: 'user' } }),
      ev(500, 'MESSAGE', { summary: 'Hello!', metadata: { role: 'assistant' } }),
    ]);
    assert.equal(isCodingSession(chat), false);
  });
});

describe('radar payload + <3s initial load (directive §11)', () => {
  it('session list items carry attention fields and last-observed labels', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pigeon-radar-'));
    const ui = new PigeonUi({ claudeDir: dir, codexDir: dir, zcodeDir: dir, extraDirs: [] });
    let server: Server | null = null;
    try {
      const line = (i: number, type: string, extra: Record<string, unknown> = {}): string =>
        JSON.stringify({
          id: `e${i}`, sessionId: 's1', agentId: 'main', type,
          timestamp: new Date(BASE + i * 1000).toISOString(), source: 'generic-jsonl', ...extra,
        });
      writeFileSync(join(dir, 'blocked.pigeon.jsonl'), [
        line(0, 'SESSION_STARTED', { metadata: { cwd: 'C:\\work\\GameProbe' } }),
        line(1, 'ERROR', { error: 'API Error: 402 insufficient_quota', summary: 'API error reported' }),
        line(2, 'SESSION_COMPLETED'),
      ].join('\n'), 'utf8');
      writeFileSync(join(dir, 'healthy.pigeon.jsonl'), [
        line(0, 'SESSION_STARTED', { metadata: { cwd: 'C:\\work\\Storefront' } }),
        line(1, 'TEST_PASSED', { command: 'npm test' }),
      ].join('\n'), 'utf8');
      // Old mtime: this session is not live — it must be IDLE (tier 6), never DONE.
      const { utimesSync } = await import('node:fs');
      utimesSync(join(dir, 'healthy.pigeon.jsonl'), new Date(BASE + 60_000), new Date(BASE + 60_000));
      server = await ui.listen(0);
      const port = (server.address() as { port: number }).port;
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions?limit=20`);
      const data = await res.json() as { sessions: SessionListItem[] };
      const blocked = data.sessions.find((s) => s.label !== undefined && s.sessionId === 's1' && s.path.includes('blocked'));
      const healthy = data.sessions.find((s) => s.path.includes('healthy'));
      assert.ok(blocked && healthy);
      assert.equal(blocked.attentionTier, 1);
      assert.equal(blocked.recoveryState, 'BLOCKED');
      assert.equal(blocked.problemCategory, 'PROVIDER');
      assert.equal(blocked.lastObserved, 'API error reported');
      assert.equal(healthy.attentionTier, 6);
      assert.equal(healthy.lastObserved, 'tests passed');
      assert.equal(healthy.project, 'Storefront');
    } finally {
      server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('first /api/sessions result over a 60-file history lands in under 3 seconds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pigeon-radar-perf-'));
    const ui = new PigeonUi({ claudeDir: dir, codexDir: dir, zcodeDir: dir, extraDirs: [] });
    let server: Server | null = null;
    try {
      // 60 synthetic coding sessions × 1k events, deterministic mix.
      for (let f = 0; f < 60; f++) {
        const lines: string[] = [];
        for (let i = 0; i < 1000; i++) {
          const type = i % 50 === 11 ? 'TEST_FAILED' : i % 50 === 13 ? 'TEST_PASSED' : i % 5 === 0 ? 'FILE_READ' : 'TOOL_CALLED';
          lines.push(JSON.stringify({
            id: `f${f}e${i}`, sessionId: `s${f}`, agentId: 'main', type,
            timestamp: new Date(BASE + i * 1000).toISOString(), source: 'generic-jsonl',
            ...(type.startsWith('FILE') ? { filePath: `src/m${i % 40}.ts` } : {}),
            ...(type === 'TEST_FAILED' ? { command: 'npm test', metadata: { testsFailedCount: 2 } } : {}),
            ...(type === 'TEST_PASSED' ? { command: 'npm test' } : {}),
          }));
        }
        writeFileSync(join(dir, `s${f}.pigeon.jsonl`), lines.join('\n'), 'utf8');
      }
      server = await ui.listen(0);
      const port = (server.address() as { port: number }).port;
      const start = performance.now();
      const res = await fetch(`http://127.0.0.1:${port}/api/sessions?limit=120`);
      const data = await res.json() as { sessions: SessionListItem[] };
      const elapsed = performance.now() - start;
      assert.ok(data.sessions.length > 0);
      assert.ok(elapsed < 3000, `first radar payload took ${elapsed.toFixed(0)}ms (budget 3000ms)`);
    } finally {
      server?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
