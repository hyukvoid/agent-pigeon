/**
 * Per-install HMAC secret (POC-03.5.1).
 *
 * A random 32-byte secret generated locally on first use, stored OUTSIDE any
 * repository (default <Home>/.agent-pigeon/secret.key, mode 0600). It keys
 * the change/path fingerprints so stored digests cannot be candidate-matched
 * by anyone without this machine's secret. The secret must NEVER be
 * committed and NEVER leaves the machine (it is not part of any event or Jev
 * payload).
 *
 * AGENT_PIGEON_HOME overrides the state directory (used by tests).
 */

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function pigeonHome(): string {
  return process.env.AGENT_PIGEON_HOME ?? join(homedir(), '.agent-pigeon');
}

/** Load the per-install secret, generating it on first use. */
export function loadOrCreateSecret(): string {
  const dir = pigeonHome();
  mkdirSync(dir, { recursive: true });
  const secretPath = join(dir, 'secret.key');
  if (existsSync(secretPath)) {
    const existing = readFileSync(secretPath, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const secret = randomBytes(32).toString('hex');
  writeFileSync(secretPath, `${secret}\n`, { encoding: 'utf8', mode: 0o600 });
  return secret;
}
