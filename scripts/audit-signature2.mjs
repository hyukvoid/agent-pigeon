// POC-04C audit probe #2 — recompute the signature content lines for failed
// exec outputs (sandbox noise excluded) and print them for manual comparison.
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { parseCodexSessionJsonl } from '../dist/src/replay/codex.js';

const lf = (t) => t.replace(/\r\n?/gu, '\n');
function mask(t) {
  return t
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<PATH>')
    .replace(/(?:\/(?:home|Users|root|tmp|var|mnt)\/\S+)/g, '<PATH>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<HEX>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<N>');
}
const GENERIC_LINE =
  /^(?:(?:script|command|shell|exec(?:ution)?)\s+(?:failed|completed)|exit code[:\s]*<N>|process exited(?: with code <N>)?|failed|error|<N>)\s*$/i;

function signatureLines(text) {
  const normalized = mask(text);
  return normalized
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => l.length > 3 && !GENERIC_LINE.test(l))
    .slice(0, 3);
}

const file = process.argv[2];
const text = readFileSync(file, 'utf8');
const seen = new Map();
for (const line of text.split('\n')) {
  if (line.length === 0) continue;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const p = o.payload;
  if (o.type !== 'response_item' || p?.type !== 'custom_tool_call_output' || !Array.isArray(p.output)) continue;
  const t = p.output.map((e) => (e && typeof e === 'object' && typeof e.text === 'string' ? e.text : '')).join('\n');
  if (!/exit code:\s*[1-9]/i.test(t)) continue;
  if (/orchestrator_helper_launch_failed|windows sandbox:[^\n]*launch/i.test(t)) continue;
  const lines = signatureLines(t);
  const key = lines.join(' § ');
  if (!seen.has(key)) seen.set(key, { lines, count: 1 });
  else seen.get(key).count++;
}
for (const [key, { lines, count }] of seen) {
  console.log(`signature-content (x${count}):`);
  lines.forEach((l) => console.log('   ·', l.slice(0, 110)));
  const hmac = createHmac('sha256', 'probe').update(lines.join('\n')).digest('hex').slice(0, 8);
  console.log('   (probe-hash)', hmac);
}
console.log('distinct signature contents:', seen.size);
void parseCodexSessionJsonl;
