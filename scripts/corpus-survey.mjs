// POC-04B corpus survey — aggregate statistics ONLY (no content output).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (entry.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const root = join(homedir(), '.codex', 'sessions');
const files = walk(root);
const typeCount = {};
const payloadTypeCount = {};
const fnNames = {};
const turnKeys = new Set();
const metaKeys = new Set();
const tokenRecordKeys = new Set();
let totalLines = 0;
let filesWithFnCalls = 0;
let filesWithApplyPatch = 0;
let filesWithTokens = 0;

for (const file of files) {
  let hasFn = false;
  let hasPatch = false;
  let hasTok = false;
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const line of text.split('\n')) {
    if (line.length === 0) continue;
    totalLines++;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const t = o.type ?? '<none>';
    typeCount[t] = (typeCount[t] ?? 0) + 1;
    const p = o.payload;
    if (p === null || typeof p !== 'object') continue;
    const pt = p.type ?? '<none>';
    payloadTypeCount[`${t}/${pt}`] = (payloadTypeCount[`${t}/${pt}`] ?? 0) + 1;
    if (t === 'response_item' && pt === 'function_call') {
      hasFn = true;
      const name = typeof p.name === 'string' ? p.name : '<none>';
      fnNames[name] = (fnNames[name] ?? 0) + 1;
      if (typeof p.arguments === 'string' && p.arguments.includes('apply_patch')) hasPatch = true;
    }
    if (t === 'event_msg' && pt === 'function_call') hasFn = true;
    if (t === 'token_usage_record') {
      hasTok = true;
      for (const k of Object.keys(p)) tokenRecordKeys.add(k);
    }
    if (t === 'turn_context') for (const k of Object.keys(p)) turnKeys.add(k);
    if (t === 'session_meta') for (const k of Object.keys(p)) metaKeys.add(k);
  }
  if (hasFn) filesWithFnCalls++;
  if (hasPatch) filesWithApplyPatch++;
  if (hasTok) filesWithTokens++;
}

console.log(JSON.stringify({
  files: files.length,
  totalLines,
  typeCount,
  payloadTypeCount_top: Object.fromEntries(Object.entries(payloadTypeCount).sort((a, b) => b[1] - a[1]).slice(0, 14)),
  functionCallNames: fnNames,
  filesWithFnCalls,
  filesWithApplyPatch,
  filesWithTokens,
  turnContextKeys: [...turnKeys].sort(),
  sessionMetaKeys: [...metaKeys].sort(),
  tokenRecordKeys: [...tokenRecordKeys].sort(),
}, null, 1));
