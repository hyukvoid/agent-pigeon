import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  classifyVerificationCommand,
  extractFailedCount,
  failureSignature,
  parseClaudeSessionJsonl,
} from '../src/replay/claude.js';
import { segmentIntoAttempts } from '../src/replay/segment.js';
import { analyzeAttempts } from '../src/replay/analyze.js';
import type { ReplayAttempt } from '../src/replay/types.js';
import type { AttemptEvidence } from '../src/core/types.js';
import { join } from 'node:path';
import { fixturesRoot } from './paths.js';

function attemptOf(
  index: number,
  overrides: {
    performed?: boolean;
    changeSetHash?: string | null;
    failedCount?: number | null;
    build?: 'pass' | 'fail' | null;
    failureSignatureHash?: string | null;
    implementationEvents?: number;
  },
): ReplayAttempt {
  const evidence: AttemptEvidence = {
    attemptId: `attempt-${index + 1}`,
    build: { status: overrides.build ?? null },
    tests: { failedCount: overrides.failedCount ?? null },
    runtime: { crashSignature: null, screenSignature: null },
    verification: { performed: overrides.performed ?? false },
    code: { changedFilesCount: 1, changeSetHash: overrides.changeSetHash ?? `hash-${index}` },
  };
  return {
    index,
    evidence,
    failureSignatureHash: overrides.failureSignatureHash ?? null,
    verificationKinds: overrides.performed ? ['test'] : [],
    implementationEvents: overrides.implementationEvents ?? 1,
    timestampOffset: index * 1000,
  };
}

describe('command classification', () => {
  it('classifies verification commands', () => {
    assert.equal(classifyVerificationCommand('npm test'), 'test');
    assert.equal(classifyVerificationCommand('cd apps/web && npm run test'), 'test');
    assert.equal(classifyVerificationCommand('./gradlew test'), 'test');
    assert.equal(classifyVerificationCommand('adb install app.apk'), 'device');
    assert.equal(classifyVerificationCommand('npx agent-device snapshot -i'), 'device');
    assert.equal(classifyVerificationCommand('npm run build'), 'build');
    assert.equal(classifyVerificationCommand('tsc -p tsconfig.json'), 'build');
    assert.equal(classifyVerificationCommand('pwd && ls'), null);
    assert.equal(classifyVerificationCommand('cat package.json'), null);
  });

  it('extracts only failed-test numbers', () => {
    assert.equal(extractFailedCount('Tests: 3 failed, 12 passed, 15 total'), 3);
    assert.equal(extractFailedCount('18 tests failed'), 18);
    assert.equal(extractFailedCount('2 failing'), 2);
    assert.equal(extractFailedCount('all good'), null);
  });

  it('normalizes error identity: same failure with different numbers hashes identically', () => {
    const a = failureSignature('TypeError: cannot read property of undefined at Login.kt:84 line 12');
    const b = failureSignature('TypeError: cannot read property of undefined at Login.kt:91 line 99');
    const c = failureSignature('NullPointerException at Session.kt:3');
    assert.equal(a, b);
    assert.notEqual(a, c);
  });
});

describe('attempt segmentation', () => {
  it('build → test sequence attaches to the same attempt window', () => {
    const session = [
      assistantToolUse('t1', 'Edit', { file_path: '/x/a.ts' }),
      userToolResult('t1', false),
      assistantToolUse('t2', 'Bash', { command: 'npm run build' }),
      userToolResult('t2', false),
      assistantToolUse('t3', 'Bash', { command: 'npm test' }),
      userToolResult('t3', true, 'Tests: 4 failed, 10 passed'),
      assistantToolUse('t4', 'Edit', { file_path: '/x/b.ts' }),
      userToolResult('t4', false),
    ].join('\n');
    const { events } = parseClaudeSessionJsonl(session, 'testses1');
    const attempts = segmentIntoAttempts(events);
    assert.equal(attempts.length, 2);
    const first = attempts[0];
    assert.ok(first);
    assert.equal(first.verificationKinds.length, 2);
    assert.equal(first.evidence.tests.failedCount, 4);
    assert.equal(first.evidence.build.status, 'pass');
    assert.equal(first.evidence.code.changedFilesCount, 1);
    assert.equal(first.evidence.verification.performed, true);
    const second = attempts[1];
    assert.ok(second);
    assert.equal(second.evidence.verification.performed, false, 'trailing edit without verification');
  });

  it('replays the REAL sanitized session fixture into the recorded debt finding', () => {
    const fixturePath = join(fixturesRoot, 'replay', 'sanitized-415efbff.json');
    const sanitized = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
      events: Parameters<typeof segmentIntoAttempts>[0];
    };
    const attempts = segmentIntoAttempts(sanitized.events);
    const analysis = analyzeAttempts(attempts);
    assert.equal(analysis.implementationCalls, 11);
    assert.equal(analysis.verificationRuns, 0);
    assert.equal(analysis.findings.length, 1);
    const debt = analysis.findings[0];
    assert.ok(debt);
    assert.equal(debt.kind, 'verification-debt');
    assert.equal(debt.confidence, 'HIGH');
    assert.match(analysis.verdict, /⏸ Verification debt/u);
  });

  it('sanitized fixture contains no raw content (privacy invariant)', () => {
    const raw = readFileSync(join(fixturesRoot, 'replay', 'sanitized-415efbff.json'), 'utf8');
    assert.doesNotMatch(raw, /[A-Za-z]:\\\\/u);
    assert.doesNotMatch(raw, /"command"|stdout|stderr|file_path|prompt/iu);
    // every hash field must be a short hex string or null
    for (const match of raw.matchAll(/"(?:changeSetHash|failureSignatureHash)":\s*("[^"]*"|null)/gu)) {
      const value = match[1] ?? '';
      if (value !== 'null') assert.match(value, /^"[0-9a-f]{8}"$/u);
    }
  });
});

describe('findings on synthetic-but-realistic sessions', () => {
  it('detects dead-end exploration (same failure, novel patches) and productive progress', () => {
    const attempts: ReplayAttempt[] = [
      attemptOf(0, { performed: true, changeSetHash: 'aaa', failedCount: 18, build: 'pass', failureSignatureHash: 'deadbeef' }),
      attemptOf(1, { performed: true, changeSetHash: 'bbb', failedCount: 18, build: 'pass', failureSignatureHash: 'deadbeef' }),
      attemptOf(2, { performed: true, changeSetHash: 'ccc', failedCount: 9, build: 'pass', failureSignatureHash: 'cafe0000' }),
    ];
    const analysis = analyzeAttempts(attempts);
    const deadEnd = analysis.findings.find((f) => f.kind === 'dead-end');
    assert.ok(deadEnd);
    assert.equal(deadEnd.attemptRange[0], 1);
    assert.equal(deadEnd.attemptRange[1], 2);
    assert.equal(deadEnd.confidence, 'MEDIUM');
    const productive = analysis.findings.filter((f) => f.kind === 'productive');
    assert.ok(productive.length >= 1);
    assert.match(analysis.verdict, /⚠ Different code\. Same error\./u);
  });

  it('does NOT call a session with a single unverified edit a dead end (false-positive guard)', () => {
    const analysis = analyzeAttempts([
      attemptOf(0, { performed: false, changeSetHash: 'aaa', implementationEvents: 1 }),
    ]);
    assert.equal(analysis.findings.length, 0);
    assert.equal(analysis.overallConfidence, 'INCONCLUSIVE');
    assert.match(analysis.verdict, /INCONCLUSIVE/u);
  });

  it('flags multi-attempt verification debt', () => {
    const analysis = analyzeAttempts([
      attemptOf(0, { performed: false }),
      attemptOf(1, { performed: false }),
      attemptOf(2, { performed: false }),
    ]);
    const debt = analysis.findings.find((f) => f.kind === 'verification-debt');
    assert.ok(debt);
    assert.equal(debt.confidence, 'HIGH');
  });
});

// --- helpers -------------------------------------------------------------

function assistantToolUse(
  id: string,
  name: string,
  input: Record<string, unknown>,
  timestamp = '2026-09-22T10:00:00.000Z',
): string {
  return JSON.stringify({
    type: 'assistant',
    timestamp,
    sessionId: 'test-session-0001',
    message: { content: [{ type: 'tool_use', id, name, input }] },
  });
}

function userToolResult(
  id: string,
  isError: boolean,
  text = 'ok',
  timestamp = '2026-09-22T10:00:01.000Z',
): string {
  return JSON.stringify({
    type: 'user',
    timestamp,
    sessionId: 'test-session-0001',
    toolUseResult: { stdout: isError ? '' : 'ok', stderr: isError ? text : '', durationMs: 120 },
    message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: text }] },
  });
}
