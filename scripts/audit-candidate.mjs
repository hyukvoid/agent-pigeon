// POC-04B manual audit helper — prints SANITIZED per-attempt detail for one
// session so a human can judge whether the detector's label is defensible.
// Never prints commands, paths, output text, or prompts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseCodexSessionJsonl, tokensInWindow } from '../dist/src/replay/codex.js';
import { parseClaudeSessionJsonl } from '../dist/src/replay/claude.js';
import { segmentWithWindows } from '../dist/src/replay/segment.js';

const file = process.argv[2];
const source = process.argv[3] ?? 'codex';

const text = readFileSync(file, 'utf8');
const parsed =
  source === 'codex'
    ? (() => {
        const s = parseCodexSessionJsonl(text);
        return { sessionId8: s.sessionId8, events: s.events, epochMs: s.epochMs, mobile: s.mobileSignal, tokenRecords: s.tokenRecords };
      })()
    : (() => {
        const s = parseClaudeSessionJsonl(text);
        return { sessionId8: s.meta.sessionId8, events: s.events, epochMs: null, mobile: false, tokenRecords: [] };
      })();

const { attempts, windows } = segmentWithWindows(parsed.events);
console.log(`session ${parsed.sessionId8} · events ${parsed.events.length} · attempts ${attempts.length} · mobile=${parsed.mobile}`);

attempts.forEach((attempt, i) => {
  const window = windows[i];
  const verification = (window?.verifications ?? [])
    .map((v) => `${v.verificationKind ?? 'run'}:${v.ok === true ? 'pass' : v.ok === false ? 'FAIL' : 'unknown'}${v.testsFailedCount !== null ? `(${v.testsFailedCount} failing)` : ''}`)
    .join(',') || 'NOT VERIFIED';
  const offset = attempt.timestampOffset === null ? '?' : `+${(attempt.timestampOffset / 1000).toFixed(0)}s`;
  console.log(
    `attempt ${attempt.index + 1}  ${offset}  impl=${attempt.implementationEvents}  changeSetHash=${attempt.evidence.code.changeSetHash ?? '-'}  failuresig=${attempt.failureSignatureHash ?? '-'}  tests=${attempt.evidence.tests.failedCount ?? '-'}  verification: ${verification}`,
  );
});

// token usage per attempt window (codex only)
if (source === 'codex' && parsed.epochMs !== null && parsed.tokenRecords.length > 0) {
  attempts.forEach((attempt, i) => {
    const window = windows[i];
    const offsets = [attempt.timestampOffset, (window?.verifications ?? []).at(-1)?.timestampOffset ?? attempt.timestampOffset].filter(
      (o) => typeof o === 'number',
    );
    if (offsets.length === 0 || parsed.epochMs === null) return;
    const from = parsed.epochMs + Math.min(...offsets);
    const tokens = tokensInWindow(parsed.tokenRecords, from, from + 600_000);
    console.log(`attempt ${attempt.index + 1} tokens≈${tokens === null ? 'UNKNOWN' : tokens.toLocaleString('en-US')}`);
  });
}
