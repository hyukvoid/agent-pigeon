/**
 * Structural validator for Pigeon Events (hand-rolled, zero dependencies —
 * mirrors the style of core/types.ts AttemptEvidence validation).
 *
 * Adapters run every event through this before it reaches the processor:
 * a malformed event must never silently corrupt the flight recorder's view.
 */

import { EVENT_STATUSES, PIGEON_EVENT_TYPES } from './types.js';
import type { PigeonEvent, PigeonEventType, EventStatus } from './types.js';

export type ValidationOutcome =
  | { ok: true; value: PigeonEvent }
  | { ok: false; errors: string[] };

function isOptionalString(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'string';
}

function isOptionalNumber(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'number';
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || value === null || typeof value === 'boolean';
}

export function validatePigeonEvent(raw: unknown): ValidationOutcome {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['event must be an object'] };
  }
  const e = raw as Record<string, unknown>;

  if (typeof e.id !== 'string' || e.id.length === 0) {
    errors.push('id must be a non-empty string');
  }
  if (typeof e.sessionId !== 'string' || e.sessionId.length === 0) {
    errors.push('sessionId must be a non-empty string');
  }
  if (typeof e.type !== 'string' || !PIGEON_EVENT_TYPES.includes(e.type as PigeonEventType)) {
    errors.push(`type must be one of ${PIGEON_EVENT_TYPES.join('|')}`);
  }
  if (typeof e.timestamp !== 'string' || !Number.isFinite(Date.parse(e.timestamp))) {
    errors.push('timestamp must be an ISO 8601 string');
  }
  if (!isOptionalString(e.agentId) || (typeof e.agentId === 'string' && e.agentId.length === 0)) {
    errors.push('agentId must be a non-empty string when present');
  }
  if (!isOptionalString(e.parentAgentId)) {
    errors.push('parentAgentId must be a string or null');
  }
  if (!isOptionalString(e.parentId)) {
    errors.push('parentId must be a string or null');
  }
  if (e.durationMs !== undefined && e.durationMs !== null &&
      (typeof e.durationMs !== 'number' || !Number.isFinite(e.durationMs) || e.durationMs < 0)) {
    errors.push('durationMs must be a non-negative finite number or null');
  }
  if (e.exitCode !== undefined && e.exitCode !== null &&
      (typeof e.exitCode !== 'number' || !Number.isInteger(e.exitCode))) {
    errors.push('exitCode must be an integer or null');
  }
  if (!isOptionalString(e.summary)) errors.push('summary must be a string or null');
  if (!isOptionalString(e.filePath)) errors.push('filePath must be a string or null');
  if (!isOptionalString(e.command)) errors.push('command must be a string or null');
  if (!isOptionalString(e.toolName)) errors.push('toolName must be a string or null');
  if (!isOptionalString(e.error)) errors.push('error must be a string or null');
  if (!isOptionalNumber(e.durationMs)) errors.push('durationMs must be a number or null');
  if (e.status !== undefined && e.status !== null &&
      (typeof e.status !== 'string' || !EVENT_STATUSES.includes(e.status as EventStatus))) {
    errors.push(`status must be one of ${EVENT_STATUSES.join('|')}`);
  }
  if (e.metadata !== undefined && e.metadata !== null &&
      (typeof e.metadata !== 'object' || Array.isArray(e.metadata))) {
    errors.push('metadata must be an object or null');
  }
  if (e.relatedEventIds !== undefined && e.relatedEventIds !== null) {
    if (!Array.isArray(e.relatedEventIds) || !e.relatedEventIds.every((v) => typeof v === 'string')) {
      errors.push('relatedEventIds must be an array of strings');
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: raw as unknown as PigeonEvent };
}

/** Validate a whole array; returns the valid events plus per-item problems. */
export function validatePigeonEvents(
  raw: unknown[],
): { events: PigeonEvent[]; invalid: { index: number; errors: string[] }[] } {
  const events: PigeonEvent[] = [];
  const invalid: { index: number; errors: string[] }[] = [];
  raw.forEach((item, index) => {
    const result = validatePigeonEvent(item);
    if (result.ok) events.push(result.value);
    else invalid.push({ index, errors: result.errors });
  });
  return { events, invalid };
}
