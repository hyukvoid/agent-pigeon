import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCodexSessionJsonl, tokensInWindow } from '../src/replay/codex.js';
import { segmentWithWindows } from '../src/replay/segment.js';
import { analyzeAttempts } from '../src/replay/analyze.js';
import { contentFingerprint } from '../src/replay/fingerprint.js';
import { repoRoot } from './paths.js';

const FIXTURE = join(repoRoot, 'fixtures', 'codex', 'sample-rollout.jsonl');

describe('Codex offline adapter (synthetic rollout)', () => {
  const text = readFileSync(FIXTURE, 'utf8');
  const session = parseCodexSessionJsonl(text);
  const { attempts } = segmentWithWindows(session.events);
  const analysis = analyzeAttempts(attempts);

  it('maps apply_patch → implementation events with content fingerprints', () => {
    const impls = session.events.filter((e) => e.eventType === 'implementation');
    assert.equal(impls.length, 3);
    assert.ok(impls.every((e) => e.fingerprintBasis === 'content'));
    const hashes = new Set(impls.map((e) => e.changeSetHash));
    assert.equal(hashes.size, 3, 'three different patches → three fingerprints');
    assert.ok(impls.every((e) => (e.changedFilesCount ?? 0) >= 1));
  });

  it('pairs exec outputs: verification kind, exit code, failure signature, failed counts', () => {
    const verifs = session.events.filter((e) => e.eventType === 'verification');
    assert.equal(verifs.length, 4, '3× npm test (test) + 1× adb devices (device)');
    assert.equal(verifs.filter((v) => v.verificationKind === 'test').length, 3);
    const adb = session.events.find((e) => e.verificationKind === 'device');
    assert.ok(adb, 'adb devices classified as device verification');
    const failing = verifs.filter((v) => v.verificationKind === 'test');
    assert.ok(failing.every((v) => v.ok === false));
    assert.ok(failing.every((v) => v.testsFailedCount === 8));
    const sigs = new Set(failing.map((v) => v.failureSignatureHash));
    assert.equal(sigs.size, 1, 'same failure → same normalized signature');
  });

  it('reconstructs the real dead-end pattern: 3 novel patches, same failure', () => {
    assert.equal(attempts.length, 3);
    const deadEnd = analysis.findings.find((f) => f.kind === 'dead-end');
    assert.ok(deadEnd);
    assert.equal(deadEnd.attemptRange[0], 1);
    assert.equal(deadEnd.attemptRange[1], 3);
    assert.equal(deadEnd.confidence, 'HIGH');
    assert.equal(analysis.findings.find((f) => f.kind === 'productive'), undefined);
  });

  it('flags mobile context from commands (in memory only)', () => {
    assert.equal(session.mobileSignal, true, 'adb devices → mobile signal');
  });

  it('privacy: no patch content, no absolute paths in serialized events', () => {
    const serialized = JSON.stringify(session.events);
    // patch bodies never persist
    assert.ok(!serialized.includes('session?.token'));
    assert.ok(!serialized.includes('Token.create'));
    assert.ok(!serialized.includes('npm test'));
    assert.ok(!serialized.includes('adb devices'));
    // repo-relative display paths are allowed (POC flight shows them);
    // absolute machine paths are not.
    assert.ok(!serialized.includes('/Users/'));
    assert.ok(!serialized.includes('C:/'));
    assert.doesNotMatch(serialized, /"path":"[^"]*\/[^"]*\/[^"]*\/[^"]*\/[^"]*"/u);
  });

  it('token window deltas reconstruct from cumulative records', () => {
    const first = Date.parse('2026-06-01T10:00:00.000Z');
    assert.equal(tokensInWindow(session.tokenRecords, first + 1_000, first + 390_000), 140);
    assert.equal(tokensInWindow(session.tokenRecords, first + 361_000, first + 700_000), 250);
    assert.equal(tokensInWindow(session.tokenRecords, first + 700_000, first + 900_000), null);
  });
});
