import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeGovernorDecision } from '../src/governor/governor.js';
import type { GovernorEvent, GovernorState } from '../src/governor/governor.js';
import { repoRoot } from './paths.js';

const OBSERVE_HOOK = join(repoRoot, 'hooks', 'hook-posttooluse.mjs');
const BATCH_HOOK = join(repoRoot, 'dist', 'src', 'governor-batch.js');
const SESSION_ID = 'gov00000-1111-2222-3333-444444444444';
const SESSION8 = SESSION_ID.slice(0, 8);

interface Harness {
  home: string;
  eventsPath: string;
  edit: (tag: string, content?: string) => void;
  editAsync: (tag: string, content?: string) => Promise<void>;
  test: (ok: boolean) => void;
  batch: () => { code: number; stdout: string; parsed: Emitted | null };
  readState: () => { firedEpisodeStart: string | null };
  secret: () => string;
  cleanup: () => void;
}

interface Emitted {
  hookSpecificOutput: { hookEventName: string; additionalContext: string };
  suppressOutput: boolean;
}

function makeHarness(): Harness {
  const home = mkdtempSync(join(tmpdir(), 'pigeon-batch-'));
  const eventsPath = join(home, 'events.jsonl');
  const env = (): NodeJS.ProcessEnv => ({
    ...process.env,
    AGENT_PIGEON_HOME: home,
    AGENT_PIGEON_EVENTS: eventsPath,
  });
  const runObserve = (payload: object): void => {
    execSyncVoid(OBSERVE_HOOK, payload, env());
  };
  return {
    home,
    eventsPath,
    edit: (tag: string, content?: string) => {
      runObserve({
        session_id: SESSION_ID,
        hook_event_name: 'PostToolUse',
        tool_name: 'Edit',
        tool_input: {
          file_path: `C:/proj/App${tag}.kt`,
          old_string: `OLD ${tag} ${content ?? ''}`,
          new_string: `NEW ${tag} ${content ?? ''}`,
        },
        tool_response: {},
      });
    },
    editAsync: (tag: string, content?: string) =>
      new Promise<void>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          [OBSERVE_HOOK],
          { env: env(), windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] },
        );
        child.stdin.write(
          JSON.stringify({
            session_id: SESSION_ID,
            hook_event_name: 'PostToolUse',
            tool_name: 'Edit',
            tool_input: {
              file_path: `C:/proj/App${tag}.kt`,
              old_string: `OLD ${tag} ${content ?? ''}`,
              new_string: `NEW ${tag} ${content ?? ''}`,
            },
            tool_response: {},
          }),
        );
        child.stdin.end();
        child.on('exit', () => resolve());
        child.on('error', reject);
      }),
    test: (ok: boolean) => {
      runObserve({
        session_id: SESSION_ID,
        hook_event_name: 'PostToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
        tool_response: ok
          ? { stdout: 'pass 3', stderr: '', is_error: false }
          : { stdout: '', stderr: 'Tests: 1 failed', is_error: true },
      });
    },
    batch: () => {
      const result = spawnSync(
        process.execPath,
        [BATCH_HOOK],
        {
          input: JSON.stringify({ session_id: SESSION_ID, hook_event_name: 'PostToolBatch' }),
          env: env(),
          encoding: 'utf8',
          windowsHide: true,
        },
      );
      let parsed: Emitted | null = null;
      if (result.stdout.length > 0) parsed = JSON.parse(result.stdout) as Emitted;
      return { code: result.status ?? 1, stdout: result.stdout, parsed };
    },
    readState: () =>
      JSON.parse(readFileSync(join(home, 'governor-state.json'), 'utf8')) as GovernorState,
    secret: () => readFileSync(join(home, 'secret.key'), 'utf8').trim(),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

function execSyncVoid(script: string, payload: object, env: NodeJS.ProcessEnv): void {
  spawnSync(process.execPath, [script], {
    input: JSON.stringify(payload),
    env,
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'ignore'],
  });
}

describe('POC-04A.1 PostToolBatch delivery (scenarios A–H)', () => {
  it('A: edit A/B/C → exactly ONE additionalContext VERIFY_FIRST before the next model call', () => {
    const h = makeHarness();
    h.edit('A');
    h.edit('B');
    h.edit('C');
    const first = h.batch();
    assert.equal(first.code, 0);
    assert.ok(first.parsed, 'batch must emit context');
    assert.equal(first.parsed?.hookSpecificOutput.hookEventName, 'PostToolBatch');
    assert.match(
      first.parsed?.hookSpecificOutput.additionalContext ?? '',
      /3 materially different implementation changes were made without collecting new verification evidence\./u,
    );
    assert.match(
      first.parsed?.hookSpecificOutput.additionalContext ?? '',
      /Verify the current app before another implementation change\./u,
    );
    assert.equal(first.parsed?.suppressOutput, true);
    // next batch without verification → silent (anti-spam)
    const second = h.batch();
    assert.equal(second.code, 0);
    assert.equal(second.stdout, '');
    assert.equal(second.parsed, null);
    h.cleanup();
  });

  it('B: edit A/B, test, edit C → silent', () => {
    const h = makeHarness();
    h.edit('A');
    h.edit('B');
    h.test(true);
    h.edit('C');
    const result = h.batch();
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    h.cleanup();
  });

  it('C: warning, then next batch without verification → silent', () => {
    const h = makeHarness();
    h.edit('A');
    h.edit('B');
    h.edit('C');
    assert.ok(h.batch().parsed, 'first batch warns');
    const next = h.batch();
    assert.equal(next.stdout, '');
    h.cleanup();
  });

  it('D: warning → test → new A/B/C episode → warns once again', () => {
    const h = makeHarness();
    h.edit('A');
    h.edit('B');
    h.edit('C');
    assert.ok(h.batch().parsed);
    h.test(true);
    assert.equal(h.batch().stdout, '');
    h.edit('D');
    h.edit('E');
    h.edit('F');
    const second = h.batch();
    assert.ok(second.parsed, 'new episode fires once');
    assert.match(
      second.parsed?.hookSpecificOutput.additionalContext ?? '',
      /3 materially different implementation changes/u,
    );
    h.cleanup();
  });

  it('E: parallel Edit A/B/C events → valid state, one debt episode, one warning', async () => {
    const h = makeHarness();
    await Promise.all([h.editAsync('A'), h.editAsync('B'), h.editAsync('C')]);
    const lines = readFileSync(h.eventsPath, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 3);
    for (const line of lines) assert.doesNotThrow(() => JSON.parse(line));
    const first = h.batch();
    assert.ok(first.parsed, 'parallel edits form exactly one episode');
    assert.match(first.parsed?.hookSpecificOutput.additionalContext ?? '', /3 materially different/u);
    assert.equal(h.batch().stdout, '');
    h.cleanup();
  });

  it('F: 12 concurrent hooks on FIRST EVER RUN → one stable secret, consistent fingerprints', async () => {
    const h = makeHarness();
    const tags = Array.from({ length: 12 }, (_, i) => `T${i}`);
    await Promise.all(tags.map((tag) => h.editAsync(tag, 'same-content')));

    const secret = h.secret();
    assert.match(secret, /^[0-9a-f]{64}$/u, 'one valid install secret');

    // Every event's fingerprint must be reproducible with the SAME secret.
    const { contentFingerprint } = await import('../src/replay/fingerprint.js');
    const lines = readFileSync(h.eventsPath, 'utf8').split('\n').filter(Boolean);
    assert.equal(lines.length, 12);
    const fingerprints = new Set<string>();
    for (const line of lines) {
      const event = JSON.parse(line) as { changeFingerprint: string; fingerprintBasis: string };
      assert.equal(event.fingerprintBasis, 'content');
      assert.match(event.changeFingerprint, /^[0-9a-f]{32}$/u);
      fingerprints.add(event.changeFingerprint);
    }
    // tags T0..T11: content differs per tag → 12 distinct, all under one key
    assert.equal(fingerprints.size, 12);
    for (const tag of tags) {
      assert.ok(fingerprints.has(contentFingerprint(secret, 'edit', [`OLD ${tag} same-content`, `NEW ${tag} same-content`])));
    }

    const decision = h.batch();
    assert.equal(decision.parsed?.hookSpecificOutput.additionalContext ?? '', expectMessage(12));
    h.cleanup();
  });

  it('G: corrupt/missing state → fail open, no broken output', () => {
    const h = makeHarness();
    h.edit('A');
    h.edit('B');
    h.edit('C');
    writeFileSync(join(h.home, 'governor-state.json'), '{corrupt', 'utf8');
    const result = h.batch();
    assert.equal(result.code, 0, 'hook must not crash');
    if (result.stdout.length > 0) {
      const parsed = JSON.parse(result.stdout) as Emitted; // must be valid JSON if anything
      assert.ok(parsed.hookSpecificOutput.additionalContext.length > 0);
    }
    // missing state file entirely → also fine
    rmSync(join(h.home, 'governor-state.json'), { force: true });
    const again = h.batch();
    assert.equal(again.code, 0);
    h.cleanup();
  });

  it('H: productive fix/test sequence → silent', () => {
    const h = makeHarness();
    for (const tag of ['A', 'B', 'C']) {
      h.edit(tag);
      h.test(true);
    }
    const result = h.batch();
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    h.cleanup();
  });
});

function expectMessage(distinct: number): string {
  return `Agent Pigeon\n\n${distinct} materially different implementation changes were made without collecting new verification evidence.\n\nVerify the current app before another implementation change.`;
}

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
    const many = Array.from({ length: 50 }, (_, i) =>
      ev({ ts: new Date(Date.parse('2026-09-22T12:00:00Z') + i * 60_000).toISOString(), changeFingerprint: 'same' }),
    );
    assert.equal(computeGovernorDecision(many, state).policy, 'SILENT');
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
