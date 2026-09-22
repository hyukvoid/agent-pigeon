/**
 * Per-install HMAC secret (POC-03.5.1; race-safe since POC-04A.1).
 *
 * A random 32-byte secret generated locally on first use, stored OUTSIDE any
 * repository (default <Home>/.agent-pigeon/secret.key). PostToolUse hooks may
 * run CONCURRENTLY, so first-use creation is race-safe:
 *
 *   - exclusive create ('wx' / O_EXCL): exactly one process wins
 *   - losers get EEXIST and read the winner's secret, retrying briefly in
 *     case the winner has not flushed yet
 *   - every process converges on the SAME secret
 *
 * The secret must NEVER be committed and NEVER leaves the machine (it is not
 * part of any event or Jev payload).
 *
 * AGENT_PIGEON_HOME overrides the state directory (used by tests).
 */

import { randomBytes } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, writeSync, writeFileSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const SECRET_PATTERN = /^[0-9a-f]{64}$/u;

export function pigeonHome(): string {
  return process.env.AGENT_PIGEON_HOME ?? join(homedir(), '.agent-pigeon');
}

function readValidSecret(secretPath: string): string | null {
  if (!existsSync(secretPath)) return null;
  const existing = readFileSync(secretPath, 'utf8').trim();
  return SECRET_PATTERN.test(existing) ? existing : null;
}

/** Poll a just-created secret file until the winning process has flushed it. */
function waitAndReadValidSecret(secretPath: string, timeoutMs = 2000): string | null {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const secret = readValidSecret(secretPath);
    if (secret !== null) return secret;
    sleep(25);
  }
  return null;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Load the per-install secret, generating it atomically on first use. */
export function loadOrCreateSecret(): string {
  const dir = pigeonHome();
  mkdirSync(dir, { recursive: true });
  const secretPath = join(dir, 'secret.key');

  const existing = readValidSecret(secretPath);
  if (existing !== null) return existing;

  const secret = randomBytes(32).toString('hex');
  try {
    // Exclusive create: concurrent processes race; exactly one wins.
    const fd = openSync(secretPath, 'wx');
    try {
      writeSync(fd, `${secret}\n`);
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(secretPath, 0o600);
    } catch {
      // best-effort on platforms without POSIX modes
    }
    return secret;
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
  }

  // Lost the creation race: converge on the winner's secret (it may still be
  // mid-flush, so poll briefly).
  const winners = waitAndReadValidSecret(secretPath);
  if (winners !== null) return winners;

  throw new Error('unable to converge on the per-install secret');
}

/** Atomic JSON replace: write temp file, then rename over the target. */
export function atomicWriteJson(path: string, value: unknown): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  // rename over an existing file is atomic on POSIX and on Windows (Node uses
  // MoveFileEx with REPLACE_EXISTING)
  renameSync(tmp, path);
}
