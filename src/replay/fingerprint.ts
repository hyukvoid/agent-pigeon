/**
 * changeFingerprint (hardened, POC-03.5.1).
 *
 *   fingerprint = HMAC-SHA256(perInstallSecret, canonicalPayload)[0:32 hex]  (128 bits)
 *
 * Why HMAC with a per-install secret: a bare digest lets anyone test
 * candidate contents ("did the agent touch this exact snippet?") by
 * re-hashing guesses. Keying with a locally-generated secret that never
 * leaves the machine removes candidate matching for everyone except the
 * install owner. The digest is 128 bits — collision/target resistance —
 * but it is still a commitment to content: treat stored fingerprints as
 * sensitive metadata, not as anonymous data.
 *
 * Canonicalization policy (serialization mechanics ONLY):
 *  - stable JSON layout with explicit key order (v, op, parts…)
 *  - line endings normalized (CRLF/CR → LF) so the same edit committed from
 *    different tooling hashes identically — justified mechanics, not
 *    semantics
 *  - NO whitespace collapsing: indentation and spacing are part of the
 *    change semantics
 *
 * The per-install secret never enters any event, fixture, or Jev payload.
 */

import { createHmac } from 'node:crypto';
import { loadOrCreateSecret } from './secret.js';

const lf = (text: string): string => text.replace(/\r\n?/gu, '\n');

function hmacFingerprint(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical, 'utf8').digest('hex').slice(0, 32);
}

export type ChangeOperation = 'edit' | 'write' | 'notebook' | 'multi-edit' | 'patch';

/** Content fingerprint: HMAC-SHA256(128-bit) over the canonical change payload. */
export function contentFingerprint(
  secret: string,
  op: ChangeOperation,
  parts: string[],
): string {
  const canonical = JSON.stringify({ v: 2, op, parts: parts.map(lf) });
  return hmacFingerprint(secret, canonical);
}

/** Fallback fingerprint over the sorted changed-path list (same HMAC keying). */
export function pathFingerprint(secret: string, paths: string[]): string {
  const canonical = JSON.stringify({ v: 2, op: 'paths', paths: [...paths].sort() });
  return hmacFingerprint(secret, canonical);
}

/** Convenience: load-or-create the install secret and fingerprint content. */
export function fingerprintChange(op: ChangeOperation, parts: string[]): string {
  return contentFingerprint(loadOrCreateSecret(), op, parts);
}
