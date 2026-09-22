import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contentFingerprint } from '../src/replay/fingerprint.js';
import { evaluateScenario } from '../src/core/evaluate.js';
import type { ProgressContract } from '../src/core/contract.js';
import type { AttemptEvidence } from '../src/core/types.js';
import { validateAttemptEvidence } from '../src/core/types.js';
import { repoRoot, fixturesRoot } from './paths.js';

const HOOK = join(repoRoot, 'hooks', 'hook-posttooluse.mjs');
const POC035 = join(repoRoot, 'dist', 'src', 'poc035.js');

describe('changeFingerprint (HMAC-SHA256 128-bit, per-install secret)', () => {
  /** Drive the real hook with an isolated AGENT_PIGEON_HOME; returns artifacts. */
  function driveHook(payload: object): { eventsPath: string; home: string; secret: string } {
    const home = mkdtempSync(join(tmpdir(), 'pigeon-fp-'));
    const eventsPath = join(home, 'events.jsonl');
    execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, AGENT_PIGEON_HOME: home, AGENT_PIGEON_EVENTS: eventsPath },
      windowsHide: true,
    });
    // The hook created the per-install secret inside the temp home — read it
    // from THERE (not the machine-wide install) for TS-side parity checks.
    const secret = readFileSync(join(home, 'secret.key'), 'utf8').trim();
    return { eventsPath, home, secret };
  }

  function editPayload(oldString: string, newString: string, filePath = 'C:/proj/LoginViewModel.kt'): object {
    return {
      session_id: 'fp000001-1111-2222-3333-444444444444',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: filePath, old_string: oldString, new_string: newString },
      tool_response: {},
    };
  }

  it('1: same exact edit → same fingerprint (and hook/TS mirror agreement)', () => {
    // Same install (same home/secret), two hook invocations of the same edit.
    const home = mkdtempSync(join(tmpdir(), 'pigeon-fp-'));
    const eventsPath = join(home, 'events.jsonl');
    const secret = (): string => readFileSync(join(home, 'secret.key'), 'utf8').trim();
    const run = (): void => {
      execFileSync(process.execPath, [HOOK], {
        input: JSON.stringify(editPayload('return a - b', 'return a + b')),
        env: { ...process.env, AGENT_PIGEON_HOME: home, AGENT_PIGEON_EVENTS: eventsPath },
        windowsHide: true,
      });
    };
    run();
    run();
    const [e1, e2] = readFileSync(eventsPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { changeFingerprint: string });
    assert.ok(e1 && e2);
    assert.match(e1.changeFingerprint, /^[0-9a-f]{32}$/u);
    assert.equal(e1.changeFingerprint, e2.changeFingerprint);
    // Same secret → TS and hook agree (mirror contract).
    assert.equal(e1.changeFingerprint, contentFingerprint(secret(), 'edit', ['return a - b', 'return a + b']));
    rmSync(home, { recursive: true, force: true });
  });

  it('2: different edit in the same file → different fingerprint', () => {
    const s = 'k'.repeat(64);
    assert.notEqual(contentFingerprint(s, 'edit', ['return a - b', 'return a + b']), contentFingerprint(s, 'edit', ['return a - b', 'return a * b']));
  });

  it('3: indentation-sensitive change → different fingerprint (no whitespace collapsing)', () => {
    const a = driveHook(editPayload('return a - b', '\treturn a + b;'));
    const b = driveHook(editPayload('return a - b', '    return a + b;'));
    const e1 = JSON.parse(readFileSync(a.eventsPath, 'utf8'));
    const e2 = JSON.parse(readFileSync(b.eventsPath, 'utf8'));
    assert.notEqual(e1.changeFingerprint, e2.changeFingerprint);
    rmSync(a.home, { recursive: true, force: true });
    rmSync(b.home, { recursive: true, force: true });
  });

  it('C: different file + different edit → different fingerprint', () => {
    const s = 'k'.repeat(64);
    assert.notEqual(contentFingerprint(s, 'edit', ['return a - b', 'return a + b']), contentFingerprint(s, 'edit', ['render()', 'renderLoading()']));
  });

  it('4+5: raw source never persisted; secret never enters events or the repo; CRLF canonicalized', () => {
    const secretOld = 'SECRET_TOKEN = loadFromKeychain("hunter2")';
    const secretNew = 'SECRET_TOKEN = loadFromKeychain("correct-horse")\r\nexport { SECRET_TOKEN };';
    const { eventsPath, home, secret } = driveHook(editPayload(secretOld, secretNew, 'C:/proj/Vault.kt'));
    const stored = readFileSync(eventsPath, 'utf8');
    assert.ok(!stored.includes('SECRET_TOKEN'));
    assert.ok(!stored.includes('hunter2'));
    assert.ok(!stored.includes('correct-horse'));
    assert.match(stored, /"changeFingerprint":"[0-9a-f]{32}"/u);
    assert.match(stored, /"fingerprintBasis":"content"/u);
    // CRLF is serialization mechanics: the LF-canonical form hashes identically.
    assert.equal(
      JSON.parse(stored).changeFingerprint,
      contentFingerprint(secret, 'edit', [secretOld, secretNew.replace('\r\n', '\n')]),
    );
    // The secret never appears in the event stream…
    assert.ok(!stored.includes(secret));
    // …and no secret/state file exists anywhere in the repository.
    assert.ok(!existsSync(join(repoRoot, 'secret.key')));
    assert.ok(!existsSync(join(repoRoot, '.agent-pigeon')));
    rmSync(home, { recursive: true, force: true });
  });
});

// --- reality fixtures A–E -------------------------------------------------

function loadReality(name: string): { contract: ProgressContract; attempts: AttemptEvidence[] } {
  const raw = JSON.parse(readFileSync(join(fixturesRoot, 'scenarios', `reality-${name}.json`), 'utf8'));
  const attempts: AttemptEvidence[] = [];
  for (const entry of raw.attempts) {
    const outcome = validateAttemptEvidence(entry);
    assert.equal(outcome.ok, true);
    if (outcome.ok) attempts.push(outcome.value);
  }
  return { contract: raw.contract, attempts };
}

describe('reality fixtures A–E (three-concept separation)', () => {
  it('CASE A — productive: HIGH/HIGH/HIGH, no false warning, OBSERVE', () => {
    const { contract, attempts } = loadReality('a');
    const { signals, evaluation } = evaluateScenario(attempts, contract);
    assert.equal(evaluation.runtimeChange, 'MULTIPLE');
    assert.equal(evaluation.evidenceGain, 'HIGH');
    assert.equal(evaluation.goalProgress.level, 'HIGH');
    assert.ok(evaluation.goalProgress.matchedSuccessSignals.includes('crash disappears'));
    assert.equal(signals.verificationDebt, 'LOW');
    assert.equal(evaluation.deadEndCandidate, false);
    assert.equal(evaluation.policy, 'OBSERVE');
  });

  it('CASE B — new evidence, unclear progress: change is NOT success', () => {
    const { contract, attempts } = loadReality('b');
    const { evaluation } = evaluateScenario(attempts, contract);
    assert.equal(evaluation.runtimeChange, 'SINGLE');
    assert.equal(evaluation.evidenceGain, 'MEDIUM');
    assert.equal(evaluation.goalProgress.level, 'UNKNOWN');
    assert.equal(evaluation.policy, 'OBSERVE', 'must not report successful progress');
  });

  it('CASE C — different implementation, same outcome: dead-end, RETHINK', () => {
    const { contract, attempts } = loadReality('c');
    const { signals, evaluation } = evaluateScenario(attempts, contract);
    assert.ok(signals.pairs.every((p) => p.codeNovelty === true), 'content fingerprints are novel');
    assert.equal(evaluation.runtimeChange, 'NONE');
    assert.equal(evaluation.evidenceGain, 'LOW');
    assert.equal(evaluation.goalProgress.level, 'LOW');
    assert.equal(evaluation.deadEndCandidate, true);
    assert.equal(evaluation.policy, 'RETHINK');
  });

  it('CASE D — verification debt: deterministic HIGH, VERIFY_FIRST (no Jev)', () => {
    const { contract, attempts } = loadReality('d');
    const { signals, evaluation } = evaluateScenario(attempts, contract);
    assert.equal(signals.verificationDebt, 'HIGH');
    assert.equal(signals.verificationDebtStreak, 4);
    assert.equal(evaluation.policy, 'VERIFY_FIRST');
  });

  it('CASE E — runtime changed in the wrong direction: gain HIGH but goal LOW', () => {
    const { contract, attempts } = loadReality('e');
    const { evaluation } = evaluateScenario(attempts, contract);
    assert.equal(evaluation.runtimeChange, 'MULTIPLE');
    assert.equal(evaluation.evidenceGain, 'HIGH');
    assert.notEqual(evaluation.goalProgress.level, 'HIGH');
    assert.equal(evaluation.goalProgress.level, 'LOW');
    assert.match(evaluation.goalProgress.rationale, /movement without improvement/u);
  });
});

describe('poc:035 CLI', () => {
  it('runs all five reality fixtures deterministically', () => {
    const run = (): string =>
      execFileSync(process.execPath, [POC035, '--json'], { encoding: 'utf8' });
    assert.equal(run(), run());
    const parsed = JSON.parse(run()) as Array<{ case: string; policy: string }>;
    assert.equal(parsed.length, 5);
    const byCase = (id: string): { policy: string } | undefined =>
      parsed.find((p) => p.case.startsWith(`A — ${id}`) || p.case.startsWith(`${id} `) || p.case.includes(id));
    assert.ok(byCase('A'));
  });
});
