// Print the first lines of a failed exec output (local audit only).
import { readFileSync } from 'node:fs';
const file = process.argv[2];
const text = readFileSync(file, 'utf8');
let printed = 0;
for (const line of text.split('\n')) {
  if (printed >= 2) break;
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  const p = o.payload;
  if (o.type === 'response_item' && p?.type === 'custom_tool_call_output' && Array.isArray(p.output)) {
    const t = p.output.map((e) => (e && typeof e === 'object' && typeof e.text === 'string' ? e.text : '')).join('\n');
    if (!/exit code:\s*[1-9]|FAIL/i.test(t)) continue;
    printed++;
    const ls = t.split(/\r?\n/).slice(0, 8);
    console.log(`--- failed output (session file, sample ${printed}) ---`);
    ls.forEach((l, i) => console.log(`  L${i + 1}: ${l.slice(0, 100)}`));
  }
}
