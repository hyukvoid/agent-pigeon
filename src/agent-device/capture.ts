/**
 * Thin capture layer: invokes the agent-device CLI (the first-party evidence
 * provider) and returns its raw output plus wall-clock duration. This is not
 * an ADB wrapper and not UI automation — every command is agent-device's own.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

export interface CaptureResult {
  command: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}

const AGENT_DEVICE_ENTRY = fileURLToPath(
  new URL('../../../node_modules/agent-device/bin/agent-device.mjs', import.meta.url),
);

export async function runAgentDevice(
  args: string[],
  timeoutMs = 90_000,
): Promise<CaptureResult> {
  const startedAt = performance.now();
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [AGENT_DEVICE_ENTRY, ...args],
      { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
    );
    return {
      command: args,
      stdout,
      stderr,
      exitCode: 0,
      durationMs: performance.now() - startedAt,
    };
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; code?: number | string };
    return {
      command: args,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? (error instanceof Error ? error.message : String(error)),
      exitCode: typeof err.code === 'number' ? err.code : 1,
      durationMs: performance.now() - startedAt,
    };
  }
}

/** One normalized observation of the app: snapshot + (optional) log window. */
export interface CapturedAttempt {
  snapshotText: string | null;
  logsText: string | null;
  snapshotMs: number;
  logsMs: number;
}

export async function captureSnapshot(): Promise<CapturedAttempt> {
  const snapshot = await runAgentDevice(['snapshot', '-i']);
  return {
    snapshotText: snapshot.exitCode === 0 ? snapshot.stdout : null,
    logsText: null,
    snapshotMs: snapshot.durationMs,
    logsMs: 0,
  };
}
