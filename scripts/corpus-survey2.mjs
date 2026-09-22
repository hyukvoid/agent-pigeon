// POC-04B survey #2 — custom_tool_call shapes + token usage structure (aggregates only).
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
const customNames = {};
const customInputKeys = {};
const customOutputKeys = {};
const shellArgKeys = new Set();
const fcArgKeys = new Set();
const tokenUsageKeys = new Set();
const threadUsageKeys = new Set();
let tokenSamplePrinted = false;
let exitCodeSeen = 0;
let outputStrSeen = 0;

for (const file of files) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
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

    if (o.type === 'response_item' && p.type === 'custom_tool_call') {
      const name = typeof p.name === 'string' ? p.name : '<none>';
      customNames[name] = (customNames[name] ?? 0) + 1;
      const input = p.input;
      const ikeys = typeof input === 'string' ? ['<string>'] : input === null || typeof input !== 'object' ? ['<' + typeof input + '>'] : Object.keys(input);
      customInputKeys[`${name}: ${ikeys.sort().join(',')}`] = (customInputKeys[`${name}: ${ikeys.sort().join(',')}`] ?? 0) + 1;
    }
    if (o.type === 'response_item' && p.type === 'custom_tool_call_output') {
      const out = p.output;
      const okeys = typeof out === 'string' ? ['<string>'] : out === null || typeof out !== 'object' ? ['<' + typeof out + '>'] : Object.keys(out);
      const key = okeys.sort().join(',');
      customOutputKeys[key] = (customOutputKeys[key] ?? 0) + 1;
      if (typeof out === 'object' && out !== null) {
        if ('exit_code' in out) exitCodeSeen++;
        if (typeof out.output === 'string') outputStrSeen++;
      }
    }
    if (o.type === 'response_item' && p.type === 'function_call' && typeof p.arguments === 'string') {
      try {
        const args = JSON.parse(p.arguments);
        if (args !== null && typeof args === 'object') for (const k of Object.keys(args)) fcArgKeys.add(`${p.name}.${k}`);
      } catch {}
    }
    if (o.type === 'token_usage_record' && p.usage !== null && typeof p.usage === 'object') {
      for (const k of Object.keys(p.usage)) tokenUsageKeys.add(k);
    }
    if (o.type === 'token_usage_record' && p.thread_token_usage !== null && typeof p.thread_token_usage === 'object') {
      for (const k of Object.keys(p.thread_token_usage)) threadUsageKeys.add(k);
      if (!tokenSamplePrinted) {
        const numeric = {};
        for (const [k, v] of Object.entries(p.thread_token_usage)) {
          if (typeof v === 'number') numeric[k] = v;
        }
        console.log('sample thread_token_usage (numeric only):', JSON.stringify(numeric));
        tokenSamplePrinted = true;
      }
    }
  }
}

console.log(JSON.stringify({
  customNames,
  customInputKeys,
  customOutputKeys,
  functionCallArgKeys: [...fcArgKeys].sort(),
  exitCodeSeen,
  outputStrSeen,
  usageKeys: [...tokenUsageKeys].sort(),
  threadUsageKeys: [...threadUsageKeys].sort(),
}, null, 1));
