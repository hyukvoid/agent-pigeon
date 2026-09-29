import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { repoRoot, fixturesRoot } from './paths.js';
import { PigeonUi } from '../src/ui/server.js';
import type { Server } from 'node:http';

const pigeonFixtureDir = join(fixturesRoot, 'pigeon');
const FIXTURE_D = join(pigeonFixtureDir, 'd-acceptance-login.pigeon.jsonl');
const FIXTURE_A = join(pigeonFixtureDir, 'a-simple-success.pigeon.jsonl');

describe('standalone UI server (local-first, zero-dep)', () => {
  const ui = new PigeonUi({ claudeDir: pigeonFixtureDir, codexDir: join(pigeonFixtureDir, 'nope'), zcodeDir: join(pigeonFixtureDir, 'nope'), extraDirs: [] });
  let server: Server | null = null;
  let base = '';

  after(() => { server?.close(); });

  it('serves the UI page and static assets from the ui/ directory', async () => {
    server = await ui.listen(0);
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    base = `http://127.0.0.1:${port}`;
    const html = await (await fetch(base + '/')).text();
    assert.match(html, /Agent Pigeon/u);
    assert.match(html, /Show only the mess/u);
    const css = await (await fetch(base + '/app.css')).text();
    assert.match(css, /flight recorder UI/u);
    const js = await (await fetch(base + '/app.js')).text();
    assert.match(js, /problemEventIds/u);
  });

  it('blocks path traversal outside the ui/ asset root', async () => {
    const res = await fetch(base + '/..%2f..%2fpackage.json');
    assert.equal([403, 404].includes(res.status), true);
  });

  it('lists discovered sessions with honest status and problem counts', async () => {
    const res = await fetch(base + '/api/sessions?limit=50');
    const data = await res.json() as { sessions: Array<{ path: string; status: string; problems: number; adapterId: string }>; scanned: number };
    assert.ok(data.sessions.length >= 4);
    const d = data.sessions.find((s) => s.path.endsWith('d-acceptance-login.pigeon.jsonl'));
    assert.ok(d);
    assert.equal(d.status, 'SUCCESS');
    assert.equal(d.problems, 2);
    assert.equal(d.adapterId, 'generic-jsonl');
  });

  it('serves the full session model with the problems-only keep set', async () => {
    const res = await fetch(base + '/api/session?path=' + encodeURIComponent(FIXTURE_D));
    const data = await res.json() as {
      adapterId: string; running: boolean;
      model: { outcome: { status: string; failures: number; recovered: number }; problems: Array<{ kind: string; status: string }>; routineCount: number; timeline: Array<{ event: { id: string } }> };
      problemEventIds: string[];
    };
    assert.equal(data.adapterId, 'generic-jsonl');
    assert.equal(data.running, false, 'fixtures have SESSION_COMPLETED so they are not running');
    assert.equal(data.model.outcome.status, 'SUCCESS');
    assert.equal(data.model.outcome.failures, 2);
    assert.equal(data.model.outcome.recovered, 2);
    assert.equal(data.model.problems.length, 2);
    const timelineIds = new Set(data.model.timeline.map((t) => t.event.id));
    assert.ok(data.problemEventIds.every((id) => timelineIds.has(id)));
    assert.ok(data.problemEventIds.length < data.model.timeline.length, 'the mess filter actually hides routine events');
  });

  it('rejects non-jsonl paths and missing sessions', async () => {
    const bad = await fetch(base + '/api/session?path=' + encodeURIComponent(join(repoRoot, 'package.json')));
    assert.equal(bad.status, 400);
    const missing = await fetch(base + '/api/session?path=' + encodeURIComponent(join(pigeonFixtureDir, 'missing.pigeon.jsonl')));
    assert.equal(missing.status, 404);
  });

  it('reports the adapter support matrix', async () => {
    const res = await fetch(base + '/api/adapters');
    const data = await res.json() as { adapters: Array<{ id: string; level: string }> };
    const levels = Object.fromEntries(data.adapters.map((a) => [a.id, a.level]));
    assert.equal(levels['generic-jsonl'], 'FULL');
    assert.equal(levels['codex'], 'PARTIAL');
    assert.equal(levels['claude'], 'PARTIAL');
    assert.equal(levels['zcode'], 'EXPERIMENTAL');
    assert.equal(levels['opencode'], 'UNAVAILABLE');
  });

  it('marks a recently-modified unfinished session as running', async () => {
    const { writeFileSync, utimesSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { mkdtempSync } = await import('node:fs');
    const dir = mkdtempSync(join(tmpdir(), 'pigeon-live-'));
    const file = join(dir, 'live.pigeon.jsonl');
    const line = (i: number): string =>
      JSON.stringify({ id: `e${i}`, sessionId: 'live-1', agentId: 'main', type: 'CHECKPOINT', timestamp: new Date(Date.parse('2026-09-28T10:00:00.000Z') + i * 1000).toISOString(), source: 'generic-jsonl', summary: 'step ' + i });
    writeFileSync(file, [line(0), line(1)].join('\n'), 'utf8');
    const ui2 = new PigeonUi({ claudeDir: dir, codexDir: dir, zcodeDir: dir, extraDirs: [] });
    const server2 = await ui2.listen(0);
    try {
      const address = server2.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      const res = await fetch(`http://127.0.0.1:${port}/api/session?path=` + encodeURIComponent(file));
      const data = await res.json() as { running: boolean; model: { sessionStatus: string } };
      assert.equal(data.running, true, 'recent mtime + no SESSION_COMPLETED ⇒ running');
      assert.equal(data.model.sessionStatus, 'RUNNING');
    } finally {
      server2.close();
      const { rmSync } = await import('node:fs');
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
