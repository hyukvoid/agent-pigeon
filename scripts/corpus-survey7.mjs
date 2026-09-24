// POC-04C survey #3 — what tools do the exec-JS programs drive? + item_completed types.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (entry.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const files = walk(join(homedir(), '.codex', 'sessions'));
const awaitTool = {};
const itemCompletedTypes = {};
const eventMsgTypes = {};
const otherCustomNames = {};

for (const f of files) {
  const text = readFileSync(f, 'utf8');
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const p = o.payload;
    if (p === null || typeof p !== 'object') continue;

    if (o.type === 'response_item' && p.type === 'custom_tool_call' && p.name === 'exec' && typeof p.input === 'string') {
      for (const m of p.input.matchAll(/(?:await\s+|text\(\s*await\s+)([A-Za-z_$][\w$.]*)\s*\(/gu)) {
        const name = m[1] ?? '?';
        awaitTool[name] = (awaitTool[name] ?? 0) + 1;
      }
    }

    if (o.type === 'event_msg') {
      const pt = p.type ?? '<none>';
      eventMsgTypes[pt] = (eventMsgTypes[pt] ?? 0) + 1;
      if (pt === 'item_completed') {
        const item = p.item ?? p.items;
        const kind = item === null || typeof item !== 'object' ? typeof item : (item.type ?? Object.keys(item).sort().slice(0, 3).join(','));
        itemCompletedTypes[kind] = (itemCompletedTypes[kind] ?? 0) + 1;
      }
    }

    if (o.type === 'response_item' && p.type === 'custom_tool_call' && p.name !== 'exec' && p.name !== 'apply_patch') {
      const name = p.name ?? '<none>';
      otherCustomNames[name] = (otherCustomNames[name] ?? 0) + 1;
    }
  }
}

const top = (obj, n) => Object.fromEntries(Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n));
console.log(JSON.stringify({
  awaitTools_top: top(awaitTool, 20),
  itemCompletedTypes: top(itemCompletedTypes, 12),
  eventMsgTypes: top(eventMsgTypes, 16),
  otherCustomNames,
}, null, 1));
