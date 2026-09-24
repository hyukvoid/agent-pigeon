// POC-04B survey #4 — call_id pairing, turn_token_usage keys, timestamp presence.
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

const files = walk(join(homedir(), '.codex', 'sessions')).slice(0, 60);
const callKeys = new Set();
const outKeys = new Set();
const turnUsageKeys = new Set();
let pairsMatched = 0;
let callsTotal = 0;
let outsTotal = 0;
let withTimestamp = 0;
let withTurnUsage = 0;
let turnUsageSample = null;

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  const callIds = new Set();
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof o.timestamp === 'string') withTimestamp++;
    const p = o.payload;
    if (p === null || typeof p !== 'object') continue;
    if (o.type === 'response_item' && p.type === 'custom_tool_call') {
      callsTotal++;
      if (typeof p.call_id === 'string') callIds.add(p.call_id);
      for (const k of Object.keys(p)) callKeys.add(k);
    }
    if (o.type === 'response_item' && p.type === 'custom_tool_call_output') {
      outsTotal++;
      if (typeof p.call_id === 'string' && callIds.has(p.call_id)) pairsMatched++;
      for (const k of Object.keys(p)) outKeys.add(k);
    }
    if (o.type === 'token_usage_record') {
      if (typeof p.turn_token_usage === 'object' && p.turn_token_usage !== null) {
        withTurnUsage++;
        for (const k of Object.keys(p.turn_token_usage)) turnUsageKeys.add(k);
        if (turnUsageSample === null) {
          const numeric = {};
          for (const [k, v] of Object.entries(p.turn_token_usage)) {
            if (typeof v === 'number') numeric[k] = v;
          }
          turnUsageSample = numeric;
        }
      }
    }
  }
}

console.log(JSON.stringify({
  filesSampled: 60,
  callsTotal,
  outsTotal,
  pairsMatched,
  callKeys: [...callKeys].sort(),
  outKeys: [...outKeys].sort(),
  withTimestamp,
  withTurnUsage,
  turnUsageKeys: [...turnUsageKeys].sort(),
  turnUsageSample,
}, null, 1));
