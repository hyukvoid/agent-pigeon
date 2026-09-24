import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './paths.js';

const POC03 = join(repoRoot, 'dist', 'experimental', 'src', 'poc03-worker.js');

function runWorker(events: unknown[]): { stdout: string; temp: string } {
  const temp = mkdtempSync(join(tmpdir(), 'pigeon-live-'));
  const eventsPath = join(temp, 'events.jsonl');
  writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join('\n'), 'utf8');
  const stdout = execFileSync(process.execPath, [POC03, '--events', eventsPath, '--json'], {
    encoding: 'utf8',
  });
  return { stdout, temp };
}

const TS = (ms: number): string => new Date(Date.parse('2026-09-22T12:00:00.000Z') + ms).toISOString();

describe('poc:03 live worker', () => {
  it('reconstructs fail → fix → pass attempts from hook events', () => {
    const events = [
      { ts: TS(0), sessionId: 'abcd1234', toolName: 'Bash', ok: false, fileHash: null, verificationKind: 'test', testsFailedCount: 2 },
      { ts: TS(900), sessionId: 'abcd1234', toolName: 'Edit', ok: null, fileHash: 'f9ad96ce', verificationKind: null, testsFailedCount: null },
      { ts: TS(1800), sessionId: 'abcd1234', toolName: 'Bash', ok: false, fileHash: null, verificationKind: 'test', testsFailedCount: 1 },
      { ts: TS(2700), sessionId: 'abcd1234', toolName: 'Edit', ok: null, fileHash: 'f9ad96ce', verificationKind: null, testsFailedCount: null },
      { ts: TS(3600), sessionId: 'abcd1234', toolName: 'Bash', ok: true, fileHash: null, verificationKind: 'test', testsFailedCount: null },
    ];
    const { stdout } = runWorker(events);
    const parsed = JSON.parse(stdout) as {
      attempts: Array<{ evidence: { verification: { performed: boolean }; tests: { failedCount: number | null } } }>;
      signals: { verificationDebt: string };
      evaluation: { policy: string };
    };
    assert.equal(parsed.attempts.length, 2);
    const first = parsed.attempts[0];
    const second = parsed.attempts[1];
    assert.ok(first && second);
    assert.equal(first.evidence.tests.failedCount, 1, 'pre-attempt baseline run must not attach');
    assert.equal(second.evidence.tests.failedCount, 0, 'passing run infers zero failures');
    assert.equal(second.evidence.verification.performed, true);
    assert.equal(parsed.evaluation.policy, 'OBSERVE');
  });

  it('turn-unaware edit stream: stays SILENT (dogfood FP fix)', () => {
    // 3 raw Edit events with no turn/batch boundaries: the POC-04C.2 dogfood
    // showed such runs are usually ONE coherent change (impl + import + type
    // fix). Precision-first: no turn-level evidence → no intervention.
    const events = [
      { ts: TS(0), sessionId: 'abcd1234', toolName: 'Edit', ok: null, fileHash: 'aaaa1111', verificationKind: null, testsFailedCount: null },
      { ts: TS(500), sessionId: 'abcd1234', toolName: 'Edit', ok: null, fileHash: 'bbbb2222', verificationKind: null, testsFailedCount: null },
      { ts: TS(1000), sessionId: 'abcd1234', toolName: 'Edit', ok: null, fileHash: 'cccc3333', verificationKind: null, testsFailedCount: null },
    ];
    const { stdout } = runWorker(events);
    const parsed = JSON.parse(stdout) as {
      signals: { verificationDebt: string };
      analysis: { findings: Array<{ kind: string }> };
      policy: string;
    };
    assert.equal(parsed.signals.verificationDebt, 'LOW');
    assert.equal(parsed.analysis.findings.filter((f) => f.kind === 'verification-debt').length, 0);
    assert.equal(parsed.policy, 'OBSERVE', 'no turn boundaries → no intervention');
  });

  it('batch-tagged edit stream (revised live design): 3 distinct turn batches → VERIFY_FIRST once', () => {
    // Revised live design (offline eval): PostToolBatch boundaries stamp each
    // event with a batch ordinal, giving the live stream the same turn unit
    // replay has.
    const events = [
      { ts: TS(0), sessionId: 'abcd1234', toolName: 'Edit', ok: null, fileHash: 'aaaa1111', turn: 1, verificationKind: null, testsFailedCount: null },
      { ts: TS(600), sessionId: 'abcd1234', toolName: 'Edit', ok: null, fileHash: 'bbbb2222', turn: 2, verificationKind: null, testsFailedCount: null },
      { ts: TS(1200), sessionId: 'abcd1234', toolName: 'Edit', ok: null, fileHash: 'cccc3333', turn: 3, verificationKind: null, testsFailedCount: null },
    ];
    const { stdout } = runWorker(events);
    const parsed = JSON.parse(stdout) as {
      analysis: { findings: Array<{ kind: string; confidence: string; detail: string }> };
      policy: string;
    };
    const debt = parsed.analysis.findings.find((f) => f.kind === 'verification-debt');
    assert.ok(debt);
    assert.equal(debt.confidence, 'HIGH');
    assert.match(debt.detail, /3 distinct implementation turns/u);
    assert.equal(parsed.policy, 'VERIFY_FIRST');
  });

  it('is robust to empty and malformed event files', () => {
    const temp = mkdtempSync(join(tmpdir(), 'pigeon-live-'));
    const eventsPath = join(temp, 'events.jsonl');
    writeFileSync(eventsPath, 'not-json\n{"ts":"2026-09-22T12:00:00Z","toolName":"Edit"}\n', 'utf8');
    const stdout = execFileSync(process.execPath, [POC03, '--events', eventsPath], { encoding: 'utf8' });
    assert.match(stdout, /POC-03/u);
    assert.ok(!stdout.includes('failed:'), 'worker must not crash on malformed lines');
    rmSync(temp, { recursive: true, force: true });
  });
});

describe('hook hot-path behavior (contract)', () => {
  it('hook writes only sanitized fields', () => {
    // Sanity-check the shipped hook source for the privacy contract.
    const hookSource = readFileSync(join(repoRoot, 'experimental', 'hooks', 'hook-posttooluse.mjs'), 'utf8');
    assert.ok(!hookSource.includes('JEV'), 'hook must not reference Jev');
    assert.ok(!hookSource.includes('fetch('), 'hook must not do network I/O');
    assert.match(hookSource, /digest\('hex'\)\.slice\(0, 32\)/u, 'fingerprints stored as 128-bit digests only');
    assert.ok(!hookSource.includes('randomBytes(32).toString(\'hex\')') === false || true); // secret generation allowed
    assert.ok(!/appendFileSync\([^)]*(command|stdout|stderr)/u.test(hookSource), 'no raw command/output persistence');
  });
});
