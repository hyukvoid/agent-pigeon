/**
 * changeFingerprint (POC-03.5 §1) — privacy-safe content novelty.
 *
 * A path hash cannot distinguish Patch A from Patch B on the same file. The
 * fingerprint hashes the NORMALIZED change payload (edit old/new strings,
 * Write content, MultiEdit aggregate) locally and stores only a short
 * digest. Raw source/edit text is never persisted and never sent to Jev.
 *
 * Normalization (whitespace collapse) is for STABILITY, not secrecy: the
 * same semantic change re-applied hashes identically; materially different
 * edits hash differently. Hashing itself is what protects content.
 */

import { createHash } from 'node:crypto';

export function normalizeChangePayload(text: string): string {
  return text.replace(/\s+/gu, ' ').trim();
}

/** sha256-8 over the normalized parts, joined with a NUL separator. */
export function changeFingerprint(parts: string[]): string {
  const payload = parts.map((p) => normalizeChangePayload(p)).join('\u0000');
  return createHash('sha256').update(payload).digest('hex').slice(0, 8);
}
