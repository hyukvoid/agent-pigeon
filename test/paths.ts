import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const fixturesRoot = join(repoRoot, 'fixtures');
export function scenarioFixture(name: string): string {
  return join(fixturesRoot, 'scenarios', name);
}
export function agentDeviceFixture(name: string): string {
  return join(fixturesRoot, 'agent-device', name);
}
