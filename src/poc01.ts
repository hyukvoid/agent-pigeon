#!/usr/bin/env node
/**
 * POC-01 — REAL mobile evidence experiments (spec §7 REAL A/B/C).
 *
 *   npm run poc:01 [-- --save-fixtures] [-- --device-only]
 *
 * Evidence provider: agent-device CLI (snapshot -i). Experiment control (force
 * a crash, reset app state) uses plain adb shell commands — control is not
 * evidence collection. agent-device's `logs` channel is broken on this
 * Windows host (provider bug, see POC-01.md), so the per-attempt log window
 * is fed from the Android crash buffer with explicit before/after offsets.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

import { evaluateScenario } from './core/evaluate.js';
import type { AttemptEvidence } from './core/types.js';
import { normalizeAgentDeviceEvidence } from './agent-device/adapter.js';
import { captureSnapshot, runAgentDevice } from './agent-device/capture.js';
import type { CapturedAttempt } from './agent-device/capture.js';
import { renderScenario } from './report.js';
import { createHash } from 'node:crypto';

const execFileAsync = promisify(execFile);
const SETTINGS_APP = 'com.android.settings';
const NETWORK_ROW = 'text="네트워크 및 인터넷"';
const FIXTURES_DIR = fileURLToPath(new URL('../../fixtures/agent-device/real/', import.meta.url));

interface AttemptRecord {
  id: string;
  capture: CapturedAttempt;
  logsText: string | null;
  evidence: AttemptEvidence;
  normalizeMs: number;
  evalMs: number;
  captureMs: number;
}

interface ScenarioResult {
  title: string;
  attempts: AttemptRecord[];
  report: string;
}

function sha8(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 8);
}

async function adb(args: string[], timeoutMs = 30_000): Promise<string> {
  const { stdout } = await execFileAsync('adb', args, { timeout: timeoutMs, windowsHide: true });
  return stdout;
}

async function firstDeviceSerial(): Promise<string | null> {
  const out = await adb(['devices']);
  for (const line of out.split(/\r?\n/u).slice(1)) {
    const [serial, state] = line.split('\t');
    if (state?.trim() === 'device' && serial !== undefined) return serial;
  }
  return null;
}

async function crashBufferLines(serial: string): Promise<string[]> {
  const out = await adb(['-s', serial, 'logcat', '-b', 'crash', '-d']);
  return out.split(/\r?\n/u);
}

function buildRecord(
  id: string,
  capture: CapturedAttempt,
  logsText: string | null,
  code?: { changedFilesCount: number | null; changeSetHash: string | null },
): AttemptRecord {
  const startedAt = performance.now();
  const evidence = normalizeAgentDeviceEvidence({
    attemptId: id,
    snapshotText: capture.snapshotText,
    logsText,
    code,
  });
  const normalizeMsValue = performance.now() - startedAt;
  const evalStartedAt = performance.now();
  evaluateScenario([evidence, evidence]); // touch the evaluator so timing covers it
  const evalMs = performance.now() - evalStartedAt;
  return {
    id,
    capture,
    logsText,
    evidence,
    normalizeMs: normalizeMsValue,
    evalMs,
    captureMs: capture.snapshotMs + capture.logsMs,
  };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function evaluateWindow(title: string, records: AttemptRecord[]): Promise<ScenarioResult> {
  const startedAt = performance.now();
  const { signals, evaluation } = evaluateScenario(records.map((r) => r.evidence));
  const evalMs = performance.now() - startedAt;
  const report = renderScenario({
    scenarioTitle: title,
    attempts: records.map((r) => r.evidence),
    signals,
    evaluation,
    jev: null,
    timing: { deterministicMs: evalMs, jevMs: null },
  });
  return { title, attempts: records, report };
}

function latencyTable(scenarios: ScenarioResult[]): string {
  const lines = ['Latency (POC-01 real-capture pipeline)', ''];
  for (const scenario of scenarios) {
    const captureMs = scenario.attempts.reduce((sum, a) => sum + a.captureMs, 0) / scenario.attempts.length;
    const normalizeMs = scenario.attempts.reduce((sum, a) => sum + a.normalizeMs, 0) / scenario.attempts.length;
    const endToEndMs = scenario.attempts.reduce((sum, a) => sum + a.captureMs + a.normalizeMs, 0);
    lines.push(
      `${scenario.title}: capture(avg) ${captureMs.toFixed(0)} ms · normalize(avg) ${normalizeMs.toFixed(2)} ms · capture+normalize(e2e) ${endToEndMs.toFixed(0)} ms`,
    );
  }
  return lines.join('\n');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const saveFixtures = args.includes('--save-fixtures');

  process.stdout.write('Agent Pigeon — POC-01 (real Android evidence)\n\n');

  const devices = await runAgentDevice(['devices']);
  process.stdout.write(`agent-device devices: ${devices.stdout.trim() || '(none)'}\n`);
  const serial = await firstDeviceSerial();
  if (serial === null) {
    process.stdout.write(
      '\nBLOCKED_BY_ANDROID_ENVIRONMENT: no booted device/emulator found. Start an emulator and rerun.\n',
    );
    process.exitCode = 2;
    return;
  }

  // Reset Settings to a clean foreground state.
  await adb(['-s', serial, 'shell', 'am', 'force-stop', SETTINGS_APP]).catch(() => '');
  const opened = await runAgentDevice(['open', SETTINGS_APP, '--foreground']);
  if (opened.exitCode !== 0) {
    process.stdout.write(`\nBLOCKED_BY_ANDROID_ENVIRONMENT: agent-device open failed: ${opened.stderr}\n`);
    process.exitCode = 2;
    return;
  }
  await sleep(2000);
  let crashOffset = (await crashBufferLines(serial)).length;

  // ---- REAL A: same state observed twice ---------------------------------
  const a1 = await captureSnapshot();
  await sleep(1500);
  const a2 = await captureSnapshot();
  const scenarioA = await evaluateWindow('REAL A — same state, observed twice', [
    buildRecord('real-a1', a1, null),
    buildRecord('real-a2', a2, null),
  ]);

  // ---- REAL B: actual runtime change (navigation + crash resolution) ----
  const b1 = await captureSnapshot();
  const click = await runAgentDevice(['click', NETWORK_ROW, '--settle']);
  if (click.exitCode !== 0) {
    process.stdout.write(`\nBLOCKED: navigation click failed: ${click.stderr}\n`);
    process.exitCode = 2;
    return;
  }
  const b2 = await captureSnapshot();
  await runAgentDevice(['back', '--settle']);
  await sleep(1000);

  // Crash leg: force a real crash (experiment control), capture the crash
  // state, then relaunch and observe the crash gone.
  await adb(['-s', serial, 'shell', 'am', 'crash', SETTINGS_APP]);
  await sleep(2500);
  const c1 = await captureSnapshot();
  const bufferNow = await crashBufferLines(serial);
  const crashWindow = bufferNow.slice(crashOffset).join('\n');
  crashOffset = bufferNow.length;

  await adb(['-s', serial, 'shell', 'am', 'force-stop', SETTINGS_APP]).catch(() => '');
  await runAgentDevice(['open', SETTINGS_APP, '--foreground']);
  await sleep(2500);
  const c2 = await captureSnapshot();
  const scenarioB = await evaluateWindow('REAL B — actual runtime change', [
    buildRecord('real-b1', b1, null),
    buildRecord('real-b2', b2, null),
    buildRecord('real-c1', c1, crashWindow),
    buildRecord('real-c2', c2, ''),
  ]);

  // ---- REAL C: different code, same app ---------------------------------
  const scratchDir = join(tmpdir(), 'agent-pigeon-poc01-scratch');
  mkdirSync(scratchDir, { recursive: true });
  const realCRecords: AttemptRecord[] = [];
  for (const fileName of ['patch-a.ts', 'patch-b.ts', 'patch-c.ts']) {
    const filePath = join(scratchDir, fileName);
    writeFileSync(filePath, `// POC-01 scratch patch ${fileName} — ${new Date().toISOString()}\n`, 'utf8');
    const capture = await captureSnapshot();
    realCRecords.push(
      buildRecord(`real-d-${fileName}`, capture, null, {
        changedFilesCount: 1,
        changeSetHash: sha8(fileName),
      }),
    );
  }
  const scenarioC = await evaluateWindow('REAL C — different code, same app', realCRecords);

  for (const scenario of [scenarioA, scenarioB, scenarioC]) {
    process.stdout.write(`${scenario.report}\n\n`);
  }
  process.stdout.write(`${latencyTable([scenarioA, scenarioB, scenarioC])}\n`);

  if (saveFixtures) {
    mkdirSync(FIXTURES_DIR, { recursive: true });
    const sanitize = (text: string): string =>
      text
        .split('\n')
        .filter((line) => !/session|\.agent-device|C:\\Users/u.test(line))
        .join('\n');
    const dump: Array<[string, string]> = [
      ['real-a1.snapshot.txt', a1.snapshotText ?? ''],
      ['real-a2.snapshot.txt', a2.snapshotText ?? ''],
      ['real-b1-homepage.snapshot.txt', b1.snapshotText ?? ''],
      ['real-b2-network.snapshot.txt', b2.snapshotText ?? ''],
      ['real-c1-crash.snapshot.txt', c1.snapshotText ?? ''],
      ['real-c2-homepage.snapshot.txt', c2.snapshotText ?? ''],
      ['real-crash-buffer.txt', crashWindow],
    ];
    for (const [name, text] of dump) {
      writeFileSync(join(FIXTURES_DIR, name), sanitize(text), 'utf8');
    }
    process.stdout.write(`\nFixtures saved to fixtures/agent-device/real/\n`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`poc:01 failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
