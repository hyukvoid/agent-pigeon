import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { repoRoot } from './paths.js';

const formatUrl = pathToFileURL(join(repoRoot, 'ui', 'format.js')).href;
const { cleanLastObserved, looksLikeHarnessText } = await import(formatUrl) as {
  cleanLastObserved: (label: string | null, max?: number) => string | null;
  looksLikeHarnessText: (text: string) => boolean;
};

// Guard: the helper must stay plain browser-compatible JS (no TS syntax).
const source = readFileSync(join(repoRoot, 'ui', 'format.js'), 'utf8');
assert.ok(!/:\s*(string|number|boolean)\s*[),=;]/u.test(source), 'format.js must stay plain JS');

describe('ui format helpers (presentation layer only)', () => {
  it('cleanLastObserved strips cd prefixes and collapses whitespace', () => {
    assert.equal(
      cleanLastObserved('ran cd "C:\\Agent Pigeon" && node dist/src/cli.js ui --port 7676'),
      'ran node dist/src/cli.js ui --port 7676',
    );
    assert.equal(
      cleanLastObserved("ran cd 'C:/work app' && npm test"),
      'ran npm test',
    );
    assert.equal(
      cleanLastObserved("ran $ProgressPreference='SilentlyContinue'; Invoke-RestMethod -Uri x"),
      'ran Invoke-RestMethod -Uri x',
    );
    assert.equal(cleanLastObserved('ran   npm \n test  '), 'ran npm test');
  });

  it('cleanLastObserved truncates and passes null through', () => {
    const long = 'ran ' + 'x'.repeat(120);
    const cut = cleanLastObserved(long);
    assert.ok((cut?.length ?? 0) <= 48);
    assert.ok(cut?.endsWith('…'));
    assert.equal(cleanLastObserved(null), null);
    assert.equal(cleanLastObserved(''), null);
  });

  it('cleanLastObserved never invents meaning', () => {
    assert.equal(cleanLastObserved('tests passed'), 'tests passed');
    assert.equal(cleanLastObserved('modified src/api.ts'), 'modified src/api.ts');
  });

  it('looksLikeHarnessText flags boilerplate, keeps real tasks', () => {
    assert.equal(looksLikeHarnessText('You are running inside the Codex CLI'), true);
    assert.equal(looksLikeHarnessText('Working directory: C:\\x'), true);
    assert.equal(looksLikeHarnessText('<environment_context>'), true);
    assert.equal(looksLikeHarnessText('/model'), true);
    assert.equal(looksLikeHarnessText('# AGENTS.md instructions'), true);
    assert.equal(looksLikeHarnessText('The following is the Codex agent history…'), true);
    assert.equal(looksLikeHarnessText('fix the login redirect loop'), false);
    assert.equal(looksLikeHarnessText('Add stock level validation to the inventory API'), false);
  });
});
