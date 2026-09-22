// POC-04C audit probe — inspect the actual failure texts behind a signature
// hash for specific attempts. LOCAL ONLY; output is used for the manual audit
// narrative and never committed with session content.
import { readFileSync } from 'node:fs';
import { parseCodexSessionJsonl } from '../dist/src/replay/codex.js';
import { segmentWithWindows } from '../dist/src/replay/segment.js';

const file = process.argv[2];
const wanted = new Set((process.argv[3] ?? '').split(',').map(Number).filter(Boolean));

const text = readFileSync(file, 'utf8');
const session = parseCodexSessionJsonl(text);
// Re-derive failure texts: we re-scan outputs paired to verification events.
const { attempts, windows } = segmentWithWindows(session.events);

// The parser discards output text, so re-extract it here the same way.
const lines = text.split('\n');
const callOutput = new Map();
for (const line of lines) {
  if (line.length === 0) continue;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const p = o.payload;
  if (o.type === 'response_item' && p?.type === 'custom_tool_call_output' && typeof p.call_id === 'string') {
    const parts = [];
    if (Array.isArray(p.output)) {
      for (const elem of p.output) {
        if (elem && typeof elem === 'object' && typeof elem.text === 'string') parts.push(elem.text);
      }
    } else if (typeof p.output === 'string') parts.push(p.output);
    callOutput.set(p.call_id, parts.join('\n'));
  }
}

attempts.forEach((attempt, i) => {
  if (wanted.size > 0 && !wanted.has(i + 1)) return;
  const window = windows[i];
  for (const v of window?.verifications ?? []) {
    if (v.ok === false) {
      console.log(`attempt ${i + 1} kind=${v.verificationKind} sig=${v.failureSignatureHash}`);
    }
  }
});
// Print the first lines of FAILED verification outputs for manual comparison.
const failedTexts = [];
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const p = o.payload;
  if (o.type === 'response_item' && p?.type === 'custom_tool_call_output' && Array.isArray(p.output)) {
    const t = p.output.map((e) => (e && typeof e === 'object' && typeof e.text === 'string' ? e.text : '')).join('\n');
    if (/exit code:\s*[1-9]|FAIL|failed/i.test(t)) failedTexts.push(t);
  }
}
console.log('--- first lines of failed outputs (deduped, first 8):');
const seen = new Set();
for (const t of failedTexts) {
  const first = t.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 3)[0] ?? '';
  if (seen.has(first)) continue;
  seen.add(first);
  console.log('  ·', first.slice(0, 110));
  if (seen.size >= 8) break;
}
