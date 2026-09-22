import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { changeFingerprint, normalizeChangePayload } from '../src/replay/fingerprint.js';
import { evaluateScenario } from '../src/core/evaluate.js';
import type { ProgressContract } from '../src/core/contract.js';
import type { AttemptEvidence } from '../src/core/types.js';
import { validateAttemptEvidence } from '../src/core/types.js';
import { repoRoot, fixturesRoot } from './paths.js';

const HOOK = join(repoRoot, 'hooks', 'hook-posttooluse.mjs');
const POC035 = join(repoRoot, 'dist', 'src', 'poc035.js');

describe('changeFingerprint (content novelty, POC-03.5 §1)', () => {
  it('A: same file + different edit → different fingerprint', () => {
    const a = changeFingerprint(['return a - b', 'return a + b']);
    const b = changeFingerprint(['return a - b', 'return a * b - 1']);
    assert.notEqual(a, b);
  });

  it('B: same change repeated (whitespace runs differ) → same fingerprint', () => {
    const a = changeFingerprint(['  return a - b;', 'return a + b;']);
    const b = changeFingerprint(['return a - b;', '\treturn a + b;\n']);
    assert.equal(normalizeChangePayload('  x   y '), 'x y');
    assert.equal(a, b);
  });

  it('C: different file + different edit → different fingerprint', () => {
    const a = changeFingerprint(['return a - b', 'return a + b']);
    const b = changeFingerprint(['render()', 'renderLoading()']);
    assert.notEqual(a, b);
  });

  it('hook and TS fingerprint implementations agree (mirror contract)', () => {
    const temp = mkdtempSync(join(tmpdir(), 'pigeon-fp-'));
    const eventsPath = join(temp, 'events.jsonl');
    const payload = {
      session_id: 'fp000001-1111-2222-3333-444444444444',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'C:/proj/LoginViewModel.kt', old_string: 'return a - b', new_string: 'return a + b' },
      tool_response: {},
    };
    execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, AGENT_PIGEON_EVENTS: eventsPath },
      windowsHide: true,
    });
    const event = JSON.parse(readFileSync(eventsPath, 'utf8')) as { changeFingerprint: string };
    assert.equal(event.changeFingerprint, changeFingerprint(['return a - b', 'return a + b']));
    rmSync(temp, { recursive: true, force: true });
  });

  it('D: hook event storage contains no raw source text', () => {
    const temp = mkdtempSync(join(tmpdir(), 'pigeon-fp-'));
    const eventsPath = join(temp, 'events.jsonl');
    const secretOld = 'SECRET_TOKEN = loadFromKeychain("hunter2")';
    const secretNew = 'SECRET_TOKEN = loadFromKeychain("correct-horse")';
    const payload = {
      session_id: 'fp000001-1111-2222-3333-444444444444',
      hook_event_name: 'PostToolUse',
      tool_name: 'Edit',
      tool_input: { file_path: 'C:/proj/Vault.kt', old_string: secretOld, new_string: secretNew },
      tool_response: {},
    };
    execFileSync(process.execPath, [HOOK], {
      input: JSON.stringify(payload),
      env: { ...process.env, AGENT_PIGEON_EVENTS: eventsPath },
      windowsHide: true,
    });
    const stored = readFileSync(eventsPath, 'utf8');
    assert.ok(!stored.includes('SECRET_TOKEN'));
    assert.ok(!stored.includes('hunter2'));
    assert.ok(!stored.includes('correct-horse'));
    assert.match(stored, /"changeFingerprint":"[0-9a-f]{8}"/u);
    assert.match(stored, /"fingerprintBasis":"content"/u);
    rmSync(temp, { recursive: true, force: true });
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
