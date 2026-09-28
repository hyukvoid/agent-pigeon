import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { repoRoot } from './paths.js';

const CLI = join(repoRoot, 'dist', 'src', 'cli.js');
const FIXTURE_D = join(repoRoot, 'fixtures', 'pigeon', 'd-acceptance-login.pigeon.jsonl');
const FIXTURE_A = join(repoRoot, 'fixtures', 'pigeon', 'a-simple-success.pigeon.jsonl');

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

describe('agent-pigeon session command (flight recorder in the terminal)', () => {
  it('renders the acceptance scenario with problems and recoveries', () => {
    const { stdout, status } = runCli(['session', FIXTURE_D]);
    assert.equal(status, 0);
    assert.match(stdout, /Task\s+fix login/u);
    assert.match(stdout, /SUCCESS/u);
    assert.match(stdout, /Failures\s+2 encountered · 2 recovered/u);
    assert.match(stdout, /Problems — 2/u);
    assert.match(stdout, /#1 Test failure/u);
    assert.match(stdout, /Status: RECOVERED/u);
    assert.match(stdout, /Agents\s+3 \(main, test-agent, browser-agent\)/u);
    assert.match(stdout, /├─ test-agent ✓/u);
    assert.match(stdout, /src\/middleware\.ts/u);
    assert.match(stdout, /Read-only/u);
  });

  it('renders a clean session without problems', () => {
    const { stdout, status } = runCli(['session', FIXTURE_A]);
    assert.equal(status, 0);
    assert.match(stdout, /Problems — 0/u);
    assert.match(stdout, /Outcome\s*\n\s*SUCCESS/u);
  });

  it('supports --json with the full session model', () => {
    const { stdout, status } = runCli(['session', FIXTURE_D, '--json']);
    assert.equal(status, 0);
    const model = JSON.parse(stdout) as { outcome: { status: string; failures: number; recovered: number }; problems: unknown[] };
    assert.equal(model.outcome.status, 'SUCCESS');
    assert.equal(model.outcome.failures, 2);
    assert.equal(model.outcome.recovered, 2);
    assert.equal(model.problems.length, 2);
  });

  it('fails with a clear message for unreadable files', () => {
    const { stderr, status } = runCli(['session', join(repoRoot, 'fixtures', 'scenarios', 'fixture-a.json')]);
    assert.equal(status, 1);
    assert.match(stderr, /no readable session/u);
  });

  it('help documents the session command', () => {
    const { stdout } = runCli(['--help']);
    assert.match(stdout, /session <file>/u);
  });
});
