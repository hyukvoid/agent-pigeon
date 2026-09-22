/**
 * Fixture loading. Fixtures live in <repo>/fixtures and are resolved relative
 * to the compiled module, so both `npm run poc:00` (dist/src/cli.js) and tests
 * find them without depending on the caller's cwd.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AttemptEvidence } from './core/types.js';
import { validateAttemptEvidence } from './core/types.js';

const moduleDir = dirname(fileURLToPath(import.meta.url));
// Compiled module lives at <repo>/dist/src/fixtures.js -> repo root is two levels up.
export const fixturesRoot = join(moduleDir, '..', '..', 'fixtures');

export interface ScenarioDefinition {
  id: string;
  title: string;
  fixturePath: string;
}

export const SCENARIOS: ScenarioDefinition[] = [
  { id: 'a', title: 'Productive progress', fixturePath: join(fixturesRoot, 'scenarios', 'fixture-a.json') },
  { id: 'b', title: 'Different code, same app', fixturePath: join(fixturesRoot, 'scenarios', 'fixture-b.json') },
  { id: 'c', title: 'Verification debt', fixturePath: join(fixturesRoot, 'scenarios', 'fixture-c.json') },
];

export function loadAttempts(fixturePath: string): AttemptEvidence[] {
  const raw: unknown = JSON.parse(readFileSync(fixturePath, 'utf8'));
  if (!Array.isArray(raw)) {
    throw new Error(`fixture ${fixturePath} must contain an array of attempts`);
  }
  const attempts: AttemptEvidence[] = [];
  for (const entry of raw) {
    const outcome = validateAttemptEvidence(entry);
    if (!outcome.ok) {
      throw new Error(`fixture ${fixturePath} has an invalid attempt: ${outcome.errors.join('; ')}`);
    }
    attempts.push(outcome.value);
  }
  if (attempts.length === 0) {
    throw new Error(`fixture ${fixturePath} contains no attempts`);
  }
  return attempts;
}

export function loadRecording(relPath: string): string {
  return readFileSync(join(fixturesRoot, relPath), 'utf8');
}
