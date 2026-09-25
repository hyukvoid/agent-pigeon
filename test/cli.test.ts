import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './paths.js';

const CLI = join(repoRoot, 'dist', 'src', 'cli.js');
const SESSION = 'cli00000-1111-2222-3333-444444444444';

function runCli(args: string[]): { stdout: string; stderr: string; status: number } {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

function syntheticClaudeDir(): { dir: string; file: string } {
  const home = mkdtempSync(join(tmpdir(), 'pigeon-cli-'));
  const projects = join(home, 'claude', 'projects', 'demo');
  mkdirSync(projects, { recursive: true });
  const t = (offset: number): string => new Date(Date.parse('2026-09-22T12:00:00.000Z') + offset).toISOString();
  const edit = (id: string, offset: number): string =>
    JSON.stringify({ type: 'assistant', timestamp: t(offset), sessionId: SESSION, message: { content: [{ type: 'tool_use', id, name: 'Edit', input: { file_path: `/p/${id}.ts`, old_string: `old ${id}`, new_string: `new ${id}` } }] } });
  const testRun = (id: string, offset: number, ok: boolean): string =>
    JSON.stringify({ type: 'user', timestamp: t(offset), sessionId: SESSION, toolUseResult: { stdout: ok ? 'pass' : '', stderr: ok ? '' : 'Tests: 2 failed', durationMs: 100 }, message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: !ok, content: ok ? 'pass' : 'Tests: 2 failed' }] } });
  const bash = (id: string, offset: number): string =>
    JSON.stringify({ type: 'assistant', timestamp: t(offset), sessionId: SESSION, message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'npm test' } }] } });

  const lines = [edit('t1', 0), bash('t2', 1000), testRun('t2', 1500, false), edit('t3', 2000), bash('t4', 2500), testRun('t4', 3000, true)];
  const file = join(projects, 's.jsonl');
  writeFileSync(file, lines.join('\n'), 'utf8');
  return { dir: home, file };
}

describe('agent-pigeon CLI (public v0.1)', () => {
  it('help documents the full public surface — no experimental live commands', () => {
    const { stdout } = runCli(['help']);
    assert.match(stdout, /replay/u);
    assert.match(stdout, /flight/u);
    assert.match(stdout, /compare/u);
    assert.match(stdout, /share/u);
    assert.doesNotMatch(stdout, /init|remove|governor|VERIFY_FIRST/u);
  });

  it('--version matches package.json', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version: string };
    const { stdout, status } = runCli(['--version']);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), `agent-pigeon ${pkg.version}`);
  });

  it('unknown/experimental commands are rejected', () => {
    for (const cmd of ['init', 'remove', 'governor', 'nonsense']) {
      assert.equal(runCli([cmd]).status, 1, `${cmd} must not be a public command`);
    }
  });

  it('share prints a self-contained SVG card to stdout', () => {
    // share has no directory overrides; on an empty machine it reports
    // no sessions, otherwise it emits an <svg> document. Never writes files.
    const { stdout } = runCli(['share', 'flight']);
    assert.ok(
      stdout.startsWith('<svg') || stdout.trim() === 'no sessions',
      `unexpected share output: ${stdout.slice(0, 80)}`,
    );
    if (stdout.startsWith('<svg')) {
      assert.match(stdout, /<\/svg>$/u);
      // self-contained: no external references beyond the SVG namespace
      assert.doesNotMatch(stdout, /xlink:href|<image|@import|url\(/u);
    }
  });

  it('replay analyzes a synthetic claude history and stays read-only', () => {
    const { dir, file } = syntheticClaudeDir();
    const before = readFileSync(file, 'utf8');
    const { stdout, status } = runCli(['replay', '--claude-dir', join(dir, 'claude', 'projects'), '--codex-dir', join(dir, 'codex', 'sessions'), '--source', 'claude']);
    assert.equal(status, 0);
    assert.match(stdout, /Agent Pigeon — replay/u);
    assert.match(stdout, /Implementation attempts/u);
    assert.match(stdout, /Unverified implementation stretches/u);
    assert.match(stdout, /Recognized verification runs/u);
    // read-only: history file byte-identical, and NO secret/state files created anywhere
    assert.equal(readFileSync(file, 'utf8'), before);
    const home = dir;
    assert.ok(!existsSync(join(home, 'secret.key')));
    assert.ok(!existsSync(join(home, 'governor-live-state.json')));
    rmSync(home, { recursive: true, force: true });
  });

  it('replay on an empty directory produces a friendly zero-activity report', () => {
    const empty = mkdtempSync(join(tmpdir(), 'pigeon-empty-'));
    const { stdout, status } = runCli([
      'replay',
      '--claude-dir', join(empty, 'claude', 'projects'),
      '--codex-dir', join(empty, 'codex', 'sessions'),
    ]);
    assert.equal(status, 0);
    assert.match(stdout, /0 sessions/u);
    assert.match(stdout, /nothing was modified/u);
    rmSync(empty, { recursive: true, force: true });
  });

  it('--json exposes the sanitized aggregate without session content', () => {
    const { dir } = (() => {
      const home = mkdtempSync(join(tmpdir(), 'pigeon-cli-'));
      const projects = join(home, 'claude', 'projects', 'demo');
      mkdirSync(projects, { recursive: true });
      writeFileSync(join(projects, 's.jsonl'), [
        JSON.stringify({ type: 'assistant', timestamp: '2026-09-22T12:00:00.000Z', sessionId: 'json0000-1111-2222-3333-444444444444', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/p/secret-impl.ts', old_string: 'SECRET-A', new_string: 'SECRET-B' } }] } }),
      ].join('\n'), 'utf8');
      return { dir: home };
    })();
    const { stdout } = runCli(['replay', '--claude-dir', join(dir, 'claude', 'projects'), '--json']);
    assert.ok(!stdout.includes('SECRET-A') && !stdout.includes('secret-impl'), 'no raw content in JSON output');
    const parsed = JSON.parse(stdout) as { implementationChanges: number };
    assert.ok(parsed.implementationChanges >= 1);
    rmSync(dir, { recursive: true, force: true });
  });
});
