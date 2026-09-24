// POC-04B survey #3 — exec/apply_patch input shapes, output array element shapes.
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
const execInput = { json: 0, plain: 0, other: 0 };
const execJsonKeys = {};
const patchFirstLine = {};
const outputArrLen = {};
const outputElemShapes = {};
const shellCmdKeys = {};
let patched = 0;

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

    if (o.type === 'response_item' && p.type === 'custom_tool_call' && p.name === 'exec' && typeof p.input === 'string') {
      const s = p.input.trim();
      if (s.startsWith('{')) {
        try {
          const parsed = JSON.parse(s);
          execInput.json++;
          const keys = Object.keys(parsed).sort().join(',');
          execJsonKeys[keys] = (execJsonKeys[keys] ?? 0) + 1;
          continue;
        } catch { /* fall through */ }
      }
      if (s.startsWith('[')) {
        try {
          JSON.parse(s);
          execInput.json++;
          execJsonKeys['<array>'] = (execJsonKeys['<array>'] ?? 0) + 1;
          continue;
        } catch { /* fall through */ }
      }
      execInput.plain++;
    }

    if (o.type === 'response_item' && p.type === 'custom_tool_call' && p.name === 'apply_patch' && typeof p.input === 'string') {
      patched++;
      const first = p.input.split('\n', 1)[0] ?? '';
      patchFirstLine[first.slice(0, 30)] = (patchFirstLine[first.slice(0, 30)] ?? 0) + 1;
    }

    if (o.type === 'response_item' && p.type === 'custom_tool_call_output' && Array.isArray(p.output)) {
      const len = p.output.length;
      outputArrLen[len] = (outputArrLen[len] ?? 0) + 1;
      p.output.forEach((elem, idx) => {
        const kind = elem === null || typeof elem !== 'object' ? typeof elem : Object.keys(elem).sort().join(',');
        const key = `${idx <= 1 ? idx : 'last'}:${kind}`;
        outputElemShapes[key] = (outputElemShapes[key] ?? 0) + 1;
      });
    }

    if (o.type === 'response_item' && p.type === 'function_call' && p.name === 'shell_command' && typeof p.arguments === 'string') {
      try {
        const args = JSON.parse(p.arguments);
        const keys = Object.keys(args).sort().join(',');
        shellCmdKeys[keys] = (shellCmdKeys[keys] ?? 0) + 1;
      } catch {}
    }
  }
}

console.log(JSON.stringify({
  execInput,
  execJsonKeys,
  patchFirstLine,
  patches: patched,
  outputArrLen: Object.fromEntries(Object.entries(outputArrLen).sort((a, b) => b[1] - a[1]).slice(0, 8)),
  outputElemShapes_top: Object.fromEntries(Object.entries(outputElemShapes).sort((a, b) => b[1] - a[1]).slice(0, 10)),
  shellCmdKeys,
}, null, 1));
