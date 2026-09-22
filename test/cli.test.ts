import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repoRoot } from './paths.js';

const CLI = join(repoRoot, 'dist', 'src', 'cli.js');

function runCli(args: string[], cwd?: string): { stdout: string; status: number } {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd,
    windowsHide: true,
  });
  return { stdout: result.stdout ?? '', status: result.status ?? 1 };
}

describe('agent-pigeon CLI', () => {
  it('help lists replay/init/remove', () => {
    const { stdout, status } = runCli(['help']);
    assert.equal(status, 0);
    assert.match(stdout, /replay/u);
    assert.match(stdout, /init/u);
    assert.match(stdout, /remove/u);
  });

  it('rejects unknown commands with exit code 1', () => {
    const { status } = runCli(['nonsense']);
    assert.equal(status, 1);
  });

  it('replay analyzes a synthetic claude history dir (read-only)', () => {
    const home = mkdtempSync(join(tmpdir(), 'pigeon-cli-'));
    const projects = join(home, 'claude', 'projects', 'demo');
    mkdirSync(projects, { recursive: true });
    // one attempt: edit → failing test → edit → passing test
    const t = (offset: number): string => new Date(Date.parse('2026-09-22T12:00:00.000Z') + offset).toISOString();
    const lines = [
      JSON.stringify({ type: 'assistant', timestamp: t(0), sessionId: 'cli00000-1111-2222-3333-444444444444', message: { content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/p/app.ts', old_string: 'a', new_string: 'b' } }] } }),
      JSON.stringify({ type: 'user', timestamp: t(1000), sessionId: 'cli00000-1111-2222-3333-444444444444', toolUseResult: { stderr: 'Tests: 3 failed', durationMs: 100 }, message: { content: [{ type: 'tool_result', tool_use_id: 't1', is_error: false, content: 'ok' }] } }),
    ];
    // minimal verification event: npm test via Bash tool
    const withBash = JSON.parse(lines[0]!);
    withBash.message.content = [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } }];
    lines[1] = JSON.stringify({
      type: 'user',
      timestamp: t(1500),
      sessionId: 'cli00000-1111-2222-3333-444444444444',
      toolUseResult: { stdout: '', stderr: 'Tests: 3 failed', durationMs: 100 },
      message: { content: [{ type: 'tool_result', tool_use_id: 't2', is_error: true, content: 'Tests: 3 failed' }] },
    });
    lines[0] = JSON.stringify(withBash);
    lines.push(
      JSON.stringify({ type: 'assistant', timestamp: t(2000), sessionId: 'cli00000-1111-2222-3333-444444444444', message: { content: [{ type: 'tool_use', id: 't3', name: 'Edit', input: { file_path: '/p/app.ts', old_string: 'c', new_string: 'd' } }] } }),
      JSON.stringify({ type: 'user', timestamp: t(2500), sessionId: 'cli00000-1111-2222-3333-444444444444', toolUseResult: { stdout: 'pass', stderr: '', durationMs: 100 }, message: { content: [{ type: 'tool_result', tool_use_id: 't3', is_error: false, content: 'pass' }] } }),
    );
    writeFileSync(join(projects, 's.jsonl'), lines.join('\n'), 'utf8');

    const { stdout } = runCli(['replay', '--claude-dir', join(home, 'claude', 'projects'), '--source', 'claude']);
    assert.match(stdout, /Agent Pigeon — replay/u);
    assert.match(stdout, /Implementation attempts/u);
    assert.match(stdout, /Verification debt/u);
    // source files untouched (read-only)
    assert.ok(readFileSync(join(projects, 's.jsonl'), 'utf8').length > 0);
    rmSync(home, { recursive: true, force: true });
  });
});

describe('agent-pigeon init/remove', () => {
  function project(): string {
    const dir = mkdtempSync(join(tmpdir(), 'pigeon-init-'));
    return dir;
  }

  it('installs, is idempotent, preserves unrelated config, and removes cleanly', () => {
    const dir = project();
    // pre-existing unrelated hook must survive
    const settingsPath = join(dir, '.claude', 'settings.json');
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(
      settingsPath,
      JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'node unrelated.js' }] }] } }, null, 2),
      'utf8',
    );

    const init = runCli(['init', '--project', dir]);
    assert.equal(init.status, 0);
    assert.match(init.stdout, /\+ PostToolUse/u);
    assert.match(init.stdout, /\+ PostToolBatch/u);

    const stored = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.ok(stored.hooks.UserPromptSubmit, 'unrelated hooks preserved');
    assert.equal(stored.hooks.PostToolUse[0].matcher, 'Edit|Write|MultiEdit|Bash');
    assert.equal(stored.hooks.PostToolUse[0].hooks[0].async, true);

    const again = runCli(['init', '--project', dir]);
    assert.match(again.stdout, /already installed/u);

    const remove = runCli(['remove', '--project', dir]);
    assert.equal(remove.status, 0);
    const after = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.ok(after.hooks.UserPromptSubmit, 'unrelated hooks still preserved after remove');
    assert.equal(after.hooks.PostToolUse, undefined);
    assert.equal(after.hooks.PostToolBatch, undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('refuses to touch an unparsable settings file (fail safe)', () => {
    const dir = project();
    mkdirSync(join(dir, '.claude'), { recursive: true });
    const settingsPath = join(dir, '.claude', 'settings.json');
    writeFileSync(settingsPath, '{ broken', 'utf8');
    const init = runCli(['init', '--project', dir]);
    assert.equal(init.status, 1);
    assert.equal(readFileSync(settingsPath, 'utf8'), '{ broken', 'file must remain untouched');
    rmSync(dir, { recursive: true, force: true });
  });

  it('governor batch hook fails open on corrupt state (integration)', () => {
    const home = mkdtempSync(join(tmpdir(), 'pigeon-failopen-'));
    writeFileSync(join(home, 'governor-state.json'), '{ corrupt', 'utf8');
    const result = spawnSync(process.execPath, [join(repoRoot, 'dist', 'src', 'governor-batch.js')], {
      input: JSON.stringify({ session_id: 'zzzz0000-1111-2222-3333-444444444444', hook_event_name: 'PostToolBatch' }),
      env: { ...process.env, AGENT_PIGEON_HOME: home, AGENT_PIGEON_EVENTS: join(home, 'missing-events.jsonl') },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(result.status, 0, 'batch hook must exit 0');
    assert.equal(result.stdout, '', 'fail-open must print nothing');
    rmSync(home, { recursive: true, force: true });
  });
});
