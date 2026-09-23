import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './paths.js';

const LIVE = join(repoRoot, 'experimental', 'hooks', 'governor-live.mjs');
const OBSERVE = join(repoRoot, 'experimental', 'hooks', 'hook-posttooluse.mjs');
const SESSION = 'gate0000-1111-2222-3333-444444444444';

interface Harness {
  home: string;
  eventsPath: string;
  observeEdit: (tag: string, opts?: { testPath?: boolean }) => void;
  observeTest: (ok: boolean) => void;
  observeRaw: (payload: object) => void;
  batch: () => { stdout: string; status: number; context: string | null };
  state: () => { watermark: number; opp: number; fired: boolean };
  cleanup: () => void;
}

function makeHarness(): Harness {
  const home = mkdtempSync(join(tmpdir(), 'pigeon-gate-'));
  const eventsPath = join(home, 'events.jsonl');
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, AGENT_PIGEON_HOME: home, AGENT_PIGEON_EVENTS: eventsPath });

  return {
    home,
    eventsPath,
    observeEdit: (tag, opts = {}) => {
      const path = opts.testPath ? `C:/proj/tests/${tag}.test.ts` : `C:/proj/src/${tag}.ts`;
      const payload = {
        session_id: SESSION,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: path, old_string: `old ${tag}`, new_string: `new ${tag}` },
        tool_response: {},
      };
      const r = spawnSync(process.execPath, [OBSERVE], { input: JSON.stringify(payload), env: env(), encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0, 'observer must fail open');
    },
    observeTest: (ok: boolean) => {
      const payload = {
        session_id: SESSION,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: ok
          ? { stdout: 'all passed', stderr: '', is_error: false }
          : { stdout: '', stderr: 'Tests: 2 failed', is_error: true },
      };
      const r = spawnSync(process.execPath, [OBSERVE], { input: JSON.stringify(payload), env: env(), encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0);
    },
    observeRaw: (payload: object) => {
      const r = spawnSync(process.execPath, [OBSERVE], { input: JSON.stringify(payload), env: env(), encoding: 'utf8', windowsHide: true });
      assert.equal(r.status, 0);
    },
    batch: () => {
      const r = spawnSync(process.execPath, [LIVE], {
        input: JSON.stringify({ session_id: SESSION, hook_event_name: 'PostToolBatch' }),
        env: env(),
        encoding: 'utf8',
        windowsHide: true,
      });
      let context: string | null = null;
      if (r.stdout.length > 0) {
        const parsed = JSON.parse(r.stdout) as { hookSpecificOutput: { additionalContext: string } };
        context = parsed.hookSpecificOutput.additionalContext;
      }
      return { stdout: r.stdout, status: r.status ?? 1, context };
    },
    state: () => JSON.parse(readFileSync(join(home, 'governor-live-state.json'), 'utf8')) as { watermark: number; opp: number; fired: boolean },
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe('EXPERIMENTAL live governor (watermark opportunity policy)', () => {
  it('productive debugging loop (fail→fix→fail→fix→pass) stays silent', () => {
    const h = makeHarness();
    h.observeTest(false); // batch 1: verification (fail) — collected evidence
    h.batch();            // consumed → opp 0
    h.observeEdit('fix1');
    h.batch();            // batch 2: impl → opp 1
    h.observeTest(false);
    h.batch();            // verification → opp 0
    h.observeEdit('fix2');
    h.batch();            // opp 1
    h.observeTest(true);
    h.batch();            // verification pass → opp 0
    const last = h.batch();
    assert.equal(last.context, null, 'productive loop must stay silent');
    assert.equal(h.state().opp, 0);
    h.cleanup();
  });

  it('three consecutive implementation opportunities without verification → fires exactly once', () => {
    const h = makeHarness();
    for (let i = 1; i <= 2; i++) {
      h.observeEdit(`step${i}`);
      const b = h.batch();
      assert.equal(b.context, null, `boundary ${i} must stay silent`);
    }
    h.observeEdit('step3');
    const third = h.batch();
    assert.ok(third.context, 'third boundary fires');
    assert.match(third.context ?? '', /3 separate implementation batches/u);
    assert.match(third.context ?? '', /Run a verification now/u);

    // anti-spam: further impl batches stay silent
    h.observeEdit('step4');
    assert.equal(h.batch().context, null);
    h.cleanup();
  });

  it('verification resets the episode; a second episode can fire again', () => {
    const h = makeHarness();
    h.observeEdit('a'); h.batch();
    h.observeEdit('b'); h.batch();
    h.observeEdit('c'); const firstFire = h.batch();
    assert.ok(firstFire.context, 'fires on the third boundary');
    h.observeTest(true); h.batch(); // verification resets
    assert.equal(h.state().fired, false);
    h.observeEdit('d'); h.batch();
    h.observeEdit('e'); h.batch();
    assert.equal(h.batch().context, null, 'only 2 opportunities after reset');
    h.observeEdit('f'); const secondFire = h.batch();
    assert.ok(secondFire.context, 'second episode fires once');
    h.cleanup();
  });

  it('four edits inside ONE batch consume a single opportunity (dogfood FP fix)', () => {
    const h = makeHarness();
    h.observeEdit('impl');
    h.observeEdit('import-fix');
    h.observeEdit('type-fix');
    h.observeEdit('test-write', { testPath: true }); // neutral
    const first = h.batch(); // consumes 3 impl + 1 neutral → ONE opportunity
    assert.equal(first.context, null);
    const second = h.batch(); // nothing new
    assert.equal(second.context, null);
    const third = h.batch(); // still 1 opportunity total
    assert.equal(third.context, null);
    // state check: watermark consumed everything, opportunity count is 1
    assert.equal(h.state().opp, 1);
    h.cleanup();
  });

  it('watermark survives interleaved batches; no event double-counted', () => {
    const h = makeHarness();
    h.observeEdit('a'); h.batch();
    const before = h.state().watermark;
    assert.ok(before > 0);
    h.batch();
    assert.equal(h.state().watermark, before, 'no new events → watermark unchanged');
    h.cleanup();
  });

  it('fail-open: corrupt state and truncated events never crash the hook', () => {
    const h = makeHarness();
    writeFileSync(join(h.home, 'governor-live-state.json'), '{corrupt', 'utf8');
    const r = h.batch();
    assert.equal(r.status, 0);
    // truncated last line is not consumed until complete
    appendFileSync(h.eventsPath, '{"ts":"2026-09-22T12:00:00Z","toolName":"Edit"'); // no newline
    const r2 = h.batch();
    assert.equal(r2.status, 0);
    h.cleanup();
  });
});

