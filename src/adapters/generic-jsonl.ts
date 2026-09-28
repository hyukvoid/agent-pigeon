/**
 * Generic JSONL adapter — the reference implementation of the Pigeon Event
 * Format (support level: FULL).
 *
 * Reads files where every non-empty line is a JSON Pigeon Event:
 *
 *   {"type":"SESSION_STARTED", "id":"e1", "sessionId":"s1", "timestamp":"...", ...}
 *   {"type":"FILE_CHANGED",    "id":"e2", "sessionId":"s1", "timestamp":"...", "filePath":"src/api.ts"}
 *
 * This adapter is the product's testing backbone: vendor integrations can
 * fail independently because everything (fixtures, tests, the extension's
 * demo path) runs through this format.
 *
 * Corruption policy: a malformed line is skipped and counted as a warning —
 * a partially written trailing line (live append) must never kill a session.
 */

import { readFileSync } from 'node:fs';
import { validatePigeonEvent } from '../pigeon/validate.js';
import type { PigeonEvent } from '../pigeon/types.js';

export interface ParseResult {
  events: PigeonEvent[];
  warnings: string[];
  /** Lines that were non-empty but neither valid JSON nor valid events. */
  skipped: number;
}

export function parsePigeonJsonl(text: string, sourceLabel = 'generic-jsonl'): ParseResult {
  const events: PigeonEvent[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  const lines = text.split(/\r?\n/u);
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      skipped++;
      warnings.push(`line ${index + 1}: invalid JSON skipped`);
      return;
    }
    const result = validatePigeonEvent(raw);
    if (!result.ok) {
      skipped++;
      warnings.push(`line ${index + 1}: invalid event skipped (${result.errors[0] ?? 'unknown'})`);
      return;
    }
    const event = result.value;
    if (event.source === undefined) event.source = sourceLabel;
    events.push(event);
  });
  return { events, warnings, skipped };
}

export function parsePigeonJsonlFile(path: string, sourceLabel = 'generic-jsonl'): ParseResult {
  return parsePigeonJsonl(readFileSync(path, 'utf8'), sourceLabel);
}

/**
 * Incremental reader for live sessions: feed appended text as the file grows;
 * only complete lines are parsed, a partial trailing line is buffered until
 * its newline arrives. Byte-offset bookkeeping lives with the caller.
 */
export class PigeonJsonlReader {
  private buffer = '';
  readonly warnings: string[] = [];
  skipped = 0;
  readonly events: PigeonEvent[] = [];

  push(chunk: string): PigeonEvent[] {
    this.buffer += chunk;
    const complete = this.buffer.lastIndexOf('\n');
    if (complete === -1) return [];
    const ready = this.buffer.slice(0, complete + 1);
    this.buffer = this.buffer.slice(complete + 1);
    const result = parsePigeonJsonl(ready);
    this.events.push(...result.events);
    this.warnings.push(...result.warnings);
    this.skipped += result.skipped;
    return result.events;
  }
}

/** Sniff: does this text look like a pigeon.jsonl session? */
export function looksLikePigeonJsonl(text: string): boolean {
  const lines = text.split(/\r?\n/u).filter((l) => l.trim().length > 0).slice(0, 10);
  let hits = 0;
  for (const line of lines) {
    try {
      const obj = JSON.parse(line.trim()) as Record<string, unknown>;
      if (
        typeof obj.type === 'string' &&
        typeof obj.sessionId === 'string' &&
        typeof obj.timestamp === 'string' &&
        typeof obj.id === 'string'
      ) {
        hits++;
      }
    } catch {
      // not JSON — keep sniffing
    }
  }
  return hits >= Math.max(1, Math.ceil(lines.length / 2));
}
