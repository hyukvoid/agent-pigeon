import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeGovernorDecision } from '../src/governor/governor.js';
import type { GovernorEvent, GovernorState } from '../src/governor/governor.js';
import { repoRoot } from './paths.js';

const HOOK = join(repoRoot, 'hooks', 'hook-posttooluse.mjs');
const DELIVER = join(repoRoot, 'hooks', 'deliver-verify-first.mjs');
const PROCESSOR = join(repoRoot, 'dist', 'src', 'governor-process.js');

interface Harness {
  home: string;
  eventsPath: string;
  edit: (tag: string) => void;
  test: (ok: boolean) => void;
  process: () => { policy: string; distinctEdits: number; message: string | null };
  deliver: () => string;
  readDecision: () => { policy: string; delivered: boolean; message: string | null };
  readState: () => { firedEpisodeStart: string | null };
  cleanup: () => void;
}

function makeHarness(): Harness {
  const home = mkdtempSync(join(tmpdir(), 'pigeon-gov-'));
  const eventsPath = join(home, 'events.jsonl');
  const env = (): NodeJS.ProcessEnv => ({ ...process.env, AGENT_PIGEON_HOME: home, AGENT_PIGEON_EVENTS: eventsPath });
  const runHook = (payload: object): void => {
    execFileSync(process.execPath, [HOOK], { input: JSON.stringify(payload), env: env(), windowsHide: true });
  };
  let n = 0;
  return {
    home,
    eventsPath,
    edit: (tag: string) => {
      n++;
      runHook({
        session_id: 'gov00000-1111-2222-3333-444444444444',
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: { file_path: `C:/proj/App${tag}.kt`, old_string: `OLD ${tag} ${n}`, new_string: `NEW ${tag} ${n}` },
        tool_response: {},
      });
    },
    test: (ok: boolean) => {
      runHook({
        session_id: 'gov00000-1111-2222-3333-444444444444',
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: ok ? { stdout: 'pass 3', stderr: '', is_error: false } : { stdout: '', stderr: 'Tests: 1 failed', is_error: true },
      });
    },
    process: () => {
      const stdout = execFileSync(process.execPath, [PROCESSOR, '--events', eventsPath, '--json'], {
        env: env(),
        encoding: 'utf8',
      });
      return JSON.parse(stdout) as { policy: string; distinctEdits: number; message: string | null };
    },
    deliver: () =>
      execFileSync(process.execPath, [DELIVER], { env: env(), encoding: 'utf8' }),
    readDecision: () =>
      JSON.parse(readFileSync(join(home, 'decision.json'), 'utf8')) as {
        policy: string;
        delivered: boolean;
        message: string | null;
      },
    readState: () => JSON.parse(readFileSync(join(home, 'governor-state.json'), 'utf8')) as GovernorState,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

describe('POC-04A governor (end-to-end: hook → processor → delivery)', () => {
  it('A: edit A, B, C distinct, no verify → exactly ONE VERIFY_FIRST', () => {
    const h = makeHarness();
    h.edit('A');
    h.edit('B');
    h.edit('C');
    const decision = h.process();
    assert.equal(decision.policy, 'VERIFY_FIRST');
    assert.equal(decision.distinctEdits, 3);
    assert.match(decision.message ?? '', /3 materially different implementation changes/u);
    assert.match(decision.message ?? '', /Verify the current app before another implementation change\./u);

    // delivery emits the safe additionalContext once, then never again
    const firstDelivery = h.deliver();
    const parsed = JSON.parse(firstDelivery) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    assert.match(parsed.hookSpecificOutput.additionalContext, /Agent Pigeon/u);
    assert.equal(h.readDecision().delivered, true);
    assert.equal(h.deliver(), '', 'delivered warning must not repeat');

    // a 4th edit in the same episode stays silent (anti-spam latch)
    h.edit('D');
    assert.equal(h.process().policy, 'SILENT');
    assert.equal(h.deliver(), '');
    h.cleanup();
  });

  it('B: edit A, B, test, edit C → no warning', () => {
    const h = makeHarness();
    h.edit('A');
    h.edit('B');
    h.test(true);
    h.edit('C');
    assert.equal(h.process().policy, 'SILENT');
    assert.equal(h.deliver(), '');
    h.cleanup();
  });

  it('C: same edit repeated 3 times → no false "materially different" trigger', () => {
    const h = makeHarness();
    for (let i = 0; i < 3; i++) {
      // identical change content every time → same fingerprint
      execFileSync(
        process.execPath,
        [HOOK],
        {
          input: JSON.stringify({
            session_id: 'gov00000-1111-2222-3333-444444444444',
            hook_event_name: 'PostToolUse',
            tool_name: 'Edit',
            tool_input: { file_path: 'C:/proj/Same.kt', old_string: 'OLD SAME', new_string: 'NEW SAME' },
            tool_response: {},
          }),
          env: { ...process.env, AGENT_PIGEON_HOME: h.home, AGENT_PIGEON_EVENTS: h.eventsPath },
          windowsHide: true,
        },
      );
    }
    const decision = h.process();
    assert.equal(decision.policy, 'SILENT');
    assert.equal(decision.distinctEdits, 1);
    h.cleanup();
  });

  it('D: edit A/B/C → VERIFY_FIRST → test → debt resets (new episode can fire once)', () => {
    const h = makeHarness();
    h.edit('A');
    h.edit('B');
    h.edit('C');
    assert.equal(h.process().policy, 'VERIFY_FIRST');
    h.deliver();

    h.test(true); // verification occurs → debt episode resets
    assert.equal(h.process().policy, 'SILENT');
    assert.equal(h.readState().firedEpisodeStart, null, 'latch cleared by verification');

    h.edit('D');
    h.edit('E');
    h.edit('F');
    const second = h.process();
    assert.equal(second.policy, 'VERIFY_FIRST', 'a NEW episode may fire again, once');
    h.cleanup();
  });

  it('E: productive fix/test loop → never warns', () => {
    const h = makeHarness();
    for (const tag of ['A', 'B', 'C']) {
      h.edit(tag);
      h.test(true);
    }
    assert.equal(h.process().policy, 'SILENT');
    assert.equal(h.deliver(), '');
    h.cleanup();
  });

  it('F: corrupt/missing decision output → agent continues normally', () => {
    const h = makeHarness();
    // corrupt decision file
    writeFileSync(join(h.home, 'decision.json'), '{not json', 'utf8');
    let stdout = '';
    stdout = execFileSync(process.execPath, [DELIVER], { env: { ...process.env, AGENT_PIGEON_HOME: h.home }, encoding: 'utf8' });
    assert.equal(stdout, '');
    // missing decision file entirely
    rmSync(join(h.home, 'decision.json'), { force: true });
    stdout = execFileSync(process.execPath, [DELIVER], { env: { ...process.env, AGENT_PIGEON_HOME: h.home }, encoding: 'utf8' });
    assert.equal(stdout, '');
    assert.ok(existsSync(h.home), 'harness sanity');
    h.cleanup();
  });
});

describe('governor trigger rules (unit)', () => {
  const ev = (over: Partial<GovernorEvent>): GovernorEvent => ({
    ts: '2026-09-22T12:00:00Z',
    toolName: 'Edit',
    ok: null,
    verificationKind: null,
    changeFingerprint: 'fp',
    fingerprintBasis: 'content',
    ...over,
  });

  it('elapsed time / tool-call count / repeated edits are never triggers', () => {
    const state: GovernorState = { firedEpisodeStart: null };
    // 50 identical edits over an hour: still SILENT
    const many = Array.from({ length: 50 }, (_, i) =>
      ev({ ts: new Date(Date.parse('2026-09-22T12:00:00Z') + i * 60_000).toISOString(), changeFingerprint: 'same' }),
    );
    assert.equal(computeGovernorDecision(many, state).policy, 'SILENT');
    // 2 distinct edits repeated many times: still SILENT
    const two = Array.from({ length: 12 }, (_, i) => ev({ changeFingerprint: `fp${i % 2}` }));
    assert.equal(computeGovernorDecision(two, state).policy, 'SILENT');
  });

  it('failed test runs still count as verification (evidence was collected)', () => {
    const state: GovernorState = { firedEpisodeStart: null };
    const events = [
      ev({ changeFingerprint: 'a' }),
      ev({ changeFingerprint: 'b' }),
      ev({ toolName: 'Bash', verificationKind: 'test', ok: false, changeFingerprint: null, fingerprintBasis: null }),
      ev({ changeFingerprint: 'c' }),
    ];
    assert.equal(computeGovernorDecision(events, state).policy, 'SILENT');
  });

  it('path-basis events never establish material distinctness', () => {
    const state: GovernorState = { firedEpisodeStart: null };
    const events = [
      ev({ changeFingerprint: 'p1', fingerprintBasis: 'path' }),
      ev({ changeFingerprint: 'p2', fingerprintBasis: 'path' }),
      ev({ changeFingerprint: 'p3', fingerprintBasis: 'path' }),
      ev({ changeFingerprint: 'p4', fingerprintBasis: 'path' }),
    ];
    assert.equal(computeGovernorDecision(events, state).policy, 'SILENT');
  });
});
